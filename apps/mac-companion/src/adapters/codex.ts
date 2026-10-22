import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import {
  TaskSchema,
  WorkstationEventSchema,
  createId,
  type AgentCapability,
  type Approval,
  type Artifact,
  type DiffStats,
  type MobileCommand,
  type Task,
  type TaskControlState,
  type TaskHistoryEntry,
  type TaskHistoryState,
  type TaskState,
  type TaskTurnTiming,
  type WorkstationProject,
  type WorkstationEvent,
} from "@ai-workstation/protocol";
import { z } from "zod";

import {
  CodexAppServerClient,
  CodexRpcError,
  resolveCodexBin,
  type JsonObject,
  type JsonRpcId,
  type ServerNotificationMessage,
  type ServerRequestMessage,
} from "../codex-app-server.js";
import {
  CodexDesktopIpcClient,
  type DesktopApprovalMethod,
  type DesktopThreadStateSnapshot,
} from "../codex-desktop-ipc.js";
import { loadCodexDesktopState } from "../codex-desktop-state.js";
import {
  defaultCodexProjectOverridesPath,
  loadCodexProjectOverrides,
  saveCodexProjectOverrides,
} from "../codex-project-overrides.js";
import { artifactsWithDiffContent, boundedDiffContent, readWorkingTreeDiff } from "../working-tree-diff.js";
import type { AgentAdapter, EmitAvailability, EmitEvent, EmitProjects } from "./types.js";
import { workstationDeviceId } from "../platform.js";

const deviceId = workstationDeviceId;
const maxThreads = 30;
const refreshIntervalMs = 5_000;
const approvalTtlMs = 10 * 60_000;
const historyConcurrency = 4;
const initialHistoryThreadLimit = 12;
const refreshHistoryThreadLimit = 6;
const historyPageSize = 5;
const maxHistoryTurns = 200;
const maxHistoryEntries = 1_000;
const historyReadRetryDelaysMs = [100, 250, 500] as const;
const rolloutReadChunkBytes = 256 * 1_024;
const maxInitialRolloutScanBytes = 64 * 1_024 * 1_024;
const maxIncrementalRolloutReadBytes = 4 * 1_024 * 1_024;
const execFileAsync = promisify(execFile);

const ThreadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("systemError") }),
  z.object({
    type: z.literal("active"),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])),
  }),
]);

export const CodexThreadSchema = z.object({
  id: z.string().min(1),
  preview: z.string().catch(""),
  projectId: z.string().nullable().catch(null),
  model: z.string().nullable().catch(null),
  updatedAt: z.number(),
  status: ThreadStatusSchema,
  path: z.string().nullable().catch(null),
  cwd: z.string().min(1),
  canAcceptDirectInput: z.boolean().nullable().catch(null),
  name: z.string().nullable().catch(null),
  originator: z.string().nullable().optional(),
}).passthrough();

export type CodexThread = z.infer<typeof CodexThreadSchema>;

const ThreadListResponseSchema = z.object({
  data: z.array(CodexThreadSchema),
  nextCursor: z.string().nullable(),
}).passthrough();

const ThreadStartResponseSchema = z.object({
  thread: CodexThreadSchema,
}).passthrough();

const CodexProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  roots: z.array(z.object({ path: z.string().min(1) }).passthrough()),
}).passthrough();

const ProjectListResponseSchema = z.object({
  data: z.array(CodexProjectSchema),
  nextCursor: z.string().nullable(),
}).passthrough();

const ThreadItemSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
}).passthrough();

export const CodexTurnSchema = z.object({
  id: z.string().min(1),
  items: z.array(ThreadItemSchema).catch([]),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  error: z.unknown().nullable().optional(),
  startedAt: z.number().nullable().catch(null),
  completedAt: z.number().nullable().catch(null),
}).passthrough();

export type CodexTurn = z.infer<typeof CodexTurnSchema>;

const ThreadTurnsListResponseSchema = z.object({
  data: z.array(CodexTurnSchema),
  nextCursor: z.string().nullable().optional(),
}).passthrough();

export interface RolloutLifecycle {
  turnId: string;
  state: "running" | "succeeded" | "failed" | "stopped";
  observedAt?: string;
}

interface RolloutLifecycleCache {
  path: string;
  size: number;
  partial: string;
  lifecycle?: RolloutLifecycle;
}

export interface CodexHistorySnapshot {
  artifacts: Artifact[];
  runId: string;
  state: TaskState;
  summary: string;
  updatedAt?: string;
}

export function reconcileExternalActiveTurnId(
  activeTurnId: string | undefined,
  lifecycle: RolloutLifecycle | undefined,
): string | undefined {
  if (lifecycle?.state === "running") return lifecycle.turnId;
  if (lifecycle?.turnId === activeTurnId) return undefined;
  return activeTurnId;
}

export function shouldSteerExternalTurn(
  activeTurnId: string | undefined,
  lifecycle: RolloutLifecycle | undefined,
  taskState: TaskState | undefined,
): boolean {
  return Boolean(activeTurnId)
    || lifecycle?.state === "running"
    || taskState === "running"
    || taskState === "waiting_for_user";
}

export function isCurrentTurnCompletion(activeTurnId: string | undefined, completedTurnId: string): boolean {
  return activeTurnId === undefined || activeTurnId === completedTurnId;
}

interface AppServerPendingApproval {
  source: "app_server";
  approval: Approval;
  rpcId: JsonRpcId;
  method: DesktopApprovalMethod;
  taskId: string;
  turnId: string;
  timer: NodeJS.Timeout;
}

interface DesktopPendingApproval {
  source: "desktop";
  approval: Approval;
  requestId: JsonRpcId;
  method: DesktopApprovalMethod;
  taskId: string;
  turnId: string;
}

type PendingApproval = AppServerPendingApproval | DesktopPendingApproval;

type ConnectionScopedApproval =
  | { source: "app_server"; timer: NodeJS.Timeout }
  | { source: "desktop" };

export function invalidateAppServerSessionState<T extends ConnectionScopedApproval>(state: {
  managedThreads: Set<string>;
  activeTurnIds: Map<string, string>;
  cliManagedThreads: ReadonlySet<string>;
  cliTurns: ReadonlyMap<string, unknown>;
  pendingApprovals: Map<string, T>;
}): T[] {
  for (const threadId of state.managedThreads) {
    if (!state.cliManagedThreads.has(threadId)) state.managedThreads.delete(threadId);
  }
  for (const threadId of state.activeTurnIds.keys()) {
    if (!state.cliTurns.has(threadId)) state.activeTurnIds.delete(threadId);
  }

  const invalidatedApprovals: T[] = [];
  for (const [approvalId, pending] of state.pendingApprovals) {
    if (pending.source !== "app_server") continue;
    clearTimeout(pending.timer);
    state.pendingApprovals.delete(approvalId);
    invalidatedApprovals.push(pending);
  }
  return invalidatedApprovals;
}

interface CodexCliTurn {
  child: ChildProcessWithoutNullStreams;
  runId: string;
  stderr: string[];
  stopping: boolean;
}

export function reserveCliThread(
  threadId: string,
  active: ReadonlyMap<string, unknown>,
  starting: Set<string>,
): () => void {
  if (active.has(threadId) || starting.has(threadId)) {
    throw new Error("当前 Codex 回合仍在执行，请先停止或等待完成");
  }
  starting.add(threadId);
  return () => starting.delete(threadId);
}

function shortText(value: string, limit = 1_800): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function boundedText(value: string, limit = 8_000): string {
  const normalized = value.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

export function desktopApprovalFromConversationState(
  conversationId: string,
  conversationState: JsonObject,
): DesktopPendingApproval | undefined {
  if (!Array.isArray(conversationState.requests)) return undefined;
  for (const value of [...conversationState.requests].reverse()) {
    const request = objectValue(value);
    const method = stringValue(request?.method);
    if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") continue;
    const requestId = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : undefined;
    const params = objectValue(request?.params);
    const turnId = stringValue(params?.turnId);
    if (requestId === undefined || !turnId) continue;
    const isCommand = method === "item/commandExecution/requestApproval";
    const rawCommand = params?.command;
    const command = typeof rawCommand === "string"
      ? rawCommand
      : Array.isArray(rawCommand) && rawCommand.every((part) => typeof part === "string")
        ? rawCommand.join(" ")
        : undefined;
    const cwd = stringValue(params?.cwd);
    const reason = stringValue(params?.reason);
    const grantRoot = stringValue(params?.grantRoot);
    const scope = [command, grantRoot, cwd]
      .filter((item): item is string => Boolean(item))
      .map((item) => shortText(item, 300));
    return {
      source: "desktop",
      requestId,
      method,
      taskId: conversationId,
      turnId,
      approval: {
        id: `desktop_approval_${String(requestId)}`,
        title: isCommand ? "允许 Codex 执行终端命令？" : "允许 Codex 修改文件？",
        summary: shortText(reason ?? (isCommand ? "命令将在本机按当前沙箱策略执行" : "修改将应用到当前工作区")),
        risk: isCommand ? "high" : "medium",
        capability: "approval",
        scope: scope.length > 0 ? scope : [isCommand ? "终端命令" : "工作区文件修改"],
        expiresAt: new Date(Date.now() + approvalTtlMs).toISOString(),
      },
    };
  }
  return undefined;
}

function itemText(item: z.infer<typeof ThreadItemSchema>): string | undefined {
  if (item.type === "agentMessage") return stringValue(item.text);
  if (item.type !== "userMessage" || !Array.isArray(item.content)) return undefined;
  const parts = item.content
    .map((content) => objectValue(content))
    .filter((content): content is JsonObject => content?.type === "text")
    .map((content) => stringValue(content.text))
    .filter((text): text is string => Boolean(text));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function turnState(turn: CodexTurn): TaskState {
  if (turn.status === "inProgress") return "running";
  if (turn.status === "completed") return "succeeded";
  if (turn.status === "failed") return "failed";
  return "stopped";
}

export function rolloutLifecycleFromLines(
  text: string,
  previous?: RolloutLifecycle,
): RolloutLifecycle | undefined {
  let lifecycle = previous;
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"event_msg"')) continue;
    try {
      const record = objectValue(JSON.parse(line));
      if (record?.type !== "event_msg") continue;
      const payload = objectValue(record.payload);
      const type = stringValue(payload?.type);
      if (type !== "task_started" && type !== "turn_started" && type !== "task_complete" && type !== "turn_complete" && type !== "turn_aborted") continue;
      const turnId = stringValue(payload?.turn_id);
      if (!turnId) continue;
      lifecycle = {
        turnId,
        state: type === "task_started" || type === "turn_started"
          ? "running"
          : type === "turn_aborted"
            ? "stopped"
            : payload?.error == null
              ? "succeeded"
              : "failed",
        ...(typeof record.timestamp === "string" ? { observedAt: record.timestamp } : {}),
      };
    } catch {
      // Rollout lines outside the lifecycle contract are intentionally ignored.
    }
  }
  return lifecycle;
}

async function readRolloutRange(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function scanLatestRolloutLifecycle(path: string, size: number): Promise<RolloutLifecycle | undefined> {
  const lowerBound = Math.max(0, size - maxInitialRolloutScanBytes);
  const handle = await open(path, "r");
  try {
    let cursor = size;
    let suffix = "";
    while (cursor > lowerBound) {
      const start = Math.max(lowerBound, cursor - rolloutReadChunkBytes);
      const buffer = Buffer.allocUnsafe(cursor - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const combined = `${buffer.subarray(0, bytesRead).toString("utf8")}${suffix}`;
      const lines = combined.split("\n");
      suffix = lines.shift() ?? "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const lifecycle = rolloutLifecycleFromLines(lines[index] ?? "");
        if (lifecycle) return lifecycle;
      }
      cursor = start;
    }
    return lowerBound === 0 ? rolloutLifecycleFromLines(suffix) : undefined;
  } finally {
    await handle.close();
  }
}

function displayArtifactPath(path: string, workspaceRoot?: string): string {
  if (workspaceRoot && path.startsWith(`${workspaceRoot}/`)) {
    return path.slice(workspaceRoot.length + 1);
  }
  const parts = path.split("/").filter(Boolean);
  const ownedRoot = Math.max(parts.lastIndexOf("apps"), parts.lastIndexOf("packages"), parts.lastIndexOf("services"));
  if (ownedRoot >= 0) return parts.slice(ownedRoot).join("/");
  return parts.length > 4 ? `…/${parts.slice(-4).join("/")}` : path;
}

export function diffStatsFromUnifiedDiff(diff: string): DiffStats {
  let additions = 0;
  let deletions = 0;
  let diffFileCount = 0;
  const headerPaths = new Set<string>();
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      diffFileCount += 1;
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).split("\t", 1)[0];
      if (path && path !== "/dev/null") headerPaths.add(path);
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }

  return {
    filesChanged: diffFileCount || headerPaths.size,
    additions,
    deletions,
  };
}

