import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultCodexProjectOverridesPath,
  loadCodexProjectOverrides,
  saveCodexProjectOverrides,
} from "./codex-project-overrides.js";

test("persists Codex thread project assignments atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-workstation-codex-projects-"));
  const path = join(directory, "nested", "projects.json");
  try {
    assert.deepEqual([...await loadCodexProjectOverrides(path)], []);

    await saveCodexProjectOverrides(path, new Map([
      ["thread_b", "project_b"],
      ["thread_a", "project_a"],
    ]));
    assert.deepEqual([...await loadCodexProjectOverrides(path)], [
      ["thread_a", "project_a"],
      ["thread_b", "project_b"],
    ]);
    assert.match(await readFile(path, "utf8"), /"version": 1/);

    await saveCodexProjectOverrides(path, new Map([["thread_a", "project_new"]]));
    assert.deepEqual([...await loadCodexProjectOverrides(path)], [["thread_a", "project_new"]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stores project assignments inside the active Codex home", () => {
  assert.equal(
    defaultCodexProjectOverridesPath("/tmp/codex-home"),
    "/tmp/codex-home/ai-workstation-remote-projects.json",
  );
});
