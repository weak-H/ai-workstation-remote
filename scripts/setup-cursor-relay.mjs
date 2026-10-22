import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packageCursorRelay } from "./package-cursor-relay.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionSource = join(root, "apps", "cursor-relay-extension");
const extensionManifest = JSON.parse(await readFile(join(extensionSource, "package.json"), "utf8"));
const extensionId = `${extensionManifest.publisher}.${extensionManifest.name}`;
const extensionVersion = extensionManifest.version;
const macHelperSource = join(root, "apps", "mac-companion", "native", "cursor-input-helper.swift");
const windowsHelperSource = join(root, "apps", "mac-companion", "native", "cursor-input-helper.ps1");
const toolsDirectory = join(root, ".tools");
const helperPath = join(toolsDirectory, "bin", process.platform === "win32" ? "cursor-input-helper.ps1" : "cursor-input-helper");
const vsixPath = join(toolsDirectory, "cursor-relay", "ai-workstation-cursor-relay.vsix");
const installedExtension = join(homedir(), ".cursor", "extensions", `${extensionId}-${extensionVersion}`);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function prepareHelper() {
  await mkdir(dirname(helperPath), { recursive: true });
  const helperSource = process.platform === "win32" ? windowsHelperSource : macHelperSource;
  const sourceStat = await stat(helperSource);
  const destinationStat = await stat(helperPath).catch(() => undefined);
  if (destinationStat && destinationStat.mtimeMs >= sourceStat.mtimeMs) return;
  if (process.platform === "win32") {
    console.log("正在部署 Windows Cursor 输入辅助程序...");
    await copyFile(helperSource, helperPath);
    return;
  }
  if (process.platform !== "darwin") {
    console.warn("当前平台没有 Cursor 输入辅助程序；将仅安装中继扩展。");
    return;
  }
  console.log("正在编译 macOS Cursor 输入辅助程序...");
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    "-O",
    helperSource,
    "-o",
    helperPath,
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
  ], { stdio: "inherit" });
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
  return candidates.find((candidate) => {
    const result = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    return result.status === 0;
  });
}

async function extensionAlreadyInstalled() {
  const installedManifestPath = join(installedExtension, "package.json");
  const installedScriptPath = join(installedExtension, "extension.js");
  if (!await exists(installedManifestPath) || !await exists(installedScriptPath)) return false;
  const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
  delete installedManifest.__metadata;
  return JSON.stringify(extensionManifest) === JSON.stringify(installedManifest)
    && await digest(join(extensionSource, "extension.js")) === await digest(installedScriptPath);
}

async function installExtension() {
  if (await extensionAlreadyInstalled()) {
    console.log(`Cursor 中继扩展 ${extensionId}@${extensionVersion} 已是最新版本，跳过安装。`);
    return { available: true, installed: false };
  }
  const cli = cursorCli();
  if (!cli) {
    console.warn("未找到 Cursor CLI，跳过 Cursor 中继安装；Codex 和 Claude Code 功能不受影响。");
    return { available: false, installed: false };
  }
  await packageCursorRelay(vsixPath);
  console.log("正在安装 AI Workstation Cursor Relay 扩展...");
  const result = spawnSync(cli, ["--install-extension", vsixPath, "--force"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("Cursor 中继扩展安装失败");
  return { available: true, installed: true };
}

const extension = await installExtension();
if (extension.available) {
  await prepareHelper();
  console.log(`Cursor 中继已就绪：${helperPath}`);
}
if (extension.installed) console.log("首次安装或扩展更新后，请完整重启 Cursor。");

if (extension.available && process.platform === "darwin" && process.argv.includes("--prompt-accessibility")) {
  const result = spawnSync(helperPath, ["trust", "--prompt"], { encoding: "utf8" });
  if (result.status === 0) {
    console.log("macOS 辅助功能权限已授予。");
  } else {
    console.log("已请求 macOS 辅助功能权限；授权 cursor-input-helper 后即可从网页发送。");
  }
}
