import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CursorDesktopBridgeClient } from "./cursor-desktop-bridge.js";

test("discovers Cursor Desktop and sends to the existing thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-bridge-"));
  const socketPath = join(directory, "bridge.sock");
  const token = "a".repeat(64);
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      response.setHeader("content-type", "application/json");
      if (body.type === "listThreads") {
        response.end(JSON.stringify({
          threads: [{
            id: "thread-1",
            title: "Desktop thread",
            source: "local",
            status: "idle",
            lastUpdatedAt: 123,
            windowId: 7,
          }],
        }));
      } else {
        response.end(JSON.stringify({
          status: "submitted",
          threadId: body.threadId,
          windowId: 7,
          threadTitle: "Desktop thread",
        }));
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const discoveryPath = join(directory, "cursor.json");
    await writeFile(discoveryPath, JSON.stringify({
      protocolVersion: 1,
      pid: process.pid,
      socketPath,
      token,
      appName: "Cursor",
      appVersion: "test",
      userDataDir: directory,
      createdAt: Date.now(),
    }), { mode: 0o600 });
    await chmod(discoveryPath, 0o600);

    const client = new CursorDesktopBridgeClient({ discoveryDirectory: directory });
    assert.equal(await client.isAvailable(), true);
    assert.deepEqual((await client.listThreads()).map((thread) => thread.id), ["thread-1"]);
    assert.deepEqual(await client.sendMessage("thread-1", "continue"), {
      status: "submitted",
      threadId: "thread-1",
      windowId: 7,
      threadTitle: "Desktop thread",
    });
    assert.deepEqual(requests, [
      { type: "listThreads" },
      { type: "sendMessage", threadId: "thread-1", text: "continue", force: false },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports unavailable when Cursor Desktop has not published a bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-bridge-empty-"));
  try {
    const client = new CursorDesktopBridgeClient({ discoveryDirectory: directory });
    assert.equal(await client.isAvailable(), false);
    await assert.rejects(client.sendMessage("thread-1", "continue"), /本机控制通道未启用/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
