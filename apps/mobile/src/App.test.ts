import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSource, Task, WorkstationProject } from "@ai-workstation/protocol";
import { newTaskInitialProjectId, pairingTokenFromLocation, parseUnifiedDiff, resistedPullDistance, resolveRelayUrl, routeFromHistoryState, taskCountsBySource, taskDiffStats, taskLiveSummary, workbenchSource } from "./App.js";

function task(agentId: string, agentName: string, state: Task["state"]): Task {
  return { agentId, agentName, state } as Task;
}

test("counts active and total tasks in each agent tab", () => {
  const counts = taskCountsBySource([
    task("codex-local", "Codex", "running"),
    task("codex-local", "Codex", "waiting_for_user"),
    task("codex-local", "Codex", "succeeded"),
    task("cursor-local", "Cursor", "running"),
    task("cursor-local", "Cursor", "idle"),
    task("claude-local", "Claude Code", "running"),
    task("claude-local", "Claude Code", "succeeded"),
  ]);

  assert.deepEqual(counts, {
    codex: { running: 2, total: 3 },
    cursor: { running: 1, total: 2 },
    claude: { running: 1, total: 2 },
  });
});

test("keeps the selected workbench source when returning from task details", () => {
  const available: AgentSource[] = ["codex", "cursor", "claude"];

  assert.equal(workbenchSource("cursor", available), "cursor");
  assert.equal(workbenchSource("codex", available), "codex");
  assert.equal(workbenchSource("claude", available), "claude");
  assert.equal(workbenchSource(null, available), "codex");
  assert.equal(workbenchSource("cursor", ["codex"]), "codex");
});

test("only defaults top-level new tasks to a project when the source requires one", () => {
  const projects = [{ id: "project_1" }] as WorkstationProject[];

  assert.equal(newTaskInitialProjectId("codex", undefined, projects), "");
  assert.equal(newTaskInitialProjectId("claude", undefined, projects), "");
  assert.equal(newTaskInitialProjectId("cursor", undefined, projects), "project_1");
  assert.equal(newTaskInitialProjectId("codex", "project_1", projects), "project_1");
});

test("reads pairing tokens from compact QR fragments and existing links", () => {
  const compactToken = "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456";
  assert.equal(pairingTokenFromLocation({ hash: `#${compactToken}`, search: "", pathname: "/" }), compactToken);
  assert.equal(pairingTokenFromLocation({ hash: "#token=fragment", search: "?token=query", pathname: "/" }), "fragment");
  assert.equal(pairingTokenFromLocation({ hash: "", search: "", pathname: `/${compactToken}` }), undefined);
  assert.equal(pairingTokenFromLocation({ hash: "", search: "", pathname: "/workbench" }), undefined);
});

test("uses the page origin for packaged relay ports", () => {
  const location = { protocol: "http:", host: "127.0.0.1:8788", hostname: "127.0.0.1" };
  assert.equal(resolveRelayUrl(location), "ws://127.0.0.1:8788/ws");
  assert.equal(resolveRelayUrl(location, undefined, true), "ws://127.0.0.1:8787/ws");
  assert.equal(resolveRelayUrl(location, "wss://relay.example/ws"), "wss://relay.example/ws");
});

test("reads valid app routes from browser history state", () => {
  assert.deepEqual(routeFromHistoryState({ "ai-workstation-route": { kind: "tab", tab: "workbench" } }), { kind: "tab", tab: "workbench" });
  assert.deepEqual(routeFromHistoryState({ "ai-workstation-route": { kind: "task", taskId: "task_1" } }), { kind: "task", taskId: "task_1" });
  assert.equal(routeFromHistoryState({ "ai-workstation-route": { kind: "tab", tab: "unknown" } }), undefined);
  assert.equal(routeFromHistoryState({ "ai-workstation-route": { kind: "task", taskId: "" } }), undefined);
});

test("applies bounded resistance to pull-to-refresh gestures", () => {
  assert.equal(resistedPullDistance(-20), 0);
  assert.equal(resistedPullDistance(100), 55);
  assert.equal(resistedPullDistance(1_000), 104);
});

test("reads the latest structured code-change stats for task details", () => {
  const stats = taskDiffStats({
    artifacts: [
      { id: "old", kind: "diff", title: "Earlier change", stats: { filesChanged: 1, additions: 2, deletions: 0 } },
      { id: "log", kind: "log", title: "Tests" },
      { id: "latest", kind: "diff", title: "Current change", stats: { filesChanged: 4, additions: 234, deletions: 30 } },
    ],
  });

  assert.deepEqual(stats, { filesChanged: 4, additions: 234, deletions: 30 });
});

test("groups unified diff content by changed file", () => {
  const files = parseUnifiedDiff([
    "diff --git a/src/one.ts b/src/one.ts",
    "--- a/src/one.ts",
    "+++ b/src/one.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/two.ts b/src/two.ts",
    "--- a/src/two.ts",
    "+++ b/src/two.ts",
    "@@ -0,0 +1 @@",
    "+next",
  ].join("\n"));
  assert.deepEqual(files.map((file) => file.path), ["src/one.ts", "src/two.ts"]);
  assert.equal(files[0]?.lines.at(-1), "+new");
});

test("merges repeated patches for the same file", () => {
  const files = parseUnifiedDiff([
    "diff --git a/src/app.ts b/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "+first",
    "diff --git a/src/app.ts b/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -2 +2 @@",
    "+second",
  ].join("\n"));
  assert.equal(files.length, 1);
  assert.match(files[0]?.lines.join("\n") ?? "", /\+first[\s\S]*\+second/);
});

test("only shows the live summary before the active turn has work activity", () => {
  const liveTask = {
    state: "running" as const,
    runId: "turn_active",
    summary: "Codex Desktop 正在处理任务",
    history: [{
      id: "user_1",
      turnId: "turn_active",
      kind: "user_message" as const,
      text: "修复",
    }],
  };

  assert.equal(taskLiveSummary(liveTask), "Codex Desktop 正在处理任务");
  assert.equal(taskLiveSummary({
    ...liveTask,
    history: [...liveTask.history, {
      id: "reasoning_1",
      turnId: "turn_active",
      kind: "reasoning" as const,
      text: "正在检查代码",
    }],
  }), undefined);
});
