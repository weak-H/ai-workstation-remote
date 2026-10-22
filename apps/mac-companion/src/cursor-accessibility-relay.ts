import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, extname, join, normalize, resolve } from "node:path";

import { z } from "zod";

const protocolVersion = 1;
const defaultTimeoutMs = 4_000;
const maxResponseBytes = 64 * 1024;

const DiscoverySchema = z.object({
  protocolVersion: z.literal(protocolVersion),
  pid: z.number().int().positive(),
  socketPath: z.string().min(1),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  appName: z.string().min(1),
  workspaceName: z.string(),
  workspaceFolders: z.array(z.string()),
  createdAt: z.number().nonnegative(),
});

const RelayResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }),
  z.object({ status: z.literal("focused"), composerId: z.string().min(1) }),
  z.object({ status: z.literal("created") }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

type Discovery = z.infer<typeof DiscoverySchema>;

export interface CursorDesktopInput {
  status(): Promise<"trusted" | "permission_required" | "unavailable">;
  ensureTrusted(): Promise<void>;
  activate(workspaceName: string): Promise<void>;
  openIDE(workspaceName: string): Promise<void>;
  submit(text: string): Promise<void>;
}

interface CursorAccessibilityRelayOptions {
  discoveryDirectory?: string;
  extensionDirectory?: string;
  timeoutMs?: number;
  input?: CursorDesktopInput;
}

export type CursorAccessibilityRelayAvailability =
  | { available: true; accessibilityTrusted: boolean; relayRunning: boolean }
  | { available: false; reason: "extension_unavailable" | "input_unavailable" };

interface HelperResult {
  code: number;
  stdout: string;
  stderr: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultInputHelper(name: string): string {
  const candidates = [
    resolve(process.cwd(), ".tools/bin", name),
    resolve(process.cwd(), "../..", ".tools/bin", name),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function runHelper(path: string, args: readonly string[], input = "", timeoutMs = 5_000): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const powershellScript = process.platform === "win32" && extname(path).toLowerCase() === ".ps1";
    const child = spawn(
      powershellScript ? "powershell.exe" : path,
      powershellScript
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, ...args]
        : [...args],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) reject(new Error("Cursor 输入辅助程序响应超时"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
    child.stdin.end(input);
  });
}

export class MacOSCursorInput implements CursorDesktopInput {
  private readonly helperPath: string;

  constructor(helperPath = process.env.CURSOR_INPUT_HELPER
    ?? defaultInputHelper("cursor-input-helper")) {
    this.helperPath = helperPath;
  }

  async status(): Promise<"trusted" | "permission_required" | "unavailable"> {
    if (process.platform !== "darwin") return "unavailable";
    try {
      await access(this.helperPath);
      const result = await runHelper(this.helperPath, ["trust"]);
      return result.code === 0 ? "trusted" : "permission_required";
    } catch {
      return "unavailable";
    }
  }

  async ensureTrusted(): Promise<void> {
    const result = await runHelper(this.helperPath, ["trust", "--prompt"]);
    if (result.code !== 0) {
      throw new Error("需要在 macOS“隐私与安全性 → 辅助功能”中允许 cursor-input-helper，然后重新发送");
    }
  }

  async activate(workspaceName: string): Promise<void> {
    const result = await runHelper(this.helperPath, ["activate", workspaceName]);
    if (result.code !== 0) throw new Error(result.stderr || "无法激活 Cursor 窗口");
  }

  async openIDE(workspacePath: string): Promise<void> {
    const result = await runHelper(this.helperPath, ["open-ide", workspacePath ? basename(workspacePath) : ""]);
    if (result.code !== 0) throw new Error(result.stderr || "无法打开 Cursor IDE 窗口");
  }

  async submit(text: string): Promise<void> {
    const result = await runHelper(this.helperPath, ["submit"], text, 10_000);
    if (result.code !== 0) throw new Error(result.stderr || "无法向 Cursor 输入指令");
  }
}

export class WindowsCursorInput implements CursorDesktopInput {
  private readonly helperPath: string;

  constructor(helperPath = process.env.CURSOR_INPUT_HELPER
    ?? defaultInputHelper("cursor-input-helper.ps1")) {
    this.helperPath = helperPath;
  }

  async status(): Promise<"trusted" | "permission_required" | "unavailable"> {
    if (process.platform !== "win32") return "unavailable";
    try {
      await access(this.helperPath);
      const result = await runHelper(this.helperPath, ["status"]);
      return result.code === 0 ? "trusted" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async ensureTrusted(): Promise<void> {
    const result = await runHelper(this.helperPath, ["status"]);
    if (result.code !== 0) throw new Error(result.stderr || "Windows Cursor 输入辅助程序不可用");
  }

  async activate(workspaceName: string): Promise<void> {
    const result = await runHelper(this.helperPath, ["activate", workspaceName]);
    if (result.code !== 0) throw new Error(result.stderr || "无法激活 Cursor 窗口");
  }

  async openIDE(workspacePath: string): Promise<void> {
    const result = await runHelper(this.helperPath, ["open-ide", workspacePath]);
    if (result.code !== 0) throw new Error(result.stderr || "无法打开 Cursor IDE 窗口");
  }

  async submit(text: string): Promise<void> {
    const result = await runHelper(this.helperPath, ["submit"], text, 10_000);
    if (result.code !== 0) throw new Error(result.stderr || "无法向 Cursor 输入指令");
  }
}

function platformCursorInput(): CursorDesktopInput {
  return process.platform === "win32" ? new WindowsCursorInput() : new MacOSCursorInput();
}

export class CursorAccessibilityRelayClient {
  private readonly discoveryDirectory: string;
  private readonly extensionDirectory: string;
  private readonly timeoutMs: number;
  private readonly input: CursorDesktopInput;

  constructor(options: CursorAccessibilityRelayOptions = {}) {
    this.discoveryDirectory = options.discoveryDirectory
      ?? process.env.CURSOR_RELAY_DIR
      ?? join(homedir(), ".cursor", "ai-workstation-remote");
    this.extensionDirectory = options.extensionDirectory ?? join(homedir(), ".cursor", "extensions");
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.input = options.input ?? platformCursorInput();
  }

  async availability(workspacePath?: string): Promise<CursorAccessibilityRelayAvailability> {
    const instances = await this.readyInstances(workspacePath);
    const inputStatus = await this.input.status();
    if (inputStatus === "unavailable") return { available: false, reason: "input_unavailable" };
    if (instances.length > 0) {
      return { available: true, accessibilityTrusted: inputStatus === "trusted", relayRunning: true };
    }
    if (!await this.extensionInstalled()) return { available: false, reason: "extension_unavailable" };
    return { available: true, accessibilityTrusted: inputStatus === "trusted", relayRunning: false };
  }

  async sendMessage(composerId: string, text: string, workspacePath?: string): Promise<void> {
    await this.input.ensureTrusted();
    let [instance] = await this.readyInstances(workspacePath);
    if (!instance) {
      await this.input.openIDE(workspacePath ?? "");
      const deadline = Date.now() + 30_000;
      while (!instance && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        [instance] = await this.readyInstances(workspacePath);
      }
    }
    if (!instance) throw new Error("Cursor IDE 窗口已请求打开，但中继扩展未能启动");
    await this.focus(instance, composerId);
    await this.input.activate(instance.workspaceName || (workspacePath ? basename(workspacePath) : ""));
    await new Promise((resolve) => setTimeout(resolve, 120));
    await this.focus(instance, composerId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await this.input.submit(text);
  }

  async createMessage(text: string, workspacePath?: string): Promise<void> {
    await this.input.ensureTrusted();
    let [instance] = await this.readyInstances(workspacePath);
    if (!instance) {
      await this.input.openIDE(workspacePath ?? "");
      const deadline = Date.now() + 30_000;
      while (!instance && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        [instance] = await this.readyInstances(workspacePath);
      }
    }
    if (!instance) throw new Error("Cursor IDE 窗口已请求打开，但中继扩展未能启动");
    const created = await this.request(instance, { type: "create" });
    if (created.status === "error") throw new Error(`Cursor 中继扩展无法新建会话：${created.message}`);
    if (created.status !== "created") throw new Error("Cursor 中继扩展未确认新会话");
    await this.input.activate(instance.workspaceName || (workspacePath ? basename(workspacePath) : ""));
    await new Promise((resolve) => setTimeout(resolve, 180));
    await this.input.submit(text);
  }

  private async extensionInstalled(): Promise<boolean> {
    try {
      const entries = await readdir(this.extensionDirectory, { withFileTypes: true });
      return entries.some((entry) => entry.isDirectory()
        && entry.name.startsWith("ai-workstation.ai-workstation-cursor-relay-"));
    } catch {
      return false;
    }
  }

  private async readyInstances(workspacePath?: string): Promise<Discovery[]> {
    const instances = await this.instances();
    const ordered = [...instances].sort((left, right) => (
      this.workspaceScore(right, workspacePath) - this.workspaceScore(left, workspacePath)
        || right.createdAt - left.createdAt
    ));
    const ready: Discovery[] = [];
    for (const instance of ordered) {
      try {
        const response = await this.request(instance, { type: "ping" });
        if (response.status === "ready") ready.push(instance);
      } catch {
        // Stale discovery entries are ignored and cleaned up by Cursor on exit.
      }
    }
    return ready;
  }

  private workspaceScore(instance: Discovery, workspacePath?: string): number {
    if (!workspacePath) return 0;
    const wanted = normalize(workspacePath);
    if (instance.workspaceFolders.some((folder) => normalize(folder) === wanted)) return 2;
    if (instance.workspaceName === basename(wanted)) return 1;
    return 0;
  }

  private async instances(): Promise<Discovery[]> {
    let entries;
    try {
      entries = await readdir(this.discoveryDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const instances = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("relay-") && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const path = join(this.discoveryDirectory, entry.name);
        try {
          const metadata = await stat(path);
          if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) return undefined;
          if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) return undefined;
          const parsed = DiscoverySchema.safeParse(JSON.parse(await readFile(path, "utf8")));
          if (!parsed.success || !processIsAlive(parsed.data.pid)) return undefined;
          return parsed.data;
        } catch {
          return undefined;
        }
      }));
    return instances.filter((instance): instance is Discovery => instance !== undefined);
  }

  private async focus(instance: Discovery, composerId: string): Promise<void> {
    const response = await this.request(instance, { type: "focus", composerId });
    if (response.status === "error") throw new Error(`Cursor 中继扩展无法聚焦会话：${response.message}`);
    if (response.status !== "focused" || response.composerId !== composerId) {
      throw new Error("Cursor 中继扩展返回了不匹配的会话");
    }
  }

  private request(instance: Discovery, payload: object): Promise<z.infer<typeof RelayResponseSchema>> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(instance.socketPath);
      const chunks: Buffer[] = [];
      let bytes = 0;
      const timer = setTimeout(() => socket.destroy(new Error("Cursor 中继扩展响应超时")), this.timeoutMs);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ protocolVersion, token: instance.token, ...payload })}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxResponseBytes) {
          socket.destroy(new Error("Cursor 中继扩展返回内容过大"));
          return;
        }
        chunks.push(chunk);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("end", () => {
        clearTimeout(timer);
        try {
          const parsed = RelayResponseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
