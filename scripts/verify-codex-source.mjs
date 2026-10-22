import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import readline from "node:readline";

const bundledCodex = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "ChatGPT", "resources", "codex.exe") : undefined,
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "ChatGPT", "resources", "codex-cli", "codex.exe") : undefined,
].filter(Boolean).find((candidate) => existsSync(candidate));
const codexBin = process.env.CODEX_BIN ?? bundledCodex ?? "codex";
const child = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
  windowsHide: true,
});
const lines = readline.createInterface({ input: child.stdout });
let finished = false;

const timeout = setTimeout(() => finish(new Error("Codex read-only verification timed out")), 15_000);

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) {
    if (message.error) return finish(new Error(message.error.message));
    write({ method: "initialized" });
    write({
      id: 2,
      method: "thread/list",
      params: { limit: 5, sortKey: "updated_at", sortDirection: "desc", archived: false, useStateDbOnly: true },
    });
    return;
  }
  if (message.id === 2) {
    if (message.error) return finish(new Error(message.error.message));
    const threads = message.result?.data;
    if (!Array.isArray(threads) || threads.length === 0) {
      return finish(new Error("Codex returned no persisted threads"));
    }
    console.log(`verified real Codex source: ${threads.length} recent threads; newest=${threads[0].id}`);
    finish();
  }
});

child.on("error", finish);
child.on("exit", (code) => {
  if (!finished) finish(new Error(`Codex exited before verification (${code})`));
});

write({
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "ai-workstation-remote-verifier", title: "AI Workstation Remote Verifier", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  },
});

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  child.stdin.end();
  child.kill("SIGTERM");
  if (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
