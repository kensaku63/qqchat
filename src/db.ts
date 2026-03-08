import { Database } from "bun:sqlite";
import { join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to TEXT,
  metadata TEXT,
  FOREIGN KEY (channel) REFERENCES channels(name)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);

CREATE TABLE IF NOT EXISTS members (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'human',
  joined_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export interface Message {
  id: string;
  channel: string;
  author: string;
  content: string;
  reply_to?: string | null;
  metadata?: string | null;  // JSON string for structured data (files, diffs, etc.)
}

export function openDb(chatDir: string): Database {
  const db = new Database(join(chatDir, "chat.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  // Migrate: add metadata column if missing (for existing DBs)
  try {
    db.exec("ALTER TABLE messages ADD COLUMN metadata TEXT");
  } catch {
    // Column already exists
  }
  // Migrate: add type column to members if missing
  try {
    db.exec("ALTER TABLE members ADD COLUMN type TEXT NOT NULL DEFAULT 'human'");
  } catch {
    // Column already exists
  }
  return db;
}

export function generateId(): string {
  return `${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;
}

export function idToTime(id: string): number {
  return parseInt(id.split("_")[0]!, 36);
}

export function insertMessage(db: Database, msg: Message): boolean {
  const r = db.run(
    `INSERT OR IGNORE INTO messages (id, channel, author, content, reply_to, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.channel, msg.author, msg.content, msg.reply_to ?? null, msg.metadata ?? null]
  );
  return r.changes > 0;
}

export function insertMessages(db: Database, msgs: Message[]): Message[] {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO messages (id, channel, author, content, reply_to, metadata) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const inserted: Message[] = [];
  db.transaction(() => {
    for (const msg of msgs) {
      const r = stmt.run(msg.id, msg.channel, msg.author, msg.content, msg.reply_to ?? null, msg.metadata ?? null);
      if (r.changes > 0) inserted.push(msg);
    }
  })();
  return inserted;
}

export function queryMessages(db: Database, channel: string, opts: { last?: number; since?: string; search?: string; mention?: string } = {}): Message[] {
  const conds = ["channel = ?"];
  const params: any[] = [channel];

  if (opts.since) {
    conds.push("id > ?");
    params.push(opts.since);
  }
  if (opts.search) {
    conds.push("content LIKE ?");
    params.push(`%${opts.search}%`);
  }
  if (opts.mention) {
    conds.push("content LIKE ?");
    params.push(`%@${opts.mention}%`);
  }

  const where = conds.join(" AND ");

  if (opts.last) {
    return db.prepare(
      `SELECT * FROM (SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
    ).all(...params, opts.last) as Message[];
  }

  return db.prepare(
    `SELECT * FROM messages WHERE ${where} ORDER BY id ASC`
  ).all(...params) as Message[];
}

export function getMessagesSince(db: Database, sinceId: string): Message[] {
  return db.prepare("SELECT * FROM messages WHERE id > ? ORDER BY id ASC").all(sinceId) as Message[];
}

export function getAllMessages(db: Database): Message[] {
  return db.prepare("SELECT * FROM messages ORDER BY id ASC").all() as Message[];
}

export function getChannels(db: Database): { name: string; description: string; created_at: string }[] {
  return db.prepare("SELECT * FROM channels ORDER BY name").all() as any[];
}

export function createChannel(db: Database, name: string, description = ""): void {
  db.run("INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)", [name, description]);
}

export function ensureChannel(db: Database, name: string): void {
  db.run("INSERT OR IGNORE INTO channels (name) VALUES (?)", [name]);
}

export function getThread(db: Database, messageId: string): { root: Message | null; replies: Message[] } {
  const root = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Message | null;
  const replies = db.prepare("SELECT * FROM messages WHERE reply_to = ? ORDER BY id ASC").all(messageId) as Message[];
  return { root, replies };
}

export function getMessage(db: Database, messageId: string): Message | null {
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Message | null;
}

// author文字列からメンション可能な表示名とタイプを抽出
// "agent:Opus@kensaku" → { name: "Opus", type: "agent" }
// "agent@kensaku"      → { name: "kensaku", type: "agent" }
// "kensaku"            → { name: "kensaku", type: "human" }
export function parseAuthor(author: string): { name: string; type: "human" | "agent" } {
  if (author.startsWith("agent:")) {
    const rest = author.slice(6);
    const at = rest.indexOf("@");
    return { name: at >= 0 ? rest.slice(0, at) : rest, type: "agent" };
  }
  if (author.startsWith("agent@")) {
    return { name: author.slice(6), type: "agent" };
  }
  return { name: author, type: "human" };
}

export function ensureMember(db: Database, author: string): void {
  // Skip unnamed agents (agent@identity) - the identity is the machine user, not a mentionable name
  if (author.startsWith("agent@")) return;
  const { name, type } = parseAuthor(author);
  db.run("INSERT OR IGNORE INTO members (name, type) VALUES (?, ?)", [name, type]);
}

export function getMembers(db: Database): { name: string; type: string; joined_at: string }[] {
  return db.prepare("SELECT * FROM members ORDER BY name").all() as any[];
}

// Rebuild members table from messages (fixes stale/duplicate entries)
export function rebuildMembers(db: Database): void {
  const authors = db.prepare("SELECT DISTINCT author FROM messages").all() as { author: string }[];
  db.exec("DELETE FROM members");
  for (const { author } of authors) {
    ensureMember(db, author);
  }
}

export function getUnreadMessages(db: Database, sinceId: string): Message[] {
  if (!sinceId) {
    return db.prepare("SELECT * FROM messages ORDER BY id ASC").all() as Message[];
  }
  return db.prepare("SELECT * FROM messages WHERE id > ? ORDER BY id ASC").all(sinceId) as Message[];
}

