import {
  applyEventToTasks,
  createId,
  ServerMessageSchema,
  type AgentSource,
  type Artifact,
  type CommandAction,
  type DiffStats,
  type ImageAttachment,
  type MobileCommand,
  type Task,
  type TaskState,
  type WorkstationProject,
} from "@ai-workstation/protocol";
import {
  ArrowUp,
  ArrowLeft,
  Check,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  CircleStop,
  CodeXml,
  FileDiff,
  Folder,
  FolderOpen,
  ImagePlus,
  LayoutDashboard,
  Languages,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  MonitorSmartphone,
  Plus,
  RotateCw,
  ScrollText,
  Send,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
  Timer,
  UserRound,
  Wrench,
  WifiOff,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type UIEvent as ReactUIEvent,
} from "react";
import { createPortal } from "react-dom";
import { localeOptions, useI18n, type Locale } from "./i18n.js";

type Translate = ReturnType<typeof useI18n>["t"];

const deviceId = "workstation_local";

export function pairingTokenFromLocation(location: Pick<Location, "hash" | "search" | "pathname">): string | undefined {
  const fragment = location.hash.slice(1);
  return new URLSearchParams(fragment).get("token")
    ?? fragment.match(/^[0-9A-HJKMNP-TV-Z]{39}$/)?.[0]
    ?? new URLSearchParams(location.search).get("token")
    ?? undefined;
}

function pairingToken(): string {
  return pairingTokenFromLocation(window.location)
    ?? import.meta.env.VITE_PAIRING_TOKEN
    ?? "local-development-only";
}

type Tab = "workbench" | "device";
type Route = { kind: "tab"; tab: Tab } | { kind: "task"; taskId: string } | { kind: "approval"; taskId: string };
type TransportState = "connecting" | "connected" | "disconnected";

const historyRouteKey = "ai-workstation-route";

export function routeFromHistoryState(state: unknown): Route | undefined {
  if (!state || typeof state !== "object") return undefined;
  const route = Reflect.get(state, historyRouteKey) as unknown;
  if (!route || typeof route !== "object") return undefined;
  const kind = Reflect.get(route, "kind");
  if (kind === "tab") {
    const tab = Reflect.get(route, "tab");
    return tab === "workbench" || tab === "device" ? { kind, tab } : undefined;
  }
  if (kind === "task" || kind === "approval") {
    const taskId = Reflect.get(route, "taskId");
    return typeof taskId === "string" && taskId ? { kind, taskId } : undefined;
  }
  return undefined;
}

function historyStateWithRoute(state: unknown, route: Route): Record<string, unknown> {
  const current = state && typeof state === "object" ? state as Record<string, unknown> : {};
  return { ...current, [historyRouteKey]: route };
}

interface WorkstationModel {
  transport: TransportState;
  hostOnline: boolean;
  deviceName: string | undefined;
  tasks: Map<string, Task>;
  projects: WorkstationProject[];
  activeSources: AgentSource[];
  sourcesReady: boolean;
  lastSequence: number;
}

export function resolveRelayUrl(
  location: Pick<Location, "protocol" | "host" | "hostname">,
  configuredUrl?: string,
  development = false,
): string {
  if (configuredUrl) return configuredUrl;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return development
    ? `${protocol}//${location.hostname}:8787/ws`
    : `${protocol}//${location.host}/ws`;
}

function relayUrl(): string {
  return resolveRelayUrl(window.location, import.meta.env.VITE_CONTROL_URL, import.meta.env.DEV);
}

function useWorkstation() {
  const { t } = useI18n();
  const translateRef = useRef(t);
  translateRef.current = t;
  const [model, setModel] = useState<WorkstationModel>({
    transport: "connecting",
    hostOnline: false,
    deviceName: undefined,
    tasks: new Map(),
    projects: [],
    activeSources: [],
    sourcesReady: false,
    lastSequence: 0,
  });
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const lastSequenceRef = useRef(0);
  const refreshWaitersRef = useRef(new Set<{ resolve: (refreshed: boolean) => void; timer: number }>());
  const commandWaitersRef = useRef(new Map<string, (accepted: boolean, detail?: string) => void>());

  const finishRefreshes = useCallback((refreshed: boolean) => {
    for (const waiter of refreshWaitersRef.current) {
      window.clearTimeout(waiter.timer);
      waiter.resolve(refreshed);
    }
    refreshWaitersRef.current.clear();
  }, []);

  const finishCommands = useCallback((detail: string) => {
    for (const waiter of commandWaitersRef.current.values()) waiter(false, detail);
    commandWaitersRef.current.clear();
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      setModel((current) => ({ ...current, transport: "connecting" }));
      const socket = new WebSocket(relayUrl());
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        attempt = 0;
        setModel((current) => ({ ...current, transport: "connected" }));
        socket.send(JSON.stringify({
          type: "mobile.hello",
          deviceId,
          token: pairingToken(),
          afterSequence: lastSequenceRef.current,
        }));
      });

      socket.addEventListener("message", (message) => {
        let value: unknown;
        try {
          value = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const parsed = ServerMessageSchema.safeParse(value);
        if (!parsed.success) return;
        const serverMessage = parsed.data;

        if (serverMessage.type === "server.ack" && serverMessage.status !== "delivered") {
          const waiter = commandWaitersRef.current.get(serverMessage.messageId);
          if (waiter) {
            commandWaitersRef.current.delete(serverMessage.messageId);
            waiter(serverMessage.status === "accepted", serverMessage.detail);
          }
          return;
        }

        if (serverMessage.type === "server.snapshot") {
          lastSequenceRef.current = Math.max(lastSequenceRef.current, serverMessage.lastSequence);
          setModel((current) => ({
            ...current,
            hostOnline: serverMessage.online,
            deviceName: serverMessage.deviceName ?? current.deviceName,
            tasks: new Map(serverMessage.tasks.map((task) => [task.id, task])),
            projects: serverMessage.projects,
            activeSources: serverMessage.activeSources,
            sourcesReady: serverMessage.activeSources.length > 0 || !serverMessage.online,
            lastSequence: serverMessage.lastSequence,
          }));
          finishRefreshes(true);
          return;
        }

        if (serverMessage.type === "server.event") {
          lastSequenceRef.current = Math.max(lastSequenceRef.current, serverMessage.event.sequence);
          setModel((current) => ({
            ...current,
            tasks: applyEventToTasks(current.tasks, serverMessage.event),
            lastSequence: Math.max(current.lastSequence, serverMessage.event.sequence),
          }));
          return;
        }

        if (serverMessage.type === "server.projects") {
          setModel((current) => ({ ...current, projects: serverMessage.projects }));
          return;
        }

        if (serverMessage.type === "server.sources") {
          setModel((current) => ({ ...current, activeSources: serverMessage.activeSources, sourcesReady: true }));
          return;
        }

        if (serverMessage.type === "server.host_status") {
          setModel((current) => ({
            ...current,
            hostOnline: serverMessage.online,
            deviceName: serverMessage.deviceName ?? current.deviceName,
            ...(!serverMessage.online ? { activeSources: [], sourcesReady: true } : {}),
          }));
        }
      });

      socket.addEventListener("close", () => {
        if (disposed) return;
        finishRefreshes(false);
        finishCommands(translateRef.current("connectionLost"));
        setModel((current) => ({
          ...current,
          transport: "disconnected",
          hostOnline: false,
          activeSources: [],
          sourcesReady: false,
        }));
        const delay = Math.min(1_000 * 2 ** attempt, 10_000);
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      finishRefreshes(false);
      finishCommands(translateRef.current("connectionClosed"));
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, [finishCommands, finishRefreshes]);

  const refresh = useCallback((): Promise<boolean> => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: window.setTimeout(() => {
          refreshWaitersRef.current.delete(waiter);
          resolve(false);
        }, 8_000),
      };
      refreshWaitersRef.current.add(waiter);
      socket.send(JSON.stringify({ type: "mobile.refresh", deviceId }));
    });
  }, []);

  const sendCommand = useCallback((
    taskId: string,
    action: CommandAction,
    onResult?: (accepted: boolean, detail?: string) => void,
  ): boolean => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
    const now = new Date();
    const command: MobileCommand = {
      protocolVersion: 1,
      commandId: createId("command"),
      deviceId,
      taskId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      nonce: createId("nonce"),
      action,
    };
    if (onResult) commandWaitersRef.current.set(command.commandId, onResult);
    try {
      socketRef.current.send(JSON.stringify({ type: "mobile.command", command }));
    } catch {
      commandWaitersRef.current.delete(command.commandId);
      return false;
    }
    return true;
  }, []);

  const createTask = useCallback((
    source: AgentSource,
    projectId: string | undefined,
    text: string,
    attachments?: ImageAttachment[],
    onResult?: (accepted: boolean, detail?: string) => void,
  ): string | undefined => {
    const taskId = createId("new_task");
    const sent = sendCommand(taskId, {
      kind: "new_task",
      source,
      ...(projectId ? { projectId } : {}),
      text,
      ...(attachments?.length ? { attachments } : {}),
    }, onResult);
    return sent ? taskId : undefined;
  }, [sendCommand]);

  return { model, sendCommand, createTask, refresh };
}

