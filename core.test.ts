import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, createChannel, insertMessage, insertMessages, generateId, getThread, getUnreadMessages, queryMessages, parseAuthor, ensureMember, getMembers, getTasks } from "./src/db";
import { writeConfig, readReadCursor, writeReadCursor } from "./src/config";

function makeTmpChatDir(suffix: string): string {
  const dir = `/tmp/agents-chat-test-${suffix}-${Date.now()}`;
  const chatDir = join(dir, ".chat");
  mkdirSync(chatDir, { recursive: true });
  return chatDir;
}

// -------------------------------------------------------------------
describe("thread", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("thread");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");

    // Root message
    insertMessage(db, { id: "root_001", channel: "general", author: "kensaku", content: "What do you think?", reply_to: null });
    // Replies
    insertMessage(db, { id: "reply_001", channel: "general", author: "agent@kensaku", content: "I think it's great", reply_to: "root_001" });
    insertMessage(db, { id: "reply_002", channel: "general", author: "agent:Opus@kensaku", content: "Agreed", reply_to: "root_001" });
    // Unrelated message
    insertMessage(db, { id: "other_001", channel: "general", author: "kensaku", content: "Something else", reply_to: null });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("returns root and its replies", () => {
    const db = openDb(chatDir);
    const { root, replies } = getThread(db, "root_001");
    db.close();

    expect(root).not.toBeNull();
    expect(root!.content).toBe("What do you think?");
    expect(replies.length).toBe(2);
    expect(replies[0].content).toBe("I think it's great");
    expect(replies[1].content).toBe("Agreed");
  });

  test("returns null root for non-existent message", () => {
    const db = openDb(chatDir);
    const { root, replies } = getThread(db, "nonexistent");
    db.close();

    expect(root).toBeNull();
    expect(replies.length).toBe(0);
  });
});

// -------------------------------------------------------------------
describe("unread", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("unread");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");
    createChannel(db, "dev", "Dev");

    insertMessage(db, { id: "aaa_001", channel: "general", author: "kensaku", content: "msg1", reply_to: null });
    insertMessage(db, { id: "bbb_002", channel: "dev", author: "agent@kensaku", content: "msg2", reply_to: null });
    insertMessage(db, { id: "ccc_003", channel: "general", author: "kensaku", content: "msg3", reply_to: null });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("returns all messages when no cursor", () => {
    const db = openDb(chatDir);
    const msgs = getUnreadMessages(db, "");
    db.close();
    expect(msgs.length).toBe(3);
  });

  test("returns only messages after cursor", () => {
    const db = openDb(chatDir);
    const msgs = getUnreadMessages(db, "bbb_002");
    db.close();
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("msg3");
  });

  test("read cursor persists", () => {
    writeReadCursor(chatDir, "bbb_002");
    const cursor = readReadCursor(chatDir);
    expect(cursor).toBe("bbb_002");
  });
});

// -------------------------------------------------------------------
describe("metadata", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("metadata");
    const db = openDb(chatDir);
    createChannel(db, "dev", "Dev");
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("stores and retrieves metadata", () => {
    const db = openDb(chatDir);
    const meta = JSON.stringify({ files: [{ path: "src/db.ts", content: "..." }] });
    insertMessage(db, { id: "meta_001", channel: "dev", author: "agent:Opus@kensaku", content: "check this", reply_to: null, metadata: meta });

    const msgs = queryMessages(db, "dev", { last: 1 });
    db.close();

    expect(msgs[0].metadata).toBe(meta);
    const parsed = JSON.parse(msgs[0].metadata!);
    expect(parsed.files[0].path).toBe("src/db.ts");
  });

  test("metadata is null by default", () => {
    const db = openDb(chatDir);
    insertMessage(db, { id: "nometa_001", channel: "dev", author: "kensaku", content: "plain msg", reply_to: null });

    const msgs = queryMessages(db, "dev", { last: 1 });
    db.close();

    expect(msgs[0].metadata).toBeNull();
  });

  test("bulk insert preserves metadata", () => {
    const db = openDb(chatDir);
    const meta = JSON.stringify({ diff: "+added line" });
    insertMessages(db, [
      { id: "bulk_001", channel: "dev", author: "agent@kensaku", content: "with meta", reply_to: null, metadata: meta },
      { id: "bulk_002", channel: "dev", author: "kensaku", content: "without meta", reply_to: null },
    ]);

    const msgs = queryMessages(db, "dev");
    db.close();

    expect(msgs[0].metadata).toBe(meta);
    expect(msgs[1].metadata).toBeNull();
  });
});

