#!/usr/bin/env bun
import { resolve, join, basename } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { findChatDir, requireChatDir, readConfig, writeConfig, type ChatConfig } from "./src/config";
import { openDb, createChannel, getChannels, queryMessages, getThread, getUnreadMessages, idToTime, getTasks, getMessage, getMemories, getSummaries } from "./src/db";
import { sync, sendToUpstream, getUpstreamUrls } from "./src/sync";
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
  const forName = flags.for as string | undefined;
  const msgs = getUnreadMessages(db, cursor, forName);

  // Update read cursor to latest unfiltered message (skip when --peek or --for)
  if (!flags["peek"] && !forName && msgs.length > 0) {
    writeReadCursor(chatDir, msgs[msgs.length - 1]!.id);
  } else if (!flags["peek"] && forName) {
    // When using --for, still advance cursor based on all unread
    const allMsgs = getUnreadMessages(db, cursor);
    if (allMsgs.length > 0) writeReadCursor(chatDir, allMsgs[allMsgs.length - 1]!.id);
  }
  db.close();

  if (msgs.length === 0) {
    if (flags.text) {
      console.log("No unread messages.");
    } else {
      console.log(JSON.stringify({ unread: 0, messages: [] }));
    }
    return;
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

    const meta = JSON.parse(original.metadata || "{}");
    if (!meta.task) {
      console.error(`Error: ${taskId} is not a task`);
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

    const taskName = meta.task.name;
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

    let agents = config.agents || [];
    const agentUrls = getUpstreamUrls(config);
    for (const url of agentUrls) {
      try {
        const res = await fetch(`${url}/api/agents`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) { agents = ((await res.json()) as any).agents || []; break; }
      } catch { continue; }
    }

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

async function cmdContext(args: string[]) {
  const { flags } = parseArgs(args);
  const chatDir = requireChatDir();
  const config = readConfig(chatDir);
  const agentName = flags.agent as string | undefined;

  // L1: CHAT.md
  let chatMdContent = "";
  const contextUrls = getUpstreamUrls(config);
  if (contextUrls.length > 0) {
    for (const url of contextUrls) {
      try {
        const res = await fetch(`${url}/api/context`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = (await res.json()) as { content: string | null };
          if (data.content) { chatMdContent = data.content; break; }
        }
      } catch { continue; }
    }
  } else {
    const chatMdPath = join(resolve(chatDir, ".."), "CHAT.md");
    if (existsSync(chatMdPath)) {
      chatMdContent = readFileSync(chatMdPath, "utf-8");
    }
  }

  if (!agentName) {
    // Original behavior: just print CHAT.md
    if (!chatMdContent) {
      console.error("CHAT.md not found. Create it in your project root.");
      process.exit(1);
    }
    console.log(chatMdContent);
    return;
  }

  // Enhanced context for specific agent
  const output: string[] = [];

  // L1: CHAT.md
  if (chatMdContent) {
    output.push("## Project Context (CHAT.md)\n");
    output.push(chatMdContent);
  }

  // L1: Agent registration info
  let agents = config.agents || [];
  for (const url of contextUrls) {
    try {
      const res = await fetch(`${url}/api/agents`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) { agents = ((await res.json()) as any).agents || []; break; }
    } catch { continue; }
  }
  const agentInfo = agents.find(a => a.name === agentName);
  if (!agentInfo) {
    console.error(`Warning: Agent "${agentName}" is not registered. Use 'chat agent create ${agentName}' to register.`);
  } else {
    output.push("\n---\n## Agent Identity\n");
    output.push(`- Name: ${agentInfo.name}`);
    output.push(`- Role: ${agentInfo.role}`);
    output.push(`- Channels: ${agentInfo.channels.join(", ")}`);
  }

  // L3: Agent memories
  if (config.upstream) {
    try { await sync(chatDir); } catch {}
  }
  const db = openDb(chatDir);
  const memories = getMemories(db, { agent: agentName, last: 20 });
  if (memories.length > 0) {
    output.push("\n---\n## Agent Memory\n");
    for (const mem of memories) {
      const tags = mem.tags.length > 0 ? ` [${mem.tags.join(", ")}]` : "";
      output.push(`- ${mem.content}${tags}`);
    }
  }

  // L4: Channel summaries for assigned channels (only if agent is registered)
  const assignedChannels = agentInfo?.channels || [];
  const allSummaries = assignedChannels.length > 0 ? getSummaries(db) : [];
  const channelSummaries = new Map<string, typeof allSummaries[0]>();
  for (const s of allSummaries) {
    if (assignedChannels.includes(s.channel)) {
      channelSummaries.set(s.channel, s); // keep latest per channel
    }
  }
  if (channelSummaries.size > 0) {
    output.push("\n---\n## Channel Summaries\n");
    for (const [ch, summary] of channelSummaries) {
      const period = summary.period ? ` (${summary.period})` : "";
      output.push(`### #${ch}${period}\n`);
      output.push(summary.content);
      output.push("");
    }
  }

  db.close();

  console.log(output.join("\n"));
}

async function cmdMemory(args: string[]) {
  const sub = args[0];
  const subArgs = args.slice(1);

  if (sub === "add") {
    const { positional, flags } = parseArgs(subArgs);
    const content = positional.join(" ");
    if (!content) {
      console.error("Usage: chat memory add <content> --agent-name <name> [--tag <tag>]");
      process.exit(1);
    }

    const chatDir = requireChatDir();
    const config = readConfig(chatDir);
    const agentName = flags["agent-name"] as string;
    if (!agentName) {
      console.error("Error: --agent-name is required for memory add");
      process.exit(1);
    }

    const author = `agent:${agentName}@${config.identity}`;
    const tags = flags.tag ? [(flags.tag as string)] : [];
    const metadata = JSON.stringify({ memory: { tags } });

    await sendToUpstream(chatDir, "_memory", author, content, undefined, metadata);
    console.log("ok");

  } else if (sub === "list") {
    const { flags } = parseArgs(subArgs);
    const chatDir = requireChatDir();
    const config = readConfig(chatDir);

    if (config.upstream) {
      try { await sync(chatDir); } catch {}
    }

    const db = openDb(chatDir);
    const memories = getMemories(db, {
      agent: flags.agent as string | undefined,
      tag: flags.tag as string | undefined,
      search: flags.search as string | undefined,
      last: flags.last ? parseInt(flags.last as string) : undefined,
    });
    db.close();

    if (flags.text) {
      if (memories.length === 0) { console.log("No memories."); return; }
      for (const mem of memories) {
        const tags = mem.tags.length > 0 ? ` [${mem.tags.join(", ")}]` : "";
        const time = formatTime(mem.id);
        console.log(`  [${time}] ${mem.agent}: ${mem.content}${tags}  id:${mem.id}`);
      }
      return;
    }
    console.log(JSON.stringify(memories, null, 2));

  } else {
    console.error("Usage: chat memory <add|list>");
    process.exit(1);
  }
}

async function cmdSummary(args: string[]) {
  const sub = args[0];
  const subArgs = args.slice(1);

  if (sub === "create") {
    const { positional, flags } = parseArgs(subArgs);
    const channel = positional[0];
    const content = positional.slice(1).join(" ");
    if (!channel || !content) {
      console.error("Usage: chat summary create <channel> <content> --agent-name <name> [--since <period>] [--count <N>]");
      process.exit(1);
    }

    const chatDir = requireChatDir();
    const config = readConfig(chatDir);
    const agentName = flags["agent-name"] as string;
    if (!agentName) {
      console.error("Error: --agent-name is required for summary create");
      process.exit(1);
    }

    const author = `agent:${agentName}@${config.identity}`;
    const period = (flags.since as string) || "";
    const messageCount = flags.count ? parseInt(flags.count as string) : 0;
    const metadata = JSON.stringify({ summary: { channel, period, message_count: messageCount } });

    await sendToUpstream(chatDir, "_summary", author, content, undefined, metadata);
    console.log("ok");

  } else if (sub === "list") {
    const { positional, flags } = parseArgs(subArgs);
    const channel = positional[0];
    const chatDir = requireChatDir();
    const config = readConfig(chatDir);

    if (config.upstream) {
      try { await sync(chatDir); } catch {}
    }

    const db = openDb(chatDir);
    const summaries = getSummaries(db, channel, flags.last ? parseInt(flags.last as string) : undefined);
    db.close();

    if (flags.text) {
      if (summaries.length === 0) { console.log("No summaries."); return; }
      for (const s of summaries) {
        const time = formatTime(s.id);
        const period = s.period ? ` (${s.period})` : "";
        console.log(`  [${time}] #${s.channel}${period} by ${s.agent}:`);
        console.log(`    ${s.content.split("\n").join("\n    ")}`);
      }
      return;
    }
    console.log(JSON.stringify(summaries, null, 2));

  } else if (sub === "latest") {
    const { positional, flags } = parseArgs(subArgs);
    const channel = positional[0];
    if (!channel) {
      console.error("Usage: chat summary latest <channel>");
      process.exit(1);
    }

    const chatDir = requireChatDir();
    const config = readConfig(chatDir);

    if (config.upstream) {
      try { await sync(chatDir); } catch {}
    }

    const db = openDb(chatDir);
    const summaries = getSummaries(db, channel, 1);
    db.close();

    if (summaries.length === 0) {
      if (flags.text) { console.log(`No summaries for #${channel}.`); }
      else { console.log("null"); }
      return;
    }

    const s = summaries[0];
    if (flags.text) {
      const time = formatTime(s.id);
      const period = s.period ? ` (${s.period})` : "";
      console.log(`#${s.channel}${period} [${time}] by ${s.agent}:`);
      console.log(s.content);
      return;
    }
    console.log(JSON.stringify(s, null, 2));

  } else {
    console.error("Usage: chat summary <create|list|latest>");
    process.exit(1);
  }
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

  unread [--peek] [--for <name>]   Show unread messages (default: JSON output)
    --peek                        Don't mark messages as read
    --for <name>                  Show only messages mentioning @name
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
    --agent <name>                Enhanced context: CHAT.md + agent info + memories + summaries

  memory add <content>            Save an agent memory
    --agent-name <name>           Agent name (required)
    --tag <tag>                   Tag for categorization (decision, context, pattern, etc.)
  memory list                     List agent memories
    --agent <name>                Filter by agent
    --tag <tag>                   Filter by tag
    --search <query>              Search memory content
    --last N                      Last N memories
    --text                        Output as human-readable text

  summary create <ch> <content>   Save a channel summary
    --agent-name <name>           Agent name (required)
    --since <period>              Period covered (e.g. 24h, 7d)
    --count <N>                   Number of messages summarized
  summary list [channel]          List summaries
    --last N                      Last N summaries
    --text                        Output as human-readable text
  summary latest <channel>        Show latest summary for a channel

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
  case "context":        await cmdContext(args); break;
  case "memory":         await cmdMemory(args); break;
  case "summary":        await cmdSummary(args); break;
  case "status":         await cmdStatus(); break;
  case "help": case "--help": case "-h": case undefined:
    showHelp(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    showHelp();
    process.exit(1);
}
