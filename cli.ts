#!/usr/bin/env bun
import { resolve, join, basename } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { findChatDir, requireChatDir, readConfig, writeConfig, type ChatConfig } from "./src/config";
import { openDb, createChannel, getChannels, queryMessages, getThread, getUnreadMessages, idToTime, getTasks, getMessage } from "./src/db";
import { sync, sendToUpstream } from "./src/sync";
import { readReadCursor, writeReadCursor } from "./src/config";
import { startServer, startTunnel, startNamedTunnel, isCloudflaredLoggedIn, startStandbyMode, syncFromBackups } from "./src/server";

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

// Strip null/undefined fields from objects for cleaner JSON output
function stripNulls<T extends Record<string, any>>(obj: T): Partial<T> {
  const result: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null) result[k] = v;
  }
  return result;
}

// --- Commands ---

async function cmdInit(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const name = positional[0] || basename(process.cwd());
  const identity = (flags.identity as string) || userInfo().username;

  const chatDir = join(process.cwd(), ".chat");
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

  // Create CHAT.md in project root
  const chatMdPath = join(process.cwd(), "CHAT.md");
  if (!existsSync(chatMdPath)) {
    writeFileSync(chatMdPath, `# ${name}\n\nThis project uses [agents-chat](https://github.com/kensaku63/agents-chat) for team communication.\n\n## Getting Started\n\n- \`chat context\` — Read this file\n- \`chat agent list\` — See registered agents\n- \`chat unread\` — Check unread messages\n- \`chat send <channel> <message>\` — Send a message\n`);
  }

  console.log(`Chat initialized: ${name}`);
  console.log(`  Directory: ${chatDir}`);
  console.log(`  CHAT.md:   ${chatMdPath}`);
  console.log(`  Identity:  ${identity}`);
  console.log(`  Role:      owner`);
  console.log("");
  console.log("Next steps:");
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

  const chatDir = join(process.cwd(), ".chat");

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

  // メンバーとしてサーバーに登録
  await fetch(`${upstream}/api/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: identity }),
  }).catch(() => {});

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
  const { flags } = parseArgs(args);
  const port = parseInt(flags.port as string) || config.port || 4321;

  // スタンバイモードはメンバー（upstream あり）が使う
  if (flags.standby) {
    if (!config.upstream) {
      console.error("Error: --standby is for members only (upstream required).");
      process.exit(1);
    }
    await startStandbyMode(chatDir, port);
    return;
  }

  // 通常の serve は owner のみ
  if (config.upstream) {
    console.error("Error: 'serve' is for owners only. Use --standby for backup mode.");
    process.exit(1);
  }

  // Kill existing server on the same port if running
  try {
    const res = await fetch(`http://localhost:${port}/api/info`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      console.log(`Stopping existing server on port ${port}...`);
      const proc = Bun.spawn(["fuser", "-k", `${port}/tcp`], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      await Bun.sleep(500);
    }
  } catch {
    // No existing server, continue
  }

  // Owner: バックアップから差分マージ後にサーバー起動
  await syncFromBackups(chatDir);
  startServer(chatDir, port);

  const tunnelName = (flags["tunnel-name"] as string) || config.tunnel_name;
  const tunnelHostname = (flags["tunnel-hostname"] as string) || config.tunnel_hostname;

  if (flags["no-tunnel"]) {
    // No tunnel
  } else if (tunnelName && tunnelHostname) {
    // Named tunnel (fixed URL)
    if (!isCloudflaredLoggedIn()) {
      console.log("\nCloudflare にログインが必要です。ブラウザが開きます...");
      const loginProc = Bun.spawn(["cloudflared", "tunnel", "login"], {
        stdout: "inherit", stderr: "inherit",
      });
      await loginProc.exited;
      if (!isCloudflaredLoggedIn()) {
        console.error("Error: Cloudflare ログインに失敗しました。");
        process.exit(1);
      }
    }
    console.log("\nStarting named tunnel...");
    const tunnelUrl = await startNamedTunnel(port, tunnelName, tunnelHostname);
    // Save to config for next time
    if (!config.tunnel_name || !config.tunnel_hostname) {
      config.tunnel_name = tunnelName;
      config.tunnel_hostname = tunnelHostname;
      writeConfig(chatDir, config);
    }
    console.log(`\n  Public (fixed): ${tunnelUrl}`);
    console.log(`\n  Share with team:`);
    console.log(`    chat join ${tunnelUrl}`);
  } else if (tunnelName && !tunnelHostname) {
    console.error("Error: --tunnel-hostname <hostname> も指定してください。");
    console.error("  例: chat serve --tunnel-name myapp --tunnel-hostname chat.example.com");
    process.exit(1);
  } else {
    // Quick tunnel (random URL)
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
    console.error("Usage: chat send <channel> <message> [--agent] [--agent-name <name>]");
    process.exit(1);
  }

  const chatDir = requireChatDir();
  const config = readConfig(chatDir);
  let author: string;
  if (flags["agent-name"]) {
    author = `agent:${flags["agent-name"]}@${config.identity}`;
  } else if (flags.agent) {
    author = `agent@${config.identity}`;
  } else {
    author = config.identity;
  }

  await sendToUpstream(chatDir, channel, author, content, flags["reply-to"] as string);
  console.log("ok");
}

