#!/usr/bin/env bun
import { resolve, join, basename } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { userInfo } from "node:os";
import { findChatDir, requireChatDir, readConfig, writeConfig, type ChatConfig } from "./src/config";
import { openDb, createChannel, getChannels, queryMessages, idToTime } from "./src/db";
import { sync, sendToUpstream, connectRealtime } from "./src/sync";
import { startServer, startTunnel, startStandbyMode, syncFromBackups } from "./src/server";

// --- Arg parsing ---

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function parseSince(since: string): string {
  const match = since.match(/^(\d+)([mhd])$/);
  if (match) {
    const num = match[1]!;
    const unit = match[2]!;
    const ms: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    return (Date.now() - parseInt(num) * ms[unit]!).toString(36);
  }
  // ISO timestamp → base36 for ID comparison
  const parsed = Date.parse(since);
  if (!isNaN(parsed)) return parsed.toString(36);
  return since;
}

function formatTime(id: string): string {
  const d = new Date(idToTime(id));
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

// --- Commands ---

async function cmdInit(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const name = positional[0] || basename(process.cwd());
  const identity = (flags.identity as string) || userInfo().username;
  const targetDir = positional[0] ? resolve(positional[0]) : process.cwd();

  const chatDir = join(targetDir, ".chat");
  if (existsSync(chatDir)) {
    console.error(`Error: ${chatDir} already exists.`);
    process.exit(1);
  }

  const config: ChatConfig = {
    role: "owner",
    name,
    identity,
    port: 4321,
    created_at: new Date().toISOString(),
  };
  mkdirSync(chatDir, { recursive: true });
  writeConfig(chatDir, config);

  const db = openDb(chatDir);
  createChannel(db, "general", "General discussion");
  db.close();

  console.log(`Chat initialized: ${name}`);
  console.log(`  Directory: ${chatDir}`);
  console.log(`  Identity:  ${identity}`);
  console.log(`  Role:      owner`);
  console.log("");
  console.log("Next steps:");
  if (targetDir !== process.cwd()) {
    console.log(`  cd ${positional[0]}`);
  }
  console.log("  chat serve          # Start sharing");
  console.log("  chat send general 'Hello!'");
}

async function cmdJoin(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const upstream = positional[0];
  if (!upstream) {
    console.error("Usage: chat join <url>");
    process.exit(1);
  }

  const identity = (flags.identity as string) || userInfo().username;

  // Fetch server info
  const infoRes = await fetch(`${upstream}/api/info`);
  if (!infoRes.ok) {
    console.error(`Error: Cannot connect to ${upstream}`);
    process.exit(1);
  }
  const info = await infoRes.json() as { name: string; owner: string; backup_owners?: string[] };

  const targetDir = resolve(flags.dir as string || info.name);
  const chatDir = join(targetDir, ".chat");

  if (existsSync(chatDir)) {
    console.error(`Error: ${chatDir} already exists.`);
    process.exit(1);
  }

  mkdirSync(chatDir, { recursive: true });

  const config: ChatConfig = {
    role: "member",
    name: info.name,
    identity,
    upstream,
    ...(info.backup_owners && info.backup_owners.length > 0 ? { backup_owners: info.backup_owners } : {}),
    created_at: new Date().toISOString(),
  };
  writeConfig(chatDir, config);

  // Initial sync
  const result = await sync(chatDir);

  console.log(`Joined: ${info.name} (owner: ${info.owner})`);
  console.log(`  Directory: ${chatDir}`);
  console.log(`  Identity:  ${identity}`);
  console.log(`  Upstream:  ${upstream}`);
  console.log(`  Synced:    ${result.newMessages} messages, ${result.newChannels} channels`);
}

async function cmdServe(args: string[]) {
  const chatDir = requireChatDir();
  const config = readConfig(chatDir);

  if (config.upstream) {
    console.error("Error: 'serve' is for owners only. Use 'chat watch' for real-time messages.");
    process.exit(1);
  }

  const { flags } = parseArgs(args);
  const port = parseInt(flags.port as string) || config.port || 4321;

  if (flags.standby) {
    // スタンバイモード: Primaryを監視し、落ちたら自動でサーバーを引き継ぐ
    await startStandbyMode(chatDir, port);
  } else {
    // Owner: バックアップから差分マージ後にサーバー起動
    await syncFromBackups(chatDir);
    startServer(chatDir, port);
  }

  if (flags.tunnel) {
    console.log("\nStarting tunnel...");
    const tunnelUrl = await startTunnel(port);
    console.log(`\n  Public: ${tunnelUrl}`);
    console.log(`\n  Share with team:`);
    console.log(`    chat join ${tunnelUrl}`);
  }
}

async function cmdSync() {
  const chatDir = requireChatDir();
  const config = readConfig(chatDir);

  if (!config.upstream) {
    console.log("Owner mode: no upstream to sync from.");
    return;
  }

  const result = await sync(chatDir);
  if (result.newMessages === 0 && result.newChannels === 0) {
    console.log("Already up to date.");
  } else {
    console.log(`Synced: +${result.newMessages} messages, +${result.newChannels} channels`);
  }
}

async function cmdSend(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const channel = positional[0];
  const content = positional.slice(1).join(" ");

  if (!channel || !content) {
    console.error("Usage: chat send <channel> <message> [--agent]");
    process.exit(1);
  }

  const chatDir = requireChatDir();
  const config = readConfig(chatDir);
  const author = flags.agent ? `agent@${config.identity}` : config.identity;

  await sendToUpstream(chatDir, channel, author, content, flags["reply-to"] as string);
  console.log("ok");
}

async function cmdRead(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const channel = positional[0];

  if (!channel) {
    console.error("Usage: chat read <channel> [--last N] [--since T] [--search Q] [--json]");
    process.exit(1);
  }

  const chatDir = requireChatDir();
  const config = readConfig(chatDir);

  // Sync only when explicitly requested
  if (flags.sync && config.upstream) {
    await sync(chatDir);
  }

  const db = openDb(chatDir);
  const opts: { last?: number; since?: string; search?: string } = {};

  if (flags.last) opts.last = parseInt(flags.last as string);
  if (flags.since) opts.since = parseSince(flags.since as string);
  if (flags.search) opts.search = flags.search as string;

  // Default to last 50 if no filters
  if (!opts.last && !opts.since && !opts.search) {
    opts.last = 50;
  }

  const msgs = queryMessages(db, channel, opts);
  db.close();

  if (msgs.length === 0) {
    console.log(`No messages in #${channel}`);
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify(msgs, null, 2));
    return;
  }

  console.log(`#${channel}`);
  for (const msg of msgs) {
    const time = formatTime(msg.id);
    const replyTag = msg.reply_to ? ` [reply:${msg.reply_to.slice(-6)}]` : "";
    console.log(`[${time}] ${msg.author}${replyTag}: ${msg.content}`);
  }
}

