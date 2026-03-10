import { networkInterfaces } from "node:os";
import { openDb, getAllMessages, getMessagesSince, insertMessage, insertMessages, createChannel, ensureChannel, getChannels, generateId, ensureMember, getMembers, rebuildMembers, resolveThreadRoot, getThread, getTasks, getMemories, getSummaries, getAgentConfigs, getChannelConfigs, type Message } from "./db";
import { readConfig } from "./config";
import webHtml from "../web/index.html" with { type: "text" };

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

function getMergedChannels(db: import("bun:sqlite").Database) {
  const dbChannels = getChannels(db);
  const configs = getChannelConfigs(db);
  const counts = db.prepare("SELECT channel, COUNT(*) as count FROM messages GROUP BY channel").all() as { channel: string; count: number }[];
  const countMap: Record<string, number> = {};
  for (const row of counts) countMap[row.channel] = row.count;
  return dbChannels.map(ch => ({
    ...ch,
    description: configs[ch.name]?.description || "",
    status: configs[ch.name]?.status || "active",
    message_count: countMap[ch.name] || 0,
  }));
}

export function startServer(chatDir: string, port: number) {
  const db = openDb(chatDir);
  rebuildMembers(db);  // Clean up stale/duplicate member entries on startup
  const config = readConfig(chatDir);

  const server = Bun.serve({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Web UI
      if (path === "/" && req.method === "GET") {
        return new Response(String(webHtml), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // WebSocket upgrade
      if (path === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { headers });
      }

      // GET /api/info
      if (path === "/api/info" && req.method === "GET") {
        return Response.json({
          name: config.name,
          owner: config.identity,
          backup_owners: config.backup_owners ?? [],
          public_read: config.public_read ?? false,
        }, { headers });
      }

      // Block write APIs in public_read mode
      if (config.public_read && req.method === "POST") {
        return Response.json({ error: "Read-only mode" }, { status: 403, headers });
      }
      if (config.public_read && req.method === "DELETE") {
        return Response.json({ error: "Read-only mode" }, { status: 403, headers });
      }

      // GET /api/agents
      if (path === "/api/agents" && req.method === "GET") {
        return Response.json({ agents: getAgentConfigs(db) }, { headers });
      }

      // POST /api/agents
      if (path === "/api/agents" && req.method === "POST") {
        let body: { name: string; role?: string; prompt?: string; description?: string; channels?: string[]; icon?: string };
        try { body = await req.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
        if (!body.name) return Response.json({ error: "name is required" }, { status: 400, headers });
        const existing = getAgentConfigs(db)[body.name];
        const agentConfig = {
          name: body.name,
          role: body.role || existing?.role || "",
          prompt: body.prompt ?? existing?.prompt ?? "",
          description: body.description || existing?.description || "",
          channels: body.channels || existing?.channels || [],
          icon: body.icon ?? existing?.icon ?? "",
        };
        insertMessage(db, {
          id: generateId(),
          channel: "_system",
          author: config.identity,
          content: `Register agent: ${body.name}`,
          metadata: JSON.stringify({ agent_config: agentConfig }),
        });
        const agents = getAgentConfigs(db);
        server.publish("chat", JSON.stringify({ type: "agents", agents }));
        return Response.json({ ok: true }, { headers });
      }

      // DELETE /api/agents/:name
      if (path.startsWith("/api/agents/") && req.method === "DELETE") {
        const name = decodeURIComponent(path.slice("/api/agents/".length));
        insertMessage(db, {
          id: generateId(),
          channel: "_system",
          author: config.identity,
          content: `Remove agent: ${name}`,
          metadata: JSON.stringify({ agent_config: { name, removed: true } }),
        });
        const agents = getAgentConfigs(db);
        server.publish("chat", JSON.stringify({ type: "agents", agents }));
        return Response.json({ ok: true }, { headers });
      }

      // GET /api/context
      if (path === "/api/context" && req.method === "GET") {
        const { existsSync: ex, readFileSync: rf } = require("node:fs");
        const { resolve: rs } = require("node:path");
        const chatMdPath = rs(chatDir, "..", "CHAT.md");
        const content = ex(chatMdPath) ? rf(chatMdPath, "utf-8") : null;
        return Response.json({ content }, { headers });
      }

      // GET /api/members
      if (path === "/api/members" && req.method === "GET") {
        return Response.json({ members: getMembers(db) }, { headers });
      }

      // POST /api/members - name can be author string (e.g. "agent:Opus@kensaku") or plain name
      if (path === "/api/members" && req.method === "POST") {
        let body: { name: string; old_name?: string };
        try { body = await req.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
        if (!body.name) return Response.json({ error: "name is required" }, { status: 400, headers });
        if (body.old_name) {
          db.run("DELETE FROM members WHERE name = ?", [body.old_name]);
        }
        ensureMember(db, body.name);
        server.publish("chat", JSON.stringify({ type: "members", members: getMembers(db) }));
        return Response.json({ ok: true }, { headers });
      }

      // GET /api/channels
      if (path === "/api/channels" && req.method === "GET") {
        return Response.json({ channels: getMergedChannels(db) }, { headers });
      }

      // POST /api/channels
      if (path === "/api/channels" && req.method === "POST") {
        let body: { name: string; description?: string; status?: string };
        try { body = await req.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
        if (!body.name) return Response.json({ error: "name is required" }, { status: 400, headers });
        createChannel(db, body.name);
        const existing = getChannelConfigs(db)[body.name];
        const channelConfig = {
          name: body.name,
          description: body.description ?? existing?.description ?? "",
          status: body.status ?? existing?.status ?? "active",
        };
        insertMessage(db, {
          id: generateId(),
          channel: "_system",
          author: config.identity,
          content: `Configure channel: ${body.name}`,
          metadata: JSON.stringify({ channel_config: channelConfig }),
        });
        const channels = getMergedChannels(db);
        server.publish("chat", JSON.stringify({ type: "channels", channels }));
        return Response.json({ ok: true }, { headers });
      }

      // GET /api/sync?since=<last_message_id>
      if (path === "/api/sync" && req.method === "GET") {
        const since = url.searchParams.get("since");
        const messages = since ? getMessagesSince(db, since) : getAllMessages(db);
        const channels = getChannels(db);
        const cursor = messages.length > 0 ? messages[messages.length - 1]!.id : (since || "");
        return Response.json({ messages, channels, cursor }, { headers });
      }

      // POST /api/messages
      if (path === "/api/messages" && req.method === "POST") {
        let body: { channel: string; author: string; content: string; reply_to?: string; metadata?: string };
        try { body = await req.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }

        if (!body.channel || !body.author || !body.content) {
          return Response.json({ error: "channel, author, content are required" }, { status: 400, headers });
        }

        const replyTo = body.reply_to ? resolveThreadRoot(db, body.reply_to) : null;
        const msg: Message = {
          id: generateId(),
          channel: body.channel,
          author: body.author,
          content: body.content,
          reply_to: replyTo,
          metadata: body.metadata ?? null,
        };

        ensureChannel(db, msg.channel);
        insertMessage(db, msg);
        ensureMember(db, msg.author);

        // Broadcast to all WebSocket clients
        server.publish("chat", JSON.stringify({ type: "msg", ...msg }));

        return Response.json({ ok: true }, { headers });
      }

      // GET /api/tasks?status=pending|active|done
      if (path === "/api/tasks" && req.method === "GET") {
        const status = url.searchParams.get("status") || undefined;
        return Response.json({ tasks: getTasks(db, status) }, { headers });
      }

      // GET /api/memories?agent=&tag=&search=&last=
      if (path === "/api/memories" && req.method === "GET") {
        const agent = url.searchParams.get("agent") || undefined;
        const tag = url.searchParams.get("tag") || undefined;
        const search = url.searchParams.get("search") || undefined;
        const lastRaw = url.searchParams.get("last");
        const last = lastRaw ? (parseInt(lastRaw, 10) || undefined) : undefined;
        return Response.json({ memories: getMemories(db, { agent, tag, search, last }) }, { headers });
      }

      // GET /api/summaries/:channel
      if (path.startsWith("/api/summaries/") && req.method === "GET") {
        const channel = decodeURIComponent(path.slice("/api/summaries/".length));
        const lastRaw = url.searchParams.get("last");
        const last = lastRaw ? (parseInt(lastRaw, 10) || undefined) : undefined;
        return Response.json({ summaries: getSummaries(db, channel, last) }, { headers });
      }

      // GET /api/summaries (all channels)
      if (path === "/api/summaries" && req.method === "GET") {
        const lastRaw = url.searchParams.get("last");
        const last = lastRaw ? (parseInt(lastRaw, 10) || undefined) : undefined;
        return Response.json({ summaries: getSummaries(db, undefined, last) }, { headers });
      }

      // GET /api/thread/:id
      if (path.startsWith("/api/thread/") && req.method === "GET") {
        const id = path.slice("/api/thread/".length);
        const result = getThread(db, id);
        if (!result.root) return Response.json({ error: "Not found" }, { status: 404, headers });
        return Response.json(result, { headers });
      }

      // POST /api/merge - バックアップサーバーからのメッセージ一括インポート
      if (path === "/api/merge" && req.method === "POST") {
        let body: { messages: Message[]; channels: { name: string }[] };
        try { body = await req.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
        for (const ch of body.channels ?? []) {
          ensureChannel(db, ch.name);
        }
        const inserted = insertMessages(db, body.messages ?? []);
        return Response.json({ ok: true, merged: inserted.length }, { headers });
      }

      return Response.json({ error: "Not Found" }, { status: 404, headers });
    },
    websocket: {
      open(ws) {
        ws.subscribe("chat");
      },
      message(ws, raw) {
        try {
          const data = JSON.parse(raw as string);
          if (data.type === "send") {
            if (config.public_read) {
              ws.send(JSON.stringify({ type: "error", error: "Read-only mode" }));
              return;
            }
            const { channel, author, content, reply_to, metadata } = data;
            if (!channel || !author || !content) {
              ws.send(JSON.stringify({ type: "error", error: "channel, author, content required" }));
              return;
            }
            const resolvedReplyTo = reply_to ? resolveThreadRoot(db, reply_to) : null;
            const msg: Message = {
              id: generateId(),
              channel,
              author,
              content,
              reply_to: resolvedReplyTo,
              metadata: metadata ?? null,
            };
            ensureChannel(db, msg.channel);
            insertMessage(db, msg);
            ensureMember(db, msg.author);

            ws.send(JSON.stringify({ type: "ack", ok: true }));
            // Broadcast to all (publish sends to others, send to self)
            const msgJson = JSON.stringify({ type: "msg", ...msg });
            ws.publish("chat", msgJson);
            ws.send(msgJson);
          }
        } catch (e) {
          console.error("WebSocket message error:", e);
          ws.send(JSON.stringify({ type: "error", error: "Invalid message" }));
        }
      },
      close(ws) {
        ws.unsubscribe("chat");
      },
    },
  });

  const localIp = getLocalIp();
  console.log(`Chat server started: ${config.name}`);
  console.log(`  Local:  http://localhost:${port}`);
  console.log(`  LAN:    http://${localIp}:${port}`);

  return server;
}

// Owner起動時にbackup_ownersから差分をマージする
export async function syncFromBackups(chatDir: string): Promise<void> {
  const config = readConfig(chatDir);
  if (!config.backup_owners || config.backup_owners.length === 0) return;

  for (const backupUrl of config.backup_owners) {
    try {
      const res = await fetch(`${backupUrl}/api/info`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;

      // Backupサーバーが起動していれば差分をマージ
      const db = openDb(chatDir);
      const channels = getChannels(db);
      db.close();

      const syncRes = await fetch(`${backupUrl}/api/sync`, { signal: AbortSignal.timeout(10000) });
      if (!syncRes.ok) continue;

      const data = await syncRes.json() as {
        messages: Message[];
        channels: { name: string }[];
      };

      const mergeDb = openDb(chatDir);
      for (const ch of data.channels) {
        ensureChannel(mergeDb, ch.name);
      }
      const inserted = insertMessages(mergeDb, data.messages);
      mergeDb.close();

      if (inserted.length > 0) {
        console.log(`  バックアップ (${backupUrl}) から ${inserted.length} 件をマージしました`);
      }
    } catch {
      // バックアップサーバーが起動していない場合はスキップ
    }
  }
}

// Quick tunnel (random URL, no login required)
export async function startTunnel(port: number): Promise<string> {
  const proc = Bun.spawn(["cloudflared", "tunnel", "--url", `http://localhost:${port}`], {
    stderr: "pipe",
  });

  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const match = buffer.match(/https:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com/);
    if (match) {
      reader.releaseLock();
      return match[0];
    }
  }

  throw new Error("Failed to get tunnel URL from cloudflared");
}

// Check if cloudflared is logged in
export function isCloudflaredLoggedIn(): boolean {
  const { existsSync } = require("node:fs");
  const { join } = require("node:path");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return existsSync(join(home, ".cloudflared", "cert.pem"));
}

// Named tunnel (fixed URL, requires Cloudflare login + domain)
export async function startNamedTunnel(port: number, tunnelName: string, hostname: string): Promise<string> {
  const { existsSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const credDir = join(home, ".cloudflared");

  // 1. Get tunnel info (or create if it doesn't exist)
  let tunnelId = "";

  const listProc = Bun.spawn(["cloudflared", "tunnel", "list", "--name", tunnelName, "--output", "json"], {
    stdout: "pipe", stderr: "pipe",
  });
  const listOut = await new Response(listProc.stdout).text();
  await listProc.exited;

  try {
    const tunnels = JSON.parse(listOut);
    if (tunnels.length > 0) {
      tunnelId = tunnels[0].id;
      console.log(`  Using existing tunnel "${tunnelName}" (${tunnelId})`);
    }
  } catch {}

  if (!tunnelId) {
    console.log(`  Creating tunnel "${tunnelName}"...`);
    const createProc = Bun.spawn(["cloudflared", "tunnel", "create", tunnelName], {
      stdout: "pipe", stderr: "pipe",
    });
    const createOut = await new Response(createProc.stdout).text();
    const createErr = await new Response(createProc.stderr).text();
    const exitCode = await createProc.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to create tunnel: ${createErr || createOut}`);
    }
    // Re-list to get the tunnel ID
    const reList = Bun.spawn(["cloudflared", "tunnel", "list", "--name", tunnelName, "--output", "json"], {
      stdout: "pipe", stderr: "pipe",
    });
    const reListOut = await new Response(reList.stdout).text();
    await reList.exited;
    try {
      const t = JSON.parse(reListOut);
      tunnelId = t[0]?.id || "";
    } catch {}
    if (!tunnelId) throw new Error("Failed to get tunnel ID after creation");
    console.log(`  Tunnel "${tunnelName}" created (${tunnelId})`);
  }

  // 2. Verify credentials file exists for this specific tunnel
  const credFile = join(credDir, `${tunnelId}.json`);
  if (!existsSync(credFile)) {
    throw new Error(`Credentials file not found: ${credFile}`);
  }

  // 3. Route DNS
  console.log(`  Routing DNS: ${hostname} → tunnel "${tunnelName}"...`);
  const routeProc = Bun.spawn(["cloudflared", "tunnel", "route", "dns", "--overwrite-dns", tunnelName, hostname], {
    stdout: "pipe", stderr: "pipe",
  });
  const routeExit = await routeProc.exited;
  if (routeExit !== 0) {
    const routeErr = await new Response(routeProc.stderr).text();
    console.warn(`  Warning: DNS route may have failed: ${routeErr.trim()}`);
  }

  // 4. Write config file
  const configContent = `tunnel: ${tunnelId}
credentials-file: ${credFile}
ingress:
  - hostname: ${hostname}
    service: http://localhost:${port}
  - service: http_status:404
`;
  const configPath = join(credDir, `${tunnelName}.yml`);
  writeFileSync(configPath, configContent);

  // 5. Run the named tunnel
  const proc = Bun.spawn(["cloudflared", "tunnel", "--config", configPath, "run", tunnelId], {
    stderr: "pipe",
  });

  // Wait for connection to be established
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    reader.releaseLock();
  }, 15000);

  try {
    while (!timedOut) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      if (buffer.includes("Registered tunnel connection") || buffer.includes("Connection registered")) {
        clearTimeout(timeout);
        reader.releaseLock();
        return `https://${hostname}`;
      }
    }
  } catch {
    // reader.read() throws after releaseLock from timeout
  }

  clearTimeout(timeout);
  throw new Error("Tunnel failed to establish connection within 15 seconds");
}
