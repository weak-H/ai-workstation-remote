import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

const token = "control-plane-test-token";
const deviceId = "test_workstation";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function startRelay(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [resolve("../../node_modules/tsx/dist/cli.mjs"), "src/index.ts"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      CONTROL_HOST: "127.0.0.1",
      CONTROL_PORT: String(port),
      PAIRING_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  await new Promise<void>((resolveReady, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout?.off("data", onData);
    };
    const fail = (error: Error) => {
      cleanup();
      child.kill();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null) => fail(new Error(`relay exited with ${code ?? "unknown"}`));
    const onData = (chunk: Buffer) => {
      if (!String(chunk).includes("[relay] listening")) return;
      cleanup();
      resolveReady();
    };
    const timeout = setTimeout(() => {
      const detail = stderr.trim();
      fail(new Error(`relay did not start${detail ? `: ${detail}` : ""}`));
    }, 15_000);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout?.on("data", onData);
  });
  return child;
}

async function openSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return socket;
}

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    socket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)) as Record<string, unknown>));
    socket.once("error", reject);
  });
}

test("a mobile connection receives one authoritative snapshot without replaying folded events", async () => {
  const port = await availablePort();
  const relay = await startRelay(port);
  let host: WebSocket | undefined;
  let mobile: WebSocket | undefined;

  try {
    host = await openSocket(port);
    host.send(JSON.stringify({
      type: "host.hello",
      deviceId,
      deviceName: "Test workstation",
      token,
      capabilities: ["history"],
      projects: [],
      activeSources: ["codex"],
    }));

    const emittedAt = "2026-10-22T02:00:00.000Z";
    host.send(JSON.stringify({
      type: "host.event",
      event: {
        type: "task.upsert",
        protocolVersion: 1,
        eventId: "event_1",
        deviceId,
        taskId: "task_1",
        runId: "turn_1",
        sequence: 1,
        emittedAt,
        task: {
          id: "task_1",
          deviceId,
          projectId: "project_1",
          projectName: "Project",
          runId: "turn_1",
          agentId: "codex",
          agentName: "Codex",
          title: "Active task",
          state: "running",
          summary: "Working",
          controlState: "available",
          capabilities: ["history"],
          artifacts: [],
          historyState: "not_loaded",
          history: [],
          turnTimings: [],
          updatedAt: emittedAt,
        },
      },
    }));
    assert.equal((await nextMessage(host)).type, "server.ack");

    mobile = await openSocket(port);
    const received: Array<Record<string, unknown>> = [];
    mobile.on("message", (raw) => received.push(JSON.parse(String(raw)) as Record<string, unknown>));
    mobile.send(JSON.stringify({ type: "mobile.hello", deviceId, token, afterSequence: 0 }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));

    assert.equal(received.length, 1);
    assert.equal(received[0]?.type, "server.snapshot");
    assert.equal(received[0]?.lastSequence, 1);
    assert.equal((received[0]?.tasks as Array<{ id: string }>)[0]?.id, "task_1");
  } finally {
    host?.close();
    mobile?.close();
    relay.kill("SIGTERM");
  }
});
