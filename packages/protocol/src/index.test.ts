import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEventToTasks,
  ClientMessageSchema,
  MobileCommandSchema,
  ServerMessageSchema,
  TaskSchema,
  WorkstationEventSchema,
  isCommandExpired,
  type MobileCommand,
} from "./index.js";

const now = new Date("2026-10-19T10:00:00.000Z");

test("task contract preserves explicit waiting state and approval scope", () => {
  const task = TaskSchema.parse({
    id: "task_1",
    deviceId: "mac_1",
    projectId: "rea",
    projectName: "REA",
    runId: "run_1",
    agentId: "codex",
    agentName: "Codex",
    title: "Repair recovery tests",
    state: "waiting_for_user",
    summary: "Waiting for one-time file write approval",
    controlState: "managed",
    capabilities: ["message", "stop", "approval", "tests"],
    artifacts: [],
    pendingApproval: {
      id: "approval_1",
      title: "Write three test files",
      summary: "No network access",
      risk: "medium",
      capability: "approval",
      scope: ["tests/recovery.test.ts"],
      expiresAt: "2026-10-19T10:05:00.000Z",
    },
    updatedAt: "2026-10-19T10:00:00.000Z",
  });

  assert.equal(task.state, "waiting_for_user");
  assert.deepEqual(task.pendingApproval?.scope, ["tests/recovery.test.ts"]);
});

test("diff artifacts preserve structured file and line counts", () => {
  const task = TaskSchema.parse({
    id: "task_diff",
    deviceId: "mac_1",
    projectId: "project_1",
    projectName: "Project",
    runId: "run_1",
    agentId: "codex",
    agentName: "Codex",
    title: "Sync diff stats",
    state: "running",
    summary: "Editing",
    controlState: "managed",
    capabilities: ["diff"],
    artifacts: [{
      id: "diff_1",
      kind: "diff",
      title: "4 files changed",
      stats: { filesChanged: 4, additions: 234, deletions: 30 },
    }],
    history: [{
      id: "file_change_1",
      turnId: "run_1",
      kind: "file_change",
      text: "src/index.ts",
      diffStats: { filesChanged: 1, additions: 8, deletions: 2 },
    }],
    updatedAt: "2026-10-19T10:00:00.000Z",
  });

  assert.deepEqual(task.artifacts[0]?.stats, { filesChanged: 4, additions: 234, deletions: 30 });
  assert.deepEqual(task.history[0]?.diffStats, { filesChanged: 1, additions: 8, deletions: 2 });
});

test("commands are bounded by an explicit expiry", () => {
  const command = MobileCommandSchema.parse({
    protocolVersion: 1,
    commandId: "command_1",
    deviceId: "mac_1",
    taskId: "task_1",
    issuedAt: "2026-10-19T09:59:00.000Z",
    expiresAt: "2026-10-19T10:01:00.000Z",
    nonce: "nonce_1",
    action: { kind: "stop" },
  }) satisfies MobileCommand;

  assert.equal(isCommandExpired(command, now), false);
  assert.equal(isCommandExpired(command, new Date("2026-10-19T10:01:00.000Z")), true);
});

test("history commands preserve the requested pagination direction", () => {
  const command = MobileCommandSchema.parse({
    protocolVersion: 1,
    commandId: "command_history_1",
    deviceId: "mac_1",
    taskId: "task_1",
    issuedAt: "2026-10-19T09:59:00.000Z",
    expiresAt: "2026-10-19T10:01:00.000Z",
    nonce: "nonce_history_1",
    action: { kind: "request_history", direction: "older" },
  });

  assert.equal(command.action.kind, "request_history");
  if (command.action.kind === "request_history") assert.equal(command.action.direction, "older");
});

test("mobile clients can request a fresh device snapshot", () => {
  assert.deepEqual(ClientMessageSchema.parse({
    type: "mobile.refresh",
    deviceId: "mac_1",
  }), {
    type: "mobile.refresh",
    deviceId: "mac_1",
  });
});

test("hosts can report the final command result", () => {
  assert.deepEqual(ClientMessageSchema.parse({
    type: "host.command_result",
    deviceId: "mac_1",
    commandId: "command_1",
    status: "rejected",
    detail: "The selected project is no longer available",
  }), {
    type: "host.command_result",
    deviceId: "mac_1",
    commandId: "command_1",
    status: "rejected",
    detail: "The selected project is no longer available",
  });
});

test("new task commands preserve source, project, and initial prompt", () => {
  const command = MobileCommandSchema.parse({
    protocolVersion: 1,
    commandId: "command_new_task_1",
    deviceId: "mac_1",
    taskId: "pending_task_1",
    issuedAt: "2026-10-19T09:59:00.000Z",
    expiresAt: "2026-10-19T10:01:00.000Z",
    nonce: "nonce_new_task_1",
    action: {
      kind: "new_task",
      source: "claude",
      projectId: "project_1",
      text: "检查并修复测试失败",
    },
  });

  assert.deepEqual(command.action, {
    kind: "new_task",
    source: "claude",
    projectId: "project_1",
    text: "检查并修复测试失败",
  });
});

