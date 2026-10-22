import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative as relativePath, resolve } from "node:path";

import {
  applyEventToTasks,
  ClientMessageSchema,
  isCommandExpired,
  type ServerMessage,
  type AgentSource,
  type Task,
  type WorkstationProject,
  type WorkstationEvent,
} from "@ai-workstation/protocol";
import { WebSocket, WebSocketServer } from "ws";

import { acceptsPairingToken, localPairingToken } from "./pairing";

const host = process.env.CONTROL_HOST ?? "127.0.0.1";
const port = Number(process.env.CONTROL_PORT ?? "8787");
const pairingToken = process.env.PAIRING_TOKEN ?? localPairingToken;
const mobileDistDir = process.env.MOBILE_DIST_DIR ? resolve(process.env.MOBILE_DIST_DIR) : undefined;

type Role = "unregistered" | "host" | "mobile";

interface ClientSession {
  socket: WebSocket;
  role: Role;
  deviceId?: string;
}

interface DeviceRoom {
  deviceId: string;
  deviceName?: string;
  host?: ClientSession;
  mobiles: Set<ClientSession>;
  tasks: Map<string, Task>;
  projects: WorkstationProject[];
  activeSources: AgentSource[];
  lastSequence: number;
  pendingCommands: Map<string, ClientSession>;
}

const rooms = new Map<string, DeviceRoom>();

function roomFor(deviceId: string): DeviceRoom {
  const existing = rooms.get(deviceId);
  if (existing) return existing;

  const room: DeviceRoom = {
    deviceId,
    mobiles: new Set(),
    tasks: new Map(),
    projects: [],
    activeSources: [],
    lastSequence: 0,
    pendingCommands: new Map(),
  };
  rooms.set(deviceId, room);
  return room;
}

function send(session: ClientSession, message: ServerMessage): void {
  if (session.socket.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify(message));
  }
}

function broadcastToMobiles(room: DeviceRoom, message: ServerMessage): void {
  for (const mobile of room.mobiles) send(mobile, message);
}

function snapshot(room: DeviceRoom): ServerMessage {
  const base = {
    type: "server.snapshot" as const,
    deviceId: room.deviceId,
    online: room.host !== undefined,
    tasks: [...room.tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    projects: room.projects,
    activeSources: room.host === undefined ? [] : room.activeSources,
    lastSequence: room.lastSequence,
  };
  return room.deviceName === undefined ? base : { ...base, deviceName: room.deviceName };
}

function applyEvent(room: DeviceRoom, event: WorkstationEvent): void {
  room.lastSequence = Math.max(room.lastSequence, event.sequence);
  room.tasks = applyEventToTasks(room.tasks, event);
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function staticFilePath(pathname: string): string | undefined {
  if (!mobileDistDir || !pathname.startsWith("/")) return undefined;
  const candidate = resolve(mobileDistDir, `.${pathname}`);
  const relative = relativePath(mobileDistDir, candidate);
  if (isAbsolute(relative) || relative.startsWith("..")) return undefined;
  return candidate;
}

async function serveMobile(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (!mobileDistDir || (request.method !== "GET" && request.method !== "HEAD")) return false;

  let pathname = "/";
  try {
    pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    pathname = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid URL");
    return true;
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  let filePath = staticFilePath(requestedPath);
  let fileStat: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    if (filePath) fileStat = await stat(filePath);
  } catch {
    fileStat = undefined;
  }

  // Client-side routes should render the app shell, while missing assets stay 404.
  if (!fileStat?.isFile()) {
    if (extname(requestedPath) !== "") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return true;
    }
    filePath = staticFilePath("/index.html");
    if (!filePath) return false;
    try {
      fileStat = await stat(filePath);
    } catch {
      return false;
    }
  }

  if (!filePath || !fileStat?.isFile()) return false;
  const resolvedFilePath = filePath;
  const resolvedFileStat = fileStat;

  response.writeHead(200, {
    "cache-control": requestedPath === "/index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "content-length": Number(resolvedFileStat.size),
    "content-type": contentTypes[extname(resolvedFilePath)] ?? "application/octet-stream",
  });
  if (request.method === "HEAD") {
    response.end();
  } else {
    createReadStream(resolvedFilePath).pipe(response);
  }
  return true;
}

const httpServer = createServer((request, response) => {
  void (async () => {
    const pathname = (() => {
      try {
        return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
      } catch {
        return request.url;
      }
    })();

    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size, mobile: mobileDistDir !== undefined }));
      return;
    }

    if (await serveMobile(request, response)) return;

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      service: "ai-workstation-control-plane",
      developmentOnly: true,
      websocket: "/ws",
    }));
  })().catch((error: unknown) => {
    if (response.headersSent) return;
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : "Internal server error");
  });
});