const pullRefreshThreshold = 62;
const maxPullDistance = 104;

export function resistedPullDistance(deltaY: number): number {
  return Math.round(Math.min(maxPullDistance, Math.max(0, deltaY) * 0.55));
}

type PullPhase = "idle" | "pulling" | "ready" | "refreshing" | "complete" | "failed";

function PullToRefresh({ children, className = "", windowScroll = false, containerRef, onScroll, onRefresh }: {
  children: ReactNode;
  className?: string;
  windowScroll?: boolean;
  containerRef?: MutableRefObject<HTMLDivElement | null>;
  onScroll?: (event: ReactUIEvent<HTMLDivElement>) => void;
  onRefresh: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const localRef = useRef<HTMLDivElement | null>(null);
  const startYRef = useRef<number | undefined>(undefined);
  const distanceRef = useRef(0);
  const resetTimerRef = useRef<number | undefined>(undefined);
  const [distance, setDistance] = useState(0);
  const [phase, setPhase] = useState<PullPhase>("idle");

  useEffect(() => () => {
    if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current);
  }, []);

  const setContainer = (node: HTMLDivElement | null) => {
    localRef.current = node;
    if (containerRef) containerRef.current = node;
  };
  const scrollTop = () => windowScroll ? window.scrollY : (localRef.current?.scrollTop ?? 0);
  const updateDistance = (next: number) => {
    distanceRef.current = next;
    setDistance(next);
  };
  const reset = () => {
    startYRef.current = undefined;
    updateDistance(0);
    setPhase("idle");
  };
  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (phase === "refreshing" || event.touches.length !== 1 || scrollTop() > 0) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
    startYRef.current = event.touches[0]?.clientY;
  };
  const handleTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const startY = startYRef.current;
    const touch = event.touches[0];
    if (startY === undefined || !touch) return;
    if (scrollTop() > 0) {
      reset();
      return;
    }
    const next = resistedPullDistance(touch.clientY - startY);
    if (next <= 0) {
      updateDistance(0);
      setPhase("idle");
      return;
    }
    event.preventDefault();
    updateDistance(next);
    setPhase(next >= pullRefreshThreshold ? "ready" : "pulling");
  };
  const handleTouchEnd = () => {
    startYRef.current = undefined;
    if (distanceRef.current < pullRefreshThreshold) {
      reset();
      return;
    }
    updateDistance(48);
    setPhase("refreshing");
    void onRefresh().then((refreshed) => {
      setPhase(refreshed ? "complete" : "failed");
      resetTimerRef.current = window.setTimeout(reset, 650);
    }, () => {
      setPhase("failed");
      resetTimerRef.current = window.setTimeout(reset, 650);
    });
  };
  const label = phase === "ready"
    ? t("pullRelease")
    : phase === "refreshing"
      ? t("pullRefreshing")
      : phase === "complete"
        ? t("pullComplete")
        : phase === "failed"
          ? t("pullFailed")
          : t("pullPrompt");
  const visible = phase !== "idle";

  return (
    <div
      ref={setContainer}
      className={`pull-to-refresh phase-${phase} ${className}`.trim()}
      onScroll={onScroll}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={reset}
    >
      <div
        className={`pull-refresh-indicator phase-${phase}`}
        style={visible ? { transform: `translate3d(-50%, ${distance - 38}px, 0)`, opacity: 1 } : undefined}
        role="status"
        aria-live="polite"
      >
        {phase === "complete" ? <Check /> : <RotateCw className={phase === "refreshing" ? "spin-soft" : ""} />}
        <span>{label}</span>
      </div>
      <div className="pull-refresh-content" style={distance > 0 ? { transform: `translate3d(0, ${distance}px, 0)` } : undefined}>
        {children}
      </div>
    </div>
  );
}

function relativeTime(iso: string, t: Translate): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1_000));
  if (seconds < 10) return t("justNow");
  if (seconds < 60) return t("secondsAgo", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("minutesAgo", { count: minutes });
  return t("hoursAgo", { count: Math.floor(minutes / 60) });
}

function stateLabel(state: TaskState, t: Translate): string {
  return {
    idle: t("stateIdle"),
    running: t("stateRunning"),
    waiting_for_user: t("stateWaiting"),
    succeeded: t("stateSucceeded"),
    failed: t("stateFailed"),
    stopped: t("stateStopped"),
    unknown: t("stateUnknown"),
  }[state];
}

function StateIcon({ state }: { state: TaskState }) {
  if (state === "waiting_for_user") return <ShieldAlert />;
  if (state === "running") return <LoaderCircle className="spin-soft" />;
  if (state === "succeeded") return <Check />;
  if (state === "idle") return <Terminal />;
  if (state === "failed" || state === "stopped") return <CircleStop />;
  return <RotateCw />;
}

function TaskRow({ task, onOpen, compact = false }: { task: Task; onOpen: () => void; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <button className={`task-row state-${task.state}${compact ? " compact" : ""}`} type="button" onClick={onOpen}>
      <span className="task-icon"><StateIcon state={task.state} /></span>
      <span className="task-copy">
        <strong>{compact ? task.title : `${task.projectName} · ${task.title}`}</strong>
        <small>{compact ? task.summary : `${task.agentName} · ${task.summary}`}</small>
        <time>{stateLabel(task.state, t)} · {relativeTime(task.updatedAt, t)}</time>
      </span>
      <ChevronRight className="chevron" />
    </button>
  );
}

function taskSource(task: Task): AgentSource {
  const agentName = task.agentName.toLowerCase();
  if (task.agentId === "cursor-local" || agentName.startsWith("cursor")) return "cursor";
  if (task.agentId === "claude-local" || agentName.startsWith("claude")) return "claude";
  return "codex";
}

