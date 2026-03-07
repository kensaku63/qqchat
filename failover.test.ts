import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openDb, createChannel, insertMessage, generateId } from "./src/db";
import { writeConfig, readConfig } from "./src/config";
import { sync, sendToUpstream } from "./src/sync";
import { startServer, syncFromBackups } from "./src/server";

// テスト用の一時ディレクトリを作成
function makeTmpChatDir(suffix: string): string {
  const dir = `/tmp/agents-chat-test-${suffix}-${Date.now()}`;
  const chatDir = join(dir, ".chat");
  mkdirSync(chatDir, { recursive: true });
  return chatDir;
}

// テスト用のサーバーをポート指定で起動
function startTestServer(chatDir: string, port: number) {
  return startServer(chatDir, port);
}

// ポート9100番台を使う（他テストと衝突しないよう）
const BASE_PORT = 9100;

// -------------------------------------------------------------------
describe("1. /api/info が backup_owners を返す", () => {
  let chatDir: string;
  let server: ReturnType<typeof startServer>;

  beforeEach(() => {
    chatDir = makeTmpChatDir("info");
    writeConfig(chatDir, {
      role: "owner",
      name: "test-chat",
      identity: "kensaku",
      port: BASE_PORT,
      backup_owners: ["http://sota:9101", "http://tanaka:9102"],
      created_at: new Date().toISOString(),
    });
    const db = openDb(chatDir);
    createChannel(db, "general", "General");
    db.close();
    server = startTestServer(chatDir, BASE_PORT);
  });

  afterEach(async () => {
    server.stop(true);
    await Bun.sleep(50);
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("backup_owners がレスポンスに含まれる", async () => {
    const res = await fetch(`http://localhost:${BASE_PORT}/api/info`);
    const data = await res.json() as any;
    expect(res.ok).toBe(true);
    expect(data.owner).toBe("kensaku");
    expect(data.backup_owners).toEqual(["http://sota:9101", "http://tanaka:9102"]);
  });

  test("backup_owners 未設定の場合は空配列を返す", async () => {
    // backup_owners なしの設定で別ポートのサーバーを起動
    const chatDir2 = makeTmpChatDir("info-nobackup");
    writeConfig(chatDir2, {
      role: "owner",
      name: "test-chat",
      identity: "kensaku",
      port: BASE_PORT + 10,
      created_at: new Date().toISOString(),
    });
    const db2 = openDb(chatDir2);
    createChannel(db2, "general", "General");
    db2.close();
    const server2 = startTestServer(chatDir2, BASE_PORT + 10);
    try {
      const res = await fetch(`http://localhost:${BASE_PORT + 10}/api/info`);
      const data = await res.json() as any;
      expect(data.backup_owners).toEqual([]);
    } finally {
      server2.stop(true);
      await Bun.sleep(50);
      rmSync(join(chatDir2, ".."), { recursive: true, force: true });
    }
  });
});

// -------------------------------------------------------------------
describe("2. /api/merge でメッセージを一括インポート", () => {
  let chatDir: string;
  let server: ReturnType<typeof startServer>;
  const PORT = BASE_PORT + 1;

  beforeEach(() => {
    chatDir = makeTmpChatDir("merge");
    writeConfig(chatDir, {
      role: "owner",
      name: "test-chat",
      identity: "kensaku",
      port: PORT,
      created_at: new Date().toISOString(),
    });
    const db = openDb(chatDir);
    createChannel(db, "general", "General");
    db.close();
    server = startTestServer(chatDir, PORT);
  });

  afterEach(async () => {
    server.stop(true);
    await Bun.sleep(50);
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("バックアップのメッセージがマージされる", async () => {
    // 時刻差をつけて順序を確定させる
    const id1 = `${(Date.now() - 100).toString(36)}_aaa`;
    const id2 = `${Date.now().toString(36)}_bbb`;
    const messages = [
      { id: id1, channel: "general", author: "sota", content: "バックアップ中のメッセージ1", reply_to: null },
      { id: id2, channel: "general", author: "sota", content: "バックアップ中のメッセージ2", reply_to: null },
    ];

    const res = await fetch(`http://localhost:${PORT}/api/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, channels: [{ name: "general", description: "" }] }),
    });
    const data = await res.json() as any;

    expect(res.ok).toBe(true);
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(2);

    // DBに実際に入っているか確認（ID昇順で返る）
    const syncRes = await fetch(`http://localhost:${PORT}/api/sync`);
    const syncData = await syncRes.json() as any;
    expect(syncData.messages.length).toBe(2);
    const contents = syncData.messages.map((m: any) => m.content);
    expect(contents).toContain("バックアップ中のメッセージ1");
    expect(contents).toContain("バックアップ中のメッセージ2");
  });

  test("重複メッセージは無視される（冪等性）", async () => {
    const msg = { id: generateId(), channel: "general", author: "sota", content: "重複テスト", reply_to: null };

    // 1回目
    await fetch(`http://localhost:${PORT}/api/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [msg], channels: [] }),
    });

    // 2回目（同じID）
    const res = await fetch(`http://localhost:${PORT}/api/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [msg], channels: [] }),
    });
    const data = await res.json() as any;

    expect(data.merged).toBe(0);  // 重複なので0件

    // DBには1件だけ
    const syncRes = await fetch(`http://localhost:${PORT}/api/sync`);
    const syncData = await syncRes.json() as any;
    expect(syncData.messages.length).toBe(1);
  });
});

// -------------------------------------------------------------------
describe("3. sync() がPrimary落ち時にbackup_ownersへフォールバック", () => {
  let memberChatDir: string;
  let backupChatDir: string;
  let backupServer: ReturnType<typeof startServer>;
  const PRIMARY_PORT = BASE_PORT + 2;   // 実際には起動しない（落ちている想定）
  const BACKUP_PORT  = BASE_PORT + 3;

  beforeEach(() => {
    // バックアップサーバーの準備
    backupChatDir = makeTmpChatDir("backup-sync");
    writeConfig(backupChatDir, {
      role: "owner",
      name: "test-chat",
      identity: "sota",
      port: BACKUP_PORT,
      created_at: new Date().toISOString(),
    });
    const backupDb = openDb(backupChatDir);
    createChannel(backupDb, "general", "General");
    insertMessage(backupDb, { id: generateId(), channel: "general", author: "kensaku", content: "Primaryが落ちる前のメッセージ", reply_to: null });
    insertMessage(backupDb, { id: generateId(), channel: "general", author: "sota", content: "バックアップ期間中のメッセージ", reply_to: null });
    backupDb.close();
    backupServer = startTestServer(backupChatDir, BACKUP_PORT);

    // Memberの準備（Primaryは起動していない）
    memberChatDir = makeTmpChatDir("member-sync");
    writeConfig(memberChatDir, {
      role: "member",
      name: "test-chat",
      identity: "alice",
      upstream: `http://localhost:${PRIMARY_PORT}`,           // 落ちているPrimary
      backup_owners: [`http://localhost:${BACKUP_PORT}`],     // 生きているBackup
      created_at: new Date().toISOString(),
    });
    const memberDb = openDb(memberChatDir);
    createChannel(memberDb, "general", "General");
    memberDb.close();
  });

  afterEach(async () => {
    backupServer.stop(true);
    await Bun.sleep(50);
    rmSync(join(memberChatDir, ".."), { recursive: true, force: true });
    rmSync(join(backupChatDir, ".."), { recursive: true, force: true });
  });

  test("Primaryに繋がらなくてもbackup_ownersから同期できる", async () => {
    const result = await sync(memberChatDir);

    expect(result.newMessages).toBe(2);
    expect(result.newChannels).toBe(0);  // generalは既にある
  });
});

// -------------------------------------------------------------------
describe("4. sendToUpstream() がPrimary落ち時にbackup_ownersへフォールバック", () => {
  let backupChatDir: string;
  let backupServer: ReturnType<typeof startServer>;
  let memberChatDir: string;
  const PRIMARY_PORT = BASE_PORT + 4;   // 起動しない
  const BACKUP_PORT  = BASE_PORT + 5;

  beforeEach(() => {
    backupChatDir = makeTmpChatDir("backup-send");
    writeConfig(backupChatDir, {
      role: "owner",
      name: "test-chat",
      identity: "sota",
      port: BACKUP_PORT,
      created_at: new Date().toISOString(),
    });
    const db = openDb(backupChatDir);
    createChannel(db, "general", "General");
    db.close();
    backupServer = startTestServer(backupChatDir, BACKUP_PORT);

    memberChatDir = makeTmpChatDir("member-send");
    writeConfig(memberChatDir, {
      role: "member",
      name: "test-chat",
      identity: "alice",
      upstream: `http://localhost:${PRIMARY_PORT}`,
      backup_owners: [`http://localhost:${BACKUP_PORT}`],
      created_at: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    backupServer.stop(true);
    await Bun.sleep(50);
    rmSync(join(memberChatDir, ".."), { recursive: true, force: true });
    rmSync(join(backupChatDir, ".."), { recursive: true, force: true });
  });

  test("Primaryが落ちていてもbackupへ送信できる", async () => {
    await sendToUpstream(memberChatDir, "general", "alice", "フォールバック送信テスト");

    // バックアップサーバーのDBに届いているか確認
    const res = await fetch(`http://localhost:${BACKUP_PORT}/api/sync`);
    const data = await res.json() as any;
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].content).toBe("フォールバック送信テスト");
    expect(data.messages[0].author).toBe("alice");
  });

  test("全てのupstreamが落ちていたらエラーをthrow", async () => {
    writeConfig(memberChatDir, {
      role: "member",
      name: "test-chat",
      identity: "alice",
      upstream: `http://localhost:${PRIMARY_PORT}`,
      backup_owners: [`http://localhost:19999`],  // これも存在しない
      created_at: new Date().toISOString(),
    });

    await expect(
      sendToUpstream(memberChatDir, "general", "alice", "これは届かない")
    ).rejects.toThrow();
  });
});

// -------------------------------------------------------------------
describe("5. Primary復帰時 syncFromBackups() がバックアップから差分をマージ", () => {
  let primaryChatDir: string;
  let backupChatDir: string;
  let primaryServer: ReturnType<typeof startServer>;
  let backupServer: ReturnType<typeof startServer>;
  const PRIMARY_PORT = BASE_PORT + 6;
  const BACKUP_PORT  = BASE_PORT + 7;

  beforeEach(() => {
    // バックアップ: Primaryが落ちていた間のメッセージを持つ
    backupChatDir = makeTmpChatDir("backup-recover");
    writeConfig(backupChatDir, {
      role: "owner",
      name: "test-chat",
      identity: "sota",
      port: BACKUP_PORT,
      created_at: new Date().toISOString(),
    });
    const backupDb = openDb(backupChatDir);
    createChannel(backupDb, "general", "General");
    insertMessage(backupDb, { id: generateId(), channel: "general", author: "alice", content: "Primary落ちてた間のメッセージ", reply_to: null });
    backupDb.close();
    backupServer = startTestServer(backupChatDir, BACKUP_PORT);

    // Primary: backup_ownersを設定して起動（空のDB）
    primaryChatDir = makeTmpChatDir("primary-recover");
    writeConfig(primaryChatDir, {
      role: "owner",
      name: "test-chat",
      identity: "kensaku",
      port: PRIMARY_PORT,
      backup_owners: [`http://localhost:${BACKUP_PORT}`],
      created_at: new Date().toISOString(),
    });
    const primaryDb = openDb(primaryChatDir);
    createChannel(primaryDb, "general", "General");
    primaryDb.close();
    primaryServer = startTestServer(primaryChatDir, PRIMARY_PORT);
  });

  afterEach(async () => {
    primaryServer.stop(true);
    backupServer.stop(true);
    await Bun.sleep(50);
    rmSync(join(primaryChatDir, ".."), { recursive: true, force: true });
    rmSync(join(backupChatDir, ".."), { recursive: true, force: true });
  });

  test("Primary起動時にbackupの差分がマージされる", async () => {
    // Primary起動時の処理をシミュレート
    await syncFromBackups(primaryChatDir);

    // Primaryのサーバー経由で確認
    const res = await fetch(`http://localhost:${PRIMARY_PORT}/api/sync`);
    const data = await res.json() as any;
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].content).toBe("Primary落ちてた間のメッセージ");
  });
});
