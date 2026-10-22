import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CursorStateStore,
  cursorBubbleToHistory,
  cursorConversationHasAgentReply,
  cursorConversationRevision,
  cursorConversationSelection,
  cursorConversationToTask,
  cursorProjectForConversation,
  shouldClearCursorRuntimeOverride,
  stabilizeCursorTaskState,
  cursorTaskState,
  parseCursorProcessList,
  type CursorConversation,
} from "./cursor.js";

test("detects a running Cursor process and its active workspaces", () => {
  const snapshot = parseCursorProcessList([
    "/Applications/Cursor.app/Contents/MacOS/Cursor",
    "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper fileWatcher [1:workspace_1]",
  ].join("\n"));

  assert.equal(snapshot.running, true);
  assert.deepEqual([...snapshot.workspaceIds], ["workspace_1"]);
  assert.equal(parseCursorProcessList("/usr/bin/node server.js").running, false);
});

test("detects the Windows Cursor executable without matching helpers", () => {
  const running = parseCursorProcessList([
    '\"C:\\Users\\Ada\\AppData\\Local\\Programs\\cursor\\Cursor.exe\" --no-sandbox',
    '\"C:\\Users\\Ada\\AppData\\Local\\Programs\\cursor\\Cursor Helper.exe\" --type=utility',
  ].join("\n"));
  assert.equal(running.running, true);

  const helperOnly = parseCursorProcessList('\"C:\\Program Files\\Cursor\\Cursor Helper.exe\" --type=utility');
  assert.equal(helperOnly.running, false);
});

test("ignores Cursor helpers and stale crash handlers after the main app exits", () => {
  const snapshot = parseCursorProcessList([
    "/Applications/Cursor.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --database=/tmp/Cursor/Crashpad",
    "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper fileWatcher [1:workspace_1]",
    "/usr/bin/node tool.js --cursor=/Applications/Cursor.app/Contents/MacOS/Cursor",
  ].join("\n"));

  assert.equal(snapshot.running, false);
  assert.deepEqual([...snapshot.workspaceIds], ["workspace_1"]);
});

test("keeps Cursor task snapshots stable while workspace processes transition", () => {
  assert.deepEqual(cursorConversationSelection(undefined), { mode: "all" });
  assert.deepEqual(cursorConversationSelection({ running: false, workspaceIds: new Set(["stale_workspace"]) }), {
    mode: "workspaces",
    workspaceIds: [],
  });
  assert.deepEqual(cursorConversationSelection({ running: true, workspaceIds: new Set() }), { mode: "retain" });
  assert.deepEqual(cursorConversationSelection({ running: true, workspaceIds: new Set(["workspace_1"]) }), {
    mode: "workspaces",
    workspaceIds: ["workspace_1"],
  });
});

const conversation: CursorConversation = {
  composerId: "ed66a07d-f39d-42ea-8f7a-8f9795ce5608",
  workspaceId: "workspace_1",
  createdAt: 1_792_389_515_777,
  lastUpdatedAt: 1_792_389_525_408,
  header: {
    name: "完成 Cursor 适配",
    filesChangedCount: 2,
    totalLinesAdded: 80,
    totalLinesRemoved: 12,
    workspaceIdentifier: { id: "workspace_1", uri: { fsPath: "/Users/hu/data/github/ai-workstation-remote" } },
  },
  data: {
    composerId: "ed66a07d-f39d-42ea-8f7a-8f9795ce5608",
    name: "完成 Cursor 适配",
    status: "completed",
    lastUpdatedAt: 1_792_389_525_408,
    generatingBubbleIds: [],
    queueItems: [],
    fullConversationHeadersOnly: [
      { bubbleId: "turn_1", type: 1 },
      { bubbleId: "turn_1/s:1", type: 2 },
    ],
    workspaceIdentifier: { id: "workspace_1", uri: { fsPath: "/Users/hu/data/github/ai-workstation-remote" } },
  },
};

test("maps Cursor persistence status without treating an active workspace as active execution", () => {
  assert.equal(cursorTaskState("completed", 0), "succeeded");
  assert.equal(cursorTaskState("aborted", 0), "stopped");
  assert.equal(cursorTaskState("none", 0), "idle");
  assert.equal(cursorTaskState("completed", 1), "running");
  assert.equal(cursorTaskState("completed", 0, true), "waiting_for_user");
  assert.equal(cursorTaskState("new-future-status", 0), "unknown");
});

