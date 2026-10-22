import assert from "node:assert/strict";
import test from "node:test";

import { MobileCommandSchema } from "@ai-workstation/protocol";

import {
  CodexThreadSchema,
  CodexTurnSchema,
  CodexAgentAdapter,
  collapseOfficialClientFallbackHistory,
  codexExecArgs,
  codexThreadCliSeedParams,
  codexThreadStartParams,
  codexThreadToTask,
  codexTurnsToTimeline,
  codexTurnsToHistory,
  desktopDiffArtifactFromConversationState,
  diffStatsFromUnifiedDiff,
  unifiedDiffFromTurn,
  desktopApprovalFromConversationState,
  externalWriterReason,
  isActiveWriterError,
  isCurrentTurnCompletion,
  invalidateAppServerSessionState,
  isTransientEmptyRolloutError,
  mergeLatestTurnTimeline,
  prependHistoryPage,
  reconcileExternalActiveTurnId,
  reserveCliThread,
  rolloutLifecycleFromLines,
  shouldUseCodexExec,
  shouldSteerExternalTurn,
  writerThreadIdsFromLsof,
} from "./codex.js";

test("reserves a Codex thread while its CLI process is starting", () => {
  const active = new Map<string, unknown>();
  const starting = new Set<string>();
  const release = reserveCliThread("thread_1", active, starting);

  assert.throws(() => reserveCliThread("thread_1", active, starting), /仍在执行/);
  release();
  assert.doesNotThrow(() => reserveCliThread("thread_1", active, starting)());
  active.set("thread_1", {});
  assert.throws(() => reserveCliThread("thread_1", active, starting), /仍在执行/);
});

const baseThread = CodexThreadSchema.parse({
  id: "01a151bb-8c5f-7df1-98f7-d208060cabab",
  preview: "帮我开发一个 AI 工作站遥控器",
  projectId: null,
  model: "gpt-5",
  updatedAt: 1_792_381_279,
  status: { type: "notLoaded" },
  path: "/Users/hu/.codex/sessions/example.jsonl",
  cwd: "/Users/hu/data/github/ai-workstation-remote",
  canAcceptDirectInput: null,
  name: "开发 AI 工作站遥控器",
});

const baseProject = {
  id: "project_ai_workstation",
  name: "ai-workstation-remote",
  order: 0,
};

test("propagates command execution failures to the relay acknowledgement", async () => {
  const adapter = new CodexAgentAdapter();
  const task = codexThreadToTask(baseThread, { project: baseProject });
  (Reflect.get(adapter, "threads") as Map<string, typeof baseThread>).set(baseThread.id, baseThread);
  (Reflect.get(adapter, "tasks") as Map<string, typeof task>).set(baseThread.id, task);
  Reflect.set(adapter, "startCliTurn", async () => {
    throw new Error("CLI startup failed");
  });
  const command = MobileCommandSchema.parse({
    protocolVersion: 1,
    commandId: "command_send_failure",
    deviceId: "mobile_1",
    taskId: baseThread.id,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "nonce_send_failure",
    action: {
      kind: "message",
      text: "继续",
    },
  });

  await assert.rejects(adapter.handleCommand(command, () => undefined), /CLI startup failed/);
  const current = (Reflect.get(adapter, "tasks") as Map<string, typeof task>).get(baseThread.id);
  assert.match(current?.summary ?? "", /操作失败/);
});

test("invalidates only app-server-owned state after a disconnect", () => {
  const appTimer = setTimeout(() => undefined, 60_000);
  const managedThreads = new Set(["app_thread", "cli_thread"]);
  const activeTurnIds = new Map([
    ["app_thread", "app_turn"],
    ["cli_thread", "cli_turn"],
  ]);
  const pendingApprovals = new Map<string,
    | { source: "app_server"; timer: NodeJS.Timeout; id: string }
    | { source: "desktop"; id: string }
  >([
    ["app_approval", { source: "app_server", timer: appTimer, id: "app_approval" }],
    ["desktop_approval", { source: "desktop", id: "desktop_approval" }],
  ]);

  const invalidated = invalidateAppServerSessionState({
    managedThreads,
    activeTurnIds,
    cliManagedThreads: new Set(["cli_thread"]),
    cliTurns: new Map([["cli_thread", {}]]),
    pendingApprovals,
  });

  assert.deepEqual([...managedThreads], ["cli_thread"]);
  assert.deepEqual([...activeTurnIds], [["cli_thread", "cli_turn"]]);
  assert.deepEqual(invalidated.map((approval) => approval.id), ["app_approval"]);
  assert.deepEqual([...pendingApprovals.keys()], ["desktop_approval"]);
});

