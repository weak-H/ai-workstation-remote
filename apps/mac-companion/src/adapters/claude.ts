import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";

import {
  TaskSchema,
  WorkstationEventSchema,
  createId,
  type AgentCapability,
  type Artifact,
  type MobileCommand,
  type Task,
  type TaskControlState,
  type TaskHistoryEntry,
  type TaskHistoryState,
  type TaskState,
  type TaskTurnTiming,
  type WorkstationEvent,
  type WorkstationProject,
} from "@ai-workstation/protocol";

import type { AgentAdapter, EmitAvailability, EmitEvent, EmitProjects } from "./types.js";
import { processCommandLines, workstationDeviceId } from "../platform.js";
import { artifactsWithDiffContent, preserveArtifactContent, readWorkingTreeDiff } from "../working-tree-diff.js";

const execFileAsync = promisify(execFile);
const deviceId = workstationDeviceId;
const defaultRefreshIntervalMs = 5_000;
const defaultMaxTasks = 200;
const historyPageSize = 100;
const maxHistoryEntries = 1_000;
const externalActivityGraceMs = 15_000;
const claudeAvailableReason = "消息会通过本机 Claude Code CLI 恢复到同一 session，并复用现有登录状态。";
const claudeMissingReason = "未找到 Claude Code CLI；安装 Claude Code 或设置 CLAUDE_BIN 后可继续这个会话。";
const claudeExternalReason = "Claude Code 终端正在写入这个会话；网页会同步进度，终端空闲后可继续操作。";

type JsonObject = Record<string, unknown>;

export interface ClaudeSession {
  id: string;
  path: string;
  cwd: string;
  title: string;
  summary: string;
  state: TaskState;
  updatedAt: string;
  history: TaskHistoryEntry[];
  turnTimings: TaskTurnTiming[];
  artifacts: Artifact[];
  revision: string;
}

interface ClaudeAdapterOptions {
  projectsDirectory?: string;
  claudeBin?: string;
  maxTasks?: number;
  refreshIntervalMs?: number;
}

interface ClaudeTaskOptions {
  cliAvailable: boolean;
  externalWriter?: boolean;
  managed?: boolean;
  existing?: Task;
}

interface ClaudeProcessSnapshot {
  running: boolean;
  sessionIds: Set<string>;
  unidentifiedCount: number;
}

interface ClaudeSessionFile {
  path: string;
  size: number;
  mtimeMs: number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, limit = 8_000): string {
  const normalized = value.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function shortText(value: string, limit = 1_800): string {
  return boundedText(value.replace(/\s+/g, " "), limit);
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!isObject(item)) return [];
    const blockText = stringValue(item.text) ?? stringValue(item.content);
    return blockText ? [blockText] : [];
  }).join("\n").trim();
  return text || undefined;
}

function toolKind(name: string): TaskHistoryEntry["kind"] {
  const lower = name.toLowerCase();
  if (/bash|shell|terminal|command/.test(lower)) return "command";
  if (/edit|write|patch|notebook/.test(lower)) return "file_change";
  if (/plan|todo/.test(lower)) return "plan";
  return "tool";
}

