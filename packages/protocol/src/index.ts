import { z } from "zod";

const IdSchema = z.string().min(1).max(160);
const IsoDateSchema = z.iso.datetime({ offset: true });

export const TaskStateSchema = z.enum([
  "idle",
  "running",
  "waiting_for_user",
  "succeeded",
  "failed",
  "stopped",
  "unknown",
]);

export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskControlStateSchema = z.enum([
  "available",
  "managed",
  "external_writer",
  "unavailable",
]);

export type TaskControlState = z.infer<typeof TaskControlStateSchema>;

export const AgentSourceSchema = z.enum(["codex", "cursor", "claude"]);

export type AgentSource = z.infer<typeof AgentSourceSchema>;

export const AgentCapabilitySchema = z.enum([
  "message",
  "stop",
  "approval",
  "structured_tool_calls",
  "pause_resume",
  "diff",
  "tests",
  "snapshot",
  "history",
  "new_task",
]);

export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const DiffStatsSchema = z.object({
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export type DiffStats = z.infer<typeof DiffStatsSchema>;

export const ArtifactSchema = z.object({
  id: IdSchema,
  kind: z.enum(["diff", "test_report", "log", "screenshot", "link"]),
  title: z.string().min(1).max(200),
  summary: z.string().max(1_000).optional(),
  // Optional so newer pages remain compatible with older Companion payloads.
  stats: DiffStatsSchema.optional(),
  // Diff bodies are loaded explicitly so routine task snapshots stay small.
  content: z.string().max(500_000).optional(),
  contentTruncated: z.boolean().optional(),
  contentError: z.string().max(500).optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

export const ApprovalSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(240),
  summary: z.string().min(1).max(2_000),
  risk: z.enum(["low", "medium", "high"]),
  capability: AgentCapabilitySchema,
  scope: z.array(z.string().min(1).max(300)).max(20),
  expiresAt: IsoDateSchema,
});

export type Approval = z.infer<typeof ApprovalSchema>;

export const TaskHistoryEntrySchema = z.object({
  id: IdSchema,
  turnId: IdSchema,
  kind: z.enum([
    "user_message",
    "agent_message",
    "reasoning",
    "command",
    "file_change",
    "tool",
    "plan",
    "system",
    "error",
  ]),
  title: z.string().min(1).max(200).optional(),
  text: z.string().max(8_000),
  phase: z.enum(["commentary", "final_answer"]).optional(),
  status: z.string().max(80).optional(),
  diffStats: DiffStatsSchema.optional(),
  createdAt: IsoDateSchema.optional(),
});

export type TaskHistoryEntry = z.infer<typeof TaskHistoryEntrySchema>;

export const TaskTurnTimingSchema = z.object({
  turnId: IdSchema,
  startedAt: IsoDateSchema,
  completedAt: IsoDateSchema.optional(),
});

export type TaskTurnTiming = z.infer<typeof TaskTurnTimingSchema>;

export const TaskHistoryStateSchema = z.enum([
  "not_loaded",
  "loading",
  "loaded",
  "partial",
  "failed",
]);

export type TaskHistoryState = z.infer<typeof TaskHistoryStateSchema>;

export const WorkstationProjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  order: z.number().int().nonnegative(),
  // Optional for wire compatibility with hosts running an older companion.
  source: AgentSourceSchema.optional(),
});

export type WorkstationProject = z.infer<typeof WorkstationProjectSchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  deviceId: IdSchema,
  projectId: IdSchema,
  projectName: z.string().min(1).max(120),
  runId: IdSchema,
  agentId: IdSchema,
  agentName: z.string().min(1).max(80),
  title: z.string().min(1).max(240),
  state: TaskStateSchema,
  summary: z.string().max(2_000),
  controlState: TaskControlStateSchema,
  controlReason: z.string().max(500).optional(),
  progress: z.number().min(0).max(1).optional(),
  capabilities: z.array(AgentCapabilitySchema),
  artifacts: z.array(ArtifactSchema).max(100),
  historyState: TaskHistoryStateSchema.default("not_loaded"),
  history: z.array(TaskHistoryEntrySchema).max(1_000).default([]),
  turnTimings: z.array(TaskTurnTimingSchema).max(200).default([]),
  historyError: z.string().max(500).optional(),
  pendingApproval: ApprovalSchema.optional(),
  continuedFromTaskId: IdSchema.optional(),
  updatedAt: IsoDateSchema,
});