test("creates a Desktop-visible Codex thread before submitting through CLI resume", async () => {
  const adapter = new CodexAgentAdapter({ defaultCwd: "/workspace/repository" });
  Reflect.set(adapter, "projects", [baseProject]);
  (Reflect.get(adapter, "rootPathByProjectId") as Map<string, string>).set(
    baseProject.id,
    "/workspace/repository",
  );
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const lifecycle: string[] = [];
  Reflect.set(adapter, "client", {
    request: async (method: string, params?: Record<string, unknown>) => {
      requests.push(params ? { method, params } : { method });
      lifecycle.push(method);
      if (method === "project/list") {
        return {
          data: [{
            id: "server_project_ai_workstation",
            name: "ai-workstation-remote",
            roots: [{ path: "/workspace/repository" }],
          }],
          nextCursor: null,
        };
      }
      return { thread: { ...baseThread, cwd: "/workspace/repository" } };
    },
    stop: async () => {
      lifecycle.push("app-server/stop");
    },
  });
  let started: { cwd: string; text: string; threadId?: string } | undefined;
  Reflect.set(adapter, "startCliTurn", async (options: typeof started) => {
    lifecycle.push("cli/resume");
    started = options;
    return "thread_cli";
  });
  Reflect.set(adapter, "reconnectAfterCliHandoff", async () => {
    lifecycle.push("app-server/reconnect");
  });
  const command = MobileCommandSchema.parse({
    protocolVersion: 1,
    commandId: "command_create_1",
    deviceId: "mobile_1",
    taskId: "temporary_task_1",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "nonce_create_1",
    action: {
      kind: "new_task",
      source: "codex",
      projectId: baseProject.id,
      text: "检查项目",
    },
  });
  await adapter.createTask(command, () => undefined);

  assert.deepEqual(requests, [
    {
      method: "project/list",
      params: { cursor: null, limit: 100 },
    },
    {
      method: "thread/start",
      params: codexThreadStartParams("/workspace/repository", "server_project_ai_workstation"),
    },
    {
      method: "thread/inject_items",
      params: codexThreadCliSeedParams(baseThread.id),
    },
  ]);
  assert.deepEqual(started, {
    cwd: "/workspace/repository",
    text: "检查项目",
    threadId: baseThread.id,
    project: baseProject,
  });
  assert.equal(requests.some(({ method }) => method === "turn/start"), false);
  assert.deepEqual(lifecycle, [
    "project/list",
    "thread/start",
    "thread/inject_items",
    "app-server/stop",
    "cli/resume",
    "app-server/reconnect",
  ]);
  assert.equal((Reflect.get(adapter, "tasks") as Map<string, unknown>).has(baseThread.id), true);
});

test("does not surface a history error while a new thread is handed to Codex CLI", async () => {
  const adapter = new CodexAgentAdapter();
  const task = codexThreadToTask(baseThread, { project: baseProject });
  (Reflect.get(adapter, "threads") as Map<string, typeof baseThread>).set(baseThread.id, baseThread);
  (Reflect.get(adapter, "tasks") as Map<string, typeof task>).set(baseThread.id, task);
  (Reflect.get(adapter, "cliHandoffThreads") as Set<string>).add(baseThread.id);

  const loadHistoryPage = Reflect.get(adapter, "loadHistoryPage") as (
    taskId: string,
    direction: "latest" | "older",
  ) => Promise<void>;
  await loadHistoryPage.call(adapter, baseThread.id, "latest");

  const current = (Reflect.get(adapter, "tasks") as Map<string, typeof task>).get(baseThread.id);
  assert.equal(current?.historyState, "not_loaded");
  assert.equal(current?.historyError, undefined);
});

test("loads deferred history immediately after a Codex CLI handoff", async () => {
  const adapter = new CodexAgentAdapter();
  const task = codexThreadToTask(baseThread, { project: baseProject });
  (Reflect.get(adapter, "threads") as Map<string, typeof baseThread>).set(baseThread.id, baseThread);
  (Reflect.get(adapter, "tasks") as Map<string, typeof task>).set(baseThread.id, task);
  (Reflect.get(adapter, "cliHandoffThreads") as Set<string>).add(baseThread.id);
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  Reflect.set(adapter, "client", {
    request: async (method: string, params?: Record<string, unknown>) => {
      requests.push(params ? { method, params } : { method });
      return { data: [], nextCursor: null };
    },
  });

  const loadHistoryPage = Reflect.get(adapter, "loadHistoryPage") as (
    taskId: string,
    direction: "latest" | "older",
  ) => Promise<void>;
  await loadHistoryPage.call(adapter, baseThread.id, "latest");
  assert.equal(requests.length, 0);

  (Reflect.get(adapter, "cliHandoffThreads") as Set<string>).delete(baseThread.id);
  const flushDeferredHistoryLoads = Reflect.get(adapter, "flushDeferredHistoryLoads") as (
    taskId?: string,
  ) => Promise<void>;
  await flushDeferredHistoryLoads.call(adapter, baseThread.id);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "thread/turns/list");
  assert.equal((Reflect.get(adapter, "tasks") as Map<string, typeof task>).get(baseThread.id)?.historyState, "loaded");
});

