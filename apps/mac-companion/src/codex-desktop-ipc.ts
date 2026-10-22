import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };

interface IpcResponse {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  method?: string;
  handledByClientId?: string;
  result?: JsonObject;
  error?: string;
}

export interface DesktopThreadStateSnapshot {
  conversationId: string;
  conversationState: JsonObject;
  ownerClientId?: string;
}

export type DesktopApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval";

interface PendingRequest {
  resolve: (response: IpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DesktopThread {
  id: string;
  cwd: string;
  model: string | null;
}

interface DesktopMessage {
  clientUserMessageId: string;
  input: JsonObject[];
  restoreMessage: JsonObject;
}

const initializingClientId = "initializing-client";
const maxFrameBytes = 256 * 1_024 * 1_024;

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function followerTurnId(result: JsonObject | undefined): string | undefined {
  const nested = objectValue(result?.result);
  const turn = objectValue(nested?.turn);
  const firstTurn = objectValue(nested?.firstTurn);
  return typeof nested?.turnId === "string"
    ? nested.turnId
    : typeof turn?.id === "string"
      ? turn.id
      : typeof firstTurn?.turnId === "string"
        ? firstTurn.turnId
        : undefined;
}

function desktopMessage(thread: DesktopThread, text: string): DesktopMessage {
  const clientUserMessageId = randomUUID();
  const input = [{ type: "text", text, text_elements: [] }];
  return {
    clientUserMessageId,
    input,
    restoreMessage: {
      id: clientUserMessageId,
      text,
      cwd: thread.cwd,
      createdAt: Date.now(),
      responsesapiClientMetadata: { source: "ai-workstation-remote" },
      context: {
        prompt: text,
        addedFiles: [],
        fileAttachments: [],
        ideContext: null,
        imageAttachments: [],
        workspaceRoots: [thread.cwd],
        turnTrigger: "user",
      },
    },
  };
}

function defaultSocketPath(): string {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "ipc", "ipc.sock");
}

export function encodeIpcFrame(message: JsonObject): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > maxFrameBytes) throw new Error("Codex Desktop IPC 消息过大");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class CodexDesktopIpcClient {
  private readonly socketPath: string;
  private socket: Socket | undefined;
  private connectPromise: Promise<void> | undefined;
  private clientId = initializingClientId;
  private readBuffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private followedThreadIds = new Set<string>();

  constructor(
    socketPath = process.env.CODEX_DESKTOP_IPC_PATH ?? defaultSocketPath(),
    private readonly onThreadState?: (snapshot: DesktopThreadStateSnapshot) => void,
  ) {
    this.socketPath = socketPath;
  }

  get connected(): boolean {
    return Boolean(this.socket?.writable && this.clientId !== initializingClientId);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.open().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  async findThreadOwner(conversationId: string): Promise<string | undefined> {
    await this.connect();
    const response = await this.request(
      "thread-owner-discovery",
      { hostId: "local", conversationId },
      1,
    );
    if (response.resultType === "error") {
      if (response.error === "no-client-found") return undefined;
      throw new Error(response.error ?? "Codex Desktop owner discovery failed");
    }
    return response.handledByClientId;
  }

  async startTurn(thread: DesktopThread, text: string): Promise<string | undefined> {
    const ownerClientId = await this.findThreadOwner(thread.id);
    if (!ownerClientId) throw new Error("Codex Desktop 未注册该会话的控制通道");

    const message = desktopMessage(thread, text);
    const response = await this.request(
      "thread-follower-start-turn",
      {
        conversationId: thread.id,
        turnStart: {
          request: {
            threadId: thread.id,
            input: message.input,
            turnTrigger: "user",
            clientUserMessageId: message.clientUserMessageId,
            cwd: thread.cwd,
            model: thread.model,
            approvalsReviewer: "user",
            responsesapiClientMetadata: { source: "ai-workstation-remote" },
          },
          context: {
            restoreMessage: message.restoreMessage,
          },
        },
      },
      2,
      { targetClientId: ownerClientId },
    );
    if (response.resultType === "error") {
      throw new Error(response.error ?? "Codex Desktop 拒绝了同会话消息");
    }
    return followerTurnId(response.result);
  }

  async steerTurn(thread: DesktopThread, text: string): Promise<string | undefined> {
    const ownerClientId = await this.findThreadOwner(thread.id);
    if (!ownerClientId) throw new Error("Codex Desktop 未注册该会话的控制通道");

    const message = desktopMessage(thread, text);
    const response = await this.request(
      "thread-follower-steer-turn",
      {
        conversationId: thread.id,
        clientUserMessageId: message.clientUserMessageId,
        input: message.input,
        attachments: [],
        restoreMessage: message.restoreMessage,
      },
      1,
      { targetClientId: ownerClientId },
    );
    if (response.resultType === "error") {
      throw new Error(response.error ?? "Codex Desktop 拒绝了当前回合纠偏消息");
    }
    return followerTurnId(response.result);
  }

  async interruptTurn(conversationId: string, expectedTurnId: string): Promise<string | undefined> {
    const ownerClientId = await this.findThreadOwner(conversationId);
    if (!ownerClientId) throw new Error("Codex Desktop 未注册该会话的控制通道");

    const response = await this.request(
      "thread-follower-interrupt-turn",
      { conversationId, mode: "user-stop", expectedTurnId },
      4,
      { targetClientId: ownerClientId },
    );
    if (response.resultType === "error") {
      throw new Error(response.error ?? "Codex Desktop 拒绝了停止请求");
    }
    return typeof response.result?.interruptedTurnId === "string"
      ? response.result.interruptedTurnId
      : undefined;
  }

  async followThreads(conversationIds: Iterable<string>): Promise<void> {
    const next = new Set(conversationIds);
    const removed = [...this.followedThreadIds].filter((conversationId) => !next.has(conversationId));
    this.followedThreadIds = next;
    await this.connect();
    for (const conversationId of removed) this.sendFollowingChanged(conversationId, false);
    // Sending `following: true` again asks the owner for a fresh snapshot. This
    // also makes request removal observable without implementing Immer patches.
    for (const conversationId of next) this.sendFollowingChanged(conversationId, true);
  }

  async resolveApproval(
    conversationId: string,
    requestId: string | number,
    method: DesktopApprovalMethod,
    decision: "approve" | "reject",
  ): Promise<void> {
    const ownerClientId = await this.findThreadOwner(conversationId);
    if (!ownerClientId) throw new Error("Codex Desktop 未注册该会话的控制通道");
    const followerMethod = method === "item/commandExecution/requestApproval"
      ? "thread-follower-command-approval-decision"
      : "thread-follower-file-approval-decision";
    const response = await this.request(
      followerMethod,
      { conversationId, requestId, decision: decision === "approve" ? "accept" : "decline" },
      1,
      { targetClientId: ownerClientId },
    );
    if (response.resultType === "error") {
      throw new Error(response.error ?? "Codex Desktop 拒绝了审批操作");
    }
  }

  close(): void {
    this.socket?.destroy();
    this.reset(new Error("Codex Desktop IPC 已关闭"));
  }

  private async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(this.socketPath);
      let settled = false;
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        if (this.socket && this.socket !== socket) this.socket.destroy();
        this.socket = socket;
        this.clientId = initializingClientId;
        this.readBuffer = Buffer.alloc(0);
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("close", () => this.reset(new Error("Codex Desktop IPC 连接中断"), socket));
        socket.on("error", () => undefined);
        void this.request("initialize", { clientType: "ai-workstation-remote" }, 0)
          .then((response) => {
            const clientId = typeof response.result?.clientId === "string" ? response.result.clientId : undefined;
            if (response.resultType !== "success" || !clientId) {
              throw new Error(response.error ?? "Codex Desktop IPC 初始化失败");
            }
            this.clientId = clientId;
            settled = true;
            socket.off("error", fail);
            resolve();
          })
          .catch((error: unknown) => {
            socket.destroy();
            fail(error instanceof Error ? error : new Error(String(error)));
          });
      });
    });
  }

  private request(
    method: string,
    params: JsonObject,
    version: number,
    options: { targetClientId?: string; timeoutMs?: number } = {},
  ): Promise<IpcResponse> {
    const socket = this.socket;
    if (!socket?.writable) return Promise.reject(new Error("Codex Desktop IPC 未连接"));
    if (this.clientId === initializingClientId && method !== "initialize") {
      return Promise.reject(new Error("Codex Desktop IPC 尚未初始化"));
    }
    const requestId = randomUUID();
    const timeoutMs = options.timeoutMs ?? 10_000;
    const message: JsonObject = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params,
      timeoutMs,
      ...(options.targetClientId ? { targetClientId: options.targetClientId } : {}),
    };
    return new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.write(encodeIpcFrame(message), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    while (this.readBuffer.length >= 4) {
      const frameLength = this.readBuffer.readUInt32LE(0);
      if (frameLength > maxFrameBytes) {
        this.socket?.destroy(new Error("Codex Desktop IPC 帧过大"));
        return;
      }
      if (this.readBuffer.length < frameLength + 4) return;
      const body = this.readBuffer.subarray(4, frameLength + 4);
      this.readBuffer = this.readBuffer.subarray(frameLength + 4);
      let message: JsonObject;
      try {
        message = JSON.parse(body.toString("utf8")) as JsonObject;
      } catch {
        this.socket?.destroy(new Error("Codex Desktop IPC 返回了无效 JSON"));
        return;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: JsonObject): void {
    if (message.type === "client-discovery-request" && typeof message.requestId === "string") {
      this.socket?.write(encodeIpcFrame({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false },
      }));
      return;
    }
    if (message.type === "broadcast" && message.method === "thread-stream-following-status-requested") {
      const params = objectValue(message.params);
      const conversationId = typeof params?.conversationId === "string" ? params.conversationId : undefined;
      if (conversationId && this.followedThreadIds.has(conversationId)) {
        this.sendFollowingChanged(
          conversationId,
          true,
          typeof message.sourceClientId === "string" ? [message.sourceClientId] : undefined,
        );
      }
      return;
    }
    if (message.type === "broadcast" && message.method === "thread-stream-state-changed") {
      const params = objectValue(message.params);
      const change = objectValue(params?.change);
      const conversationId = typeof params?.conversationId === "string" ? params.conversationId : undefined;
      if (!conversationId || !this.followedThreadIds.has(conversationId)) return;
      if (change?.type === "patches") {
        this.sendFollowingChanged(conversationId, true);
        return;
      }
      const conversationState = objectValue(change?.conversationState);
      if (change?.type === "snapshot" && conversationState) {
        this.onThreadState?.({
          conversationId,
          conversationState,
          ...(typeof message.sourceClientId === "string" ? { ownerClientId: message.sourceClientId } : {}),
        });
      }
      return;
    }
    if (message.type !== "response" || typeof message.requestId !== "string") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.resolve(message as unknown as IpcResponse);
  }

  private sendFollowingChanged(conversationId: string, following: boolean, targetClientIds?: string[]): void {
    const socket = this.socket;
    if (!socket?.writable || this.clientId === initializingClientId) return;
    socket.write(encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: this.clientId,
      version: 1,
      params: { conversationId, hostId: "local", following },
      ...(targetClientIds ? { targetClientIds } : {}),
    }));
  }

  private reset(error: Error, socket = this.socket): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.clientId = initializingClientId;
    this.readBuffer = Buffer.alloc(0);
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}
