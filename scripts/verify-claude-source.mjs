import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectsDirectory = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
const configuredBin = process.env.CLAUDE_BIN;

async function executableExists(command) {
  if (isAbsolute(command)) {
    try {
      await access(command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const commandShim = process.platform === "win32" && extname(command).toLowerCase() === ".cmd";
    await execFileAsync(
      commandShim ? "cmd.exe" : command,
      commandShim ? ["/d", "/s", "/c", command, "--version"] : ["--version"],
      { timeout: 3_000, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function findClaudeBin() {
  const windowsCandidates = process.platform === "win32"
    ? [
        join(homedir(), ".local", "bin", "claude.exe"),
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "claude", "claude.exe") : undefined,
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.cmd") : undefined,
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.exe") : undefined,
        "claude.exe",
        "claude.cmd",
      ].filter(Boolean)
    : [];
  const candidates = configuredBin
    ? [configuredBin]
    : [...windowsCandidates, join(homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "claude"];
  for (const candidate of candidates) {
    if (await executableExists(candidate)) return candidate;
  }
  return undefined;
}

const projectDirectories = await readdir(projectsDirectory, { withFileTypes: true });
const sessionPaths = [];
for (const directory of projectDirectories) {
  if (!directory.isDirectory()) continue;
  const files = await readdir(join(projectsDirectory, directory.name), { withFileTypes: true });
  for (const file of files) {
    if (file.isFile() && file.name.endsWith(".jsonl") && !file.name.startsWith("agent-")) {
      sessionPaths.push(join(projectsDirectory, directory.name, file.name));
    }
  }
}

let validSessions = 0;
let messageCount = 0;
for (const path of sessionPaths) {
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  let valid = false;
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record.sessionId === "string" && typeof record.cwd === "string") valid = true;
    if ((record.type === "user" || record.type === "assistant") && record.message) messageCount += 1;
  }
  if (valid) validSessions += 1;
}

if (validSessions === 0) throw new Error("Claude Code has no readable persisted sessions");
const claudeBin = await findClaudeBin();
console.log(`Claude source verified read-only: ${validSessions} sessions, ${messageCount} messages; CLI=${claudeBin ?? "not installed (history only)"}`);