test("uses lightweight background history reads until a conversation is opened", async () => {
  const adapter = new CodexAgentAdapter();
  const loadedThread = CodexThreadSchema.parse({ ...baseThread, id: "thread_loaded" });
  const unloadedTask = codexThreadToTask(baseThread);
  const loadedTask = { ...codexThreadToTask(loadedThread), historyState: "loaded" as const };
  (Reflect.get(adapter, "tasks") as Map<string, typeof unloadedTask>).set(baseThread.id, unloadedTask);
  (Reflect.get(adapter, "tasks") as Map<string, typeof unloadedTask>).set(loadedThread.id, loadedTask);
  const requests: Array<Record<string, unknown>> = [];
  Reflect.set(adapter, "client", {
    request: async (_method: string, params?: Record<string, unknown>) => {
      if (params) requests.push(params);
      return { data: [], nextCursor: null };
    },
  });

  const refreshHistories = Reflect.get(adapter, "refreshHistories") as (
    threads: readonly typeof baseThread[],
    polling: boolean,
  ) => Promise<void>;
  await refreshHistories.call(adapter, [baseThread, loadedThread], true);

  assert.equal(requests.find((params) => params.threadId === baseThread.id)?.itemsView, "summary");
  assert.equal(requests.find((params) => params.threadId === loadedThread.id)?.itemsView, "full");
});

test("shows a cached latest turn while the full history page is loading", async () => {
  const adapter = new CodexAgentAdapter();
  const task = codexThreadToTask(baseThread, { project: baseProject });
  const cachedTurn = CodexTurnSchema.parse({
    id: "turn_cached",
    status: "inProgress",
    startedAt: 1_792_383_000,
    completedAt: null,
    error: null,
    items: [
      { type: "userMessage", id: "user_cached", content: [{ type: "text", text: "先显示这条消息" }] },
      { type: "agentMessage", id: "agent_cached", text: "正在处理" },
    ],
  });
  (Reflect.get(adapter, "threads") as Map<string, typeof baseThread>).set(baseThread.id, baseThread);
  (Reflect.get(adapter, "tasks") as Map<string, typeof task>).set(baseThread.id, task);
  (Reflect.get(adapter, "latestTurns") as Map<string, typeof cachedTurn>).set(baseThread.id, cachedTurn);
  let resolveRequest!: (value: unknown) => void;
  Reflect.set(adapter, "client", {
    request: async () => await new Promise<unknown>((resolve) => {
      resolveRequest = resolve;
    }),
  });

  const loadHistoryPage = Reflect.get(adapter, "loadHistoryPage") as (
    taskId: string,
    direction: "latest" | "older",
  ) => Promise<void>;
  const loading = loadHistoryPage.call(adapter, baseThread.id, "latest");

  const interim = (Reflect.get(adapter, "tasks") as Map<string, typeof task>).get(baseThread.id);
  assert.equal(interim?.historyState, "loading");
  assert.deepEqual(interim?.history.map((entry) => entry.text), ["先显示这条消息", "正在处理"]);

  resolveRequest({ data: [cachedTurn], nextCursor: null });
  await loading;
  assert.equal((Reflect.get(adapter, "tasks") as Map<string, typeof task>).get(baseThread.id)?.historyState, "loaded");
});

test("continues an existing Codex task directly through CLI resume", async () => {
  const adapter = new CodexAgentAdapter();
  (Reflect.get(adapter, "threads") as Map<string, typeof baseThread>).set(baseThread.id, baseThread);
  let started: { cwd: string; text: string; threadId?: string } | undefined;
  Reflect.set(adapter, "startCliTurn", async (options: typeof started) => {
    started = options;
    return baseThread.id;
  });

  const sendMessage = Reflect.get(adapter, "sendMessage") as (taskId: string, text: string) => Promise<void>;
  await sendMessage.call(adapter, baseThread.id, "继续检查");

  assert.deepEqual(started, {
    cwd: baseThread.cwd,
    text: "继续检查",
    threadId: baseThread.id,
  });
});

