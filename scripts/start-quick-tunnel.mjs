import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { compactQrAccessUrl, renderCompactQr } from "./compact-terminal-qr.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const mobileDistDir = fileURLToPath(new URL("../apps/mobile/dist", import.meta.url));
const pairingTokenAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(bytes) {
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += pairingTokenAlphabet[(buffer >> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += pairingTokenAlphabet[(buffer << (5 - bits)) & 31];
  return output;
}

const pairingToken = process.env.PAIRING_TOKEN ?? encodeBase32(randomBytes(24));
const controlPort = process.env.CONTROL_PORT ?? "8787";
const cloudflaredBin = process.env.CLOUDFLARED_BIN ?? "cloudflared";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];
let stopping = false;

if (!existsSync(mobileDistDir)) {
  console.error("Mobile build is missing. Run `npm run build -w @ai-workstation/mobile` first.");
  process.exit(1);
}

if (!/^\d+$/.test(controlPort) || Number(controlPort) < 1 || Number(controlPort) > 65_535) {
  console.error(`CONTROL_PORT must be an integer between 1 and 65535; received: ${controlPort}`);
  process.exit(1);
}

const cloudflaredProbe = spawnSync(cloudflaredBin, ["--version"], { stdio: "ignore" });
if (cloudflaredProbe.error || cloudflaredProbe.status !== 0) {
  console.error(`无法运行 cloudflared：${cloudflaredBin}`);
  console.error("请检查 CLOUDFLARED_BIN，或通过仓库根目录的 run.sh / run.ps1 启动。");
  process.exit(1);
}

const commonEnvironment = {
  ...process.env,
  CONTROL_HOST: "127.0.0.1",
  CONTROL_PORT: controlPort,
  CONTROL_URL: `ws://127.0.0.1:${controlPort}/ws`,
  PAIRING_TOKEN: pairingToken,
  MOBILE_DIST_DIR: mobileDistDir,
  WORKSTATION_CWD: process.env.WORKSTATION_CWD ?? root,
};

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 800);
}

function startNodeService(label, args, environment = commonEnvironment) {
  const child = spawn(npmCommand, args, {
    cwd: root,
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
  return child;
}

function showTunnelUrl(chunk) {
  const text = String(chunk);
  process.stdout.write(`[cloudflared] ${text}`);
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!match || showTunnelUrl.url) return;

  showTunnelUrl.url = match[0];
  const accessUrl = `${showTunnelUrl.url}/#token=${encodeURIComponent(pairingToken)}`;
  const canUseCompactQr = /^[0-9A-HJKMNP-TV-Z]{39}$/.test(pairingToken);
  const qrAccessUrl = canUseCompactQr
    ? compactQrAccessUrl(showTunnelUrl.url, pairingToken)
    : accessUrl;
  console.log("\n手机扫码打开：");
  console.log(accessUrl);
  console.log(renderCompactQr(qrAccessUrl));
  console.log("\n保持此终端和工作站服务运行，关闭后公网地址立即失效。\n");
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

startNodeService("relay", ["run", "start", "-w", "@ai-workstation/control-plane"]);
startNodeService("host", ["run", "start", "-w", "@ai-workstation/mac-companion"]);
console.log(`AI_WORKSTATION_LOCAL_URL=http://127.0.0.1:${controlPort}`);

const cloudflared = spawn(cloudflaredBin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${controlPort}`], {
  cwd: root,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(cloudflared);
cloudflared.stdout.on("data", showTunnelUrl);
cloudflared.stderr.on("data", showTunnelUrl);
cloudflared.on("error", (error) => {
  console.error(`[cloudflared] ${error.message}`);
  console.error("请检查 CLOUDFLARED_BIN，或通过仓库根目录的 run.sh / run.ps1 启动。");
  stop(1);
});
cloudflared.on("exit", (code, signal) => {
  if (stopping) return;
  console.error(`[cloudflared] exited with ${signal ?? `code ${code ?? 1}`}`);
  stop(code && code > 0 ? code : 1);
});