function projectSource(project: WorkstationProject): AgentSource {
  if (project.source) return project.source;
  const projectName = project.name.toLowerCase();
  if (project.id.startsWith("cursor_") || projectName.startsWith("cursor")) return "cursor";
  if (project.id.startsWith("claude_") || projectName.startsWith("claude")) return "claude";
  return "codex";
}

function sourceLabel(source: AgentSource): string {
  if (source === "cursor") return "Cursor";
  if (source === "claude") return "Claude Code";
  return "Codex";
}

interface TaskCounts {
  running: number;
  total: number;
}

function isRunningTask(task: Task): boolean {
  return task.state === "running" || task.state === "waiting_for_user";
}

export function taskDiffStats(task: Pick<Task, "artifacts">): DiffStats | undefined {
  return [...task.artifacts].reverse().find((artifact) => artifact.kind === "diff" && artifact.stats)?.stats;
}

export function taskCountsBySource(tasks: readonly Task[]): Record<AgentSource, TaskCounts> {
  return {
    codex: {
      running: tasks.filter((task) => isRunningTask(task) && taskSource(task) === "codex").length,
      total: tasks.filter((task) => taskSource(task) === "codex").length,
    },
    cursor: {
      running: tasks.filter((task) => isRunningTask(task) && taskSource(task) === "cursor").length,
      total: tasks.filter((task) => taskSource(task) === "cursor").length,
    },
    claude: {
      running: tasks.filter((task) => isRunningTask(task) && taskSource(task) === "claude").length,
      total: tasks.filter((task) => taskSource(task) === "claude").length,
    },
  };
}

export function workbenchSource(
  selectedSource: AgentSource | null,
  availableSources: readonly AgentSource[],
): AgentSource | undefined {
  return selectedSource && availableSources.includes(selectedSource)
    ? selectedSource
    : availableSources[0];
}

export function newTaskInitialProjectId(
  source: AgentSource,
  fixedProjectId: string | undefined,
  projects: readonly WorkstationProject[],
): string {
  return fixedProjectId ?? (source === "cursor" ? projects[0]?.id ?? "" : "");
}

function Workbench({ model, openTask, createTask, selectedSource, selectSource, expandedProjects, setProjectExpanded, refresh }: {
  model: WorkstationModel;
  openTask: (task: Task) => void;
  createTask: (source: AgentSource, projectId: string | undefined, text: string, attachments?: ImageAttachment[]) => void;
  selectedSource: AgentSource | null;
  selectSource: (source: AgentSource) => void;
  expandedProjects: Readonly<Record<string, boolean>>;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  refresh: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [newTaskTarget, setNewTaskTarget] = useState<{ source: AgentSource; projectId?: string }>();
  const tasks = [...model.tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const counts = taskCountsBySource(tasks);
  const availableSources = (["codex", "cursor", "claude"] as const).filter((item) => model.activeSources.includes(item));
  const source = workbenchSource(selectedSource, availableSources);
  const sourceTasks = tasks.filter((task) => taskSource(task) === source);
  const projects = [...model.projects]
    .filter((project) => projectSource(project) === source)
    .sort((a, b) => a.order - b.order)
    .map((project) => {
      const projectTasks = sourceTasks.filter((task) => task.projectId === project.id);
      return {
        ...project,
        tasks: projectTasks,
        active: projectTasks.some(isRunningTask),
        runningCount: projectTasks.filter(isRunningTask).length,
      };
    });

  return (
    <PullToRefresh className="workbench-pull-refresh" windowScroll onRefresh={refresh}>
      <div className="page page-workbench">
      <header className="workbench-header">
        <div>
          <span className="eyebrow">AI WORKSTATION</span>
          <h1>{t("workbenchTitle")}</h1>
          <p>{t("workbenchSubtitle")}</p>
        </div>
        <span className="workbench-status">
          <i className={model.hostOnline ? "online" : "offline"} />
          {model.hostOnline ? t("workstationOnline") : t("workstationOffline")}
        </span>
        {source ? <button className="icon-button workbench-create" type="button" aria-label={t("newSourceTask", { source: sourceLabel(source) })} title={t("newTask")} onClick={() => setNewTaskTarget({ source })}><Plus /></button> : null}
      </header>

      {availableSources.length > 0 ? <div className="agent-tabs" role="tablist" aria-label={t("selectSource")}>
        {availableSources.map((item) => (
          <button
            key={item}
            className={source === item ? "selected" : ""}
            type="button"
            role="tab"
            aria-selected={source === item}
            onClick={() => selectSource(item)}
          >
            {sourceLabel(item)}<span>{counts[item].running}/{counts[item].total}</span>
          </button>
        ))}
      </div> : null}

      {source ? <><section className="project-section">
        <div className="section-title"><h2>{t("sourceProjects", { source: sourceLabel(source) })}</h2><span>{projects.length}</span></div>
        {projects.length === 0 ? <p className="empty-row">{t("noProjects", { source: sourceLabel(source) })}</p> : projects.map((project) => (
          <ProjectGroup
            key={project.id}
            project={project}
            expanded={expandedProjects[project.id] ?? project.active}
            setExpanded={(expanded) => setProjectExpanded(project.id, expanded)}
            openTask={openTask}
            createTask={() => setNewTaskTarget({ source, projectId: project.id })}
          />
        ))}
      </section>
      <section className="recent-section">
        <div className="section-title"><h2>{t("recentSessions")}</h2></div>
        <div className="recent-tasks">
          {sourceTasks.map((task) => <TaskRow compact key={task.id} task={task} onOpen={() => openTask(task)} />)}
        </div>
      </section>
      </> : <p className="empty-row source-empty">
        {model.sourcesReady ? t("noSources") : t("detectingSources")}
      </p>}
      {newTaskTarget ? <NewTaskDialog
        source={newTaskTarget.source}
        {...(newTaskTarget.projectId ? { fixedProjectId: newTaskTarget.projectId } : {})}
        projects={model.projects.filter((project) => projectSource(project) === newTaskTarget.source)}
        close={() => setNewTaskTarget(undefined)}
        submit={(projectId, text, attachments) => {
          createTask(newTaskTarget.source, projectId, text, attachments);
          setNewTaskTarget(undefined);
        }}
      /> : null}
      </div>
    </PullToRefresh>
  );
}

function ProjectGroup({ project, expanded, setExpanded, openTask, createTask }: {
  project: WorkstationProject & { tasks: Task[]; active: boolean; runningCount: number };
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  openTask: (task: Task) => void;
  createTask: () => void;
}) {
  const { t } = useI18n();
  return (
    <details className="project-group" open={expanded}>
      <summary onClick={(event) => { event.preventDefault(); setExpanded(!expanded); }}>
        <span className="project-folder"><Folder /><FolderOpen /></span>
        <strong>{project.name}</strong>
        <small>{project.runningCount}/{project.tasks.length}</small>
        <button className="project-create" type="button" aria-label={t("newTaskInProject", { project: project.name })} title={t("createTaskInProject")} onClick={(event) => { event.preventDefault(); event.stopPropagation(); createTask(); }}><Plus /></button>
        <i className={project.active ? "active" : ""} aria-label={project.active ? t("activeTasks") : undefined} />
        <ChevronDown />
      </summary>
      <div className="project-tasks">
        {project.tasks.map((task) => <TaskRow compact key={task.id} task={task} onOpen={() => openTask(task)} />)}
      </div>
    </details>
  );
}

const acceptedImageTypes = new Set<ImageAttachment["mediaType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const maxImageBytes = 5 * 1_024 * 1_024;
const maxImageAttachments = 3;

async function imageAttachmentFromFile(file: File, t: Translate): Promise<ImageAttachment> {
  if (!acceptedImageTypes.has(file.type as ImageAttachment["mediaType"])) {
    throw new Error(t("imageTypeError"));
  }
  if (file.size > maxImageBytes) throw new Error(t("imageSizeError"));
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(t("imageReadError"))));
    reader.addEventListener("error", () => reject(new Error(t("imageReadError"))));
    reader.readAsDataURL(file);
  });
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return {
    id: createId("image"),
    kind: "image",
    name: file.name.slice(0, 180) || "image",
    mediaType: file.type as ImageAttachment["mediaType"],
    data,
  };
}