function toolInputText(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function changedPath(name: string, input: unknown): string | undefined {
  if (!/edit|write|patch|notebook/i.test(name) || !isObject(input)) return undefined;
  return stringValue(input.file_path) ?? stringValue(input.path) ?? stringValue(input.notebook_path);
}

function fallbackSummary(state: TaskState): string {
  if (state === "running") return "Claude Code 正在处理任务";
  if (state === "succeeded") return "Claude Code 会话已完成";
  if (state === "failed") return "Claude Code 会话执行失败";
  if (state === "stopped") return "Claude Code 会话已停止";
  return "Claude Code 会话空闲";
}

export function parseClaudeProcessList(output: string): ClaudeProcessSnapshot {
  const sessionIds = new Set<string>();
  let running = false;
  let unidentifiedCount = 0;
  for (const line of output.split("\n")) {
    const command = line.replace(/^\s*\d+\s+/, "");
    const isClaude = /(?:^|\s|["'])(?:\S*[/\\])?claude(?:\.exe|\.cmd)?(?:["']|\s|$)/i.test(command)
      || /@anthropic-ai[/\\]claude-code[/\\](?:[^\s/\\]+[/\\])*cli\.js(?:["']|\s|$)/i.test(command);
    if (!isClaude) continue;
    running = true;
    const match = command.match(/--(?:resume|session-id)(?:=|\s+)([0-9a-f-]{20,})/i);
    if (match?.[1]) sessionIds.add(match[1]);
    else unidentifiedCount += 1;
  }
  return { running, sessionIds, unidentifiedCount };
}

async function claudeProcessSnapshot(): Promise<ClaudeProcessSnapshot> {
  try {
    return parseClaudeProcessList(await processCommandLines());
  } catch {
    return { running: false, sessionIds: new Set(), unidentifiedCount: 0 };
  }
}

function taskCapabilities(
  cliAvailable: boolean,
  controlState: TaskControlState,
  artifacts: readonly Artifact[],
): AgentCapability[] {
  const capabilities: AgentCapability[] = ["history"];
  if (cliAvailable && controlState === "available") capabilities.push("message");
  if (controlState === "managed") capabilities.push("stop");
  if (artifacts.length > 0) capabilities.push("diff");
  return capabilities;
}

export async function readClaudeSession(path: string): Promise<ClaudeSession | undefined> {
  const fileStat = await stat(path);
  const history: TaskHistoryEntry[] = [];
  const turnTimes = new Map<string, { startedAt: string; completedAt?: string }>();
  const changedFiles = new Set<string>();
  let sessionId = basename(path, ".jsonl");
  let cwd = "";
  let firstUserText = "";
  let latestSummary = "";
  let latestTimestamp: string | undefined;
  let latestStopReason: string | undefined;
  let currentTurnId = `claude_turn_${sessionId}`;
  let sequence = 0;

  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record: JsonObject;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }
    if (record.isSidechain === true) continue;
    sessionId = stringValue(record.sessionId) ?? sessionId;
    cwd = stringValue(record.cwd) ?? cwd;
    const createdAt = isoDate(record.timestamp);
    if (createdAt) latestTimestamp = createdAt;
    if ((record.type !== "user" && record.type !== "assistant") || !isObject(record.message)) continue;
    const role = stringValue(record.message.role) ?? String(record.type);
    const rawContent = record.message.content;
    const blocks = Array.isArray(rawContent) ? rawContent : [{ type: "text", text: rawContent }];
    const hasUserText = role === "user" && blocks.some((block) => isObject(block) && block.type === "text" && stringValue(block.text));
    if (hasUserText) {
      const uuid = stringValue(record.uuid) ?? `${sequence}`;
      currentTurnId = `claude_turn_${uuid}`;
      latestStopReason = undefined;
      if (createdAt) turnTimes.set(currentTurnId, { startedAt: createdAt });
    }

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      if (!isObject(block)) continue;
      const type = stringValue(block.type);
      const uuid = stringValue(record.uuid) ?? `${sequence}`;
      const id = `claude_history_${uuid}_${blockIndex}_${sequence}`;
      let entry: TaskHistoryEntry | undefined;
      if (type === "text") {
        const text = stringValue(block.text);
        if (!text) continue;
        if (role === "user") {
          firstUserText ||= text;
          entry = { id, turnId: currentTurnId, kind: "user_message", text: boundedText(text), ...(createdAt ? { createdAt } : {}) };
        } else {
          latestSummary = text;
          entry = { id, turnId: currentTurnId, kind: "agent_message", text: boundedText(text), ...(createdAt ? { createdAt } : {}) };
        }
      } else if (type === "thinking") {
        const text = stringValue(block.thinking) ?? stringValue(block.text);
        if (text) entry = { id, turnId: currentTurnId, kind: "reasoning", title: "思考摘要", text: boundedText(text), ...(createdAt ? { createdAt } : {}) };
      } else if (type === "tool_use") {
        const name = stringValue(block.name) ?? "Claude 工具";
        const input = block.input;
        const pathValue = changedPath(name, input);
        if (pathValue) changedFiles.add(pathValue);
        latestSummary = `Claude 工具：${name}`;
        entry = {
          id,
          turnId: currentTurnId,
          kind: toolKind(name),
          title: shortText(name, 200),
          text: boundedText(toolInputText(input) || "工具调用已记录"),
          ...(createdAt ? { createdAt } : {}),
        };
      } else if (type === "tool_result") {
        const text = contentText(block.content) ?? "工具已执行";
        entry = { id, turnId: currentTurnId, kind: "tool", title: "工具结果", text: boundedText(text), ...(createdAt ? { createdAt } : {}) };
      }
      if (entry) history.push(entry);
      sequence += 1;
    }

    if (role === "assistant") {
      latestStopReason = stringValue(record.message.stop_reason);
      if (createdAt && latestStopReason && latestStopReason !== "tool_use") {
        const timing = turnTimes.get(currentTurnId);
        if (timing) timing.completedAt = createdAt;
      }
    }
  }

  if (!history.length && !cwd) return undefined;
  const updatedAt = latestTimestamp ?? fileStat.mtime.toISOString();
  const state: TaskState = latestStopReason && latestStopReason !== "tool_use" ? "succeeded" : "idle";
  const artifacts: Artifact[] = changedFiles.size > 0 ? [{
    id: `claude_diff_${sessionId}`,
    kind: "diff",
    title: `代码变更 · ${changedFiles.size} 个文件`,
    summary: [...changedFiles].slice(0, 8).map((item) => basename(item)).join("、"),
  }] : [];
  const boundedHistory = history.slice(-maxHistoryEntries);
  const turnTimings = [...turnTimes.entries()].slice(-200).map(([turnId, timing]) => ({
    turnId,
    startedAt: timing.startedAt,
    ...(timing.completedAt ? { completedAt: timing.completedAt } : {}),
  }));
  const latestEntry = boundedHistory.at(-1);
  return {
    id: sessionId,
    path,
    cwd: cwd || "/",
    title: shortText(firstUserText || "未命名 Claude Code 会话", 240),
    summary: shortText(latestSummary || fallbackSummary(state)),
    state,
    updatedAt,
    history: boundedHistory,
    turnTimings,
    artifacts,
    revision: JSON.stringify([fileStat.size, fileStat.mtimeMs, latestEntry?.id, latestEntry?.text]),
  };
}

export function claudeProjectForSession(session: ClaudeSession): WorkstationProject {
  const name = basename(session.cwd) || session.cwd || "最近会话";
  const digest = createHash("sha256").update(session.cwd).digest("hex").slice(0, 16);
  return {
    id: `claude_project_${digest}`,
    name: shortText(`Claude Code · ${name}`, 120),
    order: 0,
    source: "claude",
  };
}

export function claudeSessionToTask(
  session: ClaudeSession,
  project: WorkstationProject,
  options: ClaudeTaskOptions,
): Task {
  const controlState: TaskControlState = options.managed
    ? "managed"
    : options.externalWriter
      ? "external_writer"
      : options.cliAvailable
        ? "available"
        : "unavailable";
  const state: TaskState = options.managed || options.externalWriter ? "running" : session.state;
  const controlReason = options.managed
    ? "网页端正在通过 Claude Code CLI 继续这个会话。"
    : options.externalWriter
      ? claudeExternalReason
      : options.cliAvailable
        ? claudeAvailableReason
        : claudeMissingReason;
  const latestTurnId = session.history.at(-1)?.turnId ?? `claude_turn_${session.id}`;
  return TaskSchema.parse({
    id: `claude_${session.id}`,
    deviceId,
    projectId: project.id,
    projectName: project.name,
    runId: latestTurnId,
    agentId: "claude-local",
    agentName: "Claude Code",
    title: session.title,
    state,
    summary: options.managed ? "Claude Code 正在处理网页指令" : session.summary,
    controlState,
    controlReason,
    capabilities: taskCapabilities(options.cliAvailable, controlState, session.artifacts),
    artifacts: preserveArtifactContent(session.artifacts, options.existing?.artifacts),
    historyState: options.existing?.historyState ?? "not_loaded",
    history: options.existing?.history ?? [],
    turnTimings: options.existing?.turnTimings ?? session.turnTimings,
    ...(options.existing?.historyError ? { historyError: options.existing.historyError } : {}),
    updatedAt: session.updatedAt,
  });
}

export async function discoverRecentClaudeSessionFiles(
  projectsDirectory: string,
  limit: number,
): Promise<ClaudeSessionFile[]> {
  let projectDirectories;
  try {
    projectDirectories = await readdir(projectsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const directory of projectDirectories) {
    if (!directory.isDirectory()) continue;
    const directoryPath = join(projectsDirectory, directory.name);
    let files;
    try {
      files = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.isFile() && file.name.endsWith(".jsonl") && !file.name.startsWith("agent-")) {
        paths.push(join(directoryPath, file.name));
      }
    }
  }
  const files = (await Promise.all(paths.map(async (path) => {
    try {
      const details = await stat(path);
      return { path, size: details.size, mtimeMs: details.mtimeMs };
    } catch {
      return undefined;
    }
  }))).filter((file): file is ClaudeSessionFile => file !== undefined);
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit);
}

async function executableExists(command: string): Promise<boolean> {
  if (isAbsolute(command)) {
    try {
      await access(command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const commandShim = process.platform === "win32" && extname(command).toLowerCase() === ".cmd";
    await execFileAsync(
      commandShim ? "cmd.exe" : command,
      commandShim ? ["/d", "/s", "/c", command, "--version"] : ["--version"],
      { timeout: 3_000, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function resolveClaudeBin(configured: string | undefined): Promise<string | undefined> {
  const windowsCandidates = process.platform === "win32"
    ? [
        join(homedir(), ".local", "bin", "claude.exe"),
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "claude", "claude.exe") : undefined,
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.cmd") : undefined,
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.exe") : undefined,
        "claude.exe",
        "claude.cmd",
      ].filter((candidate): candidate is string => Boolean(candidate))
    : [];
  const candidates = configured
    ? [configured]
    : [...windowsCandidates, join(homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "claude"];
  for (const candidate of candidates) {
    if (await executableExists(candidate)) return candidate;
  }
  return undefined;
}

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly id = "claude-local";
  readonly name = "Claude Code";
  readonly source = "claude" as const;
  readonly capabilities = ["history", "new_task"] as const satisfies readonly AgentCapability[];

  private readonly projectsDirectory: string;
  private readonly configuredBin: string | undefined;
  private readonly maxTasks: number;
  private readonly refreshIntervalMs: number;
  private claudeBin: string | undefined;
  private emit: EmitEvent | undefined;
  private emitProjects: EmitProjects | undefined;
  private emitAvailability: EmitAvailability | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private active = false;
  private sequence = 0;
  private projects: WorkstationProject[] = [];
  private projectSignature = "";
  private readonly tasks = new Map<string, Task>();
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly sessionFileCache = new Map<string, { revision: string; session?: ClaudeSession }>();
  private readonly revisions = new Map<string, string>();
  private readonly historyStartIndexes = new Map<string, number>();
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly cwdByProjectId = new Map<string, string>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.projectsDirectory = options.projectsDirectory ?? join(homedir(), ".claude", "projects");
    this.configuredBin = options.claudeBin ?? process.env.CLAUDE_BIN;
    this.maxTasks = options.maxTasks ?? defaultMaxTasks;
    this.refreshIntervalMs = options.refreshIntervalMs ?? defaultRefreshIntervalMs;
  }

  async start(emit: EmitEvent, emitProjects: EmitProjects, emitAvailability?: EmitAvailability): Promise<void> {
    this.emit = emit;
    this.emitProjects = emitProjects;
    if (emitAvailability) this.emitAvailability = emitAvailability;
    const reconnecting = this.refreshTimer !== undefined;
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.refresh().catch((error: unknown) => {
          console.warn(`[claude] refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, this.refreshIntervalMs);
    }
    await this.refresh();
    if (reconnecting) {
      this.emitProjects(this.projects);
      for (const task of this.tasks.values()) this.emitEvent(task.id, task.runId, "task.upsert", { task });
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
        this.startMessage(command.taskId, command.action.text);
        return;
      }
      if (command.action.kind === "stop") {
        this.stopTask(command.taskId);
        return;
      }
      throw new Error("Claude Code 当前仅支持消息、停止和历史读取");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[claude] ${command.action.kind} failed for ${command.taskId}: ${message}`);
      this.patchTask(command.taskId, { state: "failed", summary: shortText(`操作失败：${message}`) });
      throw error;
    }
  }

  async createTask(command: MobileCommand, emit: EmitEvent): Promise<void> {
    this.emit = emit;
    if (command.action.kind !== "new_task" || command.action.source !== "claude") {
      throw new Error("无效的 Claude Code 新建任务命令");
    }
    const action = command.action;
    if (!this.claudeBin) throw new Error(claudeMissingReason);
    const cwd = action.projectId
      ? this.cwdByProjectId.get(action.projectId)
      : process.cwd();
    if (!cwd) throw new Error("该 Claude Code 项目没有可用的本地目录");
    const sessionId = randomUUID();
    const taskId = `claude_${sessionId}`;
    const project = action.projectId
      ? this.projects.find((item) => item.id === action.projectId)
      : claudeProjectForSession({ cwd } as ClaudeSession);
    if (!project) throw new Error("找不到对应的 Claude Code 项目");
    if (!this.projects.some((item) => item.id === project.id)) {
      this.projects = [...this.projects, { ...project, order: this.projects.length }];
      this.projectSignature = JSON.stringify(this.projects);
      this.emitProjects?.(this.projects);
    }
    this.cwdByProjectId.set(project.id, cwd);
    const now = new Date().toISOString();
    const turnId = `claude_turn_${createId("user")}`;
    const session: ClaudeSession = {
      id: sessionId,
      path: "",
      cwd,
      title: shortText(action.text, 240),
      summary: "Claude Code 正在处理网页指令",
      state: "running",
      updatedAt: now,
      history: [{
        id: `claude_history_${createId("user")}`,
        turnId,
        kind: "user_message",
        text: boundedText(action.text),
        createdAt: now,
      }],
      turnTimings: [{ turnId, startedAt: now }],
      artifacts: [],
      revision: `new:${sessionId}`,
    };
    const task = claudeSessionToTask(session, project, { cliAvailable: true, managed: true });
    this.sessions.set(taskId, session);
    this.tasks.set(taskId, task);
    this.emitEvent(task.id, task.runId, "task.upsert", { task });
    this.spawnTask(taskId, session, ["--session-id", sessionId], action.text);
  }

  private async loadDiff(taskId: string): Promise<void> {
    const current = this.tasks.get(taskId);
    const session = this.sessions.get(taskId);
    if (!current || !session) throw new Error("找不到对应的 Claude Code 会话");
    const artifacts = artifactsWithDiffContent(current.artifacts, await readWorkingTreeDiff(session.cwd));
    const task = TaskSchema.parse({ ...current, artifacts });
    this.tasks.set(taskId, task);
    this.emitEvent(task.id, task.runId, "task.upsert", { task });
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      if (!this.claudeBin) this.claudeBin = await resolveClaudeBin(this.configuredBin);
      const processSnapshot = await claudeProcessSnapshot();
      const sourceActive = Boolean(this.claudeBin) || processSnapshot.running;
      if (!sourceActive) {
        this.clearTasks();
        this.setActive(false);
        return;
      }

      const files = await discoverRecentClaudeSessionFiles(this.projectsDirectory, this.maxTasks);
      const selectedPaths = new Set(files.map((file) => file.path));
      for (const path of this.sessionFileCache.keys()) {
        if (!selectedPaths.has(path)) this.sessionFileCache.delete(path);
      }
      const sessions = (await Promise.all(files.map(async (file) => {
        const fileRevision = `${file.size}:${file.mtimeMs}`;
        const cached = this.sessionFileCache.get(file.path);
        if (cached?.revision === fileRevision) return cached.session;
        try {
          const session = await readClaudeSession(file.path);
          this.sessionFileCache.set(file.path, { revision: fileRevision, ...(session ? { session } : {}) });
          return session;
        } catch (error) {
          console.warn(`[claude] ignored unreadable session ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      }))).filter((session): session is ClaudeSession => Boolean(session))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      const projects = new Map<string, WorkstationProject>();
      this.cwdByProjectId.clear();
      const seen = new Set<string>();
      const unidentifiedSessionIds = new Set(
        sessions.slice(0, processSnapshot.unidentifiedCount).map((session) => session.id),
      );
      for (const session of sessions) {
        const taskId = `claude_${session.id}`;
        const project = claudeProjectForSession(session);
        if (!projects.has(project.id)) projects.set(project.id, { ...project, order: projects.size });
        this.cwdByProjectId.set(project.id, session.cwd);
        const existing = this.tasks.get(taskId);
        const explicitlyRunning = processSnapshot.sessionIds.has(session.id);
        const recentlyWritten = Date.now() - Date.parse(session.updatedAt) < externalActivityGraceMs;
        const externalWriter = !this.children.has(taskId)
          && processSnapshot.running
          && (explicitlyRunning || unidentifiedSessionIds.has(session.id) || recentlyWritten);
        let task = claudeSessionToTask(session, projects.get(project.id) ?? project, {
          cliAvailable: Boolean(this.claudeBin),
          externalWriter,
          managed: this.children.has(taskId),
          ...(existing ? { existing } : {}),
        });
        const changed = this.revisions.get(taskId) !== undefined && this.revisions.get(taskId) !== session.revision;
        if (changed && existing && (existing.historyState === "loaded" || existing.historyState === "partial")) {
          const depth = Math.max(historyPageSize, existing.history.length);
          const history = session.history.slice(-depth);
          task = TaskSchema.parse({
            ...task,
            history,
            historyState: history.length < session.history.length ? "partial" : "loaded",
            turnTimings: session.turnTimings,
          });
          this.historyStartIndexes.set(taskId, Math.max(0, session.history.length - history.length));
        }
        seen.add(taskId);
        this.sessions.set(taskId, session);
        this.revisions.set(taskId, session.revision);
        this.tasks.set(taskId, task);
        if (!existing || JSON.stringify(existing) !== JSON.stringify(task)) {
          this.emitEvent(task.id, task.runId, "task.upsert", { task });
        }
      }

      for (const [taskId, task] of this.tasks) {
        if (seen.has(taskId) || this.children.has(taskId)) continue;
        this.removeTask(taskId, task);
      }
      this.projects = [...projects.values()];
      const signature = JSON.stringify(this.projects);
      if (signature !== this.projectSignature) {
        this.projectSignature = signature;
        this.emitProjects?.(this.projects);
      }
      this.setActive(true);
    } finally {
      this.refreshing = false;
    }
  }

  private startMessage(taskId: string, text: string): void {
    const task = this.tasks.get(taskId);
    const session = this.sessions.get(taskId);
    if (!task || !session) throw new Error("找不到对应的 Claude Code 会话");
    if (!text.trim()) throw new Error("消息不能为空");
    if (!this.claudeBin || !task.capabilities.includes("message")) {
      throw new Error(task.controlReason ?? claudeMissingReason);
    }
    this.spawnTask(taskId, session, ["--resume", session.id], text.trim());
  }

  private spawnTask(taskId: string, session: ClaudeSession, sessionArgs: string[], text: string): void {
    if (!this.claudeBin) throw new Error(claudeMissingReason);
    const windowsCommandShim = process.platform === "win32" && extname(this.claudeBin).toLowerCase() === ".cmd";
    const child = spawn(this.claudeBin, [
      "--print",
      ...sessionArgs,
      "--output-format",
      "stream-json",
      "--verbose",
      ...(windowsCommandShim ? [] : [text]),
    ], {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: windowsCommandShim,
      windowsHide: true,
    });
    child.stdin.end(windowsCommandShim ? text : undefined);
    this.children.set(taskId, child);
    this.patchTask(taskId, {
      state: "running",
      summary: "Claude Code 正在处理网页指令",
      controlState: "managed",
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once("error", (error) => {
      this.children.delete(taskId);
      this.patchTask(taskId, { state: "failed", summary: shortText(`Claude Code 启动失败：${error.message}`) });
    });
    child.once("close", (code, signal) => {
      this.children.delete(taskId);
      if (code !== 0) {
        const detail = shortText(stderr || (signal ? `进程收到 ${signal}` : `退出码 ${code}`), 1_000);
        this.patchTask(taskId, { state: signal ? "stopped" : "failed", summary: `Claude Code 执行失败：${detail}` });
        return;
      }
      void this.refresh().catch((error: unknown) => {
        console.warn(`[claude] refresh after message failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  private stopTask(taskId: string): void {
    const child = this.children.get(taskId);
    if (!child) throw new Error("这个 Claude Code 会话当前不由网页端执行");
    child.kill("SIGINT");
    this.patchTask(taskId, { state: "stopped", summary: "已请求停止 Claude Code 任务" });
  }

  private loadHistory(taskId: string, direction: "latest" | "older"): void {
    const session = this.sessions.get(taskId);
    const current = this.tasks.get(taskId);
    if (!session || !current) throw new Error("找不到对应的 Claude Code 会话");
    if (direction === "older" && current.historyState !== "partial") return;
    if (direction === "latest") this.updateHistory(taskId, "loading", current.history);
    const previousStart = this.historyStartIndexes.get(taskId) ?? session.history.length;
    const start = direction === "older"
      ? Math.max(0, previousStart - historyPageSize)
      : Math.max(0, session.history.length - historyPageSize);
    const end = direction === "older" ? previousStart : session.history.length;
    const boundedStart = Math.max(start, end - maxHistoryEntries);
    const page = session.history.slice(boundedStart, end);
    const history = direction === "older" ? [...page, ...current.history].slice(-maxHistoryEntries) : page;
    this.historyStartIndexes.set(taskId, boundedStart);
    this.updateHistory(taskId, boundedStart > 0 && history.length < maxHistoryEntries ? "partial" : "loaded", history);
  }

  private updateHistory(taskId: string, historyState: TaskHistoryState, history: TaskHistoryEntry[]): void {
    const current = this.tasks.get(taskId);
    const session = this.sessions.get(taskId);
    if (!current) return;
    const task = TaskSchema.parse({
      ...current,
      historyState,
      history,
      turnTimings: session?.turnTimings ?? current.turnTimings,
    });
    this.tasks.set(taskId, task);
    this.emitEvent(task.id, task.runId, "task.upsert", { task });
  }

  private patchTask(taskId: string, patch: {
    state: TaskState;
    summary: string;
    controlState?: TaskControlState;
  }): void {
    const current = this.tasks.get(taskId);
    if (!current) return;
    const controlState = patch.controlState ?? (this.children.has(taskId) ? "managed" : this.claudeBin ? "available" : "unavailable");
    const task = TaskSchema.parse({
      ...current,
      state: patch.state,
      summary: shortText(patch.summary),
      controlState,
      controlReason: controlState === "managed" ? "网页端正在通过 Claude Code CLI 继续这个会话。" : this.claudeBin ? claudeAvailableReason : claudeMissingReason,
      capabilities: taskCapabilities(Boolean(this.claudeBin), controlState, current.artifacts),
      updatedAt: new Date().toISOString(),
    });
    this.tasks.set(taskId, task);
    this.emitEvent(task.id, task.runId, "task.upsert", { task });
  }

  private clearTasks(): void {
    for (const [taskId, task] of this.tasks) this.removeTask(taskId, task);
    if (this.projects.length > 0) {
      this.projects = [];
      this.projectSignature = "[]";
      this.emitProjects?.([]);
    }
  }

  private removeTask(taskId: string, task: Task): void {
    this.tasks.delete(taskId);
    this.sessions.delete(taskId);
    this.revisions.delete(taskId);
    this.historyStartIndexes.delete(taskId);
    this.emitEvent(taskId, task.runId, "task.removed", {});
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.emitAvailability?.(active);
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
}