test("task history accepts an explicit failed-turn record", () => {
  const task = TaskSchema.parse({
    id: "task_failed",
    deviceId: "mac_1",
    projectId: "project_1",
    projectName: "Project",
    runId: "turn_failed",
    agentId: "codex",
    agentName: "Codex",
    title: "Failed task",
    state: "failed",
    summary: "Request failed",
    controlState: "available",
    capabilities: ["history"],
    artifacts: [],
    historyState: "loaded",
    history: [{
      id: "turn_error_turn_failed",
      turnId: "turn_failed",
      kind: "error",
      title: "执行失败",
      text: "Request failed",
      status: "failed",
    }],
    updatedAt: "2026-10-19T10:00:00.000Z",
  });

  assert.equal(task.history[0]?.kind, "error");
});

test("device snapshots preserve empty projects independently from tasks", () => {
  const snapshot = ServerMessageSchema.parse({
    type: "server.snapshot",
    deviceId: "mac_1",
    online: true,
    tasks: [],
    projects: [{ id: "project_1", name: "REA", order: 0 }],
    activeSources: ["codex"],
    lastSequence: 0,
  });

  assert.equal(snapshot.type, "server.snapshot");
  if (snapshot.type === "server.snapshot") {
    assert.equal(snapshot.projects[0]?.name, "REA");
    assert.deepEqual(snapshot.activeSources, ["codex"]);
  }
});

test("empty remote messages fail closed", () => {
  const result = MobileCommandSchema.safeParse({
    protocolVersion: 1,
    commandId: "command_2",
    deviceId: "mac_1",
    taskId: "task_1",
    issuedAt: "2026-10-19T09:59:00.000Z",
    expiresAt: "2026-10-19T10:01:00.000Z",
    nonce: "nonce_2",
    action: { kind: "message", text: "   " },
  });

  assert.equal(result.success, false);
});

test("message commands accept bounded image attachments", () => {
  const command = MobileCommandSchema.parse({
    protocolVersion: 1,
    commandId: "command_image_1",
    deviceId: "mac_1",
    taskId: "task_1",
    issuedAt: "2026-10-19T09:59:00.000Z",
    expiresAt: "2026-10-19T10:01:00.000Z",
    nonce: "nonce_image_1",
    action: {
      kind: "message",
      text: "请分析这张截图",
      attachments: [{
        id: "image_1",
        kind: "image",
        name: "screen.png",
        mediaType: "image/png",
        data: "aGVsbG8=",
      }],
    },
  });

  assert.equal(command.action.kind, "message");
  if (command.action.kind === "message") {
    assert.equal(command.action.attachments?.[0]?.name, "screen.png");
  }
});

test("image attachments reject unsupported formats", () => {
  const result = MobileCommandSchema.safeParse({
    protocolVersion: 1,
    commandId: "command_image_2",
    deviceId: "mac_1",
    taskId: "task_1",
    issuedAt: "2026-10-19T09:59:00.000Z",
    expiresAt: "2026-10-19T10:01:00.000Z",
    nonce: "nonce_image_2",
    action: {
      kind: "message",
      text: "查看附件",
      attachments: [{
        id: "image_2",
        kind: "image",
        name: "vector.svg",
        mediaType: "image/svg+xml",
        data: "PHN2Zz4=",
      }],
    },
  });

  assert.equal(result.success, false);
});

test("shared event reducer owns approval state transitions", () => {
  const task = TaskSchema.parse({
    id: "task_1",
    deviceId: "mac_1",
    projectId: "rea",
    projectName: "REA",
    runId: "run_1",
    agentId: "codex",
    agentName: "Codex",
    title: "Repair recovery tests",
    state: "running",
    summary: "Running",
    controlState: "managed",
    progress: 0.2,
    capabilities: ["message", "stop", "approval"],
    artifacts: [],
    updatedAt: "2026-10-19T10:00:00.000Z",
  });
  const approval = {
    id: "approval_1",
    title: "Write tests",
    summary: "No network",
    risk: "medium" as const,
    capability: "approval" as const,
    scope: ["tests/recovery.test.ts"],
    expiresAt: "2026-10-19T10:05:00.000Z",
  };
  const base = {
    protocolVersion: 1 as const,
    deviceId: "mac_1",
    taskId: "task_1",
    runId: "run_1",
  };
  const requested = WorkstationEventSchema.parse({
    ...base,
    type: "approval.requested",
    eventId: "event_1",
    sequence: 1,
    emittedAt: "2026-10-19T10:00:01.000Z",
    approval,
  });
  const resolved = WorkstationEventSchema.parse({
    ...base,
    type: "approval.resolved",
    eventId: "event_2",
    sequence: 2,
    emittedAt: "2026-10-19T10:00:02.000Z",
    approvalId: approval.id,
    decision: "approved",
  });

  const waiting = applyEventToTasks(new Map([[task.id, task]]), requested);
  assert.equal(waiting.get(task.id)?.state, "waiting_for_user");
  assert.equal(waiting.get(task.id)?.pendingApproval?.id, approval.id);

  const running = applyEventToTasks(waiting, resolved);
  assert.equal(running.get(task.id)?.state, "running");
  assert.equal(running.get(task.id)?.pendingApproval, undefined);

  const removed = applyEventToTasks(running, WorkstationEventSchema.parse({
    ...base,
    type: "task.removed",
    eventId: "event_3",
    sequence: 3,
    emittedAt: "2026-10-19T10:00:03.000Z",
  }));
  assert.equal(removed.has(task.id), false);
});