function ImagePicker({ attachments, setAttachments }: {
  attachments: ImageAttachment[];
  setAttachments: (attachments: ImageAttachment[]) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const addImages = async (files: FileList | null) => {
    if (!files?.length) return;
    const available = maxImageAttachments - attachments.length;
    if (available <= 0) {
      setError(t("imageLimit", { count: maxImageAttachments }));
      return;
    }
    try {
      const selected = Array.from(files).slice(0, available);
      const next = await Promise.all(selected.map((file) => imageAttachmentFromFile(file, t)));
      setAttachments([...attachments, ...next]);
      setError(files.length > available ? t("imagePartial", { added: available, count: maxImageAttachments }) : undefined);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : t("imageReadError"));
    }
  };
  return (
    <div className="image-picker">
      {attachments.length > 0 ? <div className="image-previews">
        {attachments.map((attachment) => <span className="image-preview" key={attachment.id}>
          <img src={`data:${attachment.mediaType};base64,${attachment.data}`} alt={attachment.name} />
          <button type="button" aria-label={t("removeImage", { name: attachment.name })} title={t("removeImageTitle")} onClick={() => setAttachments(attachments.filter((item) => item.id !== attachment.id))}><X /></button>
        </span>)}
      </div> : null}
      <input
        ref={inputRef}
        className="image-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        onChange={(event) => {
          void addImages(event.target.files);
          event.target.value = "";
        }}
      />
      <button className="image-add" type="button" aria-label={t("addImage")} title={t("addImage")} onClick={() => inputRef.current?.click()} disabled={attachments.length >= maxImageAttachments}><ImagePlus /><span>{t("addImage")}</span></button>
      {error ? <small className="image-error" role="alert">{error}</small> : null}
    </div>
  );
}

function NewTaskDialog({ source, fixedProjectId, projects, close, submit }: {
  source: AgentSource;
  fixedProjectId?: string;
  projects: WorkstationProject[];
  close: () => void;
  submit: (projectId: string | undefined, text: string, attachments: ImageAttachment[]) => void;
}) {
  const { t } = useI18n();
  const initialProjectId = newTaskInitialProjectId(source, fixedProjectId, projects);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const fixedProject = fixedProjectId ? projects.find((project) => project.id === fixedProjectId) : undefined;
  const requiresProject = source === "cursor";
  const canSubmit = (text.trim().length > 0 || attachments.length > 0) && (!requiresProject || projectId.length > 0);
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <form className="new-task-dialog" role="dialog" aria-modal="true" aria-labelledby="new-task-title" onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        submit(projectId || undefined, text.trim() || t("attachedImageTask"), attachments);
      }}>
        <header><div><span>{sourceLabel(source)}</span><h2 id="new-task-title">{t("newConversationTask")}</h2></div><button type="button" aria-label={t("close")} title={t("close")} onClick={close}><X /></button></header>
        <div className="new-task-dialog-body">
          <label><span>{t("project")}</span>{fixedProject ? <strong>{fixedProject.name}</strong> : <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {!requiresProject ? <option value="">{t("currentWorkingDirectory")}</option> : null}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>}</label>
          <label><span>{t("task")}</span><textarea autoFocus rows={5} maxLength={4_000} value={text} onChange={(event) => setText(event.target.value)} placeholder={t("taskPlaceholder")} /></label>
          <ImagePicker attachments={attachments} setAttachments={setAttachments} />
        </div>
        <footer><button className="button" type="button" onClick={close}>{t("cancel")}</button><button className="button primary" type="submit" disabled={!canSubmit}><Send />{t("createTask")}</button></footer>
      </form>
    </div>,
    document.body,
  );
}

function ApprovalPage({ task, back, act }: {
  task: Task;
  back: () => void;
  act: (decision: "approve" | "reject") => void;
}) {
  const { t } = useI18n();
  const approval = task.pendingApproval;
  if (!approval) return <TaskPage task={task} back={back} send={() => undefined} refresh={() => Promise.resolve(false)} />;

  return (
    <div className="page detail-page">
      <DetailHeader title={t("approvalTitle")} back={back} />
      <div className="approval-heading">
        <span className="approval-icon"><ShieldAlert /></span>
        <div><span className={`risk risk-${approval.risk}`}>{approval.risk === "high" ? t("riskHigh") : approval.risk === "medium" ? t("riskMedium") : t("riskLow")} · {approval.capability}</span><h1>{approval.title}</h1></div>
      </div>
      <dl className="context-list">
        <div><dt>{t("task")}</dt><dd>{task.title}</dd></div>
        <div><dt>{t("project")}</dt><dd>{task.projectName}</dd></div>
        <div><dt>{t("validFor")}</dt><dd>{t("oneOperation")}</dd></div>
      </dl>
      <section className="permission-list">
        <h2>{t("operationWill")}</h2>
        {approval.scope.map((scope) => <p key={scope}><FileDiff /><span>{scope}</span></p>)}
        <p className="approval-context"><ScrollText /><span>{approval.summary}</span></p>
      </section>
      <div className="approval-actions">
        <button className="button secondary" type="button" onClick={() => act("reject")}>{t("reject")}</button>
        <button className="button primary" type="button" onClick={() => act("approve")}><ShieldCheck />{t("approveOnce")}</button>
      </div>
    </div>
  );
}