function fileChangeStats(items: readonly unknown[]): DiffStats | undefined {
  const paths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let diffFiles = 0;
  let hasDiff = false;

  for (const rawItem of items) {
    const item = objectValue(rawItem);
    if (item?.type !== "fileChange" || !Array.isArray(item.changes)) continue;
    for (const rawChange of item.changes) {
      const change = objectValue(rawChange);
      const path = stringValue(change?.path);
      if (path) paths.add(path);
      const diff = stringValue(change?.diff);
      if (!diff) continue;
      hasDiff = true;
      const stats = diffStatsFromUnifiedDiff(diff);
      diffFiles += stats.filesChanged;
      additions += stats.additions;
      deletions += stats.deletions;
    }
  }

  return hasDiff ? { filesChanged: paths.size || diffFiles, additions, deletions } : undefined;
}

export function unifiedDiffFromTurn(turn: CodexTurn, workspaceRoot?: string): string | undefined {
  const completeDiff = stringValue(turn.diff);
  if (completeDiff) return completeDiff;
  const patches: string[] = [];
  for (const rawItem of turn.items) {
    const item = objectValue(rawItem);
    if (item?.type !== "fileChange" || !Array.isArray(item.changes)) continue;
    for (const rawChange of item.changes) {
      const change = objectValue(rawChange);
      const diff = stringValue(change?.diff);
      if (!diff) continue;
      if (diff.startsWith("diff --git ")) {
        patches.push(diff);
        continue;
      }
      const rawPath = stringValue(change?.path) ?? "changed-file";
      const path = displayArtifactPath(rawPath, workspaceRoot).replace(/^…\//, "");
      patches.push([
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        diff,
      ].join("\n"));
    }
  }
  return patches.length > 0 ? patches.join("\n\n") : undefined;
}

export function desktopDiffArtifactFromConversationState(
  conversationState: JsonObject,
): { turnId: string; artifact: Artifact } | undefined {
  const turnHistory = objectValue(conversationState.turnHistory);
  const history = objectValue(turnHistory?.history);
  const entities = objectValue(history?.entitiesByKey);
  if (!entities) return undefined;

  const turns = Object.values(entities)
    .map((value) => objectValue(value))
    .filter((value): value is JsonObject => Boolean(value && Array.isArray(value.items)));
  const turn = turns.reduce<JsonObject | undefined>((latest, candidate) => {
    const candidateStartedAt = typeof candidate.turnStartedAtMs === "number" ? candidate.turnStartedAtMs : 0;
    const latestStartedAt = typeof latest?.turnStartedAtMs === "number" ? latest.turnStartedAtMs : 0;
    return !latest || candidateStartedAt >= latestStartedAt ? candidate : latest;
  }, undefined);
  const turnId = stringValue(turn?.turnId);
  if (!turnId || !Array.isArray(turn?.items)) return undefined;

  const completeDiff = stringValue(turn.diff);
  const stats = completeDiff ? diffStatsFromUnifiedDiff(completeDiff) : fileChangeStats(turn.items);
  if (!stats || stats.filesChanged === 0) return undefined;
  return {
    turnId,
    artifact: {
      id: `diff_${turnId}`,
      kind: "diff",
      title: `代码变更 · ${stats.filesChanged} 个文件`,
      summary: `+${stats.additions} / -${stats.deletions} 行`,
      stats,
    },
  };
}

export function codexTurnsToHistory(
  turns: readonly CodexTurn[],
  workspaceRoot?: string,
): CodexHistorySnapshot | undefined {
  const latest = turns[0];
  if (!latest) return undefined;

  const agentSummary = [...latest.items]
    .reverse()
    .find((item) => item.type === "agentMessage" && Boolean(itemText(item)));
  const userSummary = [...latest.items]
    .reverse()
    .find((item) => item.type === "userMessage" && Boolean(itemText(item)));
  const error = objectValue(latest.error);
  const errorMessage = stringValue(error?.message);
  const summary = shortText(
    itemText(agentSummary ?? userSummary ?? { type: "unknown" })
      ?? errorMessage
      ?? (latest.status === "inProgress" ? "Codex 正在处理任务" : latest.status === "completed" ? "Codex 回合已完成" : latest.status === "failed" ? "Codex 回合失败" : "Codex 回合已停止"),
  );

  const filePaths = new Set<string>();
  const commands: z.infer<typeof ThreadItemSchema>[] = [];
  for (const item of latest.items) {
    if (item.type === "fileChange" && Array.isArray(item.changes)) {
      for (const rawChange of item.changes) {
        const path = stringValue(objectValue(rawChange)?.path);
        if (path) filePaths.add(path);
      }
    }
    if (item.type === "commandExecution") commands.push(item);
  }

  const artifacts: Artifact[] = [];
  if (filePaths.size > 0) {
    const paths = [...filePaths];
    const stats = fileChangeStats(latest.items);
    const displayPaths = paths.map((path) => displayArtifactPath(path, workspaceRoot));
    const preview = displayPaths.slice(0, 4).join("、");
    const remaining = displayPaths.length - 4;
    artifacts.push({
      id: `history_${latest.id}_files`,
      kind: "diff",
      title: `代码变更 · ${paths.length} 个文件`,
      summary: shortText(`${preview}${remaining > 0 ? `，另 ${remaining} 个` : ""}`, 1_000),
      ...(stats ? { stats } : {}),
    });
  }
  if (commands.length > 0) {
    const failures = commands.filter((item) => item.status === "failed" || item.status === "declined").length;
    const running = commands.filter((item) => item.status === "inProgress").length;
    const status = [
      `${commands.length} 条命令`,
      failures > 0 ? `${failures} 条失败` : undefined,
      running > 0 ? `${running} 条执行中` : undefined,
    ].filter(Boolean).join("，");
    artifacts.push({
      id: `history_${latest.id}_commands`,
      kind: "log",
      title: "终端执行",
      summary: status,
    });

    const tests = commands.filter((item) => /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|(?:^|\s)(?:pytest|cargo\s+test|go\s+test|vitest|jest)\b/i.test(stringValue(item.command) ?? ""));
    if (tests.length > 0) {
      const testFailures = tests.filter((item) => item.status === "failed" || item.status === "declined").length;
      artifacts.push({
        id: `history_${latest.id}_tests`,
        kind: "test_report",
        title: "测试执行",
        summary: `${tests.length} 次测试命令${testFailures > 0 ? `，${testFailures} 次失败` : "，未记录失败"}`,
      });
    }
  }

  const timestamp = latest.completedAt ?? latest.startedAt;
  return {
    artifacts,
    runId: latest.id,
    state: turnState(latest),
    summary,
    ...(timestamp === null ? {} : { updatedAt: new Date(timestamp * 1_000).toISOString() }),
  };
}

export function externalWriterReason(
  isExecuting: boolean,
  canRelay = false,
): string {
  if (canRelay) {
    return isExecuting
      ? "Codex Desktop 正在执行这个会话。手机端可发送后续消息，消息和进展会在同一会话中同步。"
      : "Codex Desktop 持有这个会话；手机消息会经本机控制通道在同一会话中继续，不会创建分支。";
  }
  return isExecuting
    ? "Codex Desktop 正在执行这个会话。手机端会同步进展，但不能同时发送指令。"
    : "Codex Desktop 持有同一会话的写权限。手机端会继续同步历史；接入同会话控制通道前暂不能发送，也不会创建分支。";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const object = objectValue(entry);
    const text = stringValue(object?.text) ?? stringValue(object?.summary) ?? stringValue(object?.content);
    return text ? [text] : [];
  });
}

function historyItemText(item: z.infer<typeof ThreadItemSchema>): string {
  const direct = itemText(item) ?? stringValue(item.text) ?? stringValue(item.message);
  if (direct) return direct;
  return stringList(item.summary).join("\n") || stringList(item.content).join("\n");
}

function turnErrorMessage(turn: CodexTurn): string | undefined {
  if (typeof turn.error === "string") return turn.error;
  const error = objectValue(turn.error);
  return stringValue(error?.message) ?? stringValue(error?.details);
}

