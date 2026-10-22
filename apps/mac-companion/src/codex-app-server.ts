import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type JsonObject = Record<string, unknown>;
export type JsonRpcId = string | number;

export interface ServerRequestMessage {
  id: JsonRpcId;
  method: string;
  params: JsonObject;
}

export interface ServerNotificationMessage {
  method: string;
  params: JsonObject;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export interface CodexAppServerOptions {
  codexBin?: string;
  requestTimeoutMs?: number;
  onNotification?: (message: ServerNotificationMessage) => void;
  onServerRequest?: (message: ServerRequestMessage) => void;
  onExit?: (error: Error) => void;
}

const bundledCodexCandidates = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "ChatGPT", "resources", "codex.exe") : undefined,
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "ChatGPT", "resources", "codex-cli", "codex.exe") : undefined,
].filter((candidate): candidate is string => Boolean(candidate));

export function resolveCodexBin(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  for (const candidate of bundledCodexCandidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking before falling back to PATH.
    }
  }
  return "codex";
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private stopping = false;
  private stderrTail: string[] = [];

  constructor(private readonly options: CodexAppServerOptions = {}) {}

  async start(): Promise<void> {
    if (this.process) return;
    this.stopping = false;
    const child = spawn(resolveCodexBin(this.options.codexBin), ["app-server", "--listen", "stdio://"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
    });
    this.process = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split("\n").filter(Boolean);
      this.stderrTail.push(...lines);
      if (this.stderrTail.length > 30) this.stderrTail = this.stderrTail.slice(-30);
    });
    child.on("error", (error) => this.handleExit(child, error));
    child.on("exit", (code, signal) => {
      const suffix = this.stderrTail.at(-1);
      this.handleExit(child, new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})${suffix ? `: ${suffix}` : ""}`));
    });

    await this.request("initialize", {
      clientInfo: {
        name: "ai-workstation-remote",
        title: "AI Workstation Remote",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.process;
    this.process = undefined;
    if (!child) return;
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 2_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
    child.stdin.end();
    child.kill("SIGTERM");
    this.rejectPending(new Error("Codex app-server stopped"));
    if (await exited) return;
    child.kill("SIGKILL");
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async request<T = unknown>(method: string, params?: JsonObject): Promise<T> {
    const child = this.process;
    if (!child || child.stdin.destroyed) throw new Error("Codex app-server is not connected");
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;

    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ id, method, params: params ?? {} });
    return await response as T;
  }

  notify(method: string, params?: JsonObject): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: JsonRpcId, result: JsonObject): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(payload: JsonObject): void {
    const child = this.process;
    if (!child || child.stdin.destroyed) throw new Error("Codex app-server is not connected");
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const message = asObject(value);
    if (!message) return;

    const method = typeof message.method === "string" ? message.method : undefined;
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
    if (method && id !== undefined) {
      this.options.onServerRequest?.({ id, method, params: asObject(message.params) ?? {} });
      return;
    }
    if (method) {
      this.options.onNotification?.({ method, params: asObject(message.params) ?? {} });
      return;
    }
    if (id === undefined) return;

    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    const error = asObject(message.error);
    if (error) {
      pending.reject(new CodexRpcError(
        typeof error.code === "number" ? error.code : -32_603,
        typeof error.message === "string" ? error.message : "Unknown Codex error",
        error.data,
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    this.process = undefined;
    this.rejectPending(error);
    if (!this.stopping) this.options.onExit?.(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
