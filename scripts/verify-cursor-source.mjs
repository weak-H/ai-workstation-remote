import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";

const path = process.env.CURSOR_STATE_DB ?? (process.platform === "win32"
  ? win32.join(process.env.APPDATA ?? win32.join(homedir(), "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb")
  : join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"));

const database = new DatabaseSync(path, { readOnly: true, timeout: 2_000 });
try {
  database.exec("PRAGMA query_only = ON");
  const schema = database.prepare(`
    SELECT
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'composerHeaders') AS hasHeaders,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cursorDiskKV') AS hasKv
  `).get();
  if (schema?.hasHeaders !== 1 || schema?.hasKv !== 1) {
    throw new Error("Cursor state database does not expose the expected conversation tables");
  }

  const counts = database.prepare(`
    SELECT
      COUNT(*) AS conversations,
      COUNT(DISTINCT workspaceId) AS workspaces
    FROM composerHeaders
    WHERE isArchived = 0 AND isSubagent = 0
  `).get();
  const hydrated = database.prepare(`
    SELECT COUNT(*) AS count
    FROM composerHeaders h
    JOIN cursorDiskKV d ON d.key = 'composerData:' || h.composerId
    WHERE h.isArchived = 0 AND h.isSubagent = 0
  `).get();

  if (Number(hydrated?.count ?? 0) === 0) {
    throw new Error("Cursor has no readable persisted conversations");
  }
  console.log(`Cursor source verified read-only: ${counts?.conversations ?? 0} conversations, ${counts?.workspaces ?? 0} workspaces, ${hydrated?.count ?? 0} hydrated`);
} finally {
  database.close();
}