export function codexTurnsToTimeline(
  turns: readonly CodexTurn[],
  workspaceRoot?: string,
): TaskHistoryEntry[] {
  const orderedTurns = [...turns].sort((left, right) => (
    (left.startedAt ?? left.completedAt ?? 0) - (right.startedAt ?? right.completedAt ?? 0)
  ));
  const newestFirst: TaskHistoryEntry[] = [];

  // The protocol bounds history at 1,000 entries. Walk backward so the bound
  // removes stale context instead of the latest assistant result.
  for (let turnIndex = orderedTurns.length - 1; turnIndex >= 0 && newestFirst.length < maxHistoryEntries; turnIndex -= 1) {
    const turn = orderedTurns[turnIndex];
    if (!turn) continue;
    const turnDiffStats = fileChangeStats(turn.items);
    let diffStatsAttached = false;
    const timestamp = turn.startedAt ?? turn.completedAt;
    const createdAt = timestamp === null ? undefined : new Date(timestamp * 1_000).toISOString();
    const errorMessage = turnErrorMessage(turn);
    if (turn.status === "failed" && errorMessage && newestFirst.length < maxHistoryEntries) {
      const completedAt = turn.completedAt === null
        ? createdAt
        : new Date(turn.completedAt * 1_000).toISOString();
      newestFirst.push({
        id: `turn_error_${turn.id}`,
        turnId: turn.id,
        kind: "error",
        title: "执行失败",
        text: boundedText(errorMessage),
        status: "failed",
        ...(completedAt ? { createdAt: completedAt } : {}),
      });
    }
    for (let index = turn.items.length - 1; index >= 0 && newestFirst.length < maxHistoryEntries; index -= 1) {
      const item = turn.items[index];
      if (!item) continue;
      const id = item.id ?? `${turn.id}_${index}`;
      const base = {
        id,
        turnId: turn.id,
        ...(createdAt ? { createdAt } : {}),
        ...(typeof item.status === "string" ? { status: item.status } : {}),
      };

      if (item.type === "userMessage") {
        newestFirst.push({ ...base, kind: "user_message", text: boundedText(historyItemText(item)) });
        continue;
      }
      if (item.type === "agentMessage") {
        const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
        newestFirst.push({
          ...base,
          kind: "agent_message",
          text: boundedText(historyItemText(item)),
          ...(phase ? { phase } : {}),
        });
        continue;
      }
      if (item.type === "reasoning") {
        const text = historyItemText(item);
        if (text) newestFirst.push({ ...base, kind: "reasoning", title: "思考摘要", text: boundedText(text) });
        continue;
      }
      if (item.type === "commandExecution") {
        const command = stringValue(item.command) ?? (stringList(item.command).join(" ") || "终端命令");
        const output = stringValue(item.aggregatedOutput) ?? stringValue(item.output);
        newestFirst.push({
          ...base,
          kind: "command",
          title: shortText(command, 200),
          text: boundedText(output ? `$ ${command}\n\n${output}` : `$ ${command}`),
        });
        continue;
      }
      if (item.type === "fileChange") {
        const paths = Array.isArray(item.changes)
          ? item.changes.map((change) => stringValue(objectValue(change)?.path)).filter((path): path is string => Boolean(path))
          : [];
        const diffStats = !diffStatsAttached ? turnDiffStats : undefined;
        if (diffStats) diffStatsAttached = true;
        newestFirst.push({
          ...base,
          kind: "file_change",
          title: `代码变更 · ${paths.length} 个文件`,
          text: boundedText(paths.map((path) => displayArtifactPath(path, workspaceRoot)).join("\n") || "未提供文件路径"),
          ...(diffStats ? { diffStats } : {}),
        });
        continue;
      }
      if (item.type === "plan") {
        newestFirst.push({ ...base, kind: "plan", title: "执行计划", text: boundedText(historyItemText(item)) });
        continue;
      }
      if (item.type === "contextCompaction") {
        newestFirst.push({ ...base, kind: "system", title: "上下文已压缩", text: "Codex 已压缩较早的上下文以继续工作。" });
        continue;
      }

      const server = stringValue(item.server) ?? stringValue(item.serverName);
      const tool = stringValue(item.tool) ?? stringValue(item.toolName) ?? stringValue(item.name);
      const title = [server, tool].filter(Boolean).join(" · ") || item.type;
      const text = historyItemText(item) || stringValue(item.error) || "已记录工具活动";
      newestFirst.push({ ...base, kind: "tool", title: shortText(title, 200), text: boundedText(text) });
    }
  }
  return collapseOfficialClientFallbackHistory(newestFirst.reverse());
}

export function collapseOfficialClientFallbackHistory(
  history: readonly TaskHistoryEntry[],
  suppressedTurnIds: ReadonlySet<string> = new Set(),
): TaskHistoryEntry[] {
  const turnOrder: string[] = [];
  const entriesByTurn = new Map<string, TaskHistoryEntry[]>();
  for (const entry of history) {
    const entries = entriesByTurn.get(entry.turnId);
    if (entries) {
      entries.push(entry);
    } else {
      turnOrder.push(entry.turnId);
      entriesByTurn.set(entry.turnId, [entry]);
    }
  }

  const hiddenTurnIds = new Set(suppressedTurnIds);
  for (let index = 0; index < turnOrder.length - 1; index += 1) {
    const turnId = turnOrder[index];
    const nextTurnId = turnOrder[index + 1];
    if (!turnId || !nextTurnId) continue;
    const entries = entriesByTurn.get(turnId) ?? [];
    const nextEntries = entriesByTurn.get(nextTurnId) ?? [];
    const userText = entries.find((entry) => entry.kind === "user_message")?.text;
    const nextUserText = nextEntries.find((entry) => entry.kind === "user_message")?.text;
    const hasOfficialClientError = entries.some((entry) => (
      entry.kind === "error" && /only allows Codex official clients/i.test(entry.text)
    ));
    if (hasOfficialClientError && userText && userText === nextUserText) hiddenTurnIds.add(turnId);
  }

  return history.filter((entry) => !hiddenTurnIds.has(entry.turnId));
}

export function mergeLatestTurnTimeline(
  history: readonly TaskHistoryEntry[],
  latestTurnId: string,
  latestEntries: readonly TaskHistoryEntry[],
): TaskHistoryEntry[] {
  const replacedCliTurnIds = matchingSyntheticCliTurnIds(history, latestEntries);
  return collapseOfficialClientFallbackHistory([
    ...history.filter((entry) => entry.turnId !== latestTurnId && !replacedCliTurnIds.has(entry.turnId)),
    ...latestEntries,
  ].slice(-maxHistoryEntries));
}

function matchingSyntheticCliTurnIds(
  history: readonly TaskHistoryEntry[],
  persistedEntries: readonly TaskHistoryEntry[],
): Set<string> {
  const persistedUserText = persistedEntries.find((entry) => entry.kind === "user_message")?.text;
  if (!persistedUserText) return new Set();

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    if (entry.kind === "user_message"
      && entry.turnId.startsWith("cli_turn_")
      && entry.text === persistedUserText) {
      return new Set([entry.turnId]);
    }
  }
  return new Set();
}

export function isTransientEmptyRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:rollout|session metadata).+is empty/i.test(message);
}

export function prependHistoryPage(
  history: readonly TaskHistoryEntry[],
  olderEntries: readonly TaskHistoryEntry[],
): TaskHistoryEntry[] {
  const existingIds = new Set(history.map((entry) => `${entry.turnId}:${entry.id}`));
  const uniqueOlder = olderEntries.filter((entry) => !existingIds.has(`${entry.turnId}:${entry.id}`));
  const available = Math.max(0, maxHistoryEntries - history.length);
  if (available === 0) return [...history];
  return collapseOfficialClientFallbackHistory([...uniqueOlder.slice(-available), ...history]);
}

export function codexTurnsToTimings(turns: readonly CodexTurn[]): TaskTurnTiming[] {
  return [...turns]
    .sort((left, right) => (
      (left.startedAt ?? left.completedAt ?? 0) - (right.startedAt ?? right.completedAt ?? 0)
    ))
    .flatMap((turn) => {
      if (turn.startedAt === null) return [];
      const startedAt = new Date(turn.startedAt * 1_000).toISOString();
      const completedAt = turn.completedAt !== null && turn.completedAt >= turn.startedAt
        ? new Date(turn.completedAt * 1_000).toISOString()
        : undefined;
      return [{
        turnId: turn.id,
        startedAt,
        ...(completedAt ? { completedAt } : {}),
      }];
    });
}

export function writerThreadIdsFromLsof(output: string): Set<string> {
  const ids = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("n")) continue;
    const match = /\/([0-9a-f-]{36})\.lock$/i.exec(line.slice(1));
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

export function isActiveWriterError(error: unknown): boolean {
  return error instanceof CodexRpcError
    ? error.message.includes("already has an active writer")
    : error instanceof Error && error.message.includes("already has an active writer");
}

function taskState(status: CodexThread["status"]): TaskState {
  if (status.type === "active") {
    return status.activeFlags.length > 0 ? "waiting_for_user" : "running";
  }
  if (status.type === "systemError") return "failed";
  return "idle";
}

export function codexThreadToTask(
  thread: CodexThread,
  options: {
    activeTurnId?: string;
    externalActiveTurnId?: string;
    controlReason?: string;
    controlState?: TaskControlState;
    externalLifecycle?: RolloutLifecycle;
    existing?: Task;
    history?: CodexHistorySnapshot;
    pendingApproval?: Approval;
    project?: WorkstationProject;
    artifacts?: Artifact[];
    summary?: string;
    canMessageViaExternalWriter?: boolean;
    canStopViaExternalWriter?: boolean;
  } = {},
): Task {
  const project = options.project ?? { id: "projectless", name: "最近会话" };
  const controlState = options.controlState ?? (options.activeTurnId ? "managed" : "available");
  let state: TaskState = options.pendingApproval
    ? "waiting_for_user"
    : options.activeTurnId
      ? taskState(thread.status) === "idle" ? "running" : taskState(thread.status)
      : options.externalActiveTurnId
        ? "running"
        : options.externalLifecycle?.state ?? options.history?.state ?? taskState(thread.status);
  const isActive = state === "running" || state === "waiting_for_user";
  const artifacts = options.artifacts ?? options.history?.artifacts ?? options.existing?.artifacts ?? [];
  const capabilities: AgentCapability[] = ["history"];
  if (controlState === "available" || controlState === "managed" || (controlState === "external_writer" && options.canMessageViaExternalWriter)) capabilities.push("message");
  if (options.activeTurnId) capabilities.push("stop", "structured_tool_calls");
  if (options.externalActiveTurnId && options.canStopViaExternalWriter) capabilities.push("stop");
  if (options.pendingApproval) capabilities.push("approval");
  if (artifacts.length > 0) capabilities.push("diff");

  let summary = "真实 Codex 会话；发送消息后由本机 Companion 继续";
  if (thread.status.type === "idle") summary = "Codex 会话空闲，可从手机继续";
  if (thread.status.type === "systemError") summary = "Codex 会话运行时异常";
  if (isActive) summary = "Codex 正在处理任务";
  if (options.existing && isActive) summary = options.existing.summary;
  if (options.history) summary = options.history.summary;
  if (options.externalLifecycle?.state === "running") summary = "Codex Desktop 正在处理任务";
  if (options.summary) summary = options.summary;
  if (options.pendingApproval) summary = "等待手机端确认操作";

  const title = shortText(thread.name ?? thread.preview.split("\n")[0] ?? "", 240) || "未命名 Codex 会话";
  return TaskSchema.parse({
    id: thread.id,
    deviceId,
    projectId: project.id,
    projectName: project.name,
    runId: options.activeTurnId ?? options.externalActiveTurnId ?? options.externalLifecycle?.turnId ?? options.history?.runId ?? options.existing?.runId ?? thread.id,
    agentId: "codex-app-server",
    agentName: thread.model ? `Codex · ${thread.model}` : "Codex",
    title,
    state,
    summary,
    controlState,
    ...(options.controlReason ? { controlReason: options.controlReason } : {}),
    capabilities,
    artifacts,
    historyState: options.existing?.historyState ?? "not_loaded",
    history: options.existing?.history ?? [],
    turnTimings: options.existing?.turnTimings ?? [],
    ...(options.existing?.historyError ? { historyError: options.existing.historyError } : {}),
    ...(options.pendingApproval ? { pendingApproval: options.pendingApproval } : {}),
    updatedAt: new Date(Math.max(
      thread.updatedAt * 1_000,
      options.history?.updatedAt ? Date.parse(options.history.updatedAt) : 0,
      options.existing ? Date.parse(options.existing.updatedAt) : 0,
    )).toISOString(),
  });
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function comparableProjectPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function codexExecArgs(cwd: string, threadId?: string): string[] {
  if (threadId) return ["exec", "resume", "--json", threadId, "-"];
  return ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", cwd, "-"];
}

export function codexThreadStartParams(cwd: string, projectId?: string): JsonObject {
  return {
    cwd,
    approvalsReviewer: "user",
    serviceName: "ai-workstation-remote",
    ...(projectId ? { projectId } : {}),
  };
}

export function codexThreadCliSeedParams(threadId: string): JsonObject {
  return {
    threadId,
    items: [{
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: "This thread was initialized by AI Workstation Remote. Treat the next user message as the first actionable request.",
      }],
    }],
  };
}

