import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

import {
  ServerMessageSchema,
  TaskSchema,
  WorkstationEventSchema,
  createId,
  isCommandExpired,
  type AgentCapability,
  type AgentSource,
  type MobileCommand,
  type WorkstationProject,
  type WorkstationEvent,
} from "@ai-workstation/protocol";
import WebSocket from "ws";

import { CodexAgentAdapter } from "./adapters/codex.js";
import { ClaudeAgentAdapter } from "./adapters/claude.js";
import { CursorAgentAdapter } from "./adapters/cursor.js";
import type { AgentAdapter } from "./adapters/types.js";
import { CommandReplayGuard } from "./command-replay.js";
import { materializeCommandImages } from "./image-attachments.js";
import { workstationDeviceId } from "./platform.js";

const relayUrl = process.env.CONTROL_URL ?? "ws://127.0.0.1:8787/ws";
const pairingToken = process.env.PAIRING_TOKEN ?? "local-development-only";
const deviceId = workstationDeviceId;
const deviceName = systemDeviceName();
const adapters: readonly AgentAdapter[] = [
  new CodexAgentAdapter(),
  new CursorAgentAdapter(),
  new ClaudeAgentAdapter(),
];
const queuedEvents: WorkstationEvent[] = [];
const commandReplayGuard = new CommandReplayGuard();
const projectsByAdapter = new Map<string, readonly WorkstationProject[]>();
const activeSources = new Set<AgentSource>();

let socket: WebSocket | undefined;
let reconnectAttempt = 0;
let hostSequence = Date.now() * 1_000;

function systemDeviceName(): string {
  try {
    const computerName = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
      encoding: "utf8",
      timeout: 1_000,
    }).trim();
    if (computerName) return computerName.slice(0, 120);
  } catch {
    // Non-macOS hosts and unset ComputerName values fall back to the OS hostname.
  }
  const hostName = hostname().trim();
  if (hostName) return hostName.slice(0, 120);
  throw new Error("Unable to determine the system device name");
}

function mergedProjects(): WorkstationProject[] {
  return adapters.flatMap((adapter) => projectsByAdapter.get(adapter.id) ?? [])
    .map((project, order) => ({ ...project, order }));
}

function allCapabilities(): AgentCapability[] {
  return [...new Set(adapters.flatMap((adapter) => adapter.capabilities))];
}

function adapterForTask(taskId: string): AgentAdapter | undefined {
  return adapters.find((adapter) => adapter.currentTaskIds().includes(taskId));
}

function adapterForSource(source: AgentSource): AgentAdapter | undefined {
  return adapters.find((adapter) => adapter.source === source);
}

function sendEvent(event: WorkstationEvent): void {
  hostSequence = Math.max(hostSequence + 1, Date.now() * 1_000);
  const normalizedEvent = { ...event, sequence: hostSequence };
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "host.event", event: normalizedEvent }));
    return;
  }
  queuedEvents.push(normalizedEvent);
}

function sendCommandResult(commandId: string, status: "accepted" | "rejected", detail?: string): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "host.command_result",
    deviceId,
    commandId,
    status,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  }));
}

function commandRejectionDetail(reason: string): string {
  return {
    "wrong device": "任务发到了错误的工作站，请刷新页面后重试",
    "source unavailable": "对应的 AI 终端当前不可用，请确认终端已启动",
    "new task unsupported": "当前终端不支持新建任务",
    "unknown project": "所选项目已失效，请刷新页面后重新选择",
    expired: "请求已过期，请重试",
    "replayed nonce": "请求已处理，请勿重复提交",
    "unknown task": "任务已失效，请刷新页面后重试",
    "message unsupported": "当前任务暂不支持发送消息",
    "stop unsupported": "当前任务暂不支持停止操作",
    "approval unsupported": "当前任务暂不支持审批操作",
    "snapshot unsupported": "当前任务暂不支持快照",
    "history unsupported": "当前任务暂不支持读取历史",
    "diff unsupported": "当前任务暂不支持读取改动",
  }[reason] ?? `工作站拒绝了请求：${reason}`;
}

function sendProjects(adapterId: string, projects: readonly WorkstationProject[]): void {
  projectsByAdapter.set(adapterId, projects);
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "host.projects", deviceId, projects: mergedProjects() }));
}

function sendSources(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "host.sources",
    deviceId,
    activeSources: adapters.map((adapter) => adapter.source).filter((source) => activeSources.has(source)),
  }));
}

function setSourceActive(source: AgentSource, active: boolean): void {
  const changed = active ? !activeSources.has(source) : activeSources.delete(source);
  if (active) activeSources.add(source);
  if (changed) sendSources();
}

function flushEvents(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  while (queuedEvents.length > 0) {
    const event = queuedEvents.shift();
    if (event) socket.send(JSON.stringify({ type: "host.event", event }));
  }
}