// -------------------------------------------------------------------
describe("mention filter", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("mention");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");

    insertMessage(db, { id: "m_001", channel: "general", author: "kensaku", content: "@Opus このコード見て", reply_to: null });
    insertMessage(db, { id: "m_002", channel: "general", author: "agent:Opus@kensaku", content: "了解です", reply_to: null });
    insertMessage(db, { id: "m_003", channel: "general", author: "kensaku", content: "@Sonnet こっちも頼む", reply_to: null });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("filters messages by mention", () => {
    const db = openDb(chatDir);
    const msgs = queryMessages(db, "general", { mention: "Opus" });
    db.close();

    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain("@Opus");
  });
});

// -------------------------------------------------------------------
describe("parseAuthor", () => {
  test("parses named agent", () => {
    expect(parseAuthor("agent:Opus@kensaku")).toEqual({ name: "Opus", type: "agent" });
  });

  test("parses unnamed agent", () => {
    expect(parseAuthor("agent@kensaku")).toEqual({ name: "kensaku", type: "agent" });
  });

  test("parses human", () => {
    expect(parseAuthor("kensaku")).toEqual({ name: "kensaku", type: "human" });
  });

  test("parses named agent without identity", () => {
    expect(parseAuthor("agent:Director")).toEqual({ name: "Director", type: "agent" });
  });
});

// -------------------------------------------------------------------
describe("members", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("members");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("registers human member", () => {
    const db = openDb(chatDir);
    ensureMember(db, "kensaku");
    const members = getMembers(db);
    db.close();

    expect(members.length).toBe(1);
    expect(members[0].name).toBe("kensaku");
    expect(members[0].type).toBe("human");
  });

  test("registers named agent as display name", () => {
    const db = openDb(chatDir);
    ensureMember(db, "agent:Opus@kensaku");
    const members = getMembers(db);
    db.close();

    expect(members.length).toBe(1);
    expect(members[0].name).toBe("Opus");
    expect(members[0].type).toBe("agent");
  });

  test("deduplicates members", () => {
    const db = openDb(chatDir);
    ensureMember(db, "agent:Opus@kensaku");
    ensureMember(db, "agent:Opus@kensaku");
    ensureMember(db, "kensaku");
    const members = getMembers(db);
    db.close();

    expect(members.length).toBe(2);
  });

  test("different agents get separate entries", () => {
    const db = openDb(chatDir);
    ensureMember(db, "agent:Opus@kensaku");
    ensureMember(db, "agent:Director@kensaku");
    ensureMember(db, "kensaku");
    const members = getMembers(db);
    db.close();

    expect(members.length).toBe(3);
    const names = members.map(m => m.name).sort();
    expect(names).toEqual(["Director", "Opus", "kensaku"]);
  });
});

// -------------------------------------------------------------------
describe("tasks", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("tasks");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");

    // Task message
    insertMessage(db, {
      id: "task_001", channel: "general", author: "kensaku",
      content: "[Task] Fix bug → @Opus",
      metadata: JSON.stringify({ task: { name: "Fix bug", assignee: "Opus", detail: "", status: "pending" } }),
    });
    // Non-task message
    insertMessage(db, {
      id: "msg_001", channel: "general", author: "kensaku",
      content: "Hello", reply_to: null,
    });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("getTasks returns only task messages", () => {
    const db = openDb(chatDir);
    const tasks = getTasks(db);
    db.close();

    expect(tasks.length).toBe(1);
    expect(tasks[0].name).toBe("Fix bug");
    expect(tasks[0].status).toBe("pending");
  });

  test("getTasks reflects latest status update", () => {
    const db = openDb(chatDir);
    insertMessage(db, {
      id: "upd_001", channel: "general", author: "agent:Opus@kensaku",
      content: "[Task] Fix bug → active", reply_to: "task_001",
      metadata: JSON.stringify({ task_update: { status: "active" } }),
    });
    const tasks = getTasks(db);
    db.close();

    expect(tasks[0].status).toBe("active");
  });

  test("getTasks filters by status", () => {
    const db = openDb(chatDir);
    const pending = getTasks(db, "pending");
    const done = getTasks(db, "done");
    db.close();

    expect(pending.length).toBe(1);
    expect(done.length).toBe(0);
  });

  test("task_update on non-root is ignored by getTasks", () => {
    const db = openDb(chatDir);
    // Update replying to the update (not root task) — should not affect status
    insertMessage(db, {
      id: "upd_001", channel: "general", author: "agent:Opus@kensaku",
      content: "[Task] Fix bug → active", reply_to: "task_001",
      metadata: JSON.stringify({ task_update: { status: "active" } }),
    });
    insertMessage(db, {
      id: "upd_002", channel: "general", author: "agent:Opus@kensaku",
      content: "[Task] Fix bug → done", reply_to: "upd_001",
      metadata: JSON.stringify({ task_update: { status: "done" } }),
    });
    const tasks = getTasks(db);
    db.close();

    // Only direct replies to root are tracked, so status should be "active" not "done"
    expect(tasks[0].status).toBe("active");
  });
});