test("creates a Cursor project and a web-controllable task", () => {
  const project = cursorProjectForConversation(conversation);
  const task = cursorConversationToTask(conversation, project, "Cursor 已完成适配");

  assert.equal(project.name, "Cursor · ai-workstation-remote");
  assert.equal(task.id, `cursor_${conversation.composerId}`);
  assert.equal(task.agentName, "Cursor");
  assert.equal(task.runId, "cursor_run_turn_1");
  assert.equal(task.state, "succeeded");
  assert.equal(task.controlState, "available");
  assert.deepEqual(task.capabilities, ["history", "message", "diff"]);
  assert.equal(task.artifacts[0]?.kind, "diff");
  assert.deepEqual(task.artifacts[0]?.stats, { filesChanged: 2, additions: 80, deletions: 12 });
  assert.match(task.controlReason ?? "", /Cursor Desktop/);
});

test("groups windowless Cursor conversations into one recent project", () => {
  const first = cursorProjectForConversation({
    ...conversation,
    workspaceId: "empty-window-1",
    header: { ...conversation.header, workspaceIdentifier: undefined },
    data: { ...conversation.data, workspaceIdentifier: undefined },
  });
  const second = cursorProjectForConversation({
    ...conversation,
    workspaceId: "empty-window-2",
    header: { ...conversation.header, workspaceIdentifier: undefined },
    data: { ...conversation.data, workspaceIdentifier: undefined },
  });

  assert.equal(first.id, "cursor_recent");
  assert.equal(second.id, first.id);
  assert.equal(first.name, "Cursor · 最近会话");
  assert.equal(first.source, "cursor");
});

test("maps Cursor messages, reasoning, and tool calls to the shared timeline", () => {
  const user = cursorBubbleToHistory({
    bubbleId: "turn_1",
    type: 1,
    text: "检查真实数据",
    startedAtMs: 1_792_389_550_057,
  });
  const reasoning = cursorBubbleToHistory({
    bubbleId: "turn_1/s:0",
    type: 2,
    thinking: { text: "先读取状态库" },
    startedAtMs: 1_792_389_552_607,
  });
  const command = cursorBubbleToHistory({
    bubbleId: "turn_1/s:1",
    type: 2,
    toolFormerData: {
      name: "run_terminal_command",
      params: "npm test",
      result: "12 tests passed",
      status: "completed",
    },
    startedAtMs: 1_792_389_553_000,
  });

  assert.equal(user?.kind, "user_message");
  assert.equal(reasoning?.kind, "reasoning");
  assert.equal(command?.kind, "command");
  assert.match(command?.text ?? "", /12 tests passed/);
  assert.equal(command?.turnId, user?.turnId);
});

test("detects a completed reply even when polling misses Cursor's running state", () => {
  const completed = {
    ...conversation,
    data: {
      ...conversation.data,
      status: "completed",
      generatingBubbleIds: [],
      fullConversationHeadersOnly: [
        { bubbleId: "turn_2", type: 1 },
        { bubbleId: "turn_2/s:0", type: 2 },
        { bubbleId: "turn_2/t:call_1", type: 2 },
        { bubbleId: "turn_2/s:1", type: 2 },
      ],
    },
  } satisfies CursorConversation;
  const bubbles = new Map<string, Parameters<typeof cursorBubbleToHistory>[0]>([
    ["turn_2/s:0", { bubbleId: "turn_2/s:0", type: 2, thinking: { text: "检查中" } }],
    ["turn_2/t:call_1", { bubbleId: "turn_2/t:call_1", type: 2, toolFormerData: { name: "search" } }],
    ["turn_2/s:1", { bubbleId: "turn_2/s:1", type: 2, text: "已经处理完成" }],
  ]);

  assert.equal(cursorConversationHasAgentReply(completed, "turn_2", (id) => bubbles.get(id)), true);
  assert.equal(cursorConversationHasAgentReply(completed, "turn_1", (id) => bubbles.get(id)), false);
  bubbles.delete("turn_2/s:1");
  assert.equal(cursorConversationHasAgentReply(completed, "turn_2", (id) => bubbles.get(id)), false);
});