export type Task = z.infer<typeof TaskSchema>;

const EventBaseSchema = z.object({
  protocolVersion: z.literal(1),
  eventId: IdSchema,
  deviceId: IdSchema,
  taskId: IdSchema,
  runId: IdSchema,
  sequence: z.number().int().nonnegative(),
  emittedAt: IsoDateSchema,
});

export const WorkstationEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("task.removed"),
  }),
  EventBaseSchema.extend({
    type: z.literal("task.upsert"),
    task: TaskSchema,
  }),
  EventBaseSchema.extend({
    type: z.literal("task.progress"),
    summary: z.string().max(2_000),
    progress: z.number().min(0).max(1).optional(),
    state: TaskStateSchema.optional(),
  }),
  EventBaseSchema.extend({
    type: z.literal("approval.requested"),
    approval: ApprovalSchema,
  }),
  EventBaseSchema.extend({
    type: z.literal("approval.resolved"),
    approvalId: IdSchema,
    decision: z.enum(["approved", "rejected", "expired"]),
  }),
  EventBaseSchema.extend({
    type: z.literal("task.completed"),
    outcome: z.enum(["succeeded", "failed", "stopped"]),
    summary: z.string().max(2_000),
    artifacts: z.array(ArtifactSchema).max(100),
  }),
]);

export type WorkstationEvent = z.infer<typeof WorkstationEventSchema>;

export const ImageAttachmentSchema = z.object({
  id: IdSchema,
  kind: z.literal("image"),
  name: z.string().min(1).max(180),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  data: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>;

export function applyEventToTasks(
  tasks: ReadonlyMap<string, Task>,
  event: WorkstationEvent,
): Map<string, Task> {
  const next = new Map(tasks);

  if (event.type === "task.upsert") {
    next.set(event.task.id, event.task);
    return next;
  }

  if (event.type === "task.removed") {
    next.delete(event.taskId);
    return next;
  }

  const current = next.get(event.taskId);
  if (!current) return next;

  if (event.type === "task.progress") {
    next.set(current.id, {
      ...current,
      summary: event.summary,
      updatedAt: event.emittedAt,
      ...(event.progress === undefined ? {} : { progress: event.progress }),
      ...(event.state === undefined ? {} : { state: event.state }),
    });
    return next;
  }

  if (event.type === "approval.requested") {
    next.set(current.id, {
      ...current,
      state: "waiting_for_user",
      pendingApproval: event.approval,
      updatedAt: event.emittedAt,
    });
    return next;
  }

  const { pendingApproval: _pendingApproval, ...withoutApproval } = current;
  if (event.type === "approval.resolved") {
    next.set(current.id, {
      ...withoutApproval,
      state: event.decision === "approved" ? "running" : "stopped",
      updatedAt: event.emittedAt,
    });
    return next;
  }

  next.set(current.id, {
    ...withoutApproval,
    state: event.outcome,
    summary: event.summary,
    artifacts: event.artifacts,
    progress: 1,
    updatedAt: event.emittedAt,
  });
  return next;
}

export const CommandActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    approvalId: IdSchema,
    decision: z.enum(["approve", "reject"]),
  }),
  z.object({
    kind: z.literal("message"),
    text: z.string().trim().min(1).max(4_000),
    attachments: z.array(ImageAttachmentSchema).max(3).optional(),
  }),
  z.object({ kind: z.literal("stop") }),
  z.object({ kind: z.literal("request_snapshot") }),
  z.object({
    kind: z.literal("request_history"),
    direction: z.enum(["latest", "older"]).optional(),
  }),
  z.object({ kind: z.literal("request_diff") }),
  z.object({
    kind: z.literal("new_task"),
    source: AgentSourceSchema,
    projectId: IdSchema.optional(),
    text: z.string().trim().min(1).max(4_000),
    attachments: z.array(ImageAttachmentSchema).max(3).optional(),
  }),
]);

export type CommandAction = z.infer<typeof CommandActionSchema>;