test("recognizes an empty rollout as a transient history read", () => {
  assert.equal(isTransientEmptyRolloutError(new Error(
    "failed to read session metadata /tmp/rollout.jsonl: rollout at /tmp/rollout.jsonl is empty",
  )), true);
  assert.equal(isTransientEmptyRolloutError(new Error("permission denied")), false);
});

test("collapses an official-client rejection into its CLI retry", () => {
  const history = [
    { id: "failed_user", turnId: "turn_restricted", kind: "user_message" as const, text: "页面依旧不能发起任务呢" },
    {
      id: "failed_error",
      turnId: "turn_restricted",
      kind: "error" as const,
      text: "This account only allows Codex official clients",
    },
    { id: "retry_user", turnId: "turn_cli", kind: "user_message" as const, text: "页面依旧不能发起任务呢" },
    { id: "retry_agent", turnId: "turn_cli", kind: "agent_message" as const, text: "正在检查" },
  ];

  assert.deepEqual(
    collapseOfficialClientFallbackHistory(history).map((entry) => entry.id),
    ["retry_user", "retry_agent"],
  );
});

test("does not collapse a deliberate retry after an unrelated failure", () => {
  const history = [
    { id: "failed_user", turnId: "turn_failed", kind: "user_message" as const, text: "重新运行" },
    { id: "failed_error", turnId: "turn_failed", kind: "error" as const, text: "Provider overloaded" },
    { id: "retry_user", turnId: "turn_retry", kind: "user_message" as const, text: "重新运行" },
  ];

  assert.deepEqual(
    collapseOfficialClientFallbackHistory(history).map((entry) => entry.id),
    ["failed_user", "failed_error", "retry_user"],
  );
});

test("collapses a known fallback turn even when the persisted error is generic", () => {
  const history = [
    { id: "failed_user", turnId: "turn_restricted", kind: "user_message" as const, text: "继续检查" },
    { id: "failed_error", turnId: "turn_restricted", kind: "error" as const, text: "Upstream request failed" },
    { id: "retry_user", turnId: "turn_cli", kind: "user_message" as const, text: "继续检查" },
  ];

  assert.deepEqual(
    collapseOfficialClientFallbackHistory(history, new Set(["turn_restricted"])).map((entry) => entry.id),
    ["retry_user"],
  );
});

test("collapses an official-client fallback split across history pages", () => {
  const current = [
    { id: "retry_user", turnId: "turn_cli", kind: "user_message" as const, text: "继续检查" },
  ];
  const older = [
    { id: "failed_user", turnId: "turn_restricted", kind: "user_message" as const, text: "继续检查" },
    {
      id: "failed_error",
      turnId: "turn_restricted",
      kind: "error" as const,
      text: "This account only allows Codex official clients",
    },
  ];

  assert.deepEqual(prependHistoryPage(current, older).map((entry) => entry.id), ["retry_user"]);
});

test("starts a Codex CLI thread by local working directory without leaking the Desktop project id", () => {
  assert.deepEqual(codexExecArgs("/workspace/project"), [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "-C",
    "/workspace/project",
    "-",
  ]);
  assert.deepEqual(codexExecArgs("/workspace/project", baseThread.id), [
    "exec",
    "resume",
    "--json",
    baseThread.id,
    "-",
  ]);
});

test("restores CLI routing for persisted exec sessions after a companion restart", () => {
  const execThread = CodexThreadSchema.parse({ ...baseThread, originator: "codex_exec" });

  assert.equal(shouldUseCodexExec(execThread, false), true);
  assert.equal(shouldUseCodexExec(execThread, true), false);
  assert.equal(shouldUseCodexExec(baseThread, false), false);
});

test("maps a persisted Codex thread to an idle, resumable task", () => {
  const task = codexThreadToTask(baseThread, { project: baseProject });

  assert.equal(task.id, baseThread.id);
  assert.equal(task.projectName, "ai-workstation-remote");
  assert.equal(task.title, "开发 AI 工作站遥控器");
  assert.equal(task.state, "idle");
  assert.equal(task.controlState, "available");
  assert.deepEqual(task.capabilities, ["history", "message"]);
  assert.equal(task.historyState, "not_loaded");
});

test("keeps an unassigned thread projectless instead of inventing a project from cwd", () => {
  const task = codexThreadToTask({ ...baseThread, cwd: "/tmp/new-chat" });

  assert.equal(task.projectId, "projectless");
  assert.equal(task.projectName, "最近会话");
});

