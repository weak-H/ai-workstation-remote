import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claudeProjectForSession,
  claudeSessionToTask,
  discoverRecentClaudeSessionFiles,
  parseClaudeProcessList,
  readClaudeSession,
} from "./claude.js";

test("selects recent Claude transcripts before parsing their contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-discovery-"));
  const project = join(directory, "project");
  await mkdir(project);
  const older = join(project, "older.jsonl");
  const newer = join(project, "newer.jsonl");
  await writeFile(older, "{}\n");
  await writeFile(newer, "{}\n");
  await utimes(older, new Date(1_000), new Date(1_000));
  await utimes(newer, new Date(2_000), new Date(2_000));

  try {
    const files = await discoverRecentClaudeSessionFiles(directory, 1);
    assert.deepEqual(files.map((file) => file.path), [newer]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("detects native and npm-installed Claude Code processes", () => {
  const snapshot = parseClaudeProcessList([
    "101 /Users/hu/.local/bin/claude --resume f16ab9f1-63b5-4ae8-8116-f67a09fbe0e3",
    "102 /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    "103 /usr/bin/node server.js --name claude-monitor",
  ].join("\n"));

  assert.equal(snapshot.running, true);
  assert.deepEqual([...snapshot.sessionIds], ["f16ab9f1-63b5-4ae8-8116-f67a09fbe0e3"]);
  assert.equal(snapshot.unidentifiedCount, 1);
  assert.equal(parseClaudeProcessList("103 /usr/bin/node server.js --name claude-monitor").running, false);
});

test("detects Claude Code processes on Windows", () => {
  const snapshot = parseClaudeProcessList([
    '\"C:\\Users\\Ada\\AppData\\Local\\Programs\\Claude\\claude.exe\" --resume 12345678-1234-1234-1234-123456789abc',
    'node.exe C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
  ].join("\n"));

  assert.equal(snapshot.running, true);
  assert.deepEqual([...snapshot.sessionIds], ["12345678-1234-1234-1234-123456789abc"]);
});

test("parses Claude Code JSONL into projects, tasks, turns, and tool activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-session-"));
  const path = join(directory, "session-1.jsonl");
  const records = [
    {
      type: "user",
      uuid: "user-1",
      sessionId: "session-1",
      cwd: "/Users/hu/data/github/ai-workstation-remote",
      timestamp: "2026-10-20T01:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "增加 Claude Code 的适配" }] },
    },
    {
      type: "assistant",
      uuid: "assistant-1",
      sessionId: "session-1",
      cwd: "/Users/hu/data/github/ai-workstation-remote",
      timestamp: "2026-10-20T01:00:01.000Z",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "先检查项目结构" },
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
          { type: "tool_use", name: "Edit", input: { file_path: "/tmp/src/claude.ts" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "tool-result-1",
      sessionId: "session-1",
      cwd: "/Users/hu/data/github/ai-workstation-remote",
      timestamp: "2026-10-20T01:00:02.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "tests passed" }] },
    },
    {
      type: "assistant",
      uuid: "assistant-2",
      sessionId: "session-1",
      cwd: "/Users/hu/data/github/ai-workstation-remote",
      timestamp: "2026-10-20T01:00:03.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "适配已完成" }] },
    },
  ];
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  try {
    const session = await readClaudeSession(path);
    assert.ok(session);
    assert.equal(session.id, "session-1");
    assert.equal(session.title, "增加 Claude Code 的适配");
    assert.equal(session.summary, "适配已完成");
    assert.equal(session.state, "succeeded");
    assert.deepEqual(session.history.map((entry) => entry.kind), [
      "user_message",
      "reasoning",
      "command",
      "file_change",
      "tool",
      "agent_message",
    ]);
    assert.equal(new Set(session.history.map((entry) => entry.turnId)).size, 1);
    assert.equal(session.turnTimings[0]?.completedAt, "2026-10-20T01:00:03.000Z");
    assert.equal(session.artifacts[0]?.title, "代码变更 · 1 个文件");

    const project = claudeProjectForSession(session);
    const task = claudeSessionToTask(session, project, { cliAvailable: true });
    assert.equal(project.name, "Claude Code · ai-workstation-remote");
    assert.equal(project.source, "claude");
    assert.equal(task.id, "claude_session-1");
    assert.equal(task.agentName, "Claude Code");
    assert.equal(task.controlState, "available");
    assert.deepEqual(task.capabilities, ["history", "message", "diff"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps externally-owned Claude sessions read-only and exposes stop only for managed turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-state-"));
  const path = join(directory, "session-2.jsonl");
  await writeFile(path, `${JSON.stringify({
    type: "user",
    uuid: "user-2",
    sessionId: "session-2",
    cwd: "/tmp/project",
    timestamp: "2026-10-20T01:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "继续任务" }] },
  })}\n`);

  try {
    const session = await readClaudeSession(path);
    assert.ok(session);
    const project = claudeProjectForSession(session);
    const external = claudeSessionToTask(session, project, { cliAvailable: true, externalWriter: true });
    const managed = claudeSessionToTask(session, project, { cliAvailable: true, managed: true });
    const unavailable = claudeSessionToTask(session, project, { cliAvailable: false });

    assert.equal(external.state, "running");
    assert.equal(external.controlState, "external_writer");
    assert.deepEqual(external.capabilities, ["history"]);
    assert.equal(managed.controlState, "managed");
    assert.deepEqual(managed.capabilities, ["history", "stop"]);
    assert.equal(unavailable.controlState, "unavailable");
    assert.deepEqual(unavailable.capabilities, ["history"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
