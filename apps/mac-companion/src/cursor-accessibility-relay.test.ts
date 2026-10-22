import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CursorAccessibilityRelayClient,
  type CursorDesktopInput,
} from "./cursor-accessibility-relay.js";

class FakeInput implements CursorDesktopInput {
  readonly calls: string[] = [];

  async status(): Promise<"trusted"> {
    return "trusted";
  }

  async ensureTrusted(): Promise<void> {
    this.calls.push("trusted");
  }

  async activate(workspaceName: string): Promise<void> {
    this.calls.push(`activate:${workspaceName}`);
  }

  async openIDE(workspaceName: string): Promise<void> {
    this.calls.push(`open-ide:${workspaceName}`);
  }

  async submit(text: string): Promise<void> {
    this.calls.push(`submit:${text}`);
  }
}

test("focuses the exact Cursor composer before accessibility submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-relay-"));
  const socketPath = join(directory, "relay.sock");
  const token = "b".repeat(64);
  const requests: Array<{ type?: string; composerId?: string }> = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      if (!body.includes("\n")) return;
      const request = JSON.parse(body) as { token?: string; type?: string; composerId?: string };
      assert.equal(request.token, token);
      requests.push(request);
      socket.end(`${JSON.stringify(request.type === "ping"
        ? { status: "ready" }
        : request.type === "create"
          ? { status: "created" }
          : { status: "focused", composerId: request.composerId })}\n`);
    });
  });
  const input = new FakeInput();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const discoveryPath = join(directory, "relay-current.json");
    await writeFile(discoveryPath, JSON.stringify({
      protocolVersion: 1,
      pid: process.pid,
      socketPath,
      token,
      appName: "Cursor",
      workspaceName: "ai-workstation-remote",
      workspaceFolders: ["/Users/hu/data/github/ai-workstation-remote"],
      createdAt: Date.now(),
    }), { mode: 0o600 });
    await chmod(discoveryPath, 0o600);

    const client = new CursorAccessibilityRelayClient({ discoveryDirectory: directory, input, timeoutMs: 1_000 });
    assert.deepEqual(await client.availability("/Users/hu/data/github/ai-workstation-remote"), {
      available: true,
      accessibilityTrusted: true,
      relayRunning: true,
    });
    await client.sendMessage("composer-1", "继续修复", "/Users/hu/data/github/ai-workstation-remote");
    await client.createMessage("创建测试", "/Users/hu/data/github/ai-workstation-remote");

    assert.deepEqual(requests.map(({ type, composerId }) => ({ type, composerId })), [
      { type: "ping", composerId: undefined },
      { type: "ping", composerId: undefined },
      { type: "focus", composerId: "composer-1" },
      { type: "focus", composerId: "composer-1" },
      { type: "ping", composerId: undefined },
      { type: "create", composerId: undefined },
    ]);
    assert.deepEqual(input.calls, [
      "trusted",
      "activate:ai-workstation-remote",
      "submit:继续修复",
      "trusted",
      "activate:ai-workstation-remote",
      "submit:创建测试",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports an unavailable relay when Cursor has not loaded the extension", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-relay-empty-"));
  try {
    const client = new CursorAccessibilityRelayClient({
      discoveryDirectory: directory,
      extensionDirectory: directory,
      input: new FakeInput(),
      timeoutMs: 200,
    });
    assert.deepEqual(await client.availability(), { available: false, reason: "extension_unavailable" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps messaging available when the installed extension needs an IDE window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-relay-installed-"));
  const extensionDirectory = join(directory, "extensions");
  try {
    await mkdir(join(extensionDirectory, "ai-workstation.ai-workstation-cursor-relay-0.1.0"), { recursive: true });
    const client = new CursorAccessibilityRelayClient({
      discoveryDirectory: join(directory, "relay"),
      extensionDirectory,
      input: new FakeInput(),
      timeoutMs: 200,
    });
    assert.deepEqual(await client.availability(), {
      available: true,
      accessibilityTrusted: true,
      relayRunning: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
