import { readFile, readdir, stat } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const protocolVersion = 1;
const requestTimeoutMs = 10_000;
const maxResponseBytes = 512 * 1_024;

const DiscoverySchema = z.object({
  protocolVersion: z.literal(protocolVersion),
  pid: z.number().int().positive(),
  socketPath: z.string().min(1),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  appName: z.string().min(1),
  appVersion: z.string().min(1),
  userDataDir: z.string().min(1),
  createdAt: z.number().nonnegative(),
});

const ThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  source: z.enum(["local", "cloud", "draft", "claude-code"]),
  status: z.enum(["idle", "running", "completed", "error", "unknown"]),
  lastUpdatedAt: z.number(),
  windowId: z.number().int(),
});

const ListResponseSchema = z.object({ threads: z.array(ThreadSchema) });

const SendResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["submitted", "queued"]),
    threadId: z.string().min(1),
    windowId: z.number().int(),
    threadTitle: z.string(),
  }),
  z.object({ status: z.literal("unknown-thread") }),
  z.object({ status: z.literal("timeout") }),
  z.object({ status: z.literal("not-sendable"), reason: z.string() }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

type Discovery = z.infer<typeof DiscoverySchema>;
export type CursorDesktopThread = z.infer<typeof ThreadSchema>;
export type CursorDesktopSendResult = z.infer<typeof SendResponseSchema>;

interface CursorDesktopBridgeOptions {
  discoveryDirectory?: string;
  timeoutMs?: number;
}

interface BridgeInstance {
  discovery: Discovery;
  label: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class CursorDesktopBridgeClient {
  private readonly discoveryDirectory: string;
  private readonly timeoutMs: number;

  constructor(options: CursorDesktopBridgeOptions = {}) {
    this.discoveryDirectory = options.discoveryDirectory
      ?? process.env.CURSOR_DESKTOP_BRIDGE_DIR
      ?? join(homedir(), ".cursor", "desktop-bridge");
    this.timeoutMs = options.timeoutMs ?? requestTimeoutMs;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.instances()).length > 0;
  }

  async listThreads(): Promise<CursorDesktopThread[]> {
    const instances = await this.instances();
    const results = await Promise.allSettled(instances.map(async (instance) => {
      const body = await this.post(instance, { type: "listThreads" });
      return ListResponseSchema.parse(body).threads;
    }));
    const threads = new Map<string, CursorDesktopThread>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const thread of result.value) {
        const current = threads.get(thread.id);
        if (!current || thread.lastUpdatedAt > current.lastUpdatedAt) threads.set(thread.id, thread);
      }
    }
    return [...threads.values()].sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt);
  }

  async sendMessage(threadId: string, text: string, force = false): Promise<CursorDesktopSendResult> {
    const instances = await this.instances();
    if (instances.length === 0) throw new Error("Cursor Desktop 本机控制通道未启用");
    let fallback: CursorDesktopSendResult | undefined;
    let lastError: unknown;
    for (const instance of instances) {
      try {
        const body = await this.post(instance, { type: "sendMessage", threadId, text, force });
        const result = SendResponseSchema.parse(body);
        if (result.status === "submitted" || result.status === "queued" || result.status === "timeout") return result;
        if (result.status !== "unknown-thread") fallback = result;
      } catch (error) {
        lastError = error;
      }
    }
    if (fallback) return fallback;
    if (lastError) throw lastError;
    return { status: "unknown-thread" };
  }

  private async instances(): Promise<BridgeInstance[]> {
    let entries;
    try {
      entries = await readdir(this.discoveryDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const instances = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
      const path = join(this.discoveryDirectory, entry.name);
      try {
        const metadata = await stat(path);
        if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) return undefined;
        if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) return undefined;
        const parsed = DiscoverySchema.safeParse(JSON.parse(await readFile(path, "utf8")));
        if (!parsed.success || !processIsAlive(parsed.data.pid)) return undefined;
        return { discovery: parsed.data, label: `${parsed.data.appName} ${parsed.data.appVersion}` };
      } catch {
        return undefined;
      }
    }));
    return instances.filter((instance): instance is BridgeInstance => instance !== undefined);
  }

  private post(instance: BridgeInstance, payload: object): Promise<unknown> {
    const body = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const outgoing = request({
        socketPath: instance.discovery.socketPath,
        path: "/",
        method: "POST",
        headers: {
          authorization: `Bearer ${instance.discovery.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes <= maxResponseBytes) chunks.push(buffer);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          if (bytes > maxResponseBytes) {
            reject(new Error(`${instance.label} Desktop Bridge 返回内容过大`));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new Error(`${instance.label} Desktop Bridge 返回了无效 JSON`));
            return;
          }
          if ((incoming.statusCode ?? 500) !== 200) {
            reject(new Error(`${instance.label} Desktop Bridge 返回 HTTP ${incoming.statusCode ?? 500}`));
            return;
          }
          resolve(parsed);
        });
      });
      outgoing.setTimeout(this.timeoutMs, () => outgoing.destroy(new Error(`${instance.label} Desktop Bridge 请求超时`)));
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }
}