test("tracks Cursor bubble changes when its persisted lastUpdatedAt is stale", () => {
  const bubbles = new Map<string, Parameters<typeof cursorBubbleToHistory>[0]>([
    ["turn_1/s:1", { bubbleId: "turn_1/s:1", type: 2, text: "处理中" }],
  ]);
  const before = cursorConversationRevision(conversation, (id) => bubbles.get(id));
  const withNewHeader = {
    ...conversation,
    data: {
      ...conversation.data,
      fullConversationHeadersOnly: [
        ...conversation.data.fullConversationHeadersOnly,
        { bubbleId: "turn_1/s:2", type: 2 },
      ],
    },
  } satisfies CursorConversation;
  bubbles.set("turn_1/s:2", { bubbleId: "turn_1/s:2", type: 2, text: "最终回复" });

  assert.notEqual(cursorConversationRevision(withNewHeader, (id) => bubbles.get(id)), before);
  assert.equal(conversation.lastUpdatedAt, withNewHeader.lastUpdatedAt);
});

test("does not expose a transient aborted status while Cursor is still writing", () => {
  assert.equal(stabilizeCursorTaskState("stopped", 90_000, 100_000), "running");
  assert.equal(stabilizeCursorTaskState("stopped", 80_000, 100_000), "stopped");
  assert.equal(stabilizeCursorTaskState("succeeded", 99_000, 100_000), "succeeded");
});

test("keeps a confirmed web message running across Cursor's transient terminal states", () => {
  assert.equal(shouldClearCursorRuntimeOverride("turn_2", "running", false), false);
  assert.equal(shouldClearCursorRuntimeOverride("turn_2", "stopped", false), false);
  assert.equal(shouldClearCursorRuntimeOverride("turn_2", "succeeded", false), false);
  assert.equal(shouldClearCursorRuntimeOverride("turn_2", "succeeded", true), true);
  assert.equal(shouldClearCursorRuntimeOverride("turn_2", "failed", false), true);
});

test("hands uncorrelated runtime state back to Cursor once execution is observed", () => {
  assert.equal(shouldClearCursorRuntimeOverride(undefined, "running", false), true);
  assert.equal(shouldClearCursorRuntimeOverride(undefined, "waiting_for_user", false), true);
  assert.equal(shouldClearCursorRuntimeOverride(undefined, "stopped", false), false);
});

test("reads only current top-level Cursor conversations and their indexed bubbles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-state-"));
  const path = join(directory, "state.vscdb");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY,
      workspaceId TEXT,
      createdAt INTEGER,
      lastUpdatedAt INTEGER,
      isArchived INTEGER,
      isSubagent INTEGER,
      recency INTEGER,
      value TEXT
    );
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);
  const insertHeader = database.prepare(`
    INSERT INTO composerHeaders
      (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertKv = database.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  const headerValue = JSON.stringify(conversation.header);
  const dataValue = JSON.stringify({
    ...conversation.data,
    fullConversationHeadersOnly: [{ bubbleId: "bubble_1", type: 1 }],
  });
  insertHeader.run(conversation.composerId, conversation.workspaceId, conversation.createdAt, conversation.lastUpdatedAt, 0, 0, 3, headerValue);
  insertHeader.run("archived", "workspace_1", 1, 2, 1, 0, 2, headerValue);
  insertHeader.run("subagent", "workspace_1", 1, 2, 0, 1, 1, headerValue);
  insertHeader.run("draft", "workspace_1", 1, 4, 0, 0, 4, JSON.stringify({ ...conversation.header, isDraft: true }));
  insertKv.run(`composerData:${conversation.composerId}`, dataValue);
  insertKv.run("composerData:draft", dataValue);
  insertKv.run(`bubbleId:${conversation.composerId}:bubble_1`, JSON.stringify({ bubbleId: "bubble_1", type: 1, text: "真实消息" }));
  database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursor.desktopBridge.enabled", "true");
  database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursor/desktopBridgeUserEnabled", "true");
  database.close();

  const store = new CursorStateStore(path);
  try {
    const rows = store.conversations(10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.composerId, conversation.composerId);
    assert.equal(store.bubble(conversation.composerId, "bubble_1")?.text, "真实消息");
    assert.equal(store.conversations(10, ["workspace_1"]).length, 1);
    assert.equal(store.conversations(10, ["other-workspace"]).length, 0);
    assert.equal(store.conversations(10, []).length, 0);
    assert.deepEqual(store.desktopBridgeState(), { featureEnabled: true, userEnabled: true });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
