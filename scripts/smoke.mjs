import WebSocket from "ws";

const url = process.env.CONTROL_URL ?? "ws://127.0.0.1:8787/ws";
const token = process.env.PAIRING_TOKEN ?? "local-development-only";
const deviceId = "workstation_local";
const socket = new WebSocket(url);

const timeout = setTimeout(() => {
  console.error("smoke test timed out before receiving real Codex and Cursor sessions");
  socket.close();
  process.exitCode = 1;
}, 12_000);

socket.on("open", () => {
  socket.send(JSON.stringify({
    type: "mobile.hello",
    deviceId,
    token,
    afterSequence: 0,
  }));
});

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === "server.snapshot") {
    if (!message.online) return fail("Workstation Companion is offline");
    const codex = message.tasks.filter((task) => task.agentId === "codex-app-server" && /^[0-9a-f-]{36}$/.test(task.id));
    const cursor = message.tasks.filter((task) => task.agentId === "cursor-local" && /^cursor_[0-9a-f-]{36}$/.test(task.id));
    const cursorProjects = message.projects.filter((project) => project.id.startsWith("cursor_workspace_"));
    if (codex.length > 0 && cursor.length > 0 && cursorProjects.length > 0) {
      finish(`${codex.length} real Codex sessions; ${cursor.length} real Cursor sessions in ${cursorProjects.length} workspaces`);
    }
  }
});

socket.on("error", (error) => {
  fail(error instanceof Error ? error.message : String(error));
});

function fail(message) {
  clearTimeout(timeout);
  console.error(message);
  process.exitCode = 1;
  socket.close();
}

function finish(summary) {
  clearTimeout(timeout);
  console.log(`smoke test passed: ${summary}`);
  socket.close();
}