export function shouldUseCodexExec(thread: Pick<CodexThread, "originator">, hasExternalWriter: boolean): boolean {
  return thread.originator === "codex_exec" && !hasExternalWriter;
}

export class CodexAgentAdapter implements AgentAdapter {
  readonly id = "codex-app-server";
  readonly name = "Codex";
  readonly source = "codex" as const;
  readonly capabilities = [
    "message",
    "stop",
    "approval",
    "structured_tool_calls",
    "diff",
    "history",
    "new_task",
  ] as const satisfies readonly AgentCapability[];

  private client: CodexAppServerClient | undefined;
  private readonly desktopIpc = new CodexDesktopIpcClient(
    undefined,
    (snapshot) => this.handleDesktopThreadState(snapshot),
  );
  private desktopIpcAvailable = false;
  private emit: EmitEvent | undefined;
  private emitProjects: EmitProjects | undefined;
  private emitAvailability: EmitAvailability | undefined;
  private active = false;
  private startPromise: Promise<void> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private sequence = 0;
  private readonly threads = new Map<string, CodexThread>();
  private readonly tasks = new Map<string, Task>();
  private readonly activeTurnIds = new Map<string, string>();
  private readonly externalActiveTurnIds = new Map<string, string>();
  private readonly managedThreads = new Set<string>();
  private readonly externalWriterThreads = new Set<string>();
  private readonly cliManagedThreads = new Set<string>();
  private readonly cliTurns = new Map<string, CodexCliTurn>();
  private readonly startingCliThreads = new Set<string>();
  private readonly suppressedHistoryTurnIds = new Set<string>();
  private readonly rolloutLifecycles = new Map<string, RolloutLifecycleCache>();
  private readonly histories = new Map<string, CodexHistorySnapshot>();
  private readonly latestTurns = new Map<string, CodexTurn>();
  private readonly runtimeSummaries = new Map<string, string>();
  private readonly agentMessageBuffers = new Map<string, string>();
  private readonly summaryFlushTimers = new Map<string, NodeJS.Timeout>();
  private readonly artifacts = new Map<string, Artifact[]>();
  private readonly diffContents = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly loadingHistories = new Set<string>();
  private readonly cliHandoffThreads = new Set<string>();
  private readonly deferredHistoryLoads = new Map<string, "latest" | "older">();
  private readonly historyCursors = new Map<string, string | null>();
  private projects: WorkstationProject[] = [];
  private readonly projectIdByThreadId = new Map<string, string>();
  private readonly rootPathByProjectId = new Map<string, string>();
  private readonly appServerProjectIdByDesktopProjectId = new Map<string, string>();
  private readonly projectOverrides = new Map<string, string>();
  private readonly projectOverridesPath: string;
  private readonly defaultCwd: string;
  private projectOverridesLoaded = false;
  private projectOverridesSave: Promise<void> = Promise.resolve();
  private projectSignature = "";

  constructor(options: { projectOverridesPath?: string; defaultCwd?: string } = {}) {
    this.projectOverridesPath = options.projectOverridesPath ?? defaultCodexProjectOverridesPath();
    this.defaultCwd = options.defaultCwd
      ?? process.env.WORKSTATION_CWD
      ?? process.env.INIT_CWD
      ?? process.cwd();
  }

  async start(emit: EmitEvent, emitProjects: EmitProjects, emitAvailability?: EmitAvailability): Promise<void> {
    this.emit = emit;
    this.emitProjects = emitProjects;
    if (emitAvailability) this.emitAvailability = emitAvailability;
    await this.ensureProjectOverridesLoaded();
    if (this.client) {
      this.setActive(true);
      this.replayTasks();
      this.emitProjects(this.projects);
      return;
    }
    if (!this.startPromise) {
      this.startPromise = this.connect().finally(() => {
        this.startPromise = undefined;
      });
    }
    try {
      await this.startPromise;
    } catch (error) {
      this.setActive(false);
      throw error;
    }
  }

  currentTaskIds(): readonly string[] {
    return [...this.tasks.keys()];
  }

  taskCapabilities(taskId: string): readonly AgentCapability[] {
    return this.tasks.get(taskId)?.capabilities ?? [];
  }