function TaskPage({ task, back, send, refresh }: {
  task: Task;
  back: () => void;
  send: (action: CommandAction) => void;
  refresh: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const requestedHistoryKey = useRef<string | undefined>(undefined);
  const historyViewportRef = useRef<HTMLDivElement | null>(null);
  const stickToLatestRef = useRef(true);
  const viewedTaskIdRef = useRef(task.id);
  const prependAnchorRef = useRef<{ height: number; count: number } | undefined>(undefined);
  const loadingOlderRef = useRef(false);
  const loadingOlderTimerRef = useRef<number | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const canMessage = task.capabilities.includes("message");
  const canStop = task.capabilities.includes("stop");
  const canLoadHistory = task.capabilities.includes("history");
  const desktopOwnsWriter = task.controlState === "external_writer";
  const webOwnsWriter = task.controlState === "managed";
  const desktopIsExecuting = task.state === "running" || task.state === "waiting_for_user";
  const agentLabel = sourceLabel(taskSource(task));
  const readOnlyReason = task.controlReason
    ?? (webOwnsWriter
      ? t("webExecuting")
      : desktopOwnsWriter && desktopIsExecuting
        ? t("desktopExecuting")
        : t("noMessageControl"));
  useEffect(() => {
    const historyKey = `${task.id}:${task.runId}`;
    if (task.historyState === "loaded" || task.historyState === "partial" || task.historyState === "failed") {
      requestedHistoryKey.current = undefined;
    } else if (canLoadHistory && task.historyState === "not_loaded" && requestedHistoryKey.current !== historyKey) {
      requestedHistoryKey.current = historyKey;
      send({ kind: "request_history", direction: "latest" });
    }
  }, [canLoadHistory, task.historyState, task.id, task.runId]);

  useEffect(() => {
    if (viewedTaskIdRef.current !== task.id) {
      viewedTaskIdRef.current = task.id;
      stickToLatestRef.current = true;
    }
    if (!stickToLatestRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = historyViewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [task.history.length, task.historyState, task.id, task.runId, task.state, task.summary]);

  useEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor || (task.history.length === anchor.count && task.historyState === "partial")) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = historyViewportRef.current;
      if (viewport) viewport.scrollTop += viewport.scrollHeight - anchor.height;
      prependAnchorRef.current = undefined;
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      if (loadingOlderTimerRef.current !== undefined) window.clearTimeout(loadingOlderTimerRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [task.history.length, task.historyState]);

  useEffect(() => () => {
    if (loadingOlderTimerRef.current !== undefined) window.clearTimeout(loadingOlderTimerRef.current);
  }, []);

  const requestOlderHistory = () => {
    const viewport = historyViewportRef.current;
    if (!viewport || task.historyState !== "partial" || loadingOlderRef.current) return;
    stickToLatestRef.current = false;
    prependAnchorRef.current = { height: viewport.scrollHeight, count: task.history.length };
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    send({ kind: "request_history", direction: "older" });
    loadingOlderTimerRef.current = window.setTimeout(() => {
      loadingOlderRef.current = false;
      prependAnchorRef.current = undefined;
      setLoadingOlder(false);
    }, 10_000);
  };

  const refreshConversation = async () => {
    const refreshed = await refresh();
    if (canLoadHistory) send({ kind: "request_history", direction: "latest" });
    return refreshed;
  };

  return (
    <div className="page detail-page task-chat-page">
      <div className="task-chat-top">
        <DetailHeader title={t("taskConversation")} back={back} />
        <section className="task-chat-overview">
          <div className="task-chat-title">
            <h1>{task.title}</h1>
            <span className={`status-text status-${task.state}`}><i /> {stateLabel(task.state, t)}</span>
          </div>
          <div className="task-chat-facts">
            <span>{task.projectName}</span>
            <span>{task.agentName}</span>
            <span>{t("recordCount", { count: task.history.length })}</span>
            <time>{relativeTime(task.updatedAt, t)}</time>
          </div>
          {task.progress === undefined ? null : <div className="progress" role="progressbar" aria-label={t("taskProgress")} aria-valuenow={Math.round(task.progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${task.progress * 100}%` }} /></div>}
        </section>
      </div>
      <PullToRefresh
        className="task-chat-scroll"
        containerRef={historyViewportRef}
        onRefresh={refreshConversation}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          stickToLatestRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
          if (viewport.scrollTop < 120) requestOlderHistory();
        }}
      >
        <TaskHistory
          task={task}
          loadingOlder={loadingOlder}
          loadOlder={requestOlderHistory}
          retry={() => send({ kind: "request_history", direction: "latest" })}
          requestDiff={() => send({ kind: "request_diff" })}
        />
      </PullToRefresh>
      <div className="task-chat-composer-shell">
        {canMessage ? <MessageComposer key={task.id} agentLabel={agentLabel} canStop={canStop} restart={task.state === "stopped"} send={send} onMessageSent={() => { stickToLatestRef.current = true; }} /> : <div className={`composer-readonly${canStop ? " readonly-with-stop" : ""}`}>
          {canStop ? <button className="composer-stop" type="button" aria-label={t("stopTask")} title={t("stopTask")} onClick={() => send({ kind: "stop" })}><Square /></button> : null}
          <div className="composer-readonly-message" role="status">
            <LockKeyhole />
            <span><strong>{t("readOnly")}</strong><small>{readOnlyReason}</small></span>
          </div>
        </div>}
      </div>
    </div>
  );
}

function MessageComposer({ agentLabel, canStop, restart, send, onMessageSent }: {
  agentLabel: string;
  canStop: boolean;
  restart: boolean;
  send: (action: CommandAction) => void;
  onMessageSent: () => void;
}) {
  const { t } = useI18n();
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const sendMessage = () => {
    const text = message.trim();
    if (!text && attachments.length === 0) return;
    onMessageSent();
    send({
      kind: "message",
      text: text || t("attachedImageContinue"),
      ...(attachments.length ? { attachments } : {}),
    });
    setMessage("");
    setAttachments([]);
  };
  const hasContent = Boolean(message.trim()) || attachments.length > 0;
  const stopsTask = canStop && !hasContent;
  return (
    <div className="composer">
      <ImagePicker attachments={attachments} setAttachments={setAttachments} />
      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            sendMessage();
          }
        }}
        rows={1}
        placeholder={restart ? t("restartPlaceholder") : t("messagePlaceholder", { agent: agentLabel })}
        aria-label={restart ? t("restartSession", { agent: agentLabel }) : t("messageAgent", { agent: agentLabel })}
      />
      <button
        className={stopsTask ? "composer-action composer-stop" : "composer-action composer-send"}
        type="button"
        aria-label={stopsTask ? t("stopTask") : restart ? t("restart") : t("send")}
        title={stopsTask ? t("stopTask") : restart ? t("restart") : t("send")}
        disabled={!stopsTask && !hasContent}
        onClick={stopsTask ? () => send({ kind: "stop" }) : sendMessage}
      >
        {stopsTask ? <Square /> : <ArrowUp />}
      </button>
    </div>
  );
}

function HistoryEntryIcon({ kind }: { kind: Task["history"][number]["kind"] }) {
  if (kind === "user_message") return <UserRound />;
  if (kind === "agent_message") return <CodeXml />;
  if (kind === "error") return <CircleAlert />;
  if (kind === "command") return <Terminal />;
  if (kind === "file_change") return <FileDiff />;
  if (kind === "reasoning" || kind === "plan") return <ScrollText />;
  return <Wrench />;
}

function historyTime(iso: string | undefined, locale: string): string | undefined {
  if (!iso) return undefined;
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatTurnDuration(startedAt: string, completedAt: string, t: Translate): string {
  const durationSeconds = Math.max(0, Math.floor((Date.parse(completedAt) - Date.parse(startedAt)) / 1_000));
  const hours = Math.floor(durationSeconds / 3_600);
  const minutes = Math.floor((durationSeconds % 3_600) / 60);
  const seconds = durationSeconds % 60;
  return [
    hours > 0 ? t("durationHour", { count: hours }) : undefined,
    minutes > 0 ? t("durationMinute", { count: minutes }) : undefined,
    t("durationSecond", { count: seconds }),
  ].filter(Boolean).join(" ");
}

function TurnDuration({ timing }: { timing: Task["turnTimings"][number] | undefined }) {
  const { t } = useI18n();
  if (!timing?.completedAt) return null;
  const duration = formatTurnDuration(timing.startedAt, timing.completedAt, t);
  return (
    <small className="history-message-duration" aria-label={t("processingDuration", { duration })}>
      <Timer />{t("processingDuration", { duration })}
    </small>
  );
}

type HistoryEntry = Task["history"][number];
type HistorySegment =
  | { kind: "message"; entry: HistoryEntry }
  | { kind: "work"; turnId: string; entries: HistoryEntry[] };

function groupHistoryEntries(entries: readonly HistoryEntry[], activeTurnId?: string): HistorySegment[] {
  const lastAgentMessageByTurn = new Map<string, string>();
  entries.forEach((entry) => {
    if (entry.kind === "agent_message") lastAgentMessageByTurn.set(entry.turnId, entry.id);
  });
  const segments: HistorySegment[] = [];
  for (const entry of entries) {
    const legacyProcessMessage = entry.kind === "agent_message"
      && entry.phase === undefined
      && (entry.turnId === activeTurnId || lastAgentMessageByTurn.get(entry.turnId) !== entry.id);
    const isMessage = entry.kind === "user_message"
      || entry.kind === "error"
      || (entry.kind === "agent_message" && entry.phase !== "commentary" && !legacyProcessMessage);
    if (isMessage) {
      segments.push({ kind: "message", entry });
      continue;
    }

    const previous = segments[segments.length - 1];
    if (previous?.kind === "work" && previous.turnId === entry.turnId) {
      previous.entries.push(entry);
    } else {
      segments.push({ kind: "work", turnId: entry.turnId, entries: [entry] });
    }
  }
  return segments;
}

export function taskLiveSummary(task: Pick<Task, "state" | "runId" | "summary" | "history">): string | undefined {
  if (task.state !== "running" && task.state !== "waiting_for_user") return undefined;

  const segments = groupHistoryEntries(task.history, task.runId);
  const hasLiveWork = segments.some((segment) => segment.kind === "work" && segment.turnId === task.runId);
  if (hasLiveWork) return undefined;

  const lastAgentMessage = [...task.history].reverse().find((entry) => entry.kind === "agent_message");
  return lastAgentMessage?.text.trim() === task.summary.trim() ? undefined : task.summary;
}

interface DiffFileView {
  path: string;
  lines: string[];
}

export function parseUnifiedDiff(content: string, fallbackPath = "Changes"): DiffFileView[] {
  const files: DiffFileView[] = [];
  let current: DiffFileView | undefined;
  for (const line of content.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: line.match(/ b\/(.+)$/)?.[1] ?? fallbackPath, lines: [line] };
      files.push(current);
      continue;
    }
    if (!current) {
      current = { path: fallbackPath, lines: [] };
      files.push(current);
    }
    if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
      current.path = line.slice(4).replace(/^b\//, "").split("\t", 1)[0] || current.path;
    }
    current.lines.push(line);
  }
  const grouped = new Map<string, DiffFileView>();
  for (const file of files.filter((candidate) => candidate.lines.length > 0)) {
    const existing = grouped.get(file.path);
    if (existing) existing.lines.push("", ...file.lines);
    else grouped.set(file.path, file);
  }
  return [...grouped.values()];
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "removed";
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "meta";
  return "context";
}

function TurnChangeStats({ stats, artifact, request }: {
  stats: DiffStats;
  artifact?: Artifact | undefined;
  request?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cachedContent, setCachedContent] = useState(artifact?.content);
  const [cachedError, setCachedError] = useState(artifact?.contentError);
  const [cachedTruncated, setCachedTruncated] = useState(artifact?.contentTruncated ?? false);
  const requested = useRef(Boolean(artifact?.content || artifact?.contentError));
  const files = useMemo(() => cachedContent ? parseUnifiedDiff(cachedContent, t("changesFallback")) : [], [cachedContent, t]);
  useEffect(() => {
    if (artifact?.content) {
      setCachedContent(artifact.content);
      setCachedError(undefined);
      setCachedTruncated(artifact.contentTruncated ?? false);
      setLoading(false);
      requested.current = true;
    } else if (artifact?.contentError) {
      setCachedError(artifact.contentError);
      setLoading(false);
      requested.current = true;
    }
  }, [artifact?.content, artifact?.contentError, artifact?.contentTruncated]);
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setLoading(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [loading]);
  const toggle = () => {
    const opening = !expanded;
    setExpanded(opening);
    if (opening && !cachedContent && !requested.current && request) {
      requested.current = true;
      setLoading(true);
      request();
    }
  };

  const label = t("diffLabel", { files: stats.filesChanged, additions: stats.additions, deletions: stats.deletions });
  const summary = <>
    <FileDiff />
    <span>{t("filesChanged", { count: stats.filesChanged })}</span>
    <strong className="additions">+{stats.additions}</strong>
    <strong className="deletions">-{stats.deletions}</strong>
  </>;
  if (!artifact || !request) return <div className="turn-change-stats" aria-label={label}>{summary}</div>;

  return (
    <section className={`turn-change-viewer${expanded ? " expanded" : ""}`} aria-label={t("changesContent")}>
      <button className="turn-change-stats" type="button" onClick={toggle} aria-expanded={expanded} aria-label={t("changeAction", { label, action: expanded ? t("collapseChanges") : t("expandChanges") })}>
        {summary}
        {loading ? <LoaderCircle className="spin-soft turn-change-status" /> : <ChevronDown className="turn-change-status" />}
      </button>
      {expanded && cachedError ? <p className="task-diff-error">{cachedError}</p> : null}
      {expanded && cachedContent ? <div className="task-diff-files">
        {files.map((file, fileIndex) => (
          <details key={`${file.path}:${fileIndex}`} open={fileIndex === 0}>
            <summary><FileDiff /><span>{file.path}</span><small>{file.lines.filter((line) => diffLineClass(line) === "added").length > 0 ? `+${file.lines.filter((line) => diffLineClass(line) === "added").length}` : ""}</small><ChevronDown /></summary>
            <pre>{file.lines.map((line, lineIndex) => <code className={diffLineClass(line)} key={lineIndex}>{line || " "}{"\n"}</code>)}</pre>
          </details>
        ))}
        {cachedTruncated ? <p className="task-diff-truncated">{t("diffTruncated")}</p> : null}
      </div> : null}
    </section>
  );
}

function HistoryWork({ entries, live = false }: { entries: readonly HistoryEntry[]; live?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(live);
  useEffect(() => setExpanded(live), [live]);
  const commentaryCount = entries.filter((entry) => entry.kind === "agent_message" && entry.phase === "commentary").length;
  const activityCount = entries.length - commentaryCount;
  const summary = [
    commentaryCount > 0 ? t("commentaryCount", { count: commentaryCount }) : undefined,
    activityCount > 0 ? t("activityCount", { count: activityCount }) : undefined,
    live ? t("inProgress") : t("collapsed"),
  ].filter(Boolean).join(" · ");
  return (
    <details className={`history-work${live ? " history-live" : ""}`} open={expanded}>
      <summary onClick={(event) => { event.preventDefault(); setExpanded((current) => !current); }}>
        {live ? <LoaderCircle className="spin-soft" /> : <CodeXml />}
        <span><strong>{t("thinkingItems", { count: entries.length, unit: t(entries.length === 1 ? "item" : "items") })}</strong><small>{summary}</small></span>
        <ChevronDown />
      </summary>
      {expanded ? <div className="history-work-content">
        {entries.map((entry) => entry.kind === "agent_message" ? (
          <article className="history-work-commentary" key={entry.id}><CodeXml /><p>{entry.text}</p></article>
        ) : (
          <HistoryActivity key={entry.id} entry={entry} nested />
        ))}
      </div> : null}
    </details>
  );
}

function HistoryActivity({ entry, nested = false }: { entry: HistoryEntry; nested?: boolean }) {
  const { locale, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <details className={`history-activity kind-${entry.kind}${nested ? " nested" : ""}`} open={expanded}>
      <summary onClick={(event) => { event.preventDefault(); setExpanded((current) => !current); }}><HistoryEntryIcon kind={entry.kind} /><span><strong>{entry.title ?? t("activity")}</strong><small>{entry.status ?? historyTime(entry.createdAt, locale)}</small></span><ChevronDown /></summary>
      {expanded ? <pre>{entry.text}</pre> : null}
    </details>
  );
}

const TaskHistory = memo(function TaskHistory({ task, retry, loadOlder, loadingOlder, requestDiff }: {
  task: Task;
  retry: () => void;
  loadOlder: () => void;
  loadingOlder: boolean;
  requestDiff: () => void;
}) {
  const { locale, t } = useI18n();
  const turnNumbers = new Map<string, number>();
  const turnTimings = new Map(task.turnTimings.map((timing) => [timing.turnId, timing]));
  const diffStatsByTurn = new Map<string, DiffStats>();
  task.history.forEach((entry) => {
    if (!turnNumbers.has(entry.turnId)) turnNumbers.set(entry.turnId, turnNumbers.size + 1);
    if (entry.diffStats) diffStatsByTurn.set(entry.turnId, entry.diffStats);
  });
  const activeTurnId = task.state === "running" || task.state === "waiting_for_user" ? task.runId : undefined;
  const latestDiffStats = taskSource(task) === "codex" ? taskDiffStats(task) : undefined;
  if (latestDiffStats && !diffStatsByTurn.has(task.runId)) diffStatsByTurn.set(task.runId, latestDiffStats);
  const segments = groupHistoryEntries(task.history, activeTurnId);
  const liveSummary = taskLiveSummary(task);
  const diffArtifact = [...task.artifacts].reverse().find((artifact) => artifact.kind === "diff");

  return (
    <section className="history-section">
      <div className="history-heading">
        <h2>{t("conversationHistory")} <span>{turnNumbers.size} {t(turnNumbers.size === 1 ? "turn" : "turns")}</span></h2>
        {task.historyState === "loaded" || task.historyState === "partial" ? (
          <button type="button" onClick={retry} aria-label={t("refreshHistory")} title={t("refreshHistory")}><RotateCw /></button>
        ) : null}
      </div>
      {task.historyState === "loading" || task.historyState === "not_loaded" ? (
        <div className="history-state"><LoaderCircle className="spin-soft" /><span>{t("loadingHistory")}</span></div>
      ) : null}
      {task.historyState === "failed" ? (
        <div className="history-state history-failed"><ShieldAlert /><span>{t("historyFailed", { error: task.historyError ?? t("unknownError") })}</span><button type="button" onClick={retry}>{t("retry")}</button></div>
      ) : null}
      {task.historyState === "partial" ? (
        <button className="history-load-older" type="button" disabled={loadingOlder} onClick={loadOlder} aria-live="polite">
          {loadingOlder ? <><LoaderCircle className="spin-soft" />{t("loadingOlder")}</> : <>{t("loadOlder")}</>}
        </button>
      ) : null}
      {(task.historyState === "loaded" || task.historyState === "partial") && task.history.length === 0 && task.state !== "failed" ? <p className="history-empty">{t("noMessages")}</p> : null}
      <div className="history-timeline">
        {task.state === "failed" && task.history.length === 0 ? (
          <article className="history-message error task-failure-message" role="alert">
            <span className="history-icon"><CircleAlert /></span>
            <div><strong className="history-message-title">{t("createTaskFailed")}</strong><p>{task.summary}</p></div>
          </article>
        ) : null}
        {segments.map((segment, index) => {
          const entry = segment.kind === "message" ? segment.entry : segment.entries[0];
          if (!entry) return null;
          const previous = segments[index - 1];
          const previousTurnId = previous?.kind === "message" ? previous.entry.turnId : previous?.turnId;
          const newTurn = previousTurnId !== entry.turnId;
          const next = segments[index + 1];
          const nextTurnId = next?.kind === "message" ? next.entry.turnId : next?.turnId;
          const turnEndsHere = nextTurnId !== entry.turnId && !(liveSummary && entry.turnId === task.runId);
          const turnDiffStats = turnEndsHere ? diffStatsByTurn.get(entry.turnId) : undefined;
          return (
            <div className="history-fragment" key={segment.kind === "message" ? `${entry.turnId}:${entry.id}` : `${entry.turnId}:activity:${entry.id}`}>
              {newTurn ? <div className="turn-divider"><span>{t("turnNumber", { count: turnNumbers.get(entry.turnId) ?? 0 })}</span><time>{historyTime(entry.createdAt, locale)}</time></div> : null}
              {segment.kind === "message" ? (
                <article className={`history-message ${entry.kind}`}>
                  <span className="history-icon"><HistoryEntryIcon kind={entry.kind} /></span>
                  <div>
                    {entry.kind === "error" && entry.title ? <strong className="history-message-title">{entry.title}</strong> : null}
                    <p>{entry.text}</p>
                    {entry.kind === "agent_message" ? <TurnDuration timing={turnTimings.get(entry.turnId)} /> : null}
                  </div>
                </article>
              ) : <HistoryWork entries={segment.entries} live={entry.turnId === activeTurnId} />}
              {turnDiffStats ? (
                <TurnChangeStats
                  key={entry.turnId === task.runId ? diffArtifact?.id : entry.turnId}
                  stats={turnDiffStats}
                  artifact={entry.turnId === task.runId ? diffArtifact : undefined}
                  request={entry.turnId === task.runId && diffArtifact ? requestDiff : undefined}
                />
              ) : null}
            </div>
          );
        })}
        {liveSummary ? <div aria-live="polite">
          <HistoryWork live entries={[{ id: `live_${task.runId}`, turnId: task.runId, kind: "agent_message", phase: "commentary", text: liveSummary }]} />
          {diffStatsByTurn.get(task.runId) ? <TurnChangeStats key={diffArtifact?.id ?? task.runId} stats={diffStatsByTurn.get(task.runId)!} artifact={diffArtifact} request={diffArtifact ? requestDiff : undefined} /> : null}
        </div> : null}
      </div>
    </section>
  );
});

function DevicePage({ model }: { model: WorkstationModel }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="page">
      <header className="page-header"><h1>{t("device")}</h1></header>
      <div className="device-hero"><span><Monitor /></span><h2>{model.deviceName ?? t("readingDeviceName")}</h2><p><i className={model.hostOnline ? "online" : "offline"} /> {model.hostOnline ? t("online") : t("offline")} · {t("localDevelopmentConnection")}</p></div>
      <section className="device-settings" aria-labelledby="language-setting-title">
        <div className="device-setting-heading">
          <Languages />
          <span><strong id="language-setting-title">{t("language")}</strong><small>{t("languageDescription")}</small></span>
        </div>
        <select className="language-select" aria-label={t("language")} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
          {localeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </section>
      <p className="security-note">{t("securityNote")}</p>
    </div>
  );
}

function DetailHeader({ title, back }: { title: string; back: () => void }) {
  const { t } = useI18n();
  return <header className="detail-header"><button type="button" onClick={back} aria-label={t("backToWorkbench")} title={t("backToWorkbench")}><ArrowLeft /></button><strong>{title}</strong><span /></header>;
}

function BottomNav({ tab, setTab, model }: { tab: Tab; setTab: (tab: Tab) => void; model: WorkstationModel }) {
  const { t } = useI18n();
  return (
    <nav className="bottom-nav" aria-label={t("mainNavigation")}>
      <div className="nav-brand" aria-hidden="true">
        <span className="nav-brand-icon"><Monitor /></span>
        <span><strong>AI Workstation</strong><small>Remote Console</small></span>
      </div>
      <div className="nav-items">
        <button className={tab === "workbench" ? "active" : ""} type="button" onClick={() => setTab("workbench")}><LayoutDashboard /><span>{t("workbench")}</span></button>
        <button className={tab === "device" ? "active" : ""} type="button" onClick={() => setTab("device")}><MonitorSmartphone /><span>{t("device")}</span></button>
      </div>
      <div className="nav-device">
        <span className={`nav-device-indicator ${model.hostOnline ? "online" : "offline"}`} />
        <span><strong>{model.deviceName ?? t("localWorkstation")}</strong><small>{model.hostOnline ? t("connected") : t("waitingConnection")}</small></span>
      </div>
    </nav>
  );
}

export function App() {
  const { t } = useI18n();
  const { model, sendCommand, createTask, refresh } = useWorkstation();
  const [route, setRoute] = useState<Route>({ kind: "tab", tab: "workbench" });
  const [selectedSource, setSelectedSource] = useState<AgentSource | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<string>();
  const workbenchScrollY = useRef(0);
  const pendingCreation = useRef<{ requestTaskId: string; source: AgentSource; projectId?: string; previousTaskIds: Set<string>; requestedAt: number } | undefined>(undefined);
  const tasks = useMemo(() => [...model.tasks.values()], [model.tasks]);
  const selectedTask = route.kind === "tab" ? undefined : model.tasks.get(route.taskId);

  const navigate = useCallback((nextRoute: Route, mode: "push" | "replace" = "push") => {
    const state = historyStateWithRoute(window.history.state, nextRoute);
    if (mode === "replace") window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    setRoute(nextRoute);
  }, []);

  useEffect(() => {
    navigate({ kind: "tab", tab: "workbench" }, "replace");
    const handlePopState = (event: PopStateEvent) => {
      const nextRoute = routeFromHistoryState(event.state) ?? { kind: "tab", tab: "workbench" };
      setRoute(nextRoute);
      if (nextRoute.kind === "tab" && nextRoute.tab === "workbench") {
        window.requestAnimationFrame(() => window.scrollTo({ top: workbenchScrollY.current }));
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [navigate]);

  useEffect(() => {
    const pending = pendingCreation.current;
    if (!pending) return;
    const created = [...model.tasks.values()]
      .filter((task) => !pending.previousTaskIds.has(task.id))
      .filter((task) => task.id === pending.requestTaskId || taskSource(task) === pending.source)
      .filter((task) => !pending.projectId || task.projectId === pending.projectId || task.id === pending.requestTaskId)
      .filter((task) => Date.parse(task.updatedAt) >= pending.requestedAt - 1_000)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!created) return;
    pendingCreation.current = undefined;
    setSelectedSource(taskSource(created));
    navigate({ kind: "task", taskId: created.id });
  }, [model.tasks, navigate]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(undefined), 2_000);
  };

  const dispatch = (task: Task, action: CommandAction) => {
    const sent = sendCommand(task.id, action, (accepted, detail) => {
      if (!accepted) notify(detail ? t("commandFailedDetail", { detail }) : t("commandRejected"));
    });
    if (action.kind === "request_history" || action.kind === "request_diff") {
      if (!sent) notify(t("cannotConnect"));
      return;
    }
    notify(sent ? t("requestSubmitted") : t("cannotConnect"));
  };

  const openTask = (task: Task) => {
    workbenchScrollY.current = window.scrollY;
    setSelectedSource(taskSource(task));
    navigate(task.pendingApproval ? { kind: "approval", taskId: task.id } : { kind: "task", taskId: task.id });
  };
  const startTask = (source: AgentSource, projectId: string | undefined, text: string, attachments?: ImageAttachment[]) => {
    const previousTaskIds = new Set(model.tasks.keys());
    const requestedAt = Date.now();
    const requestTaskId = createTask(source, projectId, text, attachments, (accepted, detail) => {
      if (accepted || pendingCreation.current?.requestTaskId !== requestTaskId) return;
      pendingCreation.current = undefined;
      notify(detail ? t("createFailedDetail", { detail }) : t("createRejected"));
    });
    if (!requestTaskId) {
      notify(t("cannotConnect"));
      return;
    }
    pendingCreation.current = { requestTaskId, source, ...(projectId ? { projectId } : {}), previousTaskIds, requestedAt };
    notify(t("creatingTask"));
    window.setTimeout(() => {
      if (pendingCreation.current?.requestTaskId !== requestTaskId) return;
      pendingCreation.current = undefined;
      notify(t("createTimeout"));
    }, 30_000);
  };
  const setTab = (tab: Tab) => navigate({ kind: "tab", tab }, "replace");
  const returnToWorkbench = () => {
    const historyRoute = routeFromHistoryState(window.history.state);
    if (historyRoute && historyRoute.kind !== "tab") {
      window.history.back();
      return;
    }
    setTab("workbench");
    window.requestAnimationFrame(() => window.scrollTo({ top: workbenchScrollY.current }));
  };

  let content;
  if (selectedTask && (route.kind === "approval" || (route.kind === "task" && selectedTask.pendingApproval))) {
    content = <ApprovalPage task={selectedTask} back={returnToWorkbench} act={(decision) => {
      if (!selectedTask.pendingApproval) return;
      dispatch(selectedTask, { kind: "approval", approvalId: selectedTask.pendingApproval.id, decision });
      navigate({ kind: "task", taskId: selectedTask.id }, "replace");
    }} />;
  } else if (route.kind === "task" && selectedTask) {
    content = <TaskPage task={selectedTask} back={returnToWorkbench} send={(action) => dispatch(selectedTask, action)} refresh={refresh} />;
  } else {
    const tab = route.kind === "tab" ? route.tab : "workbench";
    content = (
      <>
        {tab === "workbench" ? <Workbench
          model={model}
          openTask={openTask}
          createTask={startTask}
          selectedSource={selectedSource}
          selectSource={setSelectedSource}
          expandedProjects={expandedProjects}
          setProjectExpanded={(projectId, expanded) => setExpandedProjects((current) => ({
            ...current,
            [projectId]: expanded,
          }))}
          refresh={refresh}
        /> : null}
        {tab === "device" ? <DevicePage model={model} /> : null}
        <BottomNav tab={tab} setTab={setTab} model={model} />
      </>
    );
  }

  return (
    <div className={`app-frame ${route.kind === "tab" ? "has-primary-nav" : "is-detail"}`}>
      {model.transport === "connected" ? null : (
        <div className="transport-banner" data-state={model.transport}>
          <WifiOff />
          <span>{model.transport === "connecting" ? t("connecting") : t("reconnecting")}</span>
        </div>
      )}
      <main className="app-main">{content}</main>
      {toast ? <div className="toast" role="status"><Send />{toast}</div> : null}
    </div>
  );
}

