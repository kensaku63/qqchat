import { openDb, insertMessages, insertMessage, ensureChannel, generateId, type Message } from "./db";
import { readConfig, readSyncCursor, writeSyncCursor, type ChatConfig } from "./config";

// upstreamとbackup_ownersを順番に返す（重複除外）
function getUpstreamUrls(config: ChatConfig): string[] {
  const urls: string[] = [];
  if (config.upstream) urls.push(config.upstream);
  for (const url of config.backup_owners ?? []) {
    if (url !== config.upstream) urls.push(url);
  }
  return urls;
}

export async function sync(chatDir: string): Promise<{ newMessages: number; newChannels: number }> {
  const config = readConfig(chatDir);
  const urls = getUpstreamUrls(config);

  if (urls.length === 0) {
    return { newMessages: 0, newChannels: 0 };
  }

  const cursor = readSyncCursor(chatDir);
  let lastError: Error = new Error("All upstreams failed");

  for (const url of urls) {
    try {
      const syncUrl = `${url}/api/sync${cursor ? `?since=${encodeURIComponent(cursor)}` : ""}`;
      const res = await fetch(syncUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        lastError = new Error(`Sync failed: ${res.status} ${res.statusText}`);
        continue;
      }

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

      if (url !== config.upstream) {
        console.log(`  (フォールバック: ${url} から同期)`);
      }

      return { newMessages: inserted.length, newChannels };
    } catch (e) {
      lastError = e as Error;
      continue;
    }
  }

  throw lastError;
}

export async function sendToUpstream(chatDir: string, channel: string, author: string, content: string, replyTo?: string): Promise<void> {
  const config = readConfig(chatDir);
  const urls = getUpstreamUrls(config);

  if (urls.length > 0) {
    // Member: Primaryに送信、失敗したらbackup_ownersを順番に試す
    let lastError: Error = new Error("All upstreams failed");
    for (const url of urls) {
      try {
        const res = await fetch(`${url}/api/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, author, content, reply_to: replyTo }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          if (url !== config.upstream) {
            console.log(`  (フォールバック: ${url} へ送信)`);
          }
          return;
        }
        lastError = new Error(`Send failed: ${res.status} ${res.statusText}`);
      } catch (e) {
        lastError = e as Error;
        continue;
      }
    }
    throw lastError;
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
