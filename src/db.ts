import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

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
  db.run("INSERT OR IGNORE INTO channels (name) VALUES ('_system')");

  runMigrations(db, chatDir);

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

export interface ThreadedMessage extends Message {
  reply_count: number;
  last_reply_id: string | null;
}

export function queryMessages(db: Database, channel: string, opts: { last?: number; since?: string; search?: string; mention?: string; flat?: boolean } = {}): Message[] | ThreadedMessage[] {
  const conds = ["channel = ?"];
  const params: any[] = [channel];

  if (!opts.flat && !opts.search && !opts.mention) {
    conds.push("reply_to IS NULL");
  }

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
  const threadSelect = !opts.flat && !opts.search && !opts.mention
    ? `, (SELECT COUNT(*) FROM messages r WHERE r.reply_to = m.id) as reply_count, (SELECT r2.id FROM messages r2 WHERE r2.reply_to = m.id ORDER BY r2.id DESC LIMIT 1) as last_reply_id`
    : "";

  if (opts.last) {
    return db.prepare(
      `SELECT * FROM (SELECT m.*${threadSelect} FROM messages m WHERE ${where} ORDER BY m.id DESC LIMIT ?) ORDER BY id ASC`
    ).all(...params, opts.last) as Message[];
  }

  return db.prepare(
    `SELECT m.*${threadSelect} FROM messages m WHERE ${where} ORDER BY m.id ASC`
  ).all(...params) as Message[];
}

export function getMessagesSince(db: Database, sinceId: string): Message[] {
  return db.prepare("SELECT * FROM messages WHERE id > ? ORDER BY id ASC").all(sinceId) as Message[];
}

export function getAllMessages(db: Database): Message[] {
  return db.prepare("SELECT * FROM messages ORDER BY id ASC").all() as Message[];
}

export function getChannels(db: Database): { name: string; created_at: string }[] {
  return db.prepare("SELECT * FROM channels ORDER BY CASE WHEN name = '_system' THEN 1 ELSE 0 END, name").all() as any[];
}

export function createChannel(db: Database, name: string): void {
  db.run("INSERT OR IGNORE INTO channels (name) VALUES (?)", [name]);
}

export function ensureChannel(db: Database, name: string): void {
  db.run("INSERT OR IGNORE INTO channels (name) VALUES (?)", [name]);
}

export function resolveThreadRoot(db: Database, replyTo: string): string {
  const target = db.prepare("SELECT reply_to FROM messages WHERE id = ?").get(replyTo) as { reply_to: string | null } | null;
  return target?.reply_to || replyTo;
}

