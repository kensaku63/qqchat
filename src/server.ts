import { networkInterfaces } from "node:os";
import { openDb, getAllMessages, getMessagesSince, insertMessage, ensureChannel, getChannels, generateId, type Message } from "./db";
import { readConfig } from "./config";

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
        return Response.json({ name: config.name, owner: config.identity }, { headers });
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
        } catch {
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
  console.log("");
  console.log("Share with team:");
  console.log(`  chat join http://${localIp}:${port}`);
  console.log("");
  console.log("For internet access:");
  console.log(`  bunx cloudflared tunnel --url http://localhost:${port}`);

  return server;
}
