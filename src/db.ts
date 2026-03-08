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
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${Date.now().toString(36)}_${rand[0]!.toString(36)}${rand[1]!.toString(36)}`;
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

// Ensure all message authors are in the members table (without deleting existing members)
export function rebuildMembers(db: Database): void {
  const authors = db.prepare("SELECT DISTINCT author FROM messages").all() as { author: string }[];
  for (const { author } of authors) {
    ensureMember(db, author);
  }
}

export interface Task {
  id: string;
  name: string;
  assignee: string;
  detail: string;
  status: "pending" | "active" | "done";
  channel: string;
  author: string;
}

export function getTasks(db: Database, statusFilter?: string): Task[] {
  const taskMsgs = db.prepare(
    "SELECT * FROM messages WHERE json_valid(metadata) AND json_extract(metadata, '$.task') IS NOT NULL ORDER BY id ASC"
  ).all() as Message[];

  const tasks: Task[] = [];
  for (const msg of taskMsgs) {
    try {
      const meta = JSON.parse(msg.metadata!);
      if (!meta.task?.name) continue;

      const latestUpdate = db.prepare(
        "SELECT metadata FROM messages WHERE reply_to = ? AND json_valid(metadata) AND json_extract(metadata, '$.task_update') IS NOT NULL ORDER BY id DESC LIMIT 1"
      ).get(msg.id) as { metadata: string } | null;

      let status = meta.task.status || "pending";
      if (latestUpdate) {
        try {
          const u = JSON.parse(latestUpdate.metadata);
          if (u.task_update?.status) status = u.task_update.status;
        } catch {}
      }

      if (statusFilter && status !== statusFilter) continue;

      tasks.push({
        id: msg.id,
        name: meta.task.name,
        assignee: meta.task.assignee || "",
        detail: meta.task.detail || "",
        status,
        channel: msg.channel,
        author: msg.author,
      });
    } catch {}
  }

  return tasks;
}

export function getUnreadMessages(db: Database, sinceId: string, forName?: string): Message[] {
  const conds: string[] = [];
  const params: any[] = [];

  if (sinceId) {
    conds.push("id > ?");
    params.push(sinceId);
  }
  if (forName) {
    conds.push("content LIKE ?");
    params.push(`%@${forName}%`);
  }

  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM messages ${where} ORDER BY id ASC`).all(...params) as Message[];
}

// --- Memory ---

export interface Memory {
  id: string;
  agent: string;
  content: string;
  tags: string[];
  created_at: number;
}

function toMemory(msg: Message): Memory | null {
  try {
    const meta = JSON.parse(msg.metadata || "{}");
    const { name } = parseAuthor(msg.author);
    return {
      id: msg.id,
      agent: name,
      content: msg.content,
      tags: meta.memory?.tags || [],
      created_at: idToTime(msg.id),
    };
  } catch {
    return null;
  }
}

export function getMemories(db: Database, opts: { agent?: string; tag?: string; search?: string; last?: number } = {}): Memory[] {
  const conds = ["json_valid(metadata) AND json_extract(metadata, '$.memory') IS NOT NULL"];
  const params: any[] = [];

  if (opts.agent) {
    conds.push("(author LIKE ? OR author = ?)");
    params.push(`agent:${opts.agent}@%`, opts.agent);
  }
  if (opts.tag) {
    conds.push("json_extract(metadata, '$.memory.tags') LIKE ?");
    params.push(`%"${opts.tag}"%`);
  }
  if (opts.search) {
    conds.push("content LIKE ?");
    params.push(`%${opts.search}%`);
  }

  const where = conds.join(" AND ");

  if (opts.last) {
    return (db.prepare(
      `SELECT * FROM (SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
    ).all(...params, opts.last) as Message[]).map(toMemory).filter((m): m is Memory => m !== null);
  }

  return (db.prepare(
    `SELECT * FROM messages WHERE ${where} ORDER BY id ASC`
  ).all(...params) as Message[]).map(toMemory).filter((m): m is Memory => m !== null);
}

// --- Summary ---

export interface Summary {
  id: string;
  channel: string;
  agent: string;
  content: string;
  period: string;
  message_count: number;
  created_at: number;
}

function toSummary(msg: Message): Summary | null {
  try {
    const meta = JSON.parse(msg.metadata || "{}");
    const { name } = parseAuthor(msg.author);
    return {
      id: msg.id,
      channel: meta.summary?.channel || "",
      agent: name,
      content: msg.content,
      period: meta.summary?.period || "",
      message_count: meta.summary?.message_count || 0,
      created_at: idToTime(msg.id),
    };
  } catch {
    return null;
  }
}

export function getSummaries(db: Database, channel?: string, last?: number): Summary[] {
  const conds = ["json_valid(metadata) AND json_extract(metadata, '$.summary') IS NOT NULL"];
  const params: any[] = [];

  if (channel) {
    conds.push("json_extract(metadata, '$.summary.channel') = ?");
    params.push(channel);
  }

  const where = conds.join(" AND ");

  if (last) {
    return (db.prepare(
      `SELECT * FROM (SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
    ).all(...params, last) as Message[]).map(toSummary).filter((s): s is Summary => s !== null);
  }

  return (db.prepare(
    `SELECT * FROM messages WHERE ${where} ORDER BY id ASC`
  ).all(...params) as Message[]).map(toSummary).filter((s): s is Summary => s !== null);
}