  async handleCommand(command: MobileCommand, emit: EmitEvent): Promise<void> {
    this.emit = emit;
    try {
      if (command.action.kind === "request_history") {
        await this.loadHistoryPage(command.taskId, command.action.direction ?? "latest");
        return;
      }
      if (command.action.kind === "request_diff") {
        await this.loadDiff(command.taskId);
        return;
      }
      if (command.action.kind === "message") {
        await this.sendMessage(command.taskId, command.action.text);
        return;
      }
      if (command.action.kind === "stop") {
        await this.stopTurn(command.taskId);
        return;
      }
      if (command.action.kind === "approval") {
        await this.resolveApproval(command.taskId, command.action.approvalId, command.action.decision);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[codex] ${command.action.kind} failed for ${command.taskId}: ${message}`);
      if (isActiveWriterError(error)) {
        this.externalWriterThreads.add(command.taskId);
        this.runtimeSummaries.delete(command.taskId);
        const history = this.histories.get(command.taskId);
        const thread = this.threads.get(command.taskId);
        const lifecycle = this.rolloutLifecycles.get(command.taskId)?.lifecycle;
        this.updateTask(command.taskId, {
          ...(history ? { artifacts: history.artifacts, summary: history.summary } : {}),
          ...(lifecycle ? { runId: lifecycle.turnId, state: lifecycle.state } : history ? { runId: history.runId, state: history.state } : {}),
          controlState: "external_writer",
          controlReason: thread
            ? externalWriterReason(lifecycle?.state === "running", this.desktopIpcAvailable)
            : this.desktopIpcAvailable
              ? "Codex Desktop 持有这个会话；手机消息会经本机控制通道继续。"
              : "Codex Desktop 持有这个会话的写权限，手机端暂时只能读取。",
        });
        throw error;
      }
      const summary = shortText(`操作失败：${message}`);
      this.runtimeSummaries.set(command.taskId, summary);
      this.updateTask(command.taskId, {
        summary,
        state: this.activeTurnIds.has(command.taskId) ? "running" : "idle",
      });
      throw error;
    }
  }

  async createTask(command: MobileCommand, emit: EmitEvent): Promise<void> {
    this.emit = emit;
    if (command.action.kind !== "new_task" || command.action.source !== "codex") {
      throw new Error("无效的 Codex 新建任务命令");
    }
    const action = command.action;
    const project = action.projectId
      ? this.projects.find((item) => item.id === action.projectId)
      : undefined;
    if (action.projectId && !project) throw new Error("找不到对应的 Codex 项目");
    const cwd = project ? this.rootPathByProjectId.get(project.id) : this.defaultCwd;
    if (!cwd) throw new Error("该 Codex 项目没有可用的本地目录");
    const client = this.requireClient();
    const appServerProjectId = project
      ? await this.resolveAppServerProjectId(client, project, cwd)
      : undefined;
    const response = ThreadStartResponseSchema.parse(await client.request(
      "thread/start",
      codexThreadStartParams(cwd, appServerProjectId),
    ));
    const thread = response.thread;
    this.threads.set(thread.id, thread);
    this.managedThreads.add(thread.id);
    this.cliHandoffThreads.add(thread.id);
    if (project) {
      this.projectOverrides.set(thread.id, project.id);
      try {
        await this.persistProjectOverrides();
      } catch (error) {
        console.warn(`[codex] unable to persist project for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const task = codexThreadToTask(thread, project ? { project } : {});
    this.tasks.set(thread.id, task);
    this.emitEvent(task.id, task.runId, "task.upsert", { task });
    let reconnectAppServer = false;
    try {
      await client.request("thread/inject_items", codexThreadCliSeedParams(thread.id));
      reconnectAppServer = await this.releaseAppServerForCliHandoff(client);
      await this.startCliTurn({
        cwd,
        text: action.text,
        threadId: thread.id,
        ...(project ? { project } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const summary = shortText(`会话已创建，但 Codex CLI 启动失败：${message}`);
      this.runtimeSummaries.set(thread.id, summary);
      this.updateTask(thread.id, { state: "failed", summary, clearApproval: true });
      this.emitEvent(thread.id, this.tasks.get(thread.id)?.runId ?? thread.id, "task.completed", {
        outcome: "failed",
        summary,
        artifacts: this.tasks.get(thread.id)?.artifacts ?? [],
      });
    } finally {
      if (reconnectAppServer) await this.reconnectAfterCliHandoff();
      this.cliHandoffThreads.delete(thread.id);
      await this.flushDeferredHistoryLoads(thread.id);
    }
  }

  private async resolveAppServerProjectId(
    client: CodexAppServerClient,
    project: WorkstationProject,
    cwd: string,
  ): Promise<string> {
    const cached = this.appServerProjectIdByDesktopProjectId.get(project.id);
    if (cached) return cached;

    const targetPath = comparableProjectPath(cwd);
    let cursor: string | null = null;
    do {
      const page = ProjectListResponseSchema.parse(await client.request("project/list", {
        cursor,
        limit: 100,
      }));
      const match = page.data.find((candidate) => (
        candidate.roots.some((root) => comparableProjectPath(root.path) === targetPath)
      ));
      if (match) {
        this.appServerProjectIdByDesktopProjectId.set(project.id, match.id);
        return match.id;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    throw new Error(`Codex Desktop 尚未同步项目“${project.name}”，请在桌面端打开该项目后重试`);
  }

  private async releaseAppServerForCliHandoff(client: CodexAppServerClient): Promise<boolean> {
    if (this.client !== client) {
      throw new Error("Codex app-server 在 CLI 交接前已发生变化");
    }
    this.client = undefined;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.invalidateAppServerRuntimeState();
    await client.stop();
    return true;
  }

  private async reconnectAfterCliHandoff(): Promise<void> {
    if (this.client || !this.emit || !this.emitProjects) return;
    try {
      await this.start(this.emit, this.emitProjects, this.emitAvailability);
    } catch (error) {
      console.warn(`[codex] reconnect after CLI handoff failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
    }
  }

  private async startCliTurn(options: {
    cwd: string;
    text: string;
    project?: WorkstationProject;
    threadId?: string;
    replacesTurnId?: string;
  }): Promise<string> {
    const releaseStarting = options.threadId
      ? reserveCliThread(options.threadId, this.cliTurns, this.startingCliThreads)
      : () => undefined;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(resolveCodexBin(), codexExecArgs(options.cwd, options.threadId), {
        cwd: options.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,
      });
    } catch (error) {
      releaseStarting();
      throw error;
    }
    const runId = createId("cli_turn");
    const startedAt = new Date().toISOString();
    const stderr: string[] = [];
    let taskId = options.threadId;
    let lastAgentSummary: string | undefined;
    let settled = false;
    let activated = false;
    let resolveStarted!: (threadId: string) => void;
    let rejectStarted!: (error: Error) => void;
    const started = new Promise<string>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const startupTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      releaseStarting();
      child.kill("SIGTERM");
      rejectStarted(new Error("Codex CLI 启动会话超时"));
    }, 15_000);

    const activate = (nextTaskId: string) => {
      if (settled) return;
      if (taskId && taskId !== nextTaskId) return;
      if (activated) return;
      activated = true;
      releaseStarting();
      taskId = nextTaskId;
      this.cliManagedThreads.add(nextTaskId);
      this.managedThreads.add(nextTaskId);
      this.activeTurnIds.set(nextTaskId, runId);
      this.cliTurns.set(nextTaskId, { child, runId, stderr, stopping: false });
      if (options.project) {
        this.projectOverrides.set(nextTaskId, options.project.id);
        void this.persistProjectOverrides().catch((error: unknown) => {
          console.warn(`[codex] unable to persist project for ${nextTaskId}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }

      const existing = this.tasks.get(nextTaskId);
      const userEntry: TaskHistoryEntry = {
        id: `${runId}_user`,
        turnId: runId,
        kind: "user_message",
        text: options.text,
        createdAt: startedAt,
      };
      if (existing) {
        const suppressedTurnIds = options.replacesTurnId
          ? new Set([...this.suppressedHistoryTurnIds, options.replacesTurnId])
          : this.suppressedHistoryTurnIds;
        const history = collapseOfficialClientFallbackHistory(
          [...existing.history, userEntry],
          suppressedTurnIds,
        );
        this.updateTask(nextTaskId, {
          runId,
          state: "running",
          summary: "网页指令已提交，Codex CLI 正在处理",
          controlState: "managed",
          historyState: "loaded",
          history: history.slice(-maxHistoryEntries),
          turnTimings: [
            ...existing.turnTimings.filter((timing) => timing.turnId !== options.replacesTurnId),
            { turnId: runId, startedAt },
          ].slice(-maxHistoryTurns),
          clearHistoryError: true,
        });
      } else {
        const thread = CodexThreadSchema.parse({
          id: nextTaskId,
          preview: options.text,
          projectId: null,
          model: null,
          updatedAt: Date.now() / 1_000,
          status: { type: "active", activeFlags: [] },
          path: null,
          cwd: options.cwd,
          canAcceptDirectInput: true,
          name: null,
        });
        this.threads.set(nextTaskId, thread);
        const baseTask = codexThreadToTask(thread, {
          activeTurnId: runId,
          ...(options.project ? { project: options.project } : {}),
          summary: "网页指令已提交，Codex CLI 正在处理",
        });
        const task = TaskSchema.parse({
          ...baseTask,
          capabilities: ["history", "stop"],
          historyState: "loaded",
          history: [userEntry],
          turnTimings: [{ turnId: runId, startedAt }],
        });
        this.tasks.set(nextTaskId, task);
        this.emitEvent(task.id, task.runId, "task.upsert", { task });
      }

      if (!settled) {
        settled = true;
        clearTimeout(startupTimer);
        resolveStarted(nextTaskId);
      }
    };

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      let event: JsonObject | undefined;
      try {
        event = objectValue(JSON.parse(line));
      } catch {
        return;
      }
      const type = stringValue(event?.type);
      if (type === "thread.started") {
        const nextTaskId = stringValue(event?.thread_id);
        if (nextTaskId) activate(nextTaskId);
        return;
      }
      if (!taskId) return;
      if (type === "item.completed") {
        const item = objectValue(event?.item);
        if (stringValue(item?.type) !== "agent_message") return;
        const text = stringValue(item?.text);
        if (!text) return;
        lastAgentSummary = shortText(text);
        const current = this.tasks.get(taskId);
        if (current) {
          const entry: TaskHistoryEntry = {
            id: `${runId}_${stringValue(item?.id) ?? createId("agent")}`,
            turnId: runId,
            kind: "agent_message",
            phase: "final_answer",
            text,
            createdAt: new Date().toISOString(),
          };
          this.updateTask(taskId, {
            state: "running",
            summary: lastAgentSummary,
            historyState: "loaded",
            history: [...current.history, entry].slice(-maxHistoryEntries),
          });
        }
        return;
      }
      if (type === "turn.completed") {
        this.finishCliTurn(taskId, "succeeded", lastAgentSummary ?? "Codex 回合已完成");
        return;
      }
      if (type === "turn.failed") {
        const error = objectValue(event?.error);
        this.finishCliTurn(taskId, "failed", stringValue(error?.message) ?? "Codex CLI 回合失败");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean);
      stderr.push(...lines.filter((line) => line !== "Reading additional input from stdin..."));
      if (stderr.length > 20) stderr.splice(0, stderr.length - 20);
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        releaseStarting();
        clearTimeout(startupTimer);
        rejectStarted(error);
      } else if (taskId) {
        this.finishCliTurn(taskId, "failed", error.message);
      }
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        releaseStarting();
        clearTimeout(startupTimer);
        rejectStarted(new Error(stderr.at(-1) ?? `Codex CLI 启动失败（${code ?? signal ?? "unknown"}）`));
        return;
      }
      if (!taskId || !this.cliTurns.has(taskId)) return;
      const turn = this.cliTurns.get(taskId);
      this.finishCliTurn(
        taskId,
        turn?.stopping ? "stopped" : "failed",
        turn?.stopping ? "Codex 回合已停止，可发送新指令重新开始" : stderr.at(-1) ?? `Codex CLI 异常退出（${code ?? signal ?? "unknown"}）`,
      );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.text);
    return await started;
  }

  private finishCliTurn(taskId: string, outcome: "succeeded" | "failed" | "stopped", summary: string): void {
    const turn = this.cliTurns.get(taskId);
    if (!turn) return;
    this.cliTurns.delete(taskId);
    if (this.activeTurnIds.get(taskId) === turn.runId) this.activeTurnIds.delete(taskId);
    this.runtimeSummaries.set(taskId, summary);
    const current = this.tasks.get(taskId);
    const completedAt = new Date().toISOString();
    const turnTimings = current?.turnTimings.map((timing) => (
      timing.turnId === turn.runId ? { ...timing, completedAt } : timing
    ));
    this.updateTask(taskId, {
      state: outcome,
      summary,
      ...(turnTimings ? { turnTimings } : {}),
      clearApproval: true,
    });
    this.emitEvent(taskId, turn.runId, "task.completed", {
      outcome,
      summary: shortText(summary),
      artifacts: this.tasks.get(taskId)?.artifacts ?? [],
    });
  }

  private async loadDiff(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    const thread = this.threads.get(taskId);
    if (!task || !thread) throw new Error("找不到对应的 Codex 任务");
    const turnDiff = this.diffContents.get(taskId)
      ?? (this.latestTurns.get(taskId) ? unifiedDiffFromTurn(this.latestTurns.get(taskId)!, thread.cwd) : undefined);
    const result = turnDiff ? boundedDiffContent(turnDiff) : await readWorkingTreeDiff(thread.cwd);
    const artifacts = artifactsWithDiffContent(task.artifacts, result);
    this.artifacts.set(taskId, artifacts);
    this.updateTask(taskId, { artifacts, preserveUpdatedAt: true });
  }

  private async connect(): Promise<void> {
    const client = new CodexAppServerClient({
      onNotification: (message) => this.handleNotification(message),
      onServerRequest: (message) => this.handleServerRequest(message),
      onExit: (error) => this.handleClientExit(error),
    });
    this.client = client;
    try {
      await client.start();
      await this.refreshDesktopIpc();
      await this.refreshThreads(false);
    } catch (error) {
      if (this.client === client) this.client = undefined;
      await client.stop();
      throw error;
    }
    this.setActive(true);
    void this.flushDeferredHistoryLoads().catch((error: unknown) => {
      console.warn(`[codex] deferred history load failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.refreshTimer = setInterval(() => {
      void this.refreshThreads(true).catch((error: unknown) => {
        console.warn(`[codex] thread refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, refreshIntervalMs);
  }

  private handleClientExit(error: Error): void {
    console.warn(`[codex] disconnected: ${error.message}`);
    this.setActive(false);
    this.client = undefined;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.invalidateAppServerRuntimeState();
    for (const [taskId] of this.tasks) {
      if (this.cliManagedThreads.has(taskId)) continue;
      this.updateTask(taskId, {
        state: "unknown",
        summary: "Codex 服务连接中断，正在重连",
        controlState: "unavailable",
        controlReason: "本机 Companion 与 Codex 服务的连接已中断。",
        clearApproval: true,
      });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.emit && this.emitProjects) void this.start(this.emit, this.emitProjects, this.emitAvailability).catch((connectError: unknown) => {
        console.warn(`[codex] reconnect failed: ${connectError instanceof Error ? connectError.message : String(connectError)}`);
        this.scheduleReconnect();
      });
    }, 2_000);
  }

  private invalidateAppServerRuntimeState(): void {
    const invalidatedApprovals = invalidateAppServerSessionState({
      managedThreads: this.managedThreads,
      activeTurnIds: this.activeTurnIds,
      cliManagedThreads: this.cliManagedThreads,
      cliTurns: this.cliTurns,
      pendingApprovals: this.pendingApprovals,
    });
    for (const pending of invalidatedApprovals) {
      if (pending.source !== "app_server") continue;
      this.emitEvent(pending.taskId, pending.turnId, "approval.resolved", {
        approvalId: pending.approval.id,
        decision: "expired",
      });
    }
    for (const timer of this.summaryFlushTimers.values()) clearTimeout(timer);
    this.summaryFlushTimers.clear();
    this.agentMessageBuffers.clear();
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.emitAvailability?.(active);
  }

  private async refreshThreads(useStateDbOnly: boolean): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.performThreadRefresh(useStateDbOnly);
    } finally {
      this.refreshing = false;
    }
  }

  private async performThreadRefresh(useStateDbOnly: boolean): Promise<void> {
    const client = this.requireClient();
    await this.refreshDesktopIpc();
    await this.refreshDesktopProjects();
    const raw = await client.request("thread/list", {
      limit: maxThreads,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly,
    });
    const page = ThreadListResponseSchema.parse(raw);
    const detectedWriters = await this.detectExternalWriters();
    if (detectedWriters) {
      this.externalWriterThreads.clear();
      for (const threadId of detectedWriters) {
        if (!this.managedThreads.has(threadId)) this.externalWriterThreads.add(threadId);
      }
      for (const [approvalId, pending] of this.pendingApprovals) {
        if (pending.source === "desktop" && !this.externalWriterThreads.has(pending.taskId)) {
          this.pendingApprovals.delete(approvalId);
        }
      }
    }
    if (this.desktopIpcAvailable) {
      try {
        await this.desktopIpc.followThreads(this.externalWriterThreads);
      } catch (error) {
        this.desktopIpcAvailable = false;
        console.warn(`[codex] unable to follow desktop threads: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.refreshHistories(page.data, useStateDbOnly);
    await this.refreshRolloutLifecycles(page.data);
    const seen = new Set<string>();
    for (const thread of page.data) {
      seen.add(thread.id);
      this.threads.set(thread.id, thread);
      if (shouldUseCodexExec(thread, this.externalWriterThreads.has(thread.id))) {
        this.cliManagedThreads.add(thread.id);
      }
      const activeTurnId = this.activeTurnIds.get(thread.id);
      const existing = this.tasks.get(thread.id);
      const pending = [...this.pendingApprovals.values()].find((item) => item.taskId === thread.id)?.approval;
      const threadArtifacts = this.artifacts.get(thread.id);
      const summary = this.runtimeSummaries.get(thread.id);
      const history = this.histories.get(thread.id);
      const isManaged = this.managedThreads.has(thread.id);
      const hasExternalWriter = this.externalWriterThreads.has(thread.id) && !isManaged;
      const externalLifecycle = hasExternalWriter ? this.rolloutLifecycles.get(thread.id)?.lifecycle : undefined;
      const externalActiveTurnId = hasExternalWriter
        ? reconcileExternalActiveTurnId(this.externalActiveTurnIds.get(thread.id), externalLifecycle)
        : undefined;
      if (externalActiveTurnId) this.externalActiveTurnIds.set(thread.id, externalActiveTurnId);
      else this.externalActiveTurnIds.delete(thread.id);
      const project = this.projectForThread(thread);
      const latestTurn = this.latestTurns.get(thread.id);
      let existingWithLiveTurn = existing;
      if (existing && latestTurn && (existing.historyState === "loaded" || existing.historyState === "partial")) {
        const latestTimeline = collapseOfficialClientFallbackHistory(
          codexTurnsToTimeline([latestTurn], thread.cwd),
          this.suppressedHistoryTurnIds,
        );
        const replacedCliTurnIds = matchingSyntheticCliTurnIds(existing.history, latestTimeline);
        existingWithLiveTurn = {
          ...existing,
          history: mergeLatestTurnTimeline(existing.history, latestTurn.id, latestTimeline),
          turnTimings: [
            ...existing.turnTimings.filter((timing) => (
              timing.turnId !== latestTurn.id && !replacedCliTurnIds.has(timing.turnId)
            )),
            ...codexTurnsToTimings([latestTurn]),
          ].slice(-maxHistoryTurns),
        };
      }
      let task = codexThreadToTask(thread, {
        ...(activeTurnId ? { activeTurnId } : {}),
        ...(externalActiveTurnId ? { externalActiveTurnId } : {}),
        controlState: isManaged ? "managed" : hasExternalWriter ? "external_writer" : "available",
        ...(hasExternalWriter ? {
          controlReason: externalWriterReason(Boolean(externalActiveTurnId), this.desktopIpcAvailable),
          canMessageViaExternalWriter: this.desktopIpcAvailable,
          canStopViaExternalWriter: this.desktopIpcAvailable,
        } : {}),
        ...(externalLifecycle ? { externalLifecycle } : {}),
        ...(existingWithLiveTurn ? { existing: existingWithLiveTurn } : {}),
        ...(history ? { history } : {}),
        ...(pending ? { pendingApproval: pending } : {}),
        ...(threadArtifacts ? { artifacts: threadArtifacts } : {}),
        ...(summary ? { summary } : {}),
        ...(project ? { project } : {}),
      });
      if (this.cliManagedThreads.has(thread.id)) {
        const cliActive = this.cliTurns.has(thread.id);
        task = TaskSchema.parse({
          ...task,
          controlState: "managed",
          capabilities: [
            "history",
            cliActive ? "stop" : "message",
            ...(task.artifacts.length > 0 ? ["diff" as const] : []),
          ],
        });
      }
      this.tasks.set(thread.id, task);
      this.emitEvent(thread.id, task.runId, "task.upsert", { task });
    }

    for (const [taskId, task] of this.tasks) {
      if (seen.has(taskId) || this.managedThreads.has(taskId)) continue;
      this.tasks.delete(taskId);
      this.threads.delete(taskId);
      this.latestTurns.delete(taskId);
      this.historyCursors.delete(taskId);
      this.emitEvent(taskId, task.runId, "task.removed", {});
    }
  }

  private async refreshDesktopProjects(): Promise<void> {
    try {
      const state = await loadCodexDesktopState();
      this.projects = state.projects;
      this.projectIdByThreadId.clear();
      this.rootPathByProjectId.clear();
      for (const [threadId, projectId] of state.projectIdByThreadId) {
        this.projectIdByThreadId.set(threadId, projectId);
      }
      for (const [projectId, rootPath] of state.rootPathByProjectId) {
        this.rootPathByProjectId.set(projectId, rootPath);
      }
      const signature = JSON.stringify(this.projects);
      if (signature !== this.projectSignature) {
        this.projectSignature = signature;
        this.emitProjects?.(this.projects);
      }
    } catch (error) {
      console.warn(`[codex] unable to read desktop projects: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async refreshDesktopIpc(): Promise<void> {
    if (this.desktopIpc.connected) {
      this.desktopIpcAvailable = true;
      return;
    }
    try {
      await this.desktopIpc.connect();
      this.desktopIpcAvailable = true;
    } catch {
      this.desktopIpcAvailable = false;
    }
  }

  private projectForThread(thread: CodexThread): WorkstationProject | undefined {
    const assignedId = this.projectOverrides.get(thread.id)
      ?? this.projectIdByThreadId.get(thread.id)
      ?? (thread.projectId && this.projects.some((project) => project.id === thread.projectId) ? thread.projectId : undefined);
    return assignedId ? this.projects.find((project) => project.id === assignedId) : undefined;
  }

  private async ensureProjectOverridesLoaded(): Promise<void> {
    if (this.projectOverridesLoaded) return;
    this.projectOverridesLoaded = true;
    try {
      const persisted = await loadCodexProjectOverrides(this.projectOverridesPath);
      for (const [threadId, projectId] of persisted) this.projectOverrides.set(threadId, projectId);
    } catch (error) {
      console.warn(`[codex] unable to load persisted projects: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persistProjectOverrides(): Promise<void> {
    const snapshot = new Map(this.projectOverrides);
    const save = this.projectOverridesSave
      .catch(() => undefined)
      .then(() => saveCodexProjectOverrides(this.projectOverridesPath, snapshot));
    this.projectOverridesSave = save;
    return save;
  }

  private async refreshRolloutLifecycles(threads: readonly CodexThread[]): Promise<void> {
    await Promise.all(threads
      .filter((thread) => this.externalWriterThreads.has(thread.id) && Boolean(thread.path))
      .map(async (thread) => {
        try {
          await this.refreshRolloutLifecycle(thread);
        } catch (error) {
          console.warn(`[codex] unable to read rollout lifecycle for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));
  }

  private async refreshRolloutLifecycle(thread: CodexThread): Promise<void> {
    const path = thread.path;
    if (!path) return;
    const file = await stat(path);
    const cached = this.rolloutLifecycles.get(thread.id);
    if (!cached || cached.path !== path || file.size < cached.size) {
      const lifecycle = await scanLatestRolloutLifecycle(path, file.size);
      this.rolloutLifecycles.set(thread.id, { path, size: file.size, partial: "", ...(lifecycle ? { lifecycle } : {}) });
      return;
    }
    if (file.size === cached.size) return;

    const addedBytes = file.size - cached.size;
    if (addedBytes > maxIncrementalRolloutReadBytes) {
      const lifecycle = await scanLatestRolloutLifecycle(path, file.size);
      cached.size = file.size;
      cached.partial = "";
      if (lifecycle) cached.lifecycle = lifecycle;
      return;
    }

    const appended = await readRolloutRange(path, cached.size, addedBytes);
    const combined = `${cached.partial}${appended}`;
    const lastNewline = combined.lastIndexOf("\n");
    const complete = lastNewline >= 0 ? combined.slice(0, lastNewline + 1) : "";
    cached.partial = lastNewline >= 0 ? combined.slice(lastNewline + 1) : combined;
    cached.size = file.size;
    const lifecycle = rolloutLifecycleFromLines(complete, cached.lifecycle);
    if (lifecycle) cached.lifecycle = lifecycle;
  }

  private async detectExternalWriters(): Promise<Set<string> | undefined> {
    const lockDirectory = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "thread-writer-locks");
    try {
      const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-Fn", "+d", lockDirectory], {
        maxBuffer: 512 * 1_024,
        timeout: 3_000,
      });
      return writerThreadIdsFromLsof(stdout);
    } catch (error) {
      const details = objectValue(error);
      const stdout = stringValue(details?.stdout);
      if (stdout) return writerThreadIdsFromLsof(stdout);
      if (details?.code === 1) return new Set();
      console.warn(`[codex] unable to inspect writer locks: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async refreshHistories(threads: readonly CodexThread[], polling: boolean): Promise<void> {
    const client = this.requireClient();
    const recentLimit = polling ? refreshHistoryThreadLimit : initialHistoryThreadLimit;
    const targets = threads.filter((thread, index) => (
      index < recentLimit
      || this.externalWriterThreads.has(thread.id)
      || this.managedThreads.has(thread.id)
    ));

    for (let index = 0; index < targets.length; index += historyConcurrency) {
      const chunk = targets.slice(index, index + historyConcurrency);
      await Promise.all(chunk.map(async (thread) => {
        try {
          const historyState = this.tasks.get(thread.id)?.historyState;
          const needsFullItems = historyState === "loaded" || historyState === "partial";
          const raw = await client.request("thread/turns/list", {
            threadId: thread.id,
            limit: 1,
            sortDirection: "desc",
            itemsView: needsFullItems ? "full" : "summary",
          });
          const page = ThreadTurnsListResponseSchema.parse(raw);
          const latestTurn = page.data[0];
          if (latestTurn && (needsFullItems || !this.latestTurns.has(thread.id))) {
            this.latestTurns.set(thread.id, latestTurn);
          }
          const history = codexTurnsToHistory(
            page.data,
            thread.cwd,
          );
          if (history) {
            this.histories.set(thread.id, history);
          }
        } catch {
          // Empty or legacy threads may not expose paginated history yet.
        }
      }));
    }
  }

  private async loadHistoryPage(taskId: string, direction: "latest" | "older"): Promise<void> {
    if (this.cliHandoffThreads.has(taskId)) {
      const deferred = this.deferredHistoryLoads.get(taskId);
      this.deferredHistoryLoads.set(taskId, deferred === "latest" || direction === "latest" ? "latest" : "older");
      return;
    }
    if (this.loadingHistories.has(taskId)) return;
    const thread = this.threads.get(taskId);
    if (!thread) throw new Error("找不到对应的 Codex 会话");
    const current = this.tasks.get(taskId);
    if (!current) throw new Error("找不到对应的 Codex 任务");
    const cursor = direction === "older" ? this.historyCursors.get(taskId) : undefined;
    if (direction === "older" && cursor === null) return;

    this.loadingHistories.add(taskId);
    if (direction === "latest") {
      const cachedTurn = this.latestTurns.get(taskId);
      const cachedHistory = cachedTurn
        ? collapseOfficialClientFallbackHistory(
          codexTurnsToTimeline([cachedTurn], thread.cwd),
          this.suppressedHistoryTurnIds,
        )
        : [];
      const cachedTimings = cachedTurn ? codexTurnsToTimings([cachedTurn]) : [];
      this.updateTask(taskId, {
        historyState: "loading",
        ...(current.history.length === 0 && cachedHistory.length > 0 ? {
          history: cachedHistory,
          turnTimings: cachedTimings,
        } : {}),
        clearHistoryError: true,
        preserveUpdatedAt: true,
      });
    }

    try {
      const params = {
        threadId: taskId,
        limit: historyPageSize,
        sortDirection: "desc",
        itemsView: "full",
        ...(direction === "older" && cursor ? { cursor } : {}),
      };
      let raw: unknown;
      for (let attempt = 0; ; attempt += 1) {
        try {
          raw = await this.requireClient().request("thread/turns/list", params);
          break;
        } catch (error) {
          const delay = historyReadRetryDelaysMs[attempt];
          if (!isTransientEmptyRolloutError(error) || delay === undefined) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      const page = ThreadTurnsListResponseSchema.parse(raw);
      const pageHistory = collapseOfficialClientFallbackHistory(
        codexTurnsToTimeline(page.data, thread.cwd),
        this.suppressedHistoryTurnIds,
      );
      const pageTimings = codexTurnsToTimings(page.data);
      const mergedHistory = direction === "older"
        ? prependHistoryPage(current.history, pageHistory)
        : pageHistory;
      const history = collapseOfficialClientFallbackHistory(mergedHistory, this.suppressedHistoryTurnIds);
      const existingTurnIds = new Set(current.turnTimings.map((timing) => timing.turnId));
      const uniqueOlderTimings = pageTimings.filter((timing) => !existingTurnIds.has(timing.turnId));
      const turnTimings = direction === "older"
        ? [...uniqueOlderTimings.slice(-Math.max(0, maxHistoryTurns - current.turnTimings.length)), ...current.turnTimings]
        : pageTimings;
      const nextCursor = page.nextCursor ?? null;
      const canLoadMore = nextCursor !== null
        && page.data.length > 0
        && history.length < maxHistoryEntries
        && turnTimings.length < maxHistoryTurns;
      this.historyCursors.set(taskId, canLoadMore ? nextCursor : null);
      this.updateTask(taskId, {
        history,
        turnTimings,
        historyState: canLoadMore ? "partial" : "loaded",
        clearHistoryError: true,
        preserveUpdatedAt: true,
      });
    } catch (error) {
      if (isTransientEmptyRolloutError(error)) {
        this.updateTask(taskId, {
          historyState: "loaded",
          clearHistoryError: true,
          preserveUpdatedAt: true,
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.updateTask(taskId, {
        historyState: "failed",
        historyError: shortText(message, 500),
        preserveUpdatedAt: true,
      });
    } finally {
      this.loadingHistories.delete(taskId);
    }
  }

  private async flushDeferredHistoryLoads(taskId?: string): Promise<void> {
    if (!this.client) return;
    const entries = taskId
      ? [...this.deferredHistoryLoads.entries()].filter(([id]) => id === taskId)
      : [...this.deferredHistoryLoads.entries()];
    for (const [id, direction] of entries) {
      if (this.cliHandoffThreads.has(id)) continue;
      this.deferredHistoryLoads.delete(id);
      try {
        await this.loadHistoryPage(id, direction);
      } catch (error) {
        console.warn(`[codex] deferred history load failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async sendMessage(taskId: string, text: string): Promise<void> {
    const targetTaskId = taskId;
    const thread = this.threads.get(targetTaskId);
    if (!thread) throw new Error("找不到对应的 Codex 会话");

    if (this.externalWriterThreads.has(taskId) && !this.managedThreads.has(taskId)) {
      const desktopThread = { id: thread.id, cwd: thread.cwd, model: thread.model };
      const current = this.tasks.get(targetTaskId);
      const lifecycle = this.rolloutLifecycles.get(targetTaskId)?.lifecycle;
      const isActive = shouldSteerExternalTurn(
        this.externalActiveTurnIds.get(targetTaskId),
        lifecycle,
        current?.state,
      );
      const returnedTurnId = isActive
        ? await this.desktopIpc.steerTurn(desktopThread, text)
        : await this.desktopIpc.startTurn(desktopThread, text);
      const activeTurnId = returnedTurnId
        ?? this.externalActiveTurnIds.get(targetTaskId)
        ?? (lifecycle?.state === "running" ? lifecycle.turnId : undefined);
      if (activeTurnId) this.externalActiveTurnIds.set(targetTaskId, activeTurnId);
      this.desktopIpcAvailable = true;
      this.updateTask(targetTaskId, {
        ...(activeTurnId ? { runId: activeTurnId } : {}),
        state: "running",
        summary: isActive ? "已向 Codex Desktop 当前回合发送纠偏指令" : "手机消息已交给 Codex Desktop，在同一会话中继续处理",
        controlState: "external_writer",
        controlReason: externalWriterReason(true, true),
      });
      return;
    }

    const project = this.projectForThread(thread);
    await this.startCliTurn({
      cwd: thread.cwd,
      text,
      threadId: targetTaskId,
      ...(project ? { project } : {}),
    });
  }

  private async stopTurn(taskId: string): Promise<void> {
    const cliTurn = this.cliTurns.get(taskId);
    if (cliTurn) {
      cliTurn.stopping = true;
      cliTurn.child.kill(process.platform === "win32" ? "SIGTERM" : "SIGINT");
      this.finishCliTurn(taskId, "stopped", "Codex 回合已停止，可发送新指令重新开始");
      return;
    }

    const turnId = this.activeTurnIds.get(taskId);
    if (turnId) {
      await this.requireClient().request("turn/interrupt", { threadId: taskId, turnId });
      // The interrupt response confirms that this turn is no longer accepting
      // input. Clear it immediately so a follow-up message starts a new turn
      // instead of trying to steer the interrupted one.
      this.activeTurnIds.delete(taskId);
      this.runtimeSummaries.set(taskId, "Codex 回合已停止，可发送新指令重新开始");
      this.updateTask(taskId, {
        state: "stopped",
        summary: "Codex 回合已停止，可发送新指令重新开始",
      });
      return;
    }

    const lifecycle = this.rolloutLifecycles.get(taskId)?.lifecycle;
    const externalTurnId = this.externalActiveTurnIds.get(taskId)
      ?? (lifecycle?.state === "running" ? lifecycle.turnId : undefined);
    if (!externalTurnId || !this.externalWriterThreads.has(taskId)) {
      throw new Error("该会话没有可停止的活动回合");
    }
    await this.desktopIpc.interruptTurn(taskId, externalTurnId);
    this.externalActiveTurnIds.delete(taskId);
    const cachedLifecycle = this.rolloutLifecycles.get(taskId);
    if (cachedLifecycle?.lifecycle?.turnId === externalTurnId) {
      cachedLifecycle.lifecycle = {
        turnId: externalTurnId,
        state: "stopped",
        observedAt: new Date().toISOString(),
      };
    }
    this.runtimeSummaries.set(taskId, "Codex 回合已停止，可发送新指令重新开始");
    this.updateTask(taskId, {
      state: "stopped",
      summary: "Codex 回合已停止，可发送新指令重新开始",
    });
  }

  private async resolveApproval(taskId: string, approvalId: string, decision: "approve" | "reject"): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.taskId !== taskId) throw new Error("审批已失效或不属于该任务");
    if (pending.source === "app_server") {
      clearTimeout(pending.timer);
      this.requireClient().respond(pending.rpcId, { decision: decision === "approve" ? "accept" : "decline" });
    } else {
      await this.desktopIpc.resolveApproval(taskId, pending.requestId, pending.method, decision);
    }
    this.pendingApprovals.delete(approvalId);
    this.emitEvent(taskId, pending.turnId, "approval.resolved", {
      approvalId,
      decision: decision === "approve" ? "approved" : "rejected",
    });
    this.updateTask(taskId, {
      state: "running",
      summary: decision === "approve" ? "审批已通过，Codex 继续执行" : "操作已拒绝",
      clearApproval: true,
    });
  }

  private handleServerRequest(message: ServerRequestMessage): void {
    if (message.method !== "item/commandExecution/requestApproval" && message.method !== "item/fileChange/requestApproval") {
      this.requireClient().respondError(message.id, -32_601, `Unsupported server request: ${message.method}`);
      return;
    }
    const taskId = stringValue(message.params.threadId);
    const turnId = stringValue(message.params.turnId);
    if (!taskId || !turnId || !this.managedThreads.has(taskId)) {
      this.requireClient().respond(message.id, { decision: "decline" });
      return;
    }

    const approvalId = `approval_${String(message.id)}`;
    const isCommand = message.method === "item/commandExecution/requestApproval";
    const command = stringValue(message.params.command);
    const cwd = stringValue(message.params.cwd);
    const reason = stringValue(message.params.reason);
    const grantRoot = stringValue(message.params.grantRoot);
    const scope = [command, grantRoot, cwd].filter((value): value is string => Boolean(value)).map((value) => shortText(value, 300));
    const approval: Approval = {
      id: approvalId,
      title: isCommand ? "允许 Codex 执行终端命令？" : "允许 Codex 修改文件？",
      summary: shortText(reason ?? (isCommand ? "命令将在本机按当前沙箱策略执行" : "修改将应用到当前工作区")),
      risk: isCommand ? "high" : "medium",
      capability: "approval",
      scope: scope.length > 0 ? scope : [isCommand ? "终端命令" : "工作区文件修改"],
      expiresAt: new Date(Date.now() + approvalTtlMs).toISOString(),
    };
    const timer = setTimeout(() => {
      const expired = this.pendingApprovals.get(approvalId);
      if (!expired) return;
      this.pendingApprovals.delete(approvalId);
      if (expired.source === "app_server") this.client?.respond(expired.rpcId, { decision: "decline" });
      this.emitEvent(taskId, turnId, "approval.resolved", { approvalId, decision: "expired" });
      this.updateTask(taskId, { state: "running", summary: "审批超时，操作已自动拒绝", clearApproval: true });
    }, approvalTtlMs);
    this.pendingApprovals.set(approvalId, {
      source: "app_server",
      approval,
      rpcId: message.id,
      method: message.method,
      taskId,
      turnId,
      timer,
    });
    this.emitEvent(taskId, turnId, "approval.requested", { approval });
    this.updateTask(taskId, { state: "waiting_for_user", summary: "等待手机端确认操作", pendingApproval: approval });
  }

  private handleDesktopThreadState(snapshot: DesktopThreadStateSnapshot): void {
    if (!this.externalWriterThreads.has(snapshot.conversationId)) return;
    const desktopDiff = desktopDiffArtifactFromConversationState(snapshot.conversationState);
    const current = this.tasks.get(snapshot.conversationId);
    if (desktopDiff && current) {
      const currentDiff = current.artifacts.find((artifact) => artifact.kind === "diff");
      if (currentDiff?.id !== desktopDiff.artifact.id
        || currentDiff.stats?.filesChanged !== desktopDiff.artifact.stats?.filesChanged
        || currentDiff.stats?.additions !== desktopDiff.artifact.stats?.additions
        || currentDiff.stats?.deletions !== desktopDiff.artifact.stats?.deletions) {
        const artifacts = [
          ...current.artifacts.filter((artifact) => artifact.kind !== "diff"),
          desktopDiff.artifact,
        ];
        this.artifacts.set(snapshot.conversationId, artifacts);
        this.updateTask(snapshot.conversationId, { artifacts, preserveUpdatedAt: true });
      }
    }
    const previous = [...this.pendingApprovals.values()].find((item) => (
      item.source === "desktop" && item.taskId === snapshot.conversationId
    ));
    const pending = desktopApprovalFromConversationState(snapshot.conversationId, snapshot.conversationState);

    if (previous && previous.approval.id !== pending?.approval.id) {
      this.pendingApprovals.delete(previous.approval.id);
      this.emitEvent(previous.taskId, previous.turnId, "approval.resolved", {
        approvalId: previous.approval.id,
        decision: "expired",
      });
    }
    if (!pending) {
      if (previous) {
        this.updateTask(snapshot.conversationId, {
          state: "running",
          summary: "审批已由 Codex Desktop 处理",
          clearApproval: true,
        });
      }
      return;
    }

    this.pendingApprovals.set(pending.approval.id, pending);
    this.externalActiveTurnIds.set(snapshot.conversationId, pending.turnId);
    if (previous?.approval.id === pending.approval.id) return;
    this.emitEvent(pending.taskId, pending.turnId, "approval.requested", { approval: pending.approval });
    this.updateTask(pending.taskId, {
      runId: pending.turnId,
      state: "waiting_for_user",
      summary: "等待网页端确认 Codex Desktop 操作",
      controlState: "external_writer",
      controlReason: "Codex Desktop 正在等待你确认这次操作。",
      pendingApproval: pending.approval,
    });
  }

  private handleNotification(message: ServerNotificationMessage): void {
    const taskId = stringValue(message.params.threadId);
    if (message.method === "thread/started") {
      const rawThread = objectValue(message.params.thread);
      const parsed = CodexThreadSchema.safeParse(rawThread);
      if (parsed.success) {
        this.threads.set(parsed.data.id, parsed.data);
        const project = this.projectForThread(parsed.data);
        const task = codexThreadToTask(parsed.data, project ? { project } : {});
        this.tasks.set(task.id, task);
        this.emitEvent(task.id, task.runId, "task.upsert", { task });
      }
      return;
    }
    if (!taskId) return;

    if (message.method === "turn/started") {
      const parsed = CodexTurnSchema.safeParse(message.params.turn);
      if (!parsed.success) return;
      this.activeTurnIds.set(taskId, parsed.data.id);
      this.managedThreads.add(taskId);
      this.runtimeSummaries.set(taskId, "Codex 正在分析任务");
      this.updateTask(taskId, { runId: parsed.data.id, state: "running", summary: "Codex 正在分析任务" });
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = stringValue(message.params.delta);
      if (!delta) return;
      const next = shortText(`${this.agentMessageBuffers.get(taskId) ?? ""}${delta}`);
      this.agentMessageBuffers.set(taskId, next);
      this.runtimeSummaries.set(taskId, next);
      if (!this.summaryFlushTimers.has(taskId)) {
        const timer = setTimeout(() => {
          this.summaryFlushTimers.delete(taskId);
          const summary = this.runtimeSummaries.get(taskId);
          if (summary) this.updateTask(taskId, { summary, state: "running" });
        }, 250);
        this.summaryFlushTimers.set(taskId, timer);
      }
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = objectValue(message.params.item);
      const type = stringValue(item?.type);
      if (type === "agentMessage") {
        const text = stringValue(item?.text);
        if (message.method === "item/started") {
          this.agentMessageBuffers.set(taskId, "");
          this.updateTask(taskId, { summary: "Codex 正在回复", state: "running" });
          return;
        }
        if (text) {
          const flushTimer = this.summaryFlushTimers.get(taskId);
          if (flushTimer) clearTimeout(flushTimer);
          this.summaryFlushTimers.delete(taskId);
          this.agentMessageBuffers.set(taskId, shortText(text));
          this.runtimeSummaries.set(taskId, shortText(text));
          this.updateTask(taskId, { summary: shortText(text), state: "running" });
        }
      } else if (type === "commandExecution") {
        const command = stringValue(item?.command);
        this.updateTask(taskId, { summary: command ? `正在执行：${shortText(command, 600)}` : "正在执行终端命令", state: "running" });
      } else if (type === "fileChange") {
        this.updateTask(taskId, { summary: "正在修改工作区文件", state: "running" });
      }
      return;
    }
    if (message.method === "turn/diff/updated") {
      const turnId = stringValue(message.params.turnId) ?? this.activeTurnIds.get(taskId) ?? taskId;
      const diff = stringValue(message.params.diff) ?? "";
      if (diff) this.diffContents.set(taskId, diff);
      const stats = diffStatsFromUnifiedDiff(diff);
      const artifact: Artifact = {
        id: `diff_${turnId}`,
        kind: "diff",
        title: `代码变更 · ${stats.filesChanged} 个文件`,
        summary: `+${stats.additions} / -${stats.deletions} 行`,
        stats,
      };
      this.artifacts.set(taskId, [artifact]);
      this.updateTask(taskId, { artifacts: [artifact] });
      return;
    }
    if (message.method === "serverRequest/resolved") {
      const requestId = message.params.requestId;
      const pending = [...this.pendingApprovals.values()].find((item) => (
        item.source === "app_server" && item.rpcId === requestId
      ));
      if (pending?.source === "app_server") {
        clearTimeout(pending.timer);
        this.pendingApprovals.delete(pending.approval.id);
        this.emitEvent(taskId, pending.turnId, "approval.resolved", { approvalId: pending.approval.id, decision: "expired" });
        this.updateTask(taskId, { state: "running", summary: "审批已由 Codex 运行时结束", clearApproval: true });
      }
      return;
    }
    if (message.method === "error") {
      const error = objectValue(message.params.error);
      const errorMessage = stringValue(error?.message) ?? "Codex 运行时错误";
      this.runtimeSummaries.set(taskId, shortText(errorMessage));
      this.updateTask(taskId, { state: "failed", summary: shortText(errorMessage) });
      return;
    }
    if (message.method === "turn/completed") {
      const parsed = CodexTurnSchema.safeParse(message.params.turn);
      if (!parsed.success) return;
      if (!isCurrentTurnCompletion(this.activeTurnIds.get(taskId), parsed.data.id)) {
        return;
      }
      this.activeTurnIds.delete(taskId);
      const outcome = parsed.data.status === "completed" ? "succeeded" : parsed.data.status === "interrupted" ? "stopped" : "failed";
      const summary = this.runtimeSummaries.get(taskId) ?? (outcome === "succeeded" ? "Codex 回合已完成" : outcome === "stopped" ? "Codex 回合已停止" : "Codex 回合失败");
      const artifacts = this.artifacts.get(taskId) ?? [];
      this.updateTask(taskId, {
        state: outcome,
        summary,
        artifacts,
        clearApproval: true,
        historyState: "not_loaded",
        history: [],
        clearHistoryError: true,
      });
      this.emitEvent(taskId, parsed.data.id, "task.completed", { outcome, summary, artifacts });
    }
  }

  private updateTask(taskId: string, patch: {
    runId?: string;
    state?: TaskState;
    summary?: string;
    artifacts?: Artifact[];
    controlState?: TaskControlState;
    controlReason?: string;
    pendingApproval?: Approval;
    clearApproval?: boolean;
    historyState?: TaskHistoryState;
    history?: TaskHistoryEntry[];
    turnTimings?: TaskTurnTiming[];
    historyError?: string;
    clearHistoryError?: boolean;
    preserveUpdatedAt?: boolean;
  }): void {
    const current = this.tasks.get(taskId);
    if (!current) return;
    const {
      pendingApproval: currentApproval,
      controlReason: currentControlReason,
      historyError: currentHistoryError,
      ...base
    } = current;
    const activeTurnId = this.activeTurnIds.get(taskId);
    const externalActiveTurnId = this.externalActiveTurnIds.get(taskId);
    const controlState = patch.controlState ?? (this.managedThreads.has(taskId) ? "managed" : current.controlState);
    const controlReason = patch.controlReason ?? (controlState === current.controlState ? currentControlReason : undefined);
    const approval = patch.pendingApproval ?? (!patch.clearApproval ? currentApproval : undefined);
    const artifacts = patch.artifacts ?? current.artifacts;
    const historyError = patch.historyError ?? (!patch.clearHistoryError ? currentHistoryError : undefined);
    const capabilities: AgentCapability[] = ["history"];
    if (this.cliManagedThreads.has(taskId)) {
      capabilities.push(this.cliTurns.has(taskId) ? "stop" : "message");
    } else {
      if (controlState === "available" || controlState === "managed" || (controlState === "external_writer" && this.desktopIpcAvailable)) capabilities.push("message");
      if (activeTurnId && controlState === "managed") capabilities.push("stop", "structured_tool_calls");
      if (externalActiveTurnId && controlState === "external_writer" && this.desktopIpcAvailable) capabilities.push("stop");
      if (approval && (controlState === "managed" || (controlState === "external_writer" && this.desktopIpcAvailable))) {
        capabilities.push("approval");
      }
    }
    if (artifacts.length > 0) capabilities.push("diff");
    const next = TaskSchema.parse({
      ...base,
      ...(patch.runId ? { runId: patch.runId } : {}),
      ...(patch.state ? { state: patch.state } : {}),
      ...(patch.summary ? { summary: shortText(patch.summary) } : {}),
      artifacts,
      controlState,
      ...(controlReason ? { controlReason } : {}),
      ...(approval ? { pendingApproval: approval } : {}),
      historyState: patch.historyState ?? current.historyState,
      history: patch.history ?? current.history,
      turnTimings: patch.turnTimings ?? current.turnTimings,
      ...(historyError ? { historyError } : {}),
      capabilities,
      updatedAt: patch.preserveUpdatedAt ? current.updatedAt : new Date().toISOString(),
    });
    this.tasks.set(taskId, next);
    this.emitEvent(taskId, next.runId, "task.upsert", { task: next });
  }

  private replayTasks(): void {
    for (const task of this.tasks.values()) {
      this.emitEvent(task.id, task.runId, "task.upsert", { task });
    }
  }

  private emitEvent(taskId: string, runId: string, type: WorkstationEvent["type"], fields: JsonObject): void {
    this.sequence += 1;
    const event = WorkstationEventSchema.parse({
      protocolVersion: 1,
      eventId: createId("event"),
      deviceId,
      taskId,
      runId,
      sequence: this.sequence,
      emittedAt: new Date().toISOString(),
      type,
      ...fields,
    });
    this.emit?.(event);
  }

  private requireClient(): CodexAppServerClient {
    if (!this.client) throw new Error("Codex app-server 尚未连接");
    return this.client;
  }
}
