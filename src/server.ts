import { networkInterfaces } from "node:os";
import { openDb, getAllMessages, getMessagesSince, insertMessage, insertMessages, ensureChannel, getChannels, generateId, type Message } from "./db";
import { readConfig, readSyncCursor } from "./config";

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

export function startServer(chatDir: string, port: number) {
  const db = openDb(chatDir);
  const config = readConfig(chatDir);

  const server = Bun.serve({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // WebSocket upgrade
      if (path === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
        }, { headers });
      }

      // GET /api/channels
      if (path === "/api/channels" && req.method === "GET") {
        return Response.json({ channels: getChannels(db) }, { headers });
      }

      // POST /api/channels
      if (path === "/api/channels" && req.method === "POST") {
        let body: { name: string; description?: string };
        try { body = await req.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
        if (!body.name) return Response.json({ error: "name is required" }, { status: 400, headers });
        ensureChannel(db, body.name);
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
        let body: { channel: string; author: string; content: string; reply_to?: string };
        try { body = await req.json() as typeof body; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }

        if (!body.channel || !body.author || !body.content) {
          return Response.json({ error: "channel, author, content are required" }, { status: 400, headers });
        }

        const msg: Message = {
          id: generateId(),
          channel: body.channel,
          author: body.author,
          content: body.content,
          reply_to: body.reply_to ?? null,
        };

        ensureChannel(db, msg.channel);
        insertMessage(db, msg);

        // Broadcast to all WebSocket clients
        server.publish("chat", JSON.stringify({ type: "msg", ...msg }));

        return Response.json({ ok: true }, { headers });
      }

      // POST /api/merge - バックアップサーバーからのメッセージ一括インポート
      if (path === "/api/merge" && req.method === "POST") {
        let body: { messages: Message[]; channels: { name: string; description: string }[] };
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
            const { channel, author, content, reply_to } = data;
            if (!channel || !author || !content) {
              ws.send(JSON.stringify({ type: "error", error: "channel, author, content required" }));
              return;
            }
            const msg: Message = {
              id: generateId(),
              channel,
              author,
              content,
              reply_to: reply_to ?? null,
            };
            ensureChannel(db, msg.channel);
            insertMessage(db, msg);

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

// Primary復帰時にBackupのDBから差分をPrimaryへマージする
async function mergeToUpstream(chatDir: string, primaryUrl: string, sinceCursor: string): Promise<void> {
  const db = openDb(chatDir);
  const messages = sinceCursor ? getMessagesSince(db, sinceCursor) : getAllMessages(db);
  const channels = getChannels(db);
  db.close();

  if (messages.length === 0) return;

  try {
    const res = await fetch(`${primaryUrl}/api/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, channels }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json() as { merged: number };
      console.log(`  Primaryへ ${data.merged} 件のメッセージをマージしました`);
    }
  } catch (e) {
    console.error("  Primaryへのマージに失敗しました:", (e as Error).message);
  }
}

// スタンバイモード: Primaryを監視し、落ちたら自動でサーバーを引き継ぐ
export async function startStandbyMode(chatDir: string, port: number): Promise<void> {
  const config = readConfig(chatDir);

  if (!config.upstream) {
    console.error("Error: スタンバイモードには upstream の設定が必要です。");
    process.exit(1);
  }

  const primaryUrl: string = config.upstream;

  console.log(`スタンバイモード: ${primaryUrl} を監視中`);
  console.log(`  Primaryが落ちた場合、ポート ${port} でサーバーを起動します`);
  console.log("Ctrl+C で終了\n");

  let failCount = 0;
  let standbyServer: ReturnType<typeof startServer> | null = null;
  let outageStartCursor = "";

  async function checkPrimary() {
    try {
      const res = await fetch(`${primaryUrl}/api/info`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        if (standbyServer) {
          // Primary復帰 → マージしてスタンバイサーバー停止
          console.log("\nPrimaryが復帰しました。差分をマージしてスタンバイサーバーを停止します...");
          await mergeToUpstream(chatDir, primaryUrl, outageStartCursor);
          standbyServer.stop();
          standbyServer = null;
          outageStartCursor = "";
          console.log("スタンバイモードに戻りました。Primaryを監視中...\n");
        }
        failCount = 0;
        return;
      }
    } catch {}

    failCount++;
    if (!standbyServer) {
      process.stdout.write(`\rPrimaryに接続できません (${failCount}/3)...`);
    }

    if (failCount >= 3 && !standbyServer) {
      console.log("\nPrimaryがダウンしました！スタンバイサーバーを起動します...");
      // 障害発生直前のカーソルを記録（後でマージ範囲に使う）
      outageStartCursor = readSyncCursor(chatDir);
      standbyServer = startServer(chatDir, port);
    }
  }

  setInterval(checkPrimary, 5000);
  await new Promise(() => {});  // 永続実行
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
        channels: { name: string; description: string }[];
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

export async function startTunnel(port: number): Promise<string> {
  const proc = Bun.spawn(["npx", "cloudflared", "tunnel", "--url", `http://localhost:${port}`], {
    stderr: "pipe",
  });

  // cloudflared outputs the URL to stderr
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const match = buffer.match(/https:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com/);
    if (match) {
      // Release the reader lock so cloudflared keeps running
      reader.releaseLock();
      return match[0];
    }
  }

  throw new Error("Failed to get tunnel URL from cloudflared");
}