async function cmdChannels(args: string[]) {
  const chatDir = requireChatDir();
  const config = readConfig(chatDir);
  const { flags } = parseArgs(args);

  // Sync only when explicitly requested
  if (flags.sync && config.upstream) {
    await sync(chatDir);
  }
  const db = openDb(chatDir);
  const channels = getChannels(db);
  db.close();

  if (flags.json) {
    console.log(JSON.stringify(channels, null, 2));
    return;
  }

  if (channels.length === 0) {
    console.log("No channels.");
    return;
  }

  for (const ch of channels) {
    const desc = ch.description ? ` - ${ch.description}` : "";
    console.log(`  #${ch.name}${desc}`);
  }
}

async function cmdChannelCreate(args: string[]) {
  const { positional } = parseArgs(args);
  const name = positional[0];
  const description = positional.slice(1).join(" ") || "";

  if (!name) {
    console.error("Usage: chat channel:create <name> [description]");
    process.exit(1);
  }

  const chatDir = requireChatDir();
  const config = readConfig(chatDir);

  if (config.upstream) {
    // Member: create on upstream
    const res = await fetch(`${config.upstream}/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    if (!res.ok) throw new Error(`Failed to create channel: ${res.statusText}`);
    await sync(chatDir);
  } else {
    // Owner: create locally
    const db = openDb(chatDir);
    createChannel(db, name, description);
    db.close();
  }

  console.log(`Channel created: #${name}`);
}

async function cmdWatch(args: string[]) {
  const chatDir = requireChatDir();
  const config = readConfig(chatDir);
  const { positional } = parseArgs(args);
  const channelFilter = positional[0] || null;

  const port = config.port || 4321;
  const wsUrl = config.upstream
    ? config.upstream.replace(/^http/, "ws") + "/ws"
    : `ws://localhost:${port}/ws`;

  console.log(`Watching${channelFilter ? ` #${channelFilter}` : ""} (${config.name})`);
  console.log("Press Ctrl+C to stop.\n");

  let ws: WebSocket;
  let closed = false;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {};

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === "msg") {
          if (channelFilter && data.channel !== channelFilter) return;
          const time = formatTime(data.id);
          const replyTag = data.reply_to ? ` [reply:${data.reply_to.slice(-6)}]` : "";
          console.log(`[${time}] #${data.channel} ${data.author}${replyTag}: ${data.content}`);
        }
      } catch (e) {
        console.error("Watch message error:", e);
      }
    };

    ws.onclose = () => {
      if (!closed) {
        setTimeout(connect, 3000);
      }
    };

    ws.onerror = (e) => {
      console.error("Watch WebSocket error:", e);
    };
  }

  connect();

  await new Promise(() => {});
}

