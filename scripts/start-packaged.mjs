import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(appRoot, "runtime");
const mobileDistDir = join(appRoot, "mobile");
const releaseManifest = JSON.parse(await readFile(join(appRoot, "release-manifest.json"), "utf8"));
const cloudflaredBin = process.env.CLOUDFLARED_BIN;
const inputHelper = process.env.CURSOR_INPUT_HELPER;
const relayVsix = join(appRoot, "cursor-relay.vsix");
const pairingToken = process.env.PAIRING_TOKEN ?? randomBytes(24).toString("base64url");
const children = [];
let stopping = false;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function cursorCli() {
  const candidates = [
    process.env.CURSOR_BIN,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd") : undefined,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Cursor", "resources", "app", "bin", "cursor.cmd") : undefined,
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    "/Applications/Cursor.app/Contents/Resources/app/bin/code",
    process.platform === "win32" ? "cursor.cmd" : undefined,
    "cursor",
  ].filter(Boolean);
  return candidates.find((candidate) => spawnSync(candidate, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
    windowsHide: true,
  }).status === 0);
}

async function setupCursorRelay() {
  const installedRoot = join(homedir(), ".cursor", "extensions");
  const prefix = `${releaseManifest.cursorExtensionId}-${releaseManifest.cursorExtensionVersion}`;
  const installed = await readdir(installedRoot, { withFileTypes: true }).catch(() => []);
  if (installed.some((entry) => entry.isDirectory() && entry.name === prefix)) {
    console.log(`[setup] Cursor relay ${releaseManifest.cursorExtensionVersion} is ready`);
    return;
  }

  const cli = cursorCli();
  if (!cli) {
    console.warn("[setup] Cursor is not installed; Codex support will remain available");
    return;
  }
  const result = spawnSync(cli, ["--install-extension", relayVsix, "--force"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.warn(`[setup] Cursor relay installation failed: ${(result.stderr || result.stdout).trim()}`);
    return;
  }
  console.log("[setup] Cursor relay installed; restart Cursor before using message control");
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

async function selectPort() {
  if (process.env.CONTROL_PORT) return Number(process.env.CONTROL_PORT);
  for (let port = 8787; port <= 8887; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error("No available control port between 8787 and 8887");
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 800).unref();
}

function startNodeService(label, script, environment) {
  const child = spawn(process.execPath, [script], {
    cwd: appRoot,
    env: environment,
    stdio: "inherit",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`[${label}] ${error.message}`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[${label}] exited with ${signal ?? `code ${code ?? 1}`}`);
    stop(code && code > 0 ? code : 1);
  });
}

if (!cloudflaredBin || !await exists(cloudflaredBin)) {
  throw new Error("The packaged cloudflared executable is missing");
}
if (!inputHelper || !await exists(inputHelper)) {
  throw new Error("The packaged Cursor input helper is missing");
}

await setupCursorRelay();
const controlPort = await selectPort();
const localUrl = `http://127.0.0.1:${controlPort}`;
const commonEnvironment = {
  ...process.env,
  CONTROL_HOST: "127.0.0.1",
  CONTROL_PORT: String(controlPort),
  CONTROL_URL: `ws://127.0.0.1:${controlPort}/ws`,
  PAIRING_TOKEN: pairingToken,
  MOBILE_DIST_DIR: mobileDistDir,
  CURSOR_INPUT_HELPER: inputHelper,
};

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

startNodeService("relay", join(runtimeDir, "control-plane.cjs"), commonEnvironment);
startNodeService("host", join(runtimeDir, "mac-companion.cjs"), commonEnvironment);
console.log(`AI_WORKSTATION_LOCAL_URL=${localUrl}`);

const cloudflared = spawn(cloudflaredBin, ["tunnel", "--no-autoupdate", "--url", localUrl], {
  cwd: appRoot,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(cloudflared);

let tunnelUrl;
function consumeCloudflared(chunk) {
  const text = String(chunk);
  process.stdout.write(`[cloudflared] ${text}`);
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!match || tunnelUrl) return;
  tunnelUrl = match[0];
  const accessUrl = `${tunnelUrl}/#token=${encodeURIComponent(pairingToken)}`;
  console.log(`AI_WORKSTATION_ACCESS_URL=${accessUrl}`);
}

cloudflared.stdout.on("data", consumeCloudflared);
cloudflared.stderr.on("data", consumeCloudflared);
cloudflared.on("error", (error) => {
  console.error(`[cloudflared] ${error.message}`);
  stop(1);
});
cloudflared.on("exit", (code, signal) => {
  if (stopping) return;
  console.error(`[cloudflared] exited with ${signal ?? `code ${code ?? 1}`}`);
  stop(code && code > 0 ? code : 1);
});
