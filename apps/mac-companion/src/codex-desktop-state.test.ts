import assert from "node:assert/strict";
import test from "node:test";

import { parseCodexDesktopState } from "./codex-desktop-state.js";

test("preserves Codex project order and explicit thread membership", () => {
  const state = parseCodexDesktopState({
    "local-projects": {
      project_b: { id: "project_b", name: "Beta", rootPaths: ["/work/b"], updatedAt: 20 },
      project_a: { id: "project_a", name: "Alpha", rootPaths: ["/work/a"], updatedAt: 10 },
      project_c: { id: "project_c", name: "Gamma", rootPaths: ["/work/c"], updatedAt: 30 },
    },
    "project-order": ["project_a", "project_b"],
    "thread-project-assignments": {
      thread_a: { projectKind: "local", projectId: "project_a" },
      thread_remote: { projectKind: "remote", projectId: "project_c" },
      thread_missing: { projectKind: "local", projectId: "missing" },
    },
    "projectless-thread-ids": ["thread_free"],
  });

  assert.deepEqual(state.projects.map((project) => project.name), ["Alpha", "Beta", "Gamma"]);
  assert.equal(state.projects[0]?.order, 0);
  assert.equal(state.projectIdByThreadId.get("thread_a"), "project_a");
  assert.equal(state.projectIdByThreadId.has("thread_remote"), false);
  assert.equal(state.projectlessThreadIds.has("thread_free"), true);
  assert.equal(state.rootPathByProjectId.get("project_a"), "/work/a");
});