async function cmdStatus() {
  const chatDir = requireChatDir();
  const config = readConfig(chatDir);
  const db = openDb(chatDir);
  const channels = getChannels(db);
  const allMsgs = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
  db.close();

  console.log(`Chat: ${config.name}`);
  console.log(`  Role:      ${config.role}`);
  console.log(`  Identity:  ${config.identity}`);
  console.log(`  Directory: ${chatDir}`);
  if (config.upstream) {
    console.log(`  Upstream:  ${config.upstream}`);
  }
  console.log(`  Channels:  ${channels.length}`);
  console.log(`  Messages:  ${allMsgs.count}`);
}

// --- Help ---

function showHelp() {
  console.log(`agents-chat - P2P chat for humans and AI agents

Usage: chat <command> [args]

Commands:
  init [name]                     Create a new chat (you become the owner)
  join <url>                      Join an existing chat
  serve [--port N]                Start server (owner only)
    --standby                     Monitor primary; auto-takeover if it goes down
  sync                            Pull latest from upstream

  send <channel> <message>        Send a message
    --agent                       Send as AI agent
    --reply-to <id>               Reply to a message
  read <channel>                  Read messages (local DB)
    --last N                      Last N messages (default: 50)
    --since <time>                Since time (e.g. 1h, 30m, 2d, or ISO)
    --search <query>              Search messages
    --sync                        Sync from upstream before reading
    --json                        Output as JSON

  watch [channel]                  Watch messages in real-time

  channels [--sync]                List channels
  channel:create <name> [desc]    Create a channel
  status                          Show chat info

Options:
  --identity <name>               Set your identity (default: OS username)
`);
}

// --- Main ---

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "init":           await cmdInit(args); break;
  case "join":           await cmdJoin(args); break;
  case "serve":          await cmdServe(args); break;
  case "sync":           await cmdSync(); break;
  case "send":           await cmdSend(args); break;
  case "read":           await cmdRead(args); break;
  case "channels":       await cmdChannels(args); break;
  case "channel:create": await cmdChannelCreate(args); break;
  case "watch":          await cmdWatch(args); break;
  case "status":         await cmdStatus(); break;
  case "help": case "--help": case "-h": case undefined:
    showHelp(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    showHelp();
    process.exit(1);
}
