import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface ChatConfig {
  role: "owner" | "member";
  name: string;
  identity: string;
  port?: number;
  upstream?: string;
  backup_owners?: string[];  // バックアップOwnerのサーバーURLリスト（順番に試す）
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