function authorizeCommand(command: MobileCommand): string | undefined {
  if (command.deviceId !== deviceId) return "wrong device";
  if (command.action.kind === "new_task") {
    const action = command.action;
    const adapter = adapterForSource(action.source);
    if (!adapter || !activeSources.has(action.source)) return "source unavailable";
    if (!adapter.capabilities.includes("new_task")) return "new task unsupported";
    if (action.projectId) {
      const projects = projectsByAdapter.get(adapter.id) ?? [];
      if (!projects.some((project) => project.id === action.projectId)) return "unknown project";
    }
    if (isCommandExpired(command)) return "expired";
    if (!commandReplayGuard.accept(command.nonce, command.expiresAt)) return "replayed nonce";
    return undefined;
  }
  const adapter = adapterForTask(command.taskId);
  if (!adapter) return "unknown task";
  if (isCommandExpired(command)) return "expired";
  const capabilities = adapter.taskCapabilities(command.taskId);
  if (command.action.kind === "message" && !capabilities.includes("message")) return "message unsupported";
  if (command.action.kind === "stop" && !capabilities.includes("stop")) return "stop unsupported";
  if (command.action.kind === "approval" && !capabilities.includes("approval")) return "approval unsupported";
  if (command.action.kind === "request_snapshot" && !capabilities.includes("snapshot")) return "snapshot unsupported";
  if (command.action.kind === "request_history" && !capabilities.includes("history")) return "history unsupported";
  if (command.action.kind === "request_diff" && !capabilities.includes("diff")) return "diff unsupported";
  if (!commandReplayGuard.accept(command.nonce, command.expiresAt)) return "replayed nonce";
  return undefined;
}

async function handleCommand(command: MobileCommand): Promise<void> {
  const rejection = authorizeCommand(command);
  if (rejection) {
    console.warn(`[host] rejected command ${command.commandId}: ${rejection}`);
    sendCommandResult(command.commandId, "rejected", commandRejectionDetail(rejection));
    return;
  }

  console.log(`[host] accepted ${command.action.kind} for ${command.taskId}`);
  const adapter = command.action.kind === "new_task"
    ? adapterForSource(command.action.source)
    : adapterForTask(command.taskId);
  if (!adapter) {
    sendCommandResult(command.commandId, "rejected", "找不到对应的 AI 终端");
    return;
  }
  try {
    const materializedCommand = await materializeCommandImages(command);
    if (materializedCommand.action.kind === "new_task") await adapter.createTask(materializedCommand, sendEvent);
    else await adapter.handleCommand(materializedCommand, sendEvent);
    sendCommandResult(command.commandId, "accepted");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendCommandResult(command.commandId, "rejected", message);
    if (command.action.kind !== "new_task") {
      console.warn(`[host] ${command.action.kind} failed for ${command.taskId}: ${message}`);
      return;
    }
    const action = command.action;
    console.warn(`[host] new ${adapter.name} task failed: ${message}`);
    const project = (projectsByAdapter.get(adapter.id) ?? []).find((item) => item.id === action.projectId);
    const emittedAt = new Date().toISOString();
    const task = TaskSchema.parse({
      id: command.taskId,
      deviceId,
      projectId: project?.id ?? `${adapter.source}_new_task`,
      projectName: project?.name ?? `${adapter.name} · 当前工作目录`,
      runId: `failed_${command.commandId}`,
      agentId: adapter.id,
      agentName: adapter.name,
      title: action.text.slice(0, 240),
      state: "failed",
      summary: `创建失败：${message}`.slice(0, 2_000),
      controlState: "unavailable",
      controlReason: `无法创建新的 ${adapter.name} 会话。`,
      capabilities: [],
      artifacts: [],
      historyState: "loaded",
      history: [],
      turnTimings: [],
      updatedAt: emittedAt,
    });
    sendEvent(WorkstationEventSchema.parse({
      protocolVersion: 1,
      eventId: createId("event"),
      deviceId,
      taskId: task.id,
      runId: task.runId,
      sequence: 0,
      emittedAt,
      type: "task.upsert",
      task,
    }));
  }
}

async function startAdapters(): Promise<void> {
  await Promise.all(adapters.map(async (adapter) => {
    try {
      await adapter.start(
        sendEvent,
        (projects) => sendProjects(adapter.id, projects),
        (active) => setSourceActive(adapter.source, active),
      );
    } catch (error) {
      setSourceActive(adapter.source, false);
      console.error(`[host] failed to start ${adapter.name} adapter: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  // Always publish one final snapshot so an empty source list is authoritative.
  sendSources();
}

function connect(): void {
  console.log(`[host] connecting to ${relayUrl}`);
  socket = new WebSocket(relayUrl);

  socket.on("open", () => {
    reconnectAttempt = 0;
    socket?.send(JSON.stringify({
      type: "host.hello",
      deviceId,
      deviceName,
      token: pairingToken,
      capabilities: allCapabilities(),
      projects: mergedProjects(),
      activeSources: adapters.map((adapter) => adapter.source).filter((source) => activeSources.has(source)),
    }));
    flushEvents();
    void startAdapters();
  });

  socket.on("message", (raw) => {
    let value: unknown;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      console.warn("[host] ignored non-JSON relay message");
      return;
    }
    const parsed = ServerMessageSchema.safeParse(value);
    if (!parsed.success) {
      console.warn("[host] ignored invalid relay message");
      return;
    }
    if (parsed.data.type === "server.command") void handleCommand(parsed.data.command);
    if (parsed.data.type === "server.error") console.warn(`[host] relay error: ${parsed.data.message}`);
  });

  socket.on("close", () => {
    socket = undefined;
    const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
    reconnectAttempt += 1;
    console.log(`[host] disconnected; reconnecting in ${delay}ms`);
    setTimeout(connect, delay);
  });

  socket.on("error", (error) => {
    console.warn(`[host] transport error: ${error.message}`);
  });
}

connect();