export function getThread(db: Database, messageId: string): { root: Message | null; replies: Message[]; participants: string[]; reply_count: number } {
  const root = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Message | null;
  const replies = db.prepare("SELECT * FROM messages WHERE reply_to = ? ORDER BY id ASC").all(messageId) as Message[];
  const participantSet = new Set<string>();
  if (root) participantSet.add(parseAuthor(root.author).name);
  for (const r of replies) participantSet.add(parseAuthor(r.author).name);
  return { root, replies, participants: [...participantSet], reply_count: replies.length };
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

export function getUnreadMessages(
  db: Database,
  sinceId: string,
  opts?: { channels?: string[]; mentionName?: string }
): Message[] {
  const conds: string[] = ["channel != '_system'"];
  const params: any[] = [];

  if (sinceId) {
    conds.push("id > ?");
    params.push(sinceId);
  }

  if (opts?.mentionName) {
    if (opts.channels && opts.channels.length > 0) {
      const placeholders = opts.channels.map(() => "?").join(", ");
      conds.push(`(channel IN (${placeholders}) OR content LIKE ?)`);
      params.push(...opts.channels, `%@${opts.mentionName}%`);
    } else {
      conds.push("content LIKE ?");
      params.push(`%@${opts.mentionName}%`);
    }
  }

  const where = `WHERE ${conds.join(" AND ")}`;
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

// --- Agent / Channel Config (via _system channel) ---

export interface AgentConfigData {
  name: string;
  role: string;
  prompt: string;
  description: string;
  channels: string[];
  icon?: string;
  removed?: boolean;
}

export interface ChannelConfigData {
  name: string;
  description: string;
  status: "active" | "paused" | "archived";
}

export function getAgentConfigs(db: Database): Record<string, AgentConfigData> {
  const msgs = db.prepare(
    "SELECT * FROM messages WHERE channel = '_system' AND json_valid(metadata) AND json_extract(metadata, '$.agent_config') IS NOT NULL ORDER BY id ASC"
  ).all() as Message[];

  const result: Record<string, AgentConfigData> = {};
  for (const msg of msgs) {
    try {
      const meta = JSON.parse(msg.metadata!);
      const cfg = meta.agent_config;
      if (!cfg?.name) continue;
      if (cfg.removed) {
        delete result[cfg.name];
      } else {
        result[cfg.name] = {
          name: cfg.name,
          role: cfg.role || "",
          prompt: cfg.prompt || "",
          description: cfg.description || "",
          channels: cfg.channels || [],
          icon: cfg.icon || "",
        };
      }
    } catch {}
  }
  return result;
}

export function getChannelConfigs(db: Database): Record<string, ChannelConfigData> {
  const msgs = db.prepare(
    "SELECT * FROM messages WHERE channel = '_system' AND json_valid(metadata) AND json_extract(metadata, '$.channel_config') IS NOT NULL ORDER BY id ASC"
  ).all() as Message[];

  const result: Record<string, ChannelConfigData> = {};
  for (const msg of msgs) {
    try {
      const meta = JSON.parse(msg.metadata!);
      const cfg = meta.channel_config;
      if (!cfg?.name) continue;
      result[cfg.name] = {
        name: cfg.name,
        description: cfg.description || "",
        status: cfg.status || "active",
      };
    } catch {}
  }

  // Fill in channels that exist in the DB but have no channel_config message
  const channels = db.prepare("SELECT name FROM channels WHERE name != '_system' ORDER BY name").all() as { name: string }[];
  for (const ch of channels) {
    if (!result[ch.name]) {
      result[ch.name] = { name: ch.name, description: "", status: "active" };
    }
  }

  return result;
}

// --- Migration ---

function runMigrations(db: Database, chatDir: string): void {
  const configPath = join(chatDir, "config.json");
  let identity = "system";
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    identity = config.identity || "system";
  } catch {}

  db.transaction(() => {
    // 1. Migrate legacy config.json agents field
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.agents && Array.isArray(config.agents) && config.agents.length > 0) {
        for (const a of config.agents) {
          insertMessage(db, {
            id: generateId(),
            channel: "_system",
            author: identity,
            content: `Register agent: ${a.name}`,
            metadata: JSON.stringify({ agent_config: { name: a.name, role: a.role || "", description: "", channels: a.channels || [] } }),
          });
        }
        delete config.agents;
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      }
    } catch {}

    // 2. Migrate agents.json
    const agentsPath = join(chatDir, "agents.json");
    const agentsBakPath = join(chatDir, "agents.json.bak");
    if (existsSync(agentsPath) && !existsSync(agentsBakPath)) {
      try {
        const agents = JSON.parse(readFileSync(agentsPath, "utf-8"));
        for (const [name, a] of Object.entries(agents) as [string, any][]) {
          insertMessage(db, {
            id: generateId(),
            channel: "_system",
            author: identity,
            content: `Register agent: ${name}`,
            metadata: JSON.stringify({ agent_config: { name, role: a.role || "", description: a.description || "", channels: a.channels || [] } }),
          });
        }
        renameSync(agentsPath, agentsBakPath);
      } catch {}
    }

    // 3. Migrate channels.json
    const channelsPath = join(chatDir, "channels.json");
    const channelsBakPath = join(chatDir, "channels.json.bak");
    if (existsSync(channelsPath) && !existsSync(channelsBakPath)) {
      try {
        const channels = JSON.parse(readFileSync(channelsPath, "utf-8"));
        for (const [name, c] of Object.entries(channels) as [string, any][]) {
          insertMessage(db, {
            id: generateId(),
            channel: "_system",
            author: identity,
            content: `Configure channel: ${name}`,
            metadata: JSON.stringify({ channel_config: { name, description: c.description || "", status: c.status || "active" } }),
          });
        }
        renameSync(channelsPath, channelsBakPath);
      } catch {}
    }

    // 4. Move _memory/_summary messages to _system
    db.run("UPDATE messages SET channel = '_system' WHERE channel IN ('_memory', '_summary')");

    // 5. Remove _memory/_summary channels
    db.run("DELETE FROM channels WHERE name IN ('_memory', '_summary')");

    // 6. Drop description column from channels (SQLite doesn't support ALTER TABLE DROP COLUMN in older versions)
    const cols = db.prepare("PRAGMA table_info(channels)").all() as { name: string }[];
    const hasDescription = cols.some(c => c.name === "description");
    if (hasDescription) {
      db.run("CREATE TABLE IF NOT EXISTS channels_new (name TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
      db.run("INSERT OR IGNORE INTO channels_new (name, created_at) SELECT name, created_at FROM channels");
      db.run("DROP TABLE channels");
      db.run("ALTER TABLE channels_new RENAME TO channels");
    }
  })();
}

