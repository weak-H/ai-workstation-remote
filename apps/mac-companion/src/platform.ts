import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const workstationDeviceId = "workstation_local";

export function defaultCursorDatabasePath(
  platform = process.platform,
  appData = process.env.APPDATA,
  home = homedir(),
): string {
  if (platform === "win32") {
    return win32.join(appData || win32.join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

export async function processCommandLines(): Promise<string> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine) { $_.CommandLine } }",
    ], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return stdout;
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "command="], { maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}