const webSocketServer = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  maxPayload: 24 * 1_024 * 1_024,
});

webSocketServer.on("connection", (socket, request) => {
  const session: ClientSession = { socket, role: "unregistered" };

  socket.on("message", (raw) => {
    let input: unknown;
    try {
      input = JSON.parse(raw.toString());
    } catch {
      send(session, { type: "server.error", code: "invalid_json", message: "Message is not valid JSON" });
      return;
    }

    const parsed = ClientMessageSchema.safeParse(input);
    if (!parsed.success) {
      send(session, { type: "server.error", code: "invalid_message", message: "Message does not match the protocol" });
      return;
    }

    const message = parsed.data;

    if (message.type === "host.hello" || message.type === "mobile.hello") {
      if (session.role !== "unregistered") {
        send(session, { type: "server.error", code: "already_registered", message: "Connection already registered" });
        return;
      }
      if (!acceptsPairingToken(message.token, pairingToken, {
        host: request.headers.host,
        origin: request.headers.origin,
        forwardedByCloudflare: request.headers["cf-connecting-ip"] !== undefined
          || request.headers["cf-ray"] !== undefined,
      })) {
        send(session, { type: "server.error", code: "unauthorized", message: "Pairing token rejected" });
        socket.close(1008, "unauthorized");
        return;
      }

      const room = roomFor(message.deviceId);
      session.deviceId = message.deviceId;

      if (message.type === "host.hello") {
        session.role = "host";
        for (const [commandId, mobile] of room.pendingCommands) {
          send(mobile, { type: "server.ack", messageId: commandId, status: "rejected", detail: "工作站服务已重启，请重试" });
        }
        room.pendingCommands.clear();
        room.host?.socket.close(1012, "host replaced");
        room.host = session;
        room.deviceName = message.deviceName;
        // A host hello is an authoritative restart boundary. Do not retain
        // tasks produced by the previous host process.
        room.tasks.clear();
        room.projects = message.projects;
        room.activeSources = message.activeSources;
        broadcastToMobiles(room, {
          type: "server.host_status",
          deviceId: room.deviceId,
          deviceName: message.deviceName,
          online: true,
        });
        broadcastToMobiles(room, snapshot(room));
      } else {
        session.role = "mobile";
        room.mobiles.add(session);
        // The snapshot is authoritative through lastSequence. Replaying the
        // events already folded into it duplicates large task histories and
        // can leave remote clients minutes behind the live state.
        send(session, snapshot(room));
      }
      return;
    }

    if (session.role === "unregistered" || session.deviceId === undefined) {
      send(session, { type: "server.error", code: "hello_required", message: "Register the connection first" });
      return;
    }

    const room = roomFor(session.deviceId);

    if (message.type === "mobile.refresh") {
      if (session.role !== "mobile" || message.deviceId !== session.deviceId) {
        send(session, { type: "server.error", code: "forbidden", message: "Mobile refresh rejected" });
        return;
      }
      send(session, snapshot(room));
      return;
    }

    if (message.type === "host.projects") {
      if (session.role !== "host" || message.deviceId !== session.deviceId) {
        send(session, { type: "server.error", code: "forbidden", message: "Host project snapshot rejected" });
        return;
      }
      room.projects = message.projects;
      broadcastToMobiles(room, {
        type: "server.projects",
        deviceId: room.deviceId,
        projects: room.projects,
      });
      return;
    }

    if (message.type === "host.sources") {
      if (session.role !== "host" || message.deviceId !== session.deviceId) {
        send(session, { type: "server.error", code: "forbidden", message: "Host source snapshot rejected" });
        return;
      }
      room.activeSources = message.activeSources;
      broadcastToMobiles(room, {
        type: "server.sources",
        deviceId: room.deviceId,
        activeSources: room.activeSources,
      });
      return;
    }

    if (message.type === "host.event") {
      if (session.role !== "host" || message.event.deviceId !== session.deviceId) {
        send(session, { type: "server.error", code: "forbidden", message: "Host event rejected" });
        return;
      }
      applyEvent(room, message.event);
      broadcastToMobiles(room, { type: "server.event", event: message.event });
      send(session, { type: "server.ack", messageId: message.event.eventId, status: "accepted" });
      return;
    }

    if (message.type === "host.command_result") {
      if (session.role !== "host" || message.deviceId !== session.deviceId) {
        send(session, { type: "server.error", code: "forbidden", message: "Host command result rejected" });
        return;
      }
      const mobile = room.pendingCommands.get(message.commandId);
      if (!mobile) return;
      room.pendingCommands.delete(message.commandId);
      send(mobile, {
        type: "server.ack",
        messageId: message.commandId,
        status: message.status,
        ...(message.detail ? { detail: message.detail } : {}),
      });
      return;
    }

    if (message.type === "mobile.command") {
      if (session.role !== "mobile" || message.command.deviceId !== session.deviceId) {
        send(session, { type: "server.error", code: "forbidden", message: "Mobile command rejected" });
        return;
      }
      if (isCommandExpired(message.command)) {
        send(session, { type: "server.ack", messageId: message.command.commandId, status: "rejected", detail: "请求已过期，请重试" });
        return;
      }
      if (room.host === undefined) {
        send(session, { type: "server.ack", messageId: message.command.commandId, status: "rejected", detail: "工作站当前离线" });
        return;
      }
      room.pendingCommands.set(message.command.commandId, session);
      send(room.host, { type: "server.command", command: message.command });
      send(session, { type: "server.ack", messageId: message.command.commandId, status: "delivered" });
    }
  });

  socket.on("close", () => {
    if (session.deviceId === undefined) return;
    const room = rooms.get(session.deviceId);
    if (!room) return;

    if (session.role === "host" && room.host === session) {
      delete room.host;
      room.activeSources = [];
      for (const [commandId, mobile] of room.pendingCommands) {
        send(mobile, { type: "server.ack", messageId: commandId, status: "rejected", detail: "工作站连接已断开" });
      }
      room.pendingCommands.clear();
      broadcastToMobiles(room, {
        type: "server.sources",
        deviceId: room.deviceId,
        activeSources: [],
      });
      const status: ServerMessage = room.deviceName === undefined
        ? { type: "server.host_status", deviceId: room.deviceId, online: false }
        : { type: "server.host_status", deviceId: room.deviceId, deviceName: room.deviceName, online: false };
      broadcastToMobiles(room, status);
    }
    if (session.role === "mobile") {
      room.mobiles.delete(session);
      for (const [commandId, mobile] of room.pendingCommands) {
        if (mobile === session) room.pendingCommands.delete(commandId);
      }
    }
  });
});

httpServer.listen(port, host, () => {
  console.log(`[relay] listening on ws://${host}:${port}/ws`);
  console.log("[relay] development transport only; production identity and encryption are not implemented");
});