export const MobileCommandSchema = z.object({
  protocolVersion: z.literal(1),
  commandId: IdSchema,
  deviceId: IdSchema,
  taskId: IdSchema,
  issuedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  nonce: IdSchema,
  action: CommandActionSchema,
});

export type MobileCommand = z.infer<typeof MobileCommandSchema>;

export const HostHelloSchema = z.object({
  type: z.literal("host.hello"),
  deviceId: IdSchema,
  deviceName: z.string().min(1).max(120),
  token: z.string().min(1),
  capabilities: z.array(AgentCapabilitySchema),
  projects: z.array(WorkstationProjectSchema).default([]),
  activeSources: z.array(AgentSourceSchema).default([]),
});

export const MobileHelloSchema = z.object({
  type: z.literal("mobile.hello"),
  deviceId: IdSchema,
  token: z.string().min(1),
  afterSequence: z.number().int().nonnegative().optional(),
});

export const MobileRefreshMessageSchema = z.object({
  type: z.literal("mobile.refresh"),
  deviceId: IdSchema,
});

export const HostEventMessageSchema = z.object({
  type: z.literal("host.event"),
  event: WorkstationEventSchema,
});

export const HostProjectsMessageSchema = z.object({
  type: z.literal("host.projects"),
  deviceId: IdSchema,
  projects: z.array(WorkstationProjectSchema),
});

export const HostSourcesMessageSchema = z.object({
  type: z.literal("host.sources"),
  deviceId: IdSchema,
  activeSources: z.array(AgentSourceSchema),
});

export const HostCommandResultMessageSchema = z.object({
  type: z.literal("host.command_result"),
  deviceId: IdSchema,
  commandId: IdSchema,
  status: z.enum(["accepted", "rejected"]),
  detail: z.string().max(500).optional(),
});

export const MobileCommandMessageSchema = z.object({
  type: z.literal("mobile.command"),
  command: MobileCommandSchema,
});

export const ServerEventMessageSchema = z.object({
  type: z.literal("server.event"),
  event: WorkstationEventSchema,
});

export const ServerProjectsMessageSchema = z.object({
  type: z.literal("server.projects"),
  deviceId: IdSchema,
  projects: z.array(WorkstationProjectSchema),
});

export const ServerSourcesMessageSchema = z.object({
  type: z.literal("server.sources"),
  deviceId: IdSchema,
  activeSources: z.array(AgentSourceSchema),
});

export const ServerCommandMessageSchema = z.object({
  type: z.literal("server.command"),
  command: MobileCommandSchema,
});

export const ServerSnapshotMessageSchema = z.object({
  type: z.literal("server.snapshot"),
  deviceId: IdSchema,
  deviceName: z.string().max(120).optional(),
  online: z.boolean(),
  tasks: z.array(TaskSchema),
  projects: z.array(WorkstationProjectSchema).default([]),
  activeSources: z.array(AgentSourceSchema).default([]),
  lastSequence: z.number().int().nonnegative(),
});

export const ServerHostStatusMessageSchema = z.object({
  type: z.literal("server.host_status"),
  deviceId: IdSchema,
  deviceName: z.string().max(120).optional(),
  online: z.boolean(),
});

export const ServerAckMessageSchema = z.object({
  type: z.literal("server.ack"),
  messageId: IdSchema,
  status: z.enum(["accepted", "delivered", "rejected"]),
  detail: z.string().max(500).optional(),
});

export const ServerErrorMessageSchema = z.object({
  type: z.literal("server.error"),
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(500),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  HostHelloSchema,
  MobileHelloSchema,
  MobileRefreshMessageSchema,
  HostEventMessageSchema,
  HostProjectsMessageSchema,
  HostSourcesMessageSchema,
  HostCommandResultMessageSchema,
  MobileCommandMessageSchema,
]);

export const ServerMessageSchema = z.discriminatedUnion("type", [
  ServerEventMessageSchema,
  ServerProjectsMessageSchema,
  ServerSourcesMessageSchema,
  ServerCommandMessageSchema,
  ServerSnapshotMessageSchema,
  ServerHostStatusMessageSchema,
  ServerAckMessageSchema,
  ServerErrorMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export function isCommandExpired(command: MobileCommand, now = new Date()): boolean {
  return Date.parse(command.expiresAt) <= now.getTime();
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

