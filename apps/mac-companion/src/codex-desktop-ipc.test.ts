import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";

import { CodexDesktopIpcClient, encodeIpcFrame } from "./codex-desktop-ipc.js";

test("encodes Desktop IPC messages with a little-endian length prefix", () => {
  const frame = encodeIpcFrame({ type: "request", method: "initialize" });
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.deepEqual(JSON.parse(frame.subarray(4).toString("utf8")), {
    type: "request",
    method: "initialize",
  });
});

test("routes commands, approvals, and thread state through the existing Desktop owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-workstation-ipc-"));
  const socketPath = join(directory, "ipc.sock");
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        requests.push(message);
        if (message.method === "initialize") {
          socket.write(encodeIpcFrame({
            type: "response",
            requestId: String(message.requestId),
            resultType: "success",
            method: "initialize",
            handledByClientId: "remote-client",
            result: { clientId: "remote-client" },
          }));
        } else if (message.method === "thread-owner-discovery") {
          socket.write(encodeIpcFrame({
            type: "response",
            requestId: String(message.requestId),
            resultType: "success",
            method: "thread-owner-discovery",
            handledByClientId: "desktop-owner",
            result: { supportsUntrustedAppInput: true },
          }));
        } else if (message.method === "thread-follower-start-turn") {
          socket.write(encodeIpcFrame({
            type: "response",
            requestId: String(message.requestId),
            resultType: "success",
            method: "thread-follower-start-turn",
            handledByClientId: "desktop-owner",
            result: { result: { turn: { id: "turn-1" } } },
          }));
        } else if (message.method === "thread-follower-steer-turn") {
          socket.write(encodeIpcFrame({
            type: "response",
            requestId: String(message.requestId),
            resultType: "success",
            method: "thread-follower-steer-turn",
            handledByClientId: "desktop-owner",
            result: { result: { turnId: "turn-1" } },
          }));
        } else if (message.method === "thread-follower-interrupt-turn") {
          socket.write(encodeIpcFrame({
            type: "response",
            requestId: String(message.requestId),
            resultType: "success",
            method: "thread-follower-interrupt-turn",
            handledByClientId: "desktop-owner",
            result: { ok: true, interruptedTurnId: "turn-1" },
          }));
        } else if (message.method === "thread-stream-following-changed") {
          socket.write(encodeIpcFrame({
            type: "broadcast",
            method: "thread-stream-state-changed",
            sourceClientId: "desktop-owner",
            version: 11,
            params: {
              conversationId: "thread-1",
              hostId: "local",
              change: {
                type: "snapshot",
                revision: 7,
                conversationState: { requests: [{ id: 41, method: "item/commandExecution/requestApproval" }] },
              },
            },
          }));
        } else if (message.method === "thread-follower-command-approval-decision") {
          socket.write(encodeIpcFrame({
            type: "response",
            requestId: String(message.requestId),
            resultType: "success",
            method: "thread-follower-command-approval-decision",
            handledByClientId: "desktop-owner",
            result: { ok: true },
          }));
        }
      }
    });
  });

  server.listen(socketPath);
  await once(server, "listening");
  let resolveSnapshot: ((value: { conversationId: string; ownerClientId?: string }) => void) | undefined;
  const snapshot = new Promise<{ conversationId: string; ownerClientId?: string }>((resolve) => {
    resolveSnapshot = resolve;
  });
  const client = new CodexDesktopIpcClient(socketPath, (value) => resolveSnapshot?.({
    conversationId: value.conversationId,
    ...(value.ownerClientId ? { ownerClientId: value.ownerClientId } : {}),
  }));
  try {
    const thread = {
      id: "thread-1",
      cwd: "/Users/hu/data/github/example",
      model: "gpt-5",
    };
    assert.equal(await client.startTurn(thread, "继续完成当前任务"), "turn-1");
    assert.equal(await client.steerTurn(thread, "先修复状态问题"), "turn-1");
    assert.equal(await client.interruptTurn(thread.id, "turn-1"), "turn-1");
    await client.followThreads([thread.id]);
    assert.deepEqual(await snapshot, { conversationId: "thread-1", ownerClientId: "desktop-owner" });
    await client.resolveApproval(thread.id, 41, "item/commandExecution/requestApproval", "approve");

    const discovery = requests.find((request) => request.method === "thread-owner-discovery");
    assert.equal(discovery?.version, 1);
    assert.deepEqual(discovery?.params, { hostId: "local", conversationId: "thread-1" });

    const start = requests.find((request) => request.method === "thread-follower-start-turn");
    assert.equal(start?.version, 2);
    assert.equal(start?.targetClientId, "desktop-owner");
    const params = start?.params as Record<string, unknown>;
    const turnStart = params.turnStart as Record<string, unknown>;
    const request = turnStart.request as Record<string, unknown>;
    const context = turnStart.context as Record<string, unknown>;
    assert.equal(request.threadId, "thread-1");
    assert.deepEqual(request.input, [{ type: "text", text: "继续完成当前任务", text_elements: [] }]);
    assert.equal("useUserMessageAdmission" in context, false);

    const steer = requests.find((request) => request.method === "thread-follower-steer-turn");
    assert.equal(steer?.version, 1);
    assert.equal(steer?.targetClientId, "desktop-owner");
    const steerParams = steer?.params as Record<string, unknown>;
    assert.equal(steerParams.conversationId, "thread-1");
    assert.deepEqual(steerParams.input, [{ type: "text", text: "先修复状态问题", text_elements: [] }]);

    const interrupt = requests.find((request) => request.method === "thread-follower-interrupt-turn");
    assert.equal(interrupt?.version, 4);
    assert.equal(interrupt?.targetClientId, "desktop-owner");
    assert.deepEqual(interrupt?.params, {
      conversationId: "thread-1",
      mode: "user-stop",
      expectedTurnId: "turn-1",
    });

    const following = requests.find((request) => request.method === "thread-stream-following-changed");
    assert.equal(following?.type, "broadcast");
    assert.equal(following?.version, 1);
    assert.deepEqual(following?.params, {
      conversationId: "thread-1",
      hostId: "local",
      following: true,
    });

    const approval = requests.find((request) => request.method === "thread-follower-command-approval-decision");
    assert.equal(approval?.version, 1);
    assert.equal(approval?.targetClientId, "desktop-owner");
    assert.deepEqual(approval?.params, {
      conversationId: "thread-1",
      requestId: 41,
      decision: "accept",
    });
  } finally {
    client.close();
    server.close();
    await once(server, "close");
    await rm(directory, { recursive: true, force: true });
  }
});