async function cmdRead(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const channel = positional[0];

  if (!channel) {
    console.error("Usage: chat read <channel> [--last N] [--since T] [--search Q] [--text]");
    process.exit(1);
  }

  const chatDir = requireChatDir();
  const config = readConfig(chatDir);

  // Sync only when explicitly requested
  if (flags.sync && config.upstream) {
    await sync(chatDir);
  }

  const db = openDb(chatDir);
  const opts: { last?: number; since?: string; search?: string; mention?: string } = {};

  if (flags.last) opts.last = parseInt(flags.last as string);
  if (flags.since) opts.since = parseSince(flags.since as string);
  if (flags.search) opts.search = flags.search as string;
  if (flags.mention) opts.mention = flags.mention as string;

  // Default to last 50 if no filters
  if (!opts.last && !opts.since && !opts.search && !opts.mention) {
    opts.last = 50;
  }

  const msgs = queryMessages(db, channel, opts);
  db.close();

  if (msgs.length === 0) {
    if (flags.text) {
      console.log(`No messages in #${channel}`);
    } else {
      console.log("[]");
    }
    return;
  }

  if (flags.text) {
    console.log(`#${channel}`);
    for (const msg of msgs) {
      const time = formatTime(msg.id);
      const replyTag = msg.reply_to ? ` [reply:${msg.reply_to.slice(-6)}]` : "";
      console.log(`[${time}] ${msg.author}${replyTag}: ${msg.content}`);
    }
    return;
  }

  console.log(JSON.stringify(msgs.map(stripNulls), null, 2));
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

  if (flags.text) {
    if (channels.length === 0) {
      console.log("No channels.");
      return;
    }
    for (const ch of channels) {
      const desc = ch.description ? ` - ${ch.description}` : "";
      console.log(`  #${ch.name}${desc}`);
    }
    return;
  }

  console.log(JSON.stringify(channels, null, 2));
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

async function cmdUnread(args: string[]) {
  const { flags } = parseArgs(args);
  const chatDir = requireChatDir();
  const config = readConfig(chatDir);

  // Sync if member
  if (config.upstream) {
    await sync(chatDir);
  }

  const cursor = readReadCursor(chatDir);
  const db = openDb(chatDir);
  const msgs = getUnreadMessages(db, cursor);
  db.close();

  if (msgs.length === 0) {
    if (flags.text) {
      console.log("No unread messages.");
    } else {
      console.log(JSON.stringify({ unread: 0, messages: [] }));
    }
    return;
  }

  // Update read cursor to latest message
  const newCursor = msgs[msgs.length - 1]!.id;
  if (!flags["peek"]) {
    writeReadCursor(chatDir, newCursor);
  }

  if (flags.text) {
    // Group by channel
    const grouped = new Map<string, typeof msgs>();
    for (const msg of msgs) {
      if (!grouped.has(msg.channel)) grouped.set(msg.channel, []);
      grouped.get(msg.channel)!.push(msg);
    }

    console.log(`${msgs.length} unread messages:`);
    for (const [channel, channelMsgs] of grouped) {
      console.log(`\n#${channel} (${channelMsgs.length})`);
      for (const msg of channelMsgs) {
        const time = formatTime(msg.id);
        const replyTag = msg.reply_to ? ` [reply:${msg.reply_to.slice(-6)}]` : "";
        console.log(`  [${time}] ${msg.author}${replyTag}: ${msg.content}`);
      }
    }
    return;
  }

  console.log(JSON.stringify({ unread: msgs.length, messages: msgs.map(stripNulls) }, null, 2));
}

async function cmdThread(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const messageId = positional[0];

  if (!messageId) {
    console.error("Usage: chat thread <message-id> [--text]");
    process.exit(1);
  }

  const chatDir = requireChatDir();
  const db = openDb(chatDir);
  const { root, replies } = getThread(db, messageId);
  db.close();

  if (!root) {
    console.error(`Message not found: ${messageId}`);
    process.exit(1);
  }

  if (flags.text) {
    const time = formatTime(root.id);
    console.log(`Thread: ${root.id}`);
    console.log(`[${time}] ${root.author}: ${root.content}`);

    if (replies.length === 0) {
      console.log("\n  No replies.");
    } else {
      console.log(`\n  ${replies.length} replies:`);
      for (const reply of replies) {
        const rt = formatTime(reply.id);
        console.log(`  [${rt}] ${reply.author}: ${reply.content}`);
      }
    }
    return;
  }

  console.log(JSON.stringify({ root: stripNulls(root), replies: replies.map(stripNulls) }, null, 2));
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

async function cmdTask(args: string[]) {
  const sub = args[0];
  const subArgs = args.slice(1);

  if (sub === "create") {
    const { positional, flags } = parseArgs(subArgs);
    const name = positional.join(" ");
    if (!name) {
      console.error("Usage: chat task create <name> --assign <user> [--detail \"...\"] [--channel <ch>]");
      process.exit(1);
    }

    const chatDir = requireChatDir();
    const config = readConfig(chatDir);
    const assignee = (flags.assign as string) || "";
    const detail = (flags.detail as string) || "";
    const channel = (flags.channel as string) || "general";

    let author: string;
    if (flags["agent-name"]) {
      author = `agent:${flags["agent-name"]}@${config.identity}`;
    } else if (flags.agent) {
      author = `agent@${config.identity}`;
    } else {
      author = config.identity;
    }

    const metadata = JSON.stringify({ task: { name, assignee, detail, status: "pending" } });
    const assignText = assignee ? ` → @${assignee}` : "";
    const content = `[Task] ${name}${assignText}`;

    await sendToUpstream(chatDir, channel, author, content, undefined, metadata);
    console.log("ok");

  } else if (sub === "list") {
    const { flags } = parseArgs(subArgs);
    const chatDir = requireChatDir();
    const config = readConfig(chatDir);

    if (config.upstream) await sync(chatDir);

    const db = openDb(chatDir);
    const tasks = getTasks(db, flags.status as string | undefined);
    db.close();

    if (flags.text) {
      if (tasks.length === 0) { console.log("No tasks."); return; }
      for (const t of tasks) {
        const mark = t.status === "done" ? "x" : t.status === "active" ? ">" : " ";
        const assignText = t.assignee ? ` → @${t.assignee}` : "";
        console.log(`  [${mark}] ${t.name}${assignText}  (${t.status}) id:${t.id}`);
      }
      return;
    }
    console.log(JSON.stringify(tasks, null, 2));

  } else if (sub === "update") {
    const { positional, flags } = parseArgs(subArgs);
    const taskId = positional[0];
    const status = flags.status as string;

    if (!taskId || !status) {
      console.error("Usage: chat task update <id> --status <pending|active|done>");
      process.exit(1);
    }
    if (!["pending", "active", "done"].includes(status)) {
      console.error("Error: status must be pending, active, or done");
      process.exit(1);
    }

    const chatDir = requireChatDir();
    const config = readConfig(chatDir);

    if (config.upstream) await sync(chatDir);

    const db = openDb(chatDir);
    const original = getMessage(db, taskId);
    db.close();

    if (!original) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
    }

    let author: string;
    if (flags["agent-name"]) {
      author = `agent:${flags["agent-name"]}@${config.identity}`;
    } else if (flags.agent) {
      author = `agent@${config.identity}`;
    } else {
      author = config.identity;
    }

    const meta = JSON.parse(original.metadata || "{}");
    const taskName = meta.task?.name || "Unknown";
    const metadata = JSON.stringify({ task_update: { status } });
    const content = `[Task] ${taskName} → ${status}`;

    await sendToUpstream(chatDir, original.channel, author, content, taskId, metadata);
    console.log("ok");

  } else {
    console.error("Usage: chat task <create|list|update>");
    process.exit(1);
  }
}

async function cmdAgent(args: string[]) {
  const sub = args[0];
  const subArgs = args.slice(1);

  if (sub === "create") {
    const { positional, flags } = parseArgs(subArgs);
    const name = positional.join(" ");
    if (!name) {
      console.error("Usage: chat agent create <name> --role <role> [--channels ch1,ch2]");
      process.exit(1);
    }

    const chatDir = requireChatDir();
    const config = readConfig(chatDir);
    const role = (flags.role as string) || "";
    const channels = flags.channels ? (flags.channels as string).split(",") : [];

    if (!config.agents) config.agents = [];
    const existing = config.agents.findIndex(a => a.name === name);
    if (existing >= 0) {
      config.agents[existing] = { name, role, channels };
    } else {
      config.agents.push({ name, role, channels });
    }
    writeConfig(chatDir, config);
    console.log(`Agent registered: ${name} (${role || "no role"})`);

  } else if (sub === "list") {
    const { flags } = parseArgs(subArgs);
    const chatDir = requireChatDir();
    const config = readConfig(chatDir);
    const agents = config.agents || [];

    if (flags.text) {
      if (agents.length === 0) { console.log("No agents registered."); return; }
      for (const a of agents) {
        const ch = a.channels.length > 0 ? ` [${a.channels.join(", ")}]` : "";
        console.log(`  ${a.name} — ${a.role || "(no role)"}${ch}`);
      }
      return;
    }
    console.log(JSON.stringify(agents, null, 2));

  } else if (sub === "remove") {
    const { positional } = parseArgs(subArgs);
    const name = positional.join(" ");
    if (!name) { console.error("Usage: chat agent remove <name>"); process.exit(1); }

    const chatDir = requireChatDir();
    const config = readConfig(chatDir);
    config.agents = (config.agents || []).filter(a => a.name !== name);
    writeConfig(chatDir, config);
    console.log(`Agent removed: ${name}`);

  } else {
    console.error("Usage: chat agent <create|list|remove>");
    process.exit(1);
  }
}

function cmdContext() {
  const chatDir = requireChatDir();
  const rootDir = resolve(chatDir, "..");
  const chatMdPath = join(rootDir, "CHAT.md");

  if (!existsSync(chatMdPath)) {
    console.error("CHAT.md not found. Create it in your project root.");
    process.exit(1);
  }

  const content = readFileSync(chatMdPath, "utf-8");
  console.log(content);
}

// --- Help ---

function showHelp() {
  console.log(`agents-chat - P2P chat for humans and AI agents

Usage: chat <command> [args]

Commands:
  init [name]                     Create a new chat (you become the owner)
  join <url>                      Join an existing chat
  serve [--port N]                Start server with public URL (owner only)
    --no-tunnel                   Skip tunnel (local only)
    --tunnel-name <name>          Use a named tunnel for fixed URL (requires Cloudflare login)
    --tunnel-hostname <host>      Hostname for named tunnel (e.g. chat.example.com)
    --standby                     Monitor primary; auto-takeover if it goes down
  sync                            Pull latest from upstream

  send <channel> <message>        Send a message
    --agent                       Send as AI agent
    --agent-name <name>           Send as named agent (e.g. --agent-name Opus)
    --reply-to <id>               Reply to a message
  read <channel>                  Read messages (default: JSON output)
    --last N                      Last N messages (default: 50)
    --since <time>                Since time (e.g. 1h, 30m, 2d, or ISO)
    --search <query>              Search messages
    --mention <name>              Filter messages mentioning @name
    --sync                        Sync from upstream before reading
    --text                        Output as human-readable text

  unread [--peek]                  Show unread messages (default: JSON output)
    --peek                        Don't mark messages as read
    --text                        Output as human-readable text

  thread <message-id>              View a message thread (default: JSON output)
    --text                        Output as human-readable text

  channels [--sync]                List channels (default: JSON output)
    --text                        Output as human-readable text
  channel:create <name> [desc]    Create a channel

  task create <name>              Create a task
    --assign <user>               Assign to a user
    --detail "..."                Task details
    --channel <ch>                Channel (default: general)
  task list [--status S]          List tasks (S: pending|active|done)
    --text                        Output as human-readable text
  task update <id> --status S     Update task status

  agent create <name>             Register an agent
    --role <role>                 Agent role (e.g. builder, reviewer)
    --channels ch1,ch2            Assigned channels
  agent list                      List registered agents
  agent remove <name>             Remove an agent

  context                         Show CHAT.md (project context for agents)

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
  case "thread":         await cmdThread(args); break;
  case "unread":         await cmdUnread(args); break;
  case "task":           await cmdTask(args); break;
  case "agent":          await cmdAgent(args); break;
  case "context":        cmdContext(); break;
  case "status":         await cmdStatus(); break;
  case "help": case "--help": case "-h": case undefined:
    showHelp(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    showHelp();
    process.exit(1);
}
