import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface AgentInfo {
  name: string;
  role: string;
  channels: string[];
}

// --- channels.json / agents.json types ---

export interface ChannelMeta {
  description: string;
  status: "active" | "paused" | "archived";
}

export interface AgentConfig {
  role: string;
  description: string;
  channels: string[];
}

export type ChannelsConfig = Record<string, ChannelMeta>;
export type AgentsConfig = Record<string, AgentConfig>;

export interface ChatConfig {
  role: "owner" | "member";
  name: string;
  identity: string;
  port?: number;
  upstream?: string;
  backup_owners?: string[];  // バックアップOwnerのサーバーURLリスト（順番に試す）
  tunnel_name?: string;      // Named tunnel名（固定URL用）
  tunnel_hostname?: string;  // 固定トンネルのホスト名（例: myapp.example.com）
  agents?: AgentInfo[];
  public_read?: boolean;     // 読み取り専用モード（公開デモ用）
  created_at: string;
}

export function findChatDir(from?: string): string | null {
  let dir = resolve(from || process.cwd());
  while (true) {
    const chatDir = join(dir, ".chat");
    if (existsSync(chatDir)) return chatDir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireChatDir(): string {
  const chatDir = findChatDir();
  if (!chatDir) {
    console.error("Error: .chat not found. Run 'chat init' first.");
    process.exit(1);
  }
  return chatDir;
}

export function readConfig(chatDir: string): ChatConfig {
  return JSON.parse(readFileSync(join(chatDir, "config.json"), "utf-8"));
}

export function writeConfig(chatDir: string, config: ChatConfig): void {
  writeFileSync(join(chatDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

export function readSyncCursor(chatDir: string): string {
  const p = join(chatDir, ".sync");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8").trim();
}

export function writeSyncCursor(chatDir: string, cursor: string): void {
  writeFileSync(join(chatDir, ".sync"), cursor);
}

export function readReadCursor(chatDir: string): string {
  const p = join(chatDir, ".read_cursor");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8").trim();
}

export function writeReadCursor(chatDir: string, cursor: string): void {
  writeFileSync(join(chatDir, ".read_cursor"), cursor);
}

// --- channels.json ---

export function readChannelsMeta(chatDir: string): ChannelsConfig {
  const p = join(chatDir, "channels.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

export function writeChannelsMeta(chatDir: string, config: ChannelsConfig): void {
  writeFileSync(join(chatDir, "channels.json"), JSON.stringify(config, null, 2) + "\n");
}

// --- agents.json ---

export function readAgentsConfig(chatDir: string): AgentsConfig {
  const p = join(chatDir, "agents.json");
  // Migrate from config.json if agents.json doesn't exist
  if (!existsSync(p)) {
    const config = readConfig(chatDir);
    if (config.agents && config.agents.length > 0) {
      const agents: AgentsConfig = {};
      for (const a of config.agents) {
        agents[a.name] = { role: a.role, description: "", channels: a.channels };
      }
      writeAgentsConfig(chatDir, agents);
      // Remove agents from config.json
      delete config.agents;
      writeConfig(chatDir, config);
      return agents;
    }
    return {};
  }
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

export function writeAgentsConfig(chatDir: string, config: AgentsConfig): void {
  writeFileSync(join(chatDir, "agents.json"), JSON.stringify(config, null, 2) + "\n");
}
