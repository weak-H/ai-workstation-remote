const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const vscode = require("vscode");

const protocolVersion = 1;
const maxRequestBytes = 128 * 1024;
const discoveryDirectory = path.join(os.homedir(), ".cursor", "ai-workstation-remote");
const socketPath = process.platform === "win32"
  ? `\\\\.\\pipe\\ai-workstation-cursor-relay-${process.env.USERNAME ?? "user"}-${process.pid}`
  : path.join(os.tmpdir(), `ai-workstation-cursor-relay-${process.getuid?.() ?? "user"}-${process.pid}.sock`);
const discoveryPath = path.join(discoveryDirectory, `relay-${process.pid}.json`);
const token = crypto.randomBytes(32).toString("hex");

let server;
let output;

function response(socket, value) {
  socket.end(`${JSON.stringify(value)}\n`);
}

async function focusComposer(composerId) {
  const commands = new Set(await vscode.commands.getCommands(true));
  if (!commands.has("composer.openComposer") || !commands.has("composer.focusComposer")) {
    throw new Error("当前 Cursor 版本未公开会话聚焦命令");
  }
  await vscode.commands.executeCommand("composer.openComposer", composerId, { focusMainInputBox: true });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await vscode.commands.executeCommand("composer.focusComposer", composerId);
}

async function createComposer() {
  const commands = new Set(await vscode.commands.getCommands(true));
  const command = [
    "composer.createNew",
    "composer.newAgentChat",
    "composer.createNewComposerTab",
    "composer.createComposer",
  ].find((candidate) => commands.has(candidate));
  if (!command) throw new Error("当前 Cursor 版本未公开新建会话命令");
  await vscode.commands.executeCommand(command);
  await new Promise((resolve) => setTimeout(resolve, 180));
}

async function handleRequest(socket, value) {
  if (!value || value.protocolVersion !== protocolVersion || value.token !== token) {
    response(socket, { status: "error", message: "unauthorized" });
    return;
  }
  if (value.type === "ping") {
    response(socket, { status: "ready" });
    return;
  }
  if (value.type === "create") {
    try {
      await createComposer();
      response(socket, { status: "created" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output?.appendLine(`[relay] create failed: ${message}`);
      response(socket, { status: "error", message });
    }
    return;
  }
  if (value.type !== "focus" || typeof value.composerId !== "string" || value.composerId.length === 0) {
    response(socket, { status: "error", message: "invalid request" });
    return;
  }
  try {
    await focusComposer(value.composerId);
    response(socket, { status: "focused", composerId: value.composerId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output?.appendLine(`[relay] focus failed: ${message}`);
    response(socket, { status: "error", message });
  }
}

function accept(socket) {
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input) > maxRequestBytes) socket.destroy(new Error("request too large"));
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    socket.pause();
    let value;
    try {
      value = JSON.parse(input.slice(0, newline));
    } catch {
      response(socket, { status: "error", message: "invalid JSON" });
      return;
    }
    void handleRequest(socket, value);
  });
  socket.on("error", (error) => output?.appendLine(`[relay] socket error: ${error.message}`));
}

async function removeRuntimeFiles() {
  await Promise.all([
    ...(process.platform === "win32" ? [] : [fs.rm(socketPath, { force: true })]),
    fs.rm(discoveryPath, { force: true }),
  ]);
}

async function activate(context) {
  output = vscode.window.createOutputChannel("AI Workstation Cursor Relay");
  context.subscriptions.push(output);
  await fs.mkdir(discoveryDirectory, { recursive: true, mode: 0o700 });
  await removeRuntimeFiles();

  server = net.createServer(accept);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  if (process.platform !== "win32") await fs.chmod(socketPath, 0o600);

  const workspaceFolders = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
  const discovery = {
    protocolVersion,
    pid: process.pid,
    socketPath,
    token,
    appName: vscode.env.appName,
    workspaceName: vscode.workspace.name ?? "",
    workspaceFolders,
    createdAt: Date.now(),
  };
  const temporaryPath = `${discoveryPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(discovery), { mode: 0o600 });
  await fs.rename(temporaryPath, discoveryPath);
  output.appendLine(`[relay] listening for same-user requests at ${socketPath}`);

  context.subscriptions.push({
    dispose() {
      server?.close();
      void removeRuntimeFiles();
    },
  });
}

async function deactivate() {
  server?.close();
  await removeRuntimeFiles();
}

module.exports = { activate, deactivate };
