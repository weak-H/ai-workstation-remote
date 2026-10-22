import { basename } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import {
  TaskSchema,
  WorkstationEventSchema,
  createId,
  type AgentCapability,
  type Artifact,
  type MobileCommand,
  type Task,
  type TaskHistoryEntry,
  type TaskHistoryState,
  type TaskState,
  type TaskControlState,
  type WorkstationProject,
  type WorkstationEvent,
} from "@ai-workstation/protocol";
import { z } from "zod";

import { CursorAccessibilityRelayClient } from "../cursor-accessibility-relay.js";
import { CursorDesktopBridgeClient } from "../cursor-desktop-bridge.js";
import type { AgentAdapter, EmitAvailability, EmitEvent, EmitProjects } from "./types.js";
import { defaultCursorDatabasePath, processCommandLines, workstationDeviceId } from "../platform.js";
import { artifactsWithDiffContent, preserveArtifactContent, readWorkingTreeDiff } from "../working-tree-diff.js";

const deviceId = workstationDeviceId;
const defaultRefreshIntervalMs = 5_000;
const defaultMaxTasks = 200;
const historyPageSize = 100;
const maxHistoryEntries = 1_000;
const cursorTerminalStateGraceMs = 15_000;

const CursorWorkspaceSchema = z.object({
  id: z.string().optional(),
  uri: z.object({
    fsPath: z.string().optional(),
    path: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const CursorHeaderValueSchema = z.object({
  name: z.string().optional(),
  subtitle: z.string().optional(),
  isDraft: z.boolean().optional(),
  hasBlockingPendingActions: z.boolean().optional(),
  filesChangedCount: z.number().optional(),
  totalLinesAdded: z.number().optional(),
  totalLinesRemoved: z.number().optional(),
  workspaceIdentifier: CursorWorkspaceSchema.optional(),
}).passthrough();

const CursorConversationHeaderSchema = z.object({
  bubbleId: z.string().min(1),
  type: z.number().optional(),
  createdAt: z.string().optional(),
  startedAtMs: z.number().optional(),
  completedAtMs: z.number().optional(),
}).passthrough();

const CursorComposerDataSchema = z.object({
  composerId: z.string().optional(),
  name: z.string().optional(),
  subtitle: z.string().optional(),
  status: z.string().optional(),
  text: z.string().optional(),
  lastUpdatedAt: z.number().optional(),
  generatingBubbleIds: z.array(z.string()).catch([]),
  queueItems: z.array(z.unknown()).catch([]),
  fullConversationHeadersOnly: z.array(CursorConversationHeaderSchema).catch([]),
  workspaceIdentifier: CursorWorkspaceSchema.optional(),
}).passthrough();

const CursorBubbleSchema = z.object({
  bubbleId: z.string().min(1),
  type: z.number().optional(),
  text: z.string().optional(),
  richText: z.string().optional(),
  createdAt: z.string().optional(),
  startedAtMs: z.number().optional(),
  completedAtMs: z.number().optional(),
  capabilityType: z.number().optional(),
  thinking: z.object({ text: z.string().optional() }).passthrough().optional(),
  toolFormerData: z.object({
    name: z.string().optional(),
    params: z.string().optional(),
    rawArgs: z.string().optional(),
    result: z.string().optional(),
    status: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export type CursorComposerData = z.infer<typeof CursorComposerDataSchema>;
export type CursorBubble = z.infer<typeof CursorBubbleSchema>;

interface CursorHeaderRow {
  composerId: string;
  workspaceId: string;
  createdAt: number;
  lastUpdatedAt: number;
  headerValue: string;
  dataValue: SQLOutputValue | null;
}

export interface CursorConversation {
  composerId: string;
  workspaceId: string;
  createdAt: number;
  lastUpdatedAt: number;
  header: z.infer<typeof CursorHeaderValueSchema>;
  data: CursorComposerData;
}

interface CursorAdapterOptions {
  databasePath?: string;
  desktopBridgeDirectory?: string;
  accessibilityRelay?: CursorAccessibilityRelayClient;
  maxTasks?: number;
  refreshIntervalMs?: number;
}

const cursorAvailableReason = "消息会通过 Cursor Desktop 本机控制通道发送到同一会话，并复用桌面登录状态。";
const cursorBridgeRestartReason = "Cursor Desktop 本机控制通道尚未启动；请完整重启 Cursor。";
const cursorBridgePermissionReason = "Cursor Desktop 本机控制已开放；请在 Cursor 设置的 Beta 页面开启“Allow CLI to access desktop agents”并重启 Cursor。";
const cursorBridgeGateReason = "当前 Cursor 版本尚未向这个账号开放 Desktop Bridge；无需登录 Agent CLI，功能开放后即可复用桌面登录状态。";
const cursorRelayAvailableReason = "消息会通过本机 Cursor 中继扩展发送到同一会话，并复用桌面登录状态。";
const cursorRelayBootstrapReason = "Cursor 中继已安装；发送时会自动打开当前项目的 IDE 窗口并进入同一会话。";
const cursorRelayPermissionReason = "Cursor 中继扩展已连接；本机输入辅助程序仍需授权。";
const cursorRelayMissingReason = "Cursor Desktop Bridge 尚未开放，中继扩展也未运行；请执行 npm run setup:cursor-relay 并完整重启 Cursor。";
const cursorRelayInputMissingReason = "Cursor 中继扩展已运行，但缺少本机输入辅助程序；请执行 npm run setup:cursor-relay。";
const cursorNotRunningReason = "请先启动 Cursor；启动后网页会自动恢复发送能力。";

interface CursorTaskOptions {
  controlState?: TaskControlState;
  controlReason?: string;
  state?: TaskState;
  resolvedSummary?: string;
}

interface CursorRuntimeOverride {
  state: TaskState;
  summary: string;
  controlState: TaskControlState;
  controlReason: string;
  awaitedUserBubbleId?: string;
}

function cursorCapabilities(controlState: TaskControlState, artifacts: Artifact[]): AgentCapability[] {
  const capabilities: AgentCapability[] = ["history"];
  if (controlState === "available") capabilities.push("message");
  if (artifacts.length > 0) capabilities.push("diff");
  return capabilities;
}

function boundedText(value: string, limit = 8_000): string {
  const normalized = value.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function shortText(value: string, limit = 1_800): string {
  return boundedText(value.replace(/\s+/g, " "), limit);
}

function sqliteText(value: SQLOutputValue | null | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

function parseJson<T>(value: SQLOutputValue | null | undefined, schema: z.ZodType<T>): T | undefined {
  const text = sqliteText(value);
  if (!text) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function timestampIso(...values: Array<number | string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return undefined;
}

function conversationActivityAt(conversation: CursorConversation): number {
  const headerTimes = conversation.data.fullConversationHeadersOnly.slice(-32).flatMap((header) => [
    header.startedAtMs,
    header.completedAtMs,
    typeof header.createdAt === "string" ? Date.parse(header.createdAt) : undefined,
  ]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return Math.max(conversation.lastUpdatedAt, conversation.data.lastUpdatedAt ?? 0, ...headerTimes);
}

function workspacePath(conversation: CursorConversation): string | undefined {
  const workspace = conversation.data.workspaceIdentifier ?? conversation.header.workspaceIdentifier;
  return workspace?.uri?.fsPath ?? workspace?.uri?.path;
}

export function cursorProjectForConversation(conversation: CursorConversation): WorkstationProject {
  const path = workspacePath(conversation);
  const rawName = path ? basename(path) : "最近会话";
  // Cursor assigns different workspace ids to windowless conversations. They
  // are still one logical inbox, so keep them under a single project.
  const id = path && conversation.workspaceId !== "empty-window"
    ? `cursor_workspace_${conversation.workspaceId}`
    : "cursor_recent";
  return {
    id,
    name: shortText(path ? `Cursor · ${rawName || "工作区"}` : "Cursor · 最近会话", 120),
    order: 0,
    source: "cursor",
  };
}

export function cursorTaskState(
  status: string | undefined,
  generatingCount: number,
  hasBlockingPendingActions = false,
): TaskState {
  if (hasBlockingPendingActions) return "waiting_for_user";
  if (generatingCount > 0 || status === "generating" || status === "running") return "running";
  if (status === "completed") return "succeeded";
  if (status === "aborted" || status === "cancelled" || status === "canceled") return "stopped";
  if (status === "failed" || status === "error") return "failed";
  if (status === undefined || status === "none" || status === "idle") return "idle";
  return "unknown";
}

function bubbleText(bubble: CursorBubble): string | undefined {
  const value = bubble.text ?? bubble.richText;
  return value && value.trim() ? value : undefined;
}

function turnIdForBubble(bubbleId: string): string {
  return bubbleId.split("/", 1)[0] ?? bubbleId;
}

export function cursorConversationHasAgentReply(
  conversation: CursorConversation,
  userBubbleId: string,
  bubbleForId: (bubbleId: string) => CursorBubble | undefined,
): boolean {
  const userIndex = conversation.data.fullConversationHeadersOnly.findIndex(
    (header) => header.bubbleId === userBubbleId,
  );
  if (userIndex < 0) return false;
  return conversation.data.fullConversationHeadersOnly.slice(userIndex + 1).some((header) => {
    if (header.type !== 2 || turnIdForBubble(header.bubbleId) !== userBubbleId) return false;
    return Boolean(bubbleText(bubbleForId(header.bubbleId) ?? { bubbleId: header.bubbleId }));
  });
}

export function cursorConversationRevision(
  conversation: CursorConversation,
  bubbleForId: (bubbleId: string) => CursorBubble | undefined,
): string {
  const headers = conversation.data.fullConversationHeadersOnly;
  const latestHeader = headers.at(-1);
  const latestBubble = latestHeader ? bubbleForId(latestHeader.bubbleId) : undefined;
  return JSON.stringify({
    status: conversation.data.status,
    generatingBubbleIds: conversation.data.generatingBubbleIds,
    queueItems: conversation.data.queueItems,
    blocking: conversation.header.hasBlockingPendingActions ?? false,
    headerCount: headers.length,
    latestHeader,
    latestBubble: latestBubble ? {
      type: latestBubble.type,
      text: latestBubble.text,
      richText: latestBubble.richText,
      thinking: latestBubble.thinking?.text,
      toolStatus: latestBubble.toolFormerData?.status,
      toolResult: latestBubble.toolFormerData?.result,
      completedAtMs: latestBubble.completedAtMs,
    } : undefined,
  });
}

export function stabilizeCursorTaskState(
  observedState: TaskState,
  lastActivityAt: number | undefined,
  now = Date.now(),
): TaskState {
  if (observedState !== "stopped" || lastActivityAt === undefined) return observedState;
  return now - lastActivityAt < cursorTerminalStateGraceMs ? "running" : observedState;
}

export function shouldClearCursorRuntimeOverride(
  awaitedUserBubbleId: string | undefined,
  observedState: TaskState,
  observedReply: boolean,
): boolean {
  const observedExecution = observedState === "running" || observedState === "waiting_for_user";
  if (!awaitedUserBubbleId) return observedExecution;
  if (observedState === "failed") return true;
  return observedState === "succeeded" && observedReply;
}

function runIdForConversation(conversation: CursorConversation): string {
  const latest = conversation.data.fullConversationHeadersOnly.at(-1)?.bubbleId;
  return `cursor_run_${latest ? turnIdForBubble(latest) : conversation.composerId}`;
}

function toolEntry(bubble: CursorBubble, createdAt: string | undefined): TaskHistoryEntry | undefined {
  const tool = bubble.toolFormerData;
  if (!tool) return undefined;
  const name = tool.name?.trim() || "Cursor 工具";
  const input = tool.params?.trim() || tool.rawArgs?.trim();
  const result = tool.result?.trim();
  const text = boundedText([input, result].filter(Boolean).join("\n\n") || "工具调用已记录");
  const lowerName = name.toLowerCase();
  const kind = /terminal|shell|command|run/.test(lowerName)
    ? "command"
    : /edit|write|delete|apply|patch/.test(lowerName)
      ? "file_change"
      : "tool";
  return {
    id: `cursor_history_${bubble.bubbleId}`,
    turnId: `cursor_turn_${turnIdForBubble(bubble.bubbleId)}`,
    kind,
    title: shortText(name, 200),
    text,
    ...(tool.status ? { status: tool.status } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

export function cursorBubbleToHistory(bubble: CursorBubble): TaskHistoryEntry | undefined {
  const createdAt = timestampIso(bubble.startedAtMs, bubble.createdAt, bubble.completedAtMs);
  const base = {
    id: `cursor_history_${bubble.bubbleId}`,
    turnId: `cursor_turn_${turnIdForBubble(bubble.bubbleId)}`,
    ...(createdAt ? { createdAt } : {}),
  };
  const tool = toolEntry(bubble, createdAt);
  if (tool) return tool;
  const thinking = bubble.thinking?.text?.trim();
  if (thinking) return { ...base, kind: "reasoning", title: "思考摘要", text: boundedText(thinking) };
  const text = bubbleText(bubble);
  if (!text) return undefined;
  if (bubble.type === 1) return { ...base, kind: "user_message", text: boundedText(text) };
  if (bubble.type === 2) return { ...base, kind: "agent_message", text: boundedText(text) };
  return { ...base, kind: "system", text: boundedText(text) };
}

function fallbackSummary(state: TaskState): string {
  if (state === "running") return "Cursor 正在处理任务";
  if (state === "waiting_for_user") return "Cursor 正在等待桌面端操作";
  if (state === "succeeded") return "Cursor 会话已完成";
  if (state === "stopped") return "Cursor 会话已停止";
  if (state === "failed") return "Cursor 会话执行失败";
  if (state === "unknown") return "Cursor 会话状态未知";
  return "Cursor 会话空闲";
}

function conversationArtifacts(conversation: CursorConversation): Artifact[] {
  const changed = conversation.header.filesChangedCount ?? 0;
  if (changed <= 0) return [];
  const added = conversation.header.totalLinesAdded ?? 0;
  const removed = conversation.header.totalLinesRemoved ?? 0;
  return [{
    id: `cursor_diff_${conversation.composerId}`,
    kind: "diff",
    title: `代码变更 · ${changed} 个文件`,
    summary: `+${added} / -${removed} 行`,
    stats: { filesChanged: changed, additions: added, deletions: removed },
  }];
}

export function cursorConversationToTask(
  conversation: CursorConversation,
  project: WorkstationProject,
  summary: string | undefined,
  existing?: Task,
  options: CursorTaskOptions = {},
): Task {
  const state = options.state ?? cursorTaskState(
    conversation.data.status,
    conversation.data.generatingBubbleIds.length,
    conversation.header.hasBlockingPendingActions,
  );
  const artifacts = preserveArtifactContent(conversationArtifacts(conversation), existing?.artifacts);
  const title = shortText(conversation.data.name ?? conversation.header.name ?? "", 240) || "未命名 Cursor 会话";
  const controlState = options.controlState ?? "available";
  const controlReason = options.controlReason ?? (controlState === "available" ? cursorAvailableReason : cursorBridgeGateReason);
  return TaskSchema.parse({
    id: `cursor_${conversation.composerId}`,
    deviceId,
    projectId: project.id,
    projectName: project.name,
    runId: runIdForConversation(conversation),
    agentId: "cursor-local",
    agentName: "Cursor",
    title,
    state,
    summary: options.resolvedSummary ? shortText(options.resolvedSummary) : summary ? shortText(summary) : fallbackSummary(state),
    controlState,
    controlReason,
    capabilities: cursorCapabilities(controlState, artifacts),
    artifacts,
    historyState: existing?.historyState ?? "not_loaded",
    history: existing?.history ?? [],
    turnTimings: existing?.turnTimings ?? [],
    ...(existing?.historyError ? { historyError: existing.historyError } : {}),
    updatedAt: new Date(conversationActivityAt(conversation)).toISOString(),
  });
}

export class CursorStateStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path, { readOnly: true, timeout: 2_000 });
    this.database.exec("PRAGMA query_only = ON");
  }

  close(): void {
    this.database.close();
  }

  conversations(limit: number, workspaceIds?: readonly string[]): CursorConversation[] {
    if (workspaceIds?.length === 0) return [];
    const clauses = [
      "h.isArchived = 0",
      "h.isSubagent = 0",
      "COALESCE(json_extract(h.value, '$.isDraft'), 0) = 0",
    ];
    const parameters: Array<string | number> = [];
    if (workspaceIds && workspaceIds.length > 0) {
      clauses.push(`h.workspaceId IN (${workspaceIds.map(() => "?").join(", ")})`);
      parameters.push(...workspaceIds);
    }
    parameters.push(limit);
    const rows = this.database.prepare(`
      SELECT
        h.composerId AS composerId,
        h.workspaceId AS workspaceId,
        h.createdAt AS createdAt,
        h.lastUpdatedAt AS lastUpdatedAt,
        h.value AS headerValue,
        d.value AS dataValue
      FROM composerHeaders h
      LEFT JOIN cursorDiskKV d ON d.key = 'composerData:' || h.composerId
      WHERE ${clauses.join(" AND ")}
      ORDER BY h.recency DESC, h.lastUpdatedAt DESC
      LIMIT ?
    `).all(...parameters) as unknown as CursorHeaderRow[];

    return rows.flatMap((row) => {
      const header = parseJson(row.headerValue, CursorHeaderValueSchema);
      const data = parseJson(row.dataValue, CursorComposerDataSchema);
      if (!header || !data) return [];
      return [{
        composerId: row.composerId,
        workspaceId: row.workspaceId,
        createdAt: row.createdAt,
        lastUpdatedAt: row.lastUpdatedAt,
        header,
        data,
      }];
    });
  }

  conversation(composerId: string): CursorConversation | undefined {
    const row = this.database.prepare(`
      SELECT
        h.composerId AS composerId,
        h.workspaceId AS workspaceId,
        h.createdAt AS createdAt,
        h.lastUpdatedAt AS lastUpdatedAt,
        h.value AS headerValue,
        d.value AS dataValue
      FROM composerHeaders h
      LEFT JOIN cursorDiskKV d ON d.key = 'composerData:' || h.composerId
      WHERE h.composerId = ?
        AND h.isArchived = 0
        AND h.isSubagent = 0
        AND COALESCE(json_extract(h.value, '$.isDraft'), 0) = 0
      LIMIT 1
    `).get(composerId) as unknown as CursorHeaderRow | undefined;
    if (!row) return undefined;
    const header = parseJson(row.headerValue, CursorHeaderValueSchema);
    const data = parseJson(row.dataValue, CursorComposerDataSchema);
    if (!header || !data) return undefined;
    return {
      composerId: row.composerId,
      workspaceId: row.workspaceId,
      createdAt: row.createdAt,
      lastUpdatedAt: row.lastUpdatedAt,
      header,
      data,
    };
  }

  bubble(composerId: string, bubbleId: string): CursorBubble | undefined {
    const row = this.database.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(
      `bubbleId:${composerId}:${bubbleId}`,
    ) as { value?: SQLOutputValue } | undefined;
    return parseJson(row?.value, CursorBubbleSchema);
  }

  desktopBridgeState(): { featureEnabled: boolean; userEnabled: boolean } {
    try {
      const rows = this.database.prepare(`
        SELECT key, value
        FROM ItemTable
        WHERE key IN ('cursor.desktopBridge.enabled', 'cursor/desktopBridgeUserEnabled')
      `).all() as Array<{ key: string; value: SQLOutputValue }>;
      const values = new Map(rows.map((row) => [row.key, sqliteText(row.value)]));
      return {
        featureEnabled: values.get("cursor.desktopBridge.enabled") === "true",
        userEnabled: values.get("cursor/desktopBridgeUserEnabled") === "true",
      };
    } catch {
      return { featureEnabled: false, userEnabled: false };
    }
  }
}

export interface CursorProcessSnapshot {
  running: boolean;
  workspaceIds: Set<string>;
}

type CursorConversationSelection =
  | { mode: "all" }
  | { mode: "retain" }
  | { mode: "workspaces"; workspaceIds: string[] };

export function cursorConversationSelection(
  processSnapshot: CursorProcessSnapshot | undefined,
): CursorConversationSelection {
  if (!processSnapshot) return { mode: "all" };
  if (!processSnapshot.running) return { mode: "workspaces", workspaceIds: [] };
  if (processSnapshot.workspaceIds.size === 0) return { mode: "retain" };
  return { mode: "workspaces", workspaceIds: [...processSnapshot.workspaceIds] };
}

export function parseCursorProcessList(output: string): CursorProcessSnapshot {
  const lines = output.split("\n");
  const workspaceIds = new Set<string>();
  for (const line of lines) {
    const match = line.match(/fileWatcher \[1:([^\]]+)\]/);
    if (match?.[1]) workspaceIds.add(match[1]);
  }
  return {
    running: lines.some((line) => (
      /^\s*\/(?:\S*\/)?Cursor\.app\/Contents\/MacOS\/Cursor(?:\s|$)/.test(line)
      || /^\s*"?(?:[A-Za-z]:\\[^"\r\n]*\\)?Cursor\.exe"?(?:\s|$)/i.test(line)
    )),
    workspaceIds,
  };
}

async function cursorProcessSnapshot(): Promise<CursorProcessSnapshot | undefined> {
  try {
    return parseCursorProcessList(await processCommandLines());
  } catch {
    // Bridge discovery below is the fallback when the host does not expose `ps`.
    return undefined;
  }
}

export class CursorAgentAdapter implements AgentAdapter {
  readonly id = "cursor-local";
  readonly name = "Cursor";
  readonly source = "cursor" as const;
  readonly capabilities = ["history", "new_task"] as const satisfies readonly AgentCapability[];

  private readonly databasePath: string;
  private readonly desktopBridge: CursorDesktopBridgeClient;
  private readonly accessibilityRelay: CursorAccessibilityRelayClient;
  private readonly maxTasks: number;
  private readonly refreshIntervalMs: number;
  private store: CursorStateStore | undefined;
  private emit: EmitEvent | undefined;
  private emitProjects: EmitProjects | undefined;
  private emitAvailability: EmitAvailability | undefined;
  private active = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private sequence = 0;
  private projects: WorkstationProject[] = [];
  private projectSignature = "";
  private readonly tasks = new Map<string, Task>();
  private readonly conversationsByTaskId = new Map<string, CursorConversation>();
  private readonly historyStartIndexes = new Map<string, number>();
  private readonly runtimeOverrides = new Map<string, CursorRuntimeOverride>();
  private readonly conversationRevisions = new Map<string, string>();
  private readonly recentConversationActivity = new Map<string, number>();
  private readonly workspacePathByProjectId = new Map<string, string>();
  private desktopBridgeAvailable = false;
  private cursorControlMode: "desktop_bridge" | "accessibility_relay" | undefined;
  private cursorControlReason = cursorBridgeGateReason;

  constructor(options: CursorAdapterOptions = {}) {
    this.databasePath = options.databasePath ?? defaultCursorDatabasePath();
    this.desktopBridge = new CursorDesktopBridgeClient({
      ...(options.desktopBridgeDirectory ? { discoveryDirectory: options.desktopBridgeDirectory } : {}),
    });
    this.accessibilityRelay = options.accessibilityRelay ?? new CursorAccessibilityRelayClient();
    this.maxTasks = options.maxTasks ?? defaultMaxTasks;
    this.refreshIntervalMs = options.refreshIntervalMs ?? defaultRefreshIntervalMs;
  }

  async start(emit: EmitEvent, emitProjects: EmitProjects, emitAvailability?: EmitAvailability): Promise<void> {
    this.emit = emit;
    this.emitProjects = emitProjects;
    if (emitAvailability) this.emitAvailability = emitAvailability;
    const reconnecting = this.store !== undefined;
    if (!this.store) this.store = new CursorStateStore(this.databasePath);
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.refresh().catch((error: unknown) => {
          console.warn(`[cursor] refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, this.refreshIntervalMs);
    }
    await this.refresh();
    if (reconnecting) {
      this.emitProjects(this.projects);
      for (const task of this.tasks.values()) {
        this.emitEvent(task.id, task.runId, "task.upsert", { task });
      }
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
        this.loadHistory(command.taskId, command.action.direction ?? "latest");
        return;
      }
      if (command.action.kind === "request_diff") {
        await this.loadDiff(command.taskId);
        return;
      }
      if (command.action.kind === "message") {
        await this.startMessage(command.taskId, command.action.text);
        return;
      }
      throw new Error("Cursor 当前仅支持消息和历史读取");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[cursor] ${command.action.kind} failed for ${command.taskId}: ${message}`);
      this.updateCursorTask(command.taskId, {
        state: "failed",
        summary: shortText(`操作失败：${message}`),
        controlState: this.cursorControlMode ? "available" : "unavailable",
        controlReason: this.cursorControlReason,
      });
      throw error;
    }
  }

  async createTask(command: MobileCommand, emit: EmitEvent): Promise<void> {
    this.emit = emit;
    if (command.action.kind !== "new_task" || command.action.source !== "cursor") {
      throw new Error("无效的 Cursor 新建任务命令");
    }
    const projectId = command.action.projectId;
    if (!projectId) throw new Error("请先选择一个 Cursor 项目");
    const workspaceDirectory = this.workspacePathByProjectId.get(projectId);
    if (!workspaceDirectory) throw new Error("该 Cursor 项目没有可用的工作区目录");
    const knownIds = new Set([...this.conversationsByTaskId.values()].map((conversation) => conversation.composerId));
    await this.accessibilityRelay.createMessage(command.action.text, workspaceDirectory);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const created = this.requireStore().conversations(this.maxTasks).find((conversation) => (
        !knownIds.has(conversation.composerId)
        && workspaceDirectory === workspacePath(conversation)
      ));
      if (created) {
        const project = cursorProjectForConversation(created);
        const taskId = `cursor_${created.composerId}`;
        const task = cursorConversationToTask(created, project, undefined, undefined, {
          state: "running",
          resolvedSummary: "Cursor 已接收新任务，正在处理",
          controlState: "available",
          controlReason: cursorRelayAvailableReason,
        });
        this.conversationsByTaskId.set(taskId, created);
        this.tasks.set(taskId, task);
        this.runtimeOverrides.set(taskId, {
          state: "running",
          summary: task.summary,
          controlState: "available",
          controlReason: cursorRelayAvailableReason,
        });
        this.emitEvent(task.id, task.runId, "task.upsert", { task });
        void this.refresh().catch((error: unknown) => {
          console.warn(`[cursor] refresh after task creation failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 160));
    }
    throw new Error("Cursor 已执行新建操作，但没有在本地会话库中确认新任务");
  }

  private async loadDiff(taskId: string): Promise<void> {
    const current = this.tasks.get(taskId);
    const conversation = this.conversationsByTaskId.get(taskId);
    const cwd = conversation ? workspacePath(conversation) : undefined;
    if (!current || !cwd) throw new Error("该 Cursor 会话没有可用的工作区目录");
    const artifacts = artifactsWithDiffContent(current.artifacts, await readWorkingTreeDiff(cwd));
    const task = TaskSchema.parse({ ...current, artifacts });
    this.tasks.set(taskId, task);
    this.emitEvent(task.id, task.runId, "task.upsert", { task });
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const processSnapshot = await cursorProcessSnapshot();
      try {
        const state = this.requireStore().desktopBridgeState();
        const discovered = await this.desktopBridge.isAvailable();
        this.desktopBridgeAvailable = state.featureEnabled && state.userEnabled && discovered;
        if (this.desktopBridgeAvailable) {
          this.cursorControlMode = "desktop_bridge";
          this.cursorControlReason = cursorAvailableReason;
        } else {
          const relay = await this.accessibilityRelay.availability();
          if (relay.available && processSnapshot?.running !== false) {
            this.cursorControlMode = "accessibility_relay";
            this.cursorControlReason = relay.accessibilityTrusted
              ? relay.relayRunning ? cursorRelayAvailableReason : cursorRelayBootstrapReason
              : cursorRelayPermissionReason;
          } else {
            this.cursorControlMode = undefined;
            this.cursorControlReason = processSnapshot?.running === false
              ? cursorNotRunningReason
              : !relay.available && relay.reason === "input_unavailable"
                ? cursorRelayInputMissingReason
                : cursorRelayMissingReason;
          }
        }
      } catch (error) {
        this.desktopBridgeAvailable = false;
        this.cursorControlMode = undefined;
        this.cursorControlReason = cursorBridgeRestartReason;
        console.warn(`[cursor] control discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const sourceActive = processSnapshot?.running ?? Boolean(this.cursorControlMode);
      if (!sourceActive) this.setActive(false);

      const selection = process.platform === "win32" && processSnapshot?.running && processSnapshot.workspaceIds.size === 0
        ? { mode: "all" as const }
        : cursorConversationSelection(processSnapshot);
      if (selection.mode === "retain") {
        if (sourceActive) this.setActive(true);
        return;
      }
      const conversations = selection.mode === "all"
        ? this.requireStore().conversations(this.maxTasks)
        : this.requireStore().conversations(this.maxTasks, selection.workspaceIds);
      const projects = new Map<string, WorkstationProject>();
      this.workspacePathByProjectId.clear();
      const seen = new Set<string>();

      for (const conversation of conversations) {
        const taskId = `cursor_${conversation.composerId}`;
        const project = cursorProjectForConversation(conversation);
        if (!projects.has(project.id)) projects.set(project.id, { ...project, order: projects.size });
        const path = workspacePath(conversation);
        if (path) this.workspacePathByProjectId.set(project.id, path);
        const existing = this.tasks.get(taskId);
        const revision = cursorConversationRevision(
          conversation,
          (bubbleId) => this.requireStore().bubble(conversation.composerId, bubbleId),
        );
        const previousRevision = this.conversationRevisions.get(taskId);
        const conversationChanged = previousRevision !== undefined && previousRevision !== revision;
        if (conversationChanged) this.recentConversationActivity.set(taskId, Date.now());
        const shouldRefreshLoadedHistory = conversationChanged
          && (existing?.historyState === "loaded" || existing?.historyState === "partial");
        const latestSummary = previousRevision === revision
          ? existing?.summary
          : this.latestSummary(conversation);
        const rawObservedState = cursorTaskState(
          conversation.data.status,
          conversation.data.generatingBubbleIds.length,
          conversation.header.hasBlockingPendingActions,
        );
        const observedState = stabilizeCursorTaskState(
          rawObservedState,
          this.recentConversationActivity.get(taskId),
        );
        if (rawObservedState !== "stopped") this.recentConversationActivity.delete(taskId);
        const runtime = this.runtimeOverrides.get(taskId);
        const observedReply = runtime?.awaitedUserBubbleId
          ? cursorConversationHasAgentReply(
            conversation,
            runtime.awaitedUserBubbleId,
            (bubbleId) => this.requireStore().bubble(conversation.composerId, bubbleId),
          )
          : false;
        if (runtime && shouldClearCursorRuntimeOverride(
          runtime.awaitedUserBubbleId,
          observedState,
          observedReply,
        )) {
          this.runtimeOverrides.delete(taskId);
        }
        const activeRuntime = this.runtimeOverrides.get(taskId);
        const controlState: TaskControlState = activeRuntime?.controlState
          ?? (this.cursorControlMode ? "available" : "unavailable");
        const effectiveState = activeRuntime?.state;
        const effectiveSummary = activeRuntime?.summary;
        const task = cursorConversationToTask(
          conversation,
          projects.get(project.id) ?? project,
          latestSummary,
          existing,
          {
            controlState,
            ...(effectiveState ? { state: effectiveState } : {}),
            ...(effectiveSummary ? { resolvedSummary: effectiveSummary } : {}),
            controlReason: activeRuntime?.controlReason
              ?? this.cursorControlReason,
          },
        );
        seen.add(taskId);
        this.conversationRevisions.set(taskId, revision);
        this.conversationsByTaskId.set(taskId, conversation);
        this.tasks.set(taskId, task);
        if (!existing || JSON.stringify(existing) !== JSON.stringify(task)) {
          this.emitEvent(task.id, task.runId, "task.upsert", { task });
        }
        if (shouldRefreshLoadedHistory) this.loadHistory(taskId, "latest", true);
      }

      for (const [taskId, task] of this.tasks) {
        if (seen.has(taskId)) continue;
        this.tasks.delete(taskId);
        this.conversationsByTaskId.delete(taskId);
        this.runtimeOverrides.delete(taskId);
        this.conversationRevisions.delete(taskId);
        this.recentConversationActivity.delete(taskId);
        this.historyStartIndexes.delete(taskId);
        this.emitEvent(taskId, task.runId, "task.removed", {});
      }

      this.projects = [...projects.values()];
      const projectSignature = JSON.stringify(this.projects);
      if (projectSignature !== this.projectSignature) {
        this.projectSignature = projectSignature;
        this.emitProjects?.(this.projects);
      }
      if (sourceActive) this.setActive(true);
    } finally {
      this.refreshing = false;
    }
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.emitAvailability?.(active);
  }

  private latestSummary(conversation: CursorConversation): string | undefined {
    const headers = conversation.data.fullConversationHeadersOnly;
    for (let index = headers.length - 1; index >= Math.max(0, headers.length - 8); index -= 1) {
      const header = headers[index];
      if (!header) continue;
      const bubble = this.requireStore().bubble(conversation.composerId, header.bubbleId);
      if (!bubble) continue;
      const text = bubbleText(bubble) ?? bubble.thinking?.text;
      if (text?.trim()) return text;
      if (bubble.toolFormerData?.name) return `Cursor 工具：${bubble.toolFormerData.name}`;
    }
    return conversation.data.subtitle ?? conversation.header.subtitle;
  }

  private async startMessage(taskId: string, text: string): Promise<void> {
    const task = this.tasks.get(taskId);
    const conversation = this.conversationsByTaskId.get(taskId);
    if (!task || !conversation) throw new Error("找不到对应的 Cursor 会话");
    if (!text.trim()) throw new Error("消息不能为空");
    if (!task.capabilities.includes("message")) {
      throw new Error(task.controlReason ?? "当前 Cursor 会话不可发送指令");
    }
    this.updateCursorTask(taskId, {
      state: "running",
      summary: "正在将网页指令发送到 Cursor Desktop",
      controlState: "available",
      controlReason: cursorAvailableReason,
    });
    const message = text.trim();
    if (this.cursorControlMode === "desktop_bridge") {
      const result = await this.desktopBridge.sendMessage(conversation.composerId, message);
      if (result.status === "submitted") {
        this.updateCursorTask(taskId, {
          state: "running",
          summary: "Cursor Desktop 已接收网页指令，正在同一会话中处理",
          controlState: "available",
          controlReason: cursorAvailableReason,
        });
      } else if (result.status === "queued") {
        this.updateCursorTask(taskId, {
          state: "running",
          summary: "Cursor Desktop 正在执行；网页指令已排入同一会话",
          controlState: "available",
          controlReason: cursorAvailableReason,
        });
      } else if (result.status === "timeout") {
        throw new Error("Cursor Desktop 未及时确认，消息可能已经提交");
      } else if (result.status === "unknown-thread") {
        throw new Error("Cursor Desktop 当前没有打开这个会话");
      } else if (result.status === "not-sendable") {
        throw new Error(result.reason);
      } else if (result.status === "error") {
        throw new Error(result.message);
      }
    } else if (this.cursorControlMode === "accessibility_relay") {
      const knownBubbleIds = new Set(conversation.data.fullConversationHeadersOnly.map((header) => header.bubbleId));
      await this.accessibilityRelay.sendMessage(conversation.composerId, message, workspacePath(conversation));
      const submittedBubbleId = await this.waitForRelaySubmission(conversation.composerId, knownBubbleIds);
      if (!submittedBubbleId) {
        throw new Error("已执行 Cursor 输入操作，但未在本地会话中确认新消息；为避免重复发送，请先查看 Cursor");
      }
      this.updateCursorTask(taskId, {
        state: "running",
        summary: "Cursor 已确认网页指令，正在同一会话中处理",
        controlState: "available",
        controlReason: cursorRelayAvailableReason,
        awaitedUserBubbleId: submittedBubbleId,
      });
    } else {
      throw new Error(this.cursorControlReason);
    }
    void this.refresh().catch((error: unknown) => {
      console.warn(`[cursor] refresh after message failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async waitForRelaySubmission(
    composerId: string,
    knownBubbleIds: ReadonlySet<string>,
  ): Promise<string | undefined> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const latest = this.requireStore().conversation(composerId);
      if (latest) {
        for (const header of latest.data.fullConversationHeadersOnly) {
          if (knownBubbleIds.has(header.bubbleId)) continue;
          const bubble = this.requireStore().bubble(composerId, header.bubbleId);
          if (bubble?.type === 1) return header.bubbleId;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 160));
    }
    return undefined;
  }

  private updateCursorTask(taskId: string, patch: {
    state?: TaskState;
    summary?: string;
    controlState?: TaskControlState;
    controlReason?: string;
    awaitedUserBubbleId?: string;
  }): void {
    const current = this.tasks.get(taskId);
    if (!current) return;
    const controlState = patch.controlState ?? current.controlState;
    const controlReason = patch.controlReason
      ?? this.cursorControlReason;
    const next = TaskSchema.parse({
      ...current,
      ...(patch.state ? { state: patch.state } : {}),
      ...(patch.summary ? { summary: shortText(patch.summary) } : {}),
      controlState,
      controlReason,
      capabilities: cursorCapabilities(controlState, current.artifacts),
      updatedAt: new Date().toISOString(),
    });
    this.tasks.set(taskId, next);
    this.runtimeOverrides.set(taskId, {
      state: next.state,
      summary: next.summary,
      controlState: next.controlState,
      controlReason: next.controlReason ?? cursorAvailableReason,
      ...(patch.awaitedUserBubbleId ? { awaitedUserBubbleId: patch.awaitedUserBubbleId } : {}),
    });
    this.emitEvent(taskId, next.runId, "task.upsert", { task: next });
  }

  private loadHistory(taskId: string, direction: "latest" | "older", preserveDepth = false): void {
    const conversation = this.conversationsByTaskId.get(taskId);
    if (!conversation) throw new Error("找不到对应的 Cursor 会话");
    const current = this.tasks.get(taskId);
    if (!current) throw new Error("找不到对应的 Cursor 任务");
    if (direction === "older" && current.historyState !== "partial") return;
    if (direction === "latest" && !preserveDepth) this.updateHistory(taskId, "loading", current.history);
    try {
      const sourceHeaders = conversation.data.fullConversationHeadersOnly;
      const previousStart = this.historyStartIndexes.get(taskId) ?? sourceHeaders.length;
      const start = direction === "older"
        ? Math.max(0, previousStart - historyPageSize)
        : preserveDepth
          ? Math.max(0, Math.min(previousStart, sourceHeaders.length - 1))
          : Math.max(0, sourceHeaders.length - historyPageSize);
      const end = direction === "older" ? previousStart : sourceHeaders.length;
      const boundedStart = Math.max(start, end - maxHistoryEntries);
      const headers = sourceHeaders.slice(boundedStart, end);
      const history = headers.flatMap((header) => {
        const bubble = this.requireStore().bubble(conversation.composerId, header.bubbleId);
        if (!bubble) return [];
        const entry = cursorBubbleToHistory(bubble);
        return entry ? [entry] : [];
      });
      const nextHistory = direction === "older"
        ? [...history, ...current.history].slice(-maxHistoryEntries)
        : history;
      this.historyStartIndexes.set(taskId, boundedStart);
      this.updateHistory(
        taskId,
        boundedStart > 0 && nextHistory.length < maxHistoryEntries ? "partial" : "loaded",
        nextHistory,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateHistory(taskId, "failed", current.history, shortText(message, 500));
    }
  }

  private updateHistory(
    taskId: string,
    state: TaskHistoryState,
    history: TaskHistoryEntry[],
    historyError?: string,
  ): void {
    const current = this.tasks.get(taskId);
    if (!current) return;
    const { historyError: _historyError, ...base } = current;
    const task = TaskSchema.parse({
      ...base,
      historyState: state,
      history,
      ...(historyError ? { historyError } : {}),
    });
    this.tasks.set(taskId, task);
    this.emitEvent(taskId, task.runId, "task.upsert", { task });
  }

  private emitEvent(taskId: string, runId: string, type: WorkstationEvent["type"], fields: Record<string, unknown>): void {
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

  private requireStore(): CursorStateStore {
    if (!this.store) throw new Error("Cursor 本地状态库尚未连接");
    return this.store;
  }
}
