import assert from "node:assert/strict";
import test from "node:test";

import { defaultCursorDatabasePath } from "./platform.js";

test("resolves the Cursor database from Windows APPDATA", () => {
  assert.equal(
    defaultCursorDatabasePath("win32", "C:\\Users\\Ada\\AppData\\Roaming", "C:\\Users\\Ada"),
    "C:\\Users\\Ada\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb",
  );
});

test("keeps the macOS Cursor database path", () => {
  assert.equal(
    defaultCursorDatabasePath("darwin", undefined, "/Users/ada"),
    "/Users/ada/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
  );
});