test("advertises stop and approval only for a managed active turn", () => {
  const approval = {
    id: "approval_7",
    title: "允许 Codex 执行终端命令？",
    summary: "命令将在本机执行",
    risk: "high" as const,
    capability: "approval" as const,
    scope: ["npm test"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const task = codexThreadToTask(
    { ...baseThread, status: { type: "active", activeFlags: ["waitingOnApproval"] } },
    { activeTurnId: "turn_1", pendingApproval: approval },
  );

  assert.equal(task.state, "waiting_for_user");
  assert.equal(task.controlState, "managed");
  assert.equal(task.runId, "turn_1");
  assert.deepEqual(task.capabilities, ["history", "message", "stop", "structured_tool_calls", "approval"]);
  assert.equal(task.pendingApproval?.scope[0], "npm test");
});

test("maps a Desktop-owned terminal request to a web approval", () => {
  const pending = desktopApprovalFromConversationState("thread-1", {
    requests: [{
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        command: ["python3", "migrate.py"],
        cwd: "/Users/hu/data/project",
        reason: "执行已审核的迁移脚本",
      },
    }],
  });

  assert.equal(pending?.source, "desktop");
  assert.equal(pending?.requestId, 41);
  assert.equal(pending?.turnId, "turn-1");
  assert.equal(pending?.approval.title, "允许 Codex 执行终端命令？");
  assert.deepEqual(pending?.approval.scope, ["python3 migrate.py", "/Users/hu/data/project"]);
});

test("maps persisted turn activity to real state, summary, and artifacts", () => {
  const turn = CodexTurnSchema.parse({
    id: "01a15259-93e8-7530-a36b-86d082c962b4",
    status: "completed",
    startedAt: 1_792_383_000,
    completedAt: 1_792_383_120,
    error: null,
    items: [
      { type: "userMessage", id: "user_1", content: [{ type: "text", text: "修好真实数据链路" }] },
      { type: "commandExecution", id: "cmd_1", command: "npm test", status: "completed" },
      {
        type: "fileChange",
        id: "file_1",
        status: "completed",
        changes: [
          { path: "apps/mobile/src/App.tsx", diff: "@@ -1,2 +1,3 @@\n old\n-removed\n+added\n+another" },
          { path: "apps/mac-companion/src/adapters/codex.ts", diff: "@@ -8 +8,2 @@\n keep\n+new" },
        ],
      },
      { type: "agentMessage", id: "agent_1", text: "真实数据链路已接通" },
    ],
  });

  const history = codexTurnsToHistory([turn]);

  assert.equal(history?.state, "succeeded");
  assert.equal(history?.summary, "真实数据链路已接通");
  assert.deepEqual(history?.artifacts.map((artifact) => artifact.kind), ["diff", "log", "test_report"]);
  assert.match(history?.artifacts[0]?.summary ?? "", /apps\/mobile\/src\/App.tsx/);
  assert.deepEqual(history?.artifacts[0]?.stats, { filesChanged: 2, additions: 3, deletions: 1 });
});

test("counts files and changed lines from a unified diff without counting headers", () => {
  const stats = diffStatsFromUnifiedDiff([
    "diff --git a/src/one.ts b/src/one.ts",
    "--- a/src/one.ts",
    "+++ b/src/one.ts",
    "@@ -1,2 +1,3 @@",
    " unchanged",
    "-old",
    "+new",
    "+another",
    "diff --git a/src/two.ts b/src/two.ts",
    "--- a/src/two.ts",
    "+++ b/src/two.ts",
    "@@ -4 +4 @@",
    "-before",
    "+after",
  ].join("\n"));

  assert.deepEqual(stats, { filesChanged: 2, additions: 3, deletions: 2 });
});

test("reconstructs a file-level unified diff from a Codex turn", () => {
  const diff = unifiedDiffFromTurn({
    id: "turn_diff",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    items: [{
      type: "fileChange",
      changes: [{ path: "/workspace/src/app.ts", diff: "@@ -1 +1 @@\n-old\n+new" }],
    }],
  }, "/workspace");
  assert.match(diff ?? "", /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.match(diff ?? "", /-old\n\+new/);
});

test("reads live code-change stats from a Desktop thread snapshot", () => {
  const result = desktopDiffArtifactFromConversationState({
    turnHistory: {
      history: {
        entitiesByKey: {
          "tail:0:local:turn": {
            turnId: "turn_desktop",
            turnStartedAtMs: 1_792_383_100,
            status: "inProgress",
            diff: null,
            items: [{
              type: "fileChange",
              changes: [
                { path: "/workspace/src/one.ts", diff: "@@ -1 +1,2 @@\n-old\n+new\n+next" },
                { path: "/workspace/src/two.ts", diff: "@@ -3 +3 @@\n-before\n+after" },
              ],
            }],
          },
        },
      },
    },
  });

  assert.equal(result?.turnId, "turn_desktop");
  assert.deepEqual(result?.artifact.stats, { filesChanged: 2, additions: 3, deletions: 2 });
});

test("keeps an interrupted externally-owned turn stopped even while its writer lock remains", () => {
  const turn = CodexTurnSchema.parse({
    id: "01a15259-93e8-7530-a36b-86d082c962b4",
    status: "interrupted",
    startedAt: 1_792_383_000,
    completedAt: null,
    error: null,
    items: [{ type: "userMessage", id: "user_1", content: [{ type: "text", text: "继续处理" }] }],
  });
  const history = codexTurnsToHistory([turn]);
  assert.ok(history);
  const task = codexThreadToTask(baseThread, {
    history,
    controlState: "external_writer",
    controlReason: "该会话正由 Codex 桌面端占用。",
  });

  assert.equal(task.state, "stopped");
  assert.equal(task.controlState, "external_writer");
  assert.deepEqual(task.capabilities, ["history"]);
  assert.match(task.controlReason ?? "", /桌面端占用/);
});

test("uses rollout lifecycle to distinguish active execution from a retained writer lock", () => {
  const started = rolloutLifecycleFromLines([
    JSON.stringify({ timestamp: "2026-10-19T05:43:24.710Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn_2" } }),
    JSON.stringify({ timestamp: "2026-10-19T05:43:25.000Z", type: "response_item", payload: { type: "message" } }),
  ].join("\n"));
  assert.deepEqual(started, {
    turnId: "turn_2",
    state: "running",
    observedAt: "2026-10-19T05:43:24.710Z",
  });

  const activeTask = codexThreadToTask(baseThread, {
    controlState: "external_writer",
    externalLifecycle: started,
    controlReason: externalWriterReason(true),
  });
  assert.equal(activeTask.state, "running");
  assert.equal(activeTask.runId, "turn_2");
  assert.deepEqual(activeTask.capabilities, ["history"]);
  assert.match(activeTask.controlReason ?? "", /正在执行/);

  const completed = rolloutLifecycleFromLines(
    JSON.stringify({ timestamp: "2026-10-19T05:44:24.710Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn_2", error: null } }),
    started,
  );
  assert.ok(completed);
  const completedTask = codexThreadToTask(baseThread, {
    controlState: "external_writer",
    externalLifecycle: completed,
    controlReason: externalWriterReason(false),
  });
  assert.equal(completedTask.state, "succeeded");
  assert.deepEqual(completedTask.capabilities, ["history"]);
  assert.match(completedTask.controlReason ?? "", /不会创建分支/);
});

