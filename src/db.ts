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
  FOREIGN KEY (channel) REFERENCES channels(name)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);
`;

export interface Message {
  id: string;
  channel: string;
  author: string;
  content: string;
  reply_to?: string | null;
}

export function openDb(chatDir: string): Database {
  const db = new Database(join(chatDir, "chat.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
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
    `INSERT OR IGNORE INTO messages (id, channel, author, content, reply_to) VALUES (?, ?, ?, ?, ?)`,
    [msg.id, msg.channel, msg.author, msg.content, msg.reply_to ?? null]
  );
  return r.changes > 0;
}

export function insertMessages(db: Database, msgs: Message[]): Message[] {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO messages (id, channel, author, content, reply_to) VALUES (?, ?, ?, ?, ?)`
  );
  const inserted: Message[] = [];
  db.transaction(() => {
    for (const msg of msgs) {
      const r = stmt.run(msg.id, msg.channel, msg.author, msg.content, msg.reply_to ?? null);
      if (r.changes > 0) inserted.push(msg);
    }
  })();
  return inserted;
}

export function queryMessages(db: Database, channel: string, opts: { last?: number; since?: string; search?: string } = {}): Message[] {
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

