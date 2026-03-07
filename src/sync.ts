import { openDb, insertMessages, insertMessage, ensureChannel, generateId, type Message } from "./db";
import { readConfig, readSyncCursor, writeSyncCursor } from "./config";

export async function sync(chatDir: string): Promise<{ newMessages: number; newChannels: number }> {
  const config = readConfig(chatDir);
  if (!config.upstream) {
    return { newMessages: 0, newChannels: 0 };
  }

  const cursor = readSyncCursor(chatDir);
  const url = `${config.upstream}/api/sync${cursor ? `?since=${encodeURIComponent(cursor)}` : ""}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sync failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as {
    messages: Message[];
    channels: { name: string; description: string; created_at: string }[];
    cursor: string;
  };

  const db = openDb(chatDir);

  let newChannels = 0;
  for (const ch of data.channels) {
    const r = db.run("INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)", [ch.name, ch.description || ""]);
    if (r.changes > 0) newChannels++;
  }

  const inserted = insertMessages(db, data.messages);
  writeSyncCursor(chatDir, data.cursor);

  db.close();
  return { newMessages: inserted.length, newChannels };
}

export async function sendToUpstream(chatDir: string, channel: string, author: string, content: string, replyTo?: string): Promise<void> {
  const config = readConfig(chatDir);

  if (config.upstream) {
    // Member: POST to owner
    const res = await fetch(`${config.upstream}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, author, content, reply_to: replyTo }),
    });
    if (!res.ok) throw new Error(`Send failed: ${res.status} ${res.statusText}`);
  } else {
    // Owner: try local server first (for WS broadcast), fallback to direct DB write
    const port = config.port || 4321;
    try {
      const res = await fetch(`http://localhost:${port}/api/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, author, content, reply_to: replyTo }),
      });
      if (res.ok) return;
    } catch {
      // Local server not running, fall through to direct DB write
    }

    const db = openDb(chatDir);
    ensureChannel(db, channel);
    insertMessage(db, {
      id: generateId(),
      channel,
      author,
      content,
      reply_to: replyTo ?? null,
    });
    db.close();
  }
}