test("allows same-thread messages when the Desktop IPC relay is available", () => {
  const task = codexThreadToTask(baseThread, {
    controlState: "external_writer",
    controlReason: externalWriterReason(false, true),
    canMessageViaExternalWriter: true,
  });

  assert.equal(task.controlState, "external_writer");
  assert.deepEqual(task.capabilities, ["history", "message"]);
  assert.match(task.controlReason ?? "", /同一会话/);
});

test("keeps a newer external turn active when an older turn completes", () => {
  assert.equal(reconcileExternalActiveTurnId("turn_2", {
    turnId: "turn_1",
    state: "stopped",
  }), "turn_2");
  assert.equal(reconcileExternalActiveTurnId("turn_2", {
    turnId: "turn_2",
    state: "succeeded",
  }), undefined);
  assert.equal(reconcileExternalActiveTurnId(undefined, {
    turnId: "turn_3",
    state: "running",
  }), "turn_3");
});

test("starts a new Desktop turn after the previous turn was stopped", () => {
  assert.equal(shouldSteerExternalTurn(undefined, {
    turnId: "turn_1",
    state: "stopped",
  }, "stopped"), false);
  assert.equal(shouldSteerExternalTurn("turn_2", {
    turnId: "turn_2",
    state: "running",
  }, "running"), true);
});

test("ignores a stale managed-turn completion after a newer turn starts", () => {
  assert.equal(isCurrentTurnCompletion("turn_2", "turn_1"), false);
  assert.equal(isCurrentTurnCompletion("turn_2", "turn_2"), true);
  assert.equal(isCurrentTurnCompletion(undefined, "turn_1"), true);
});

test("advertises stop for an externally owned turn controlled through Desktop IPC", () => {
  const task = codexThreadToTask(baseThread, {
    controlState: "external_writer",
    externalActiveTurnId: "turn_external",
    canMessageViaExternalWriter: true,
    canStopViaExternalWriter: true,
  });

  assert.equal(task.state, "running");
  assert.equal(task.runId, "turn_external");
  assert.deepEqual(task.capabilities, ["history", "message", "stop"]);
});

test("maps full turns to a chronological, bounded mobile timeline", () => {
  const later = CodexTurnSchema.parse({
    id: "turn_2",
    status: "completed",
    startedAt: 1_792_383_100,
    completedAt: 1_792_383_120,
    error: null,
    items: [
      { type: "commandExecution", id: "cmd_1", command: "npm test", status: "completed", aggregatedOutput: "12 tests passed" },
      { type: "agentMessage", id: "agent_commentary", text: "我正在核对测试结果", phase: "commentary" },
      { type: "agentMessage", id: "agent_2", text: "测试已经通过", phase: "final_answer" },
    ],
  });
  const earlier = CodexTurnSchema.parse({
    id: "turn_1",
    status: "completed",
    startedAt: 1_792_383_000,
    completedAt: 1_792_383_020,
    error: null,
    items: [
      { type: "userMessage", id: "user_1", content: [{ type: "text", text: "运行测试" }] },
      {
        type: "fileChange",
        id: "files_1",
        status: "completed",
        changes: [{ path: "/workspace/apps/mobile/src/App.tsx", diff: "@@ -1 +1,2 @@\n-old\n+new\n+next" }],
      },
    ],
  });

  const timeline = codexTurnsToTimeline([later, earlier], "/workspace");

  assert.deepEqual(timeline.map((entry) => entry.kind), ["user_message", "file_change", "command", "agent_message", "agent_message"]);
  assert.equal(timeline[0]?.text, "运行测试");
  assert.match(timeline[1]?.text ?? "", /apps\/mobile\/src\/App.tsx/);
  assert.deepEqual(timeline[1]?.diffStats, { filesChanged: 1, additions: 2, deletions: 1 });
  assert.match(timeline[2]?.text ?? "", /12 tests passed/);
  assert.equal(timeline[3]?.phase, "commentary");
  assert.equal(timeline[4]?.phase, "final_answer");
});

test("shows a failed turn error after its conversation entries", () => {
  const turn = CodexTurnSchema.parse({
    id: "turn_failed",
    status: "failed",
    startedAt: 1_792_383_100,
    completedAt: 1_792_383_120,
    error: {
      message: "stream disconnected before completion: Our servers are currently overloaded. Please try again later.",
      codexErrorInfo: "other",
    },
    items: [
      { type: "userMessage", id: "failed_user", content: [{ type: "text", text: "继续" }] },
      { type: "agentMessage", id: "failed_commentary", text: "正在重连", phase: "commentary" },
    ],
  });

  const timeline = codexTurnsToTimeline([turn]);

  assert.deepEqual(timeline.map((entry) => entry.kind), ["user_message", "agent_message", "error"]);
  assert.equal(timeline.at(-1)?.title, "执行失败");
  assert.match(timeline.at(-1)?.text ?? "", /servers are currently overloaded/);
  assert.equal(timeline.at(-1)?.createdAt, "2026-10-19T04:12:00.000Z");
});

test("history limit preserves the newest assistant result", () => {
  const older = CodexTurnSchema.parse({
    id: "turn_old",
    status: "completed",
    startedAt: 1_792_383_000,
    completedAt: 1_792_383_050,
    error: null,
    items: Array.from({ length: 1_000 }, (_, index) => ({
      type: "commandExecution",
      id: `old_${index}`,
      command: `echo ${index}`,
      status: "completed",
    })),
  });
  const latest = CodexTurnSchema.parse({
    id: "turn_latest",
    status: "completed",
    startedAt: 1_792_383_100,
    completedAt: 1_792_383_120,
    error: null,
    items: [
      { type: "userMessage", id: "latest_user", content: [{ type: "text", text: "修复消息记录" }] },
      { type: "commandExecution", id: "latest_tool", command: "npm test", status: "completed" },
      { type: "agentMessage", id: "latest_answer", text: "最新 AI 结果", phase: "final_answer" },
    ],
  });

  const timeline = codexTurnsToTimeline([latest, older]);

  assert.equal(timeline.length, 1_000);
  assert.equal(timeline.some((entry) => entry.id === "old_0"), false);
  assert.equal(timeline.some((entry) => entry.id === "latest_user"), true);
  assert.equal(timeline.at(-1)?.id, "latest_answer");
  assert.equal(timeline.at(-1)?.text, "最新 AI 结果");
});

test("replaces the latest turn snapshot while preserving earlier conversation history", () => {
  const existing = [
    { id: "old_user", turnId: "turn_old", kind: "user_message" as const, text: "上一轮问题" },
    { id: "old_answer", turnId: "turn_old", kind: "agent_message" as const, text: "上一轮回答" },
    { id: "live_placeholder", turnId: "turn_live", kind: "agent_message" as const, phase: "commentary" as const, text: "正在处理" },
  ];
  const latest = [
    { id: "live_user", turnId: "turn_live", kind: "user_message" as const, text: "继续处理" },
    { id: "live_reasoning", turnId: "turn_live", kind: "agent_message" as const, phase: "commentary" as const, text: "正在检查数据源" },
    { id: "live_command", turnId: "turn_live", kind: "command" as const, title: "运行命令", text: "$ npm test", status: "inProgress" },
  ];

  const merged = mergeLatestTurnTimeline(existing, "turn_live", latest);

  assert.deepEqual(merged.map((entry) => entry.id), ["old_user", "old_answer", "live_user", "live_reasoning", "live_command"]);
  assert.equal(merged.some((entry) => entry.id === "live_placeholder"), false);
});

test("replaces synthetic CLI history with the persisted Codex turn", () => {
  const existing = [
    { id: "cli_user", turnId: "cli_turn_123", kind: "user_message" as const, text: "检查项目" },
    { id: "cli_answer", turnId: "cli_turn_123", kind: "agent_message" as const, text: "检查完成" },
  ];
  const persisted = [
    { id: "real_user", turnId: "turn_real", kind: "user_message" as const, text: "检查项目" },
    { id: "real_answer", turnId: "turn_real", kind: "agent_message" as const, text: "检查完成" },
  ];

  const merged = mergeLatestTurnTimeline(existing, "turn_real", persisted);

  assert.deepEqual(merged.map((entry) => entry.id), ["real_user", "real_answer"]);
});

test("only replaces the most recent matching synthetic CLI turn", () => {
  const existing = [
    { id: "older_user", turnId: "cli_turn_older", kind: "user_message" as const, text: "再试一次" },
    { id: "older_answer", turnId: "cli_turn_older", kind: "agent_message" as const, text: "第一次完成" },
    { id: "latest_user", turnId: "cli_turn_latest", kind: "user_message" as const, text: "再试一次" },
  ];
  const persisted = [
    { id: "real_user", turnId: "turn_real", kind: "user_message" as const, text: "再试一次" },
    { id: "real_answer", turnId: "turn_real", kind: "agent_message" as const, text: "第二次完成" },
  ];

  const merged = mergeLatestTurnTimeline(existing, "turn_real", persisted);

  assert.deepEqual(merged.map((entry) => entry.id), ["older_user", "older_answer", "real_user", "real_answer"]);
});

test("prepends only unseen older history without exceeding the mobile safety bound", () => {
  const current = [
    { id: "current_1", turnId: "turn_current", kind: "user_message" as const, text: "当前页" },
  ];
  const older = [
    { id: "older_1", turnId: "turn_older", kind: "user_message" as const, text: "更早记录" },
    { id: "current_1", turnId: "turn_current", kind: "user_message" as const, text: "重复记录" },
  ];

  assert.deepEqual(
    prependHistoryPage(current, older).map((entry) => entry.id),
    ["older_1", "current_1"],
  );

  const full = Array.from({ length: 1_000 }, (_, index) => ({
    id: `entry_${index}`,
    turnId: `turn_${index}`,
    kind: "command" as const,
    text: `command ${index}`,
  }));
  assert.equal(prependHistoryPage(full, older).length, 1_000);
  assert.equal(prependHistoryPage(full, older)[0]?.id, "entry_0");
});

test("parses active writer locks without treating the coordination lock as a thread", () => {
  const ids = writerThreadIdsFromLsof([
    "p1237",
    "n/Users/hu/.codex/thread-writer-locks/01a151bb-8c5f-7df1-98f7-d208060cabab.lock",
    "n/Users/hu/.codex/thread-writer-locks/.coordination.lock",
  ].join("\n"));

  assert.deepEqual([...ids], ["01a151bb-8c5f-7df1-98f7-d208060cabab"]);
  assert.equal(isActiveWriterError(new Error("thread already has an active writer")), true);
});
