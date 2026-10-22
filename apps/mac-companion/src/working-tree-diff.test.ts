import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { artifactsWithDiffContent, readWorkingTreeDiff } from "./working-tree-diff.js";

const execFileAsync = promisify(execFile);

test("reads tracked and untracked working-tree changes on demand", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workstation-diff-"));
  await execFileAsync("git", ["init", "-q", directory]);
  await execFileAsync("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", directory, "config", "user.name", "Test"]);
  await writeFile(join(directory, "tracked.txt"), "before\n");
  await execFileAsync("git", ["-C", directory, "add", "tracked.txt"]);
  await execFileAsync("git", ["-C", directory, "commit", "-qm", "initial"]);
  await writeFile(join(directory, "tracked.txt"), "after\n");
  await writeFile(join(directory, "new.txt"), "new line\n");

  const result = await readWorkingTreeDiff(directory);
  assert.match(result.content ?? "", /-before/);
  assert.match(result.content ?? "", /\+after/);
  assert.match(result.content ?? "", /diff --git a\/new\.txt b\/new\.txt/);
});

test("attaches diff content only to the latest diff artifact", () => {
  const artifacts = artifactsWithDiffContent([
    { id: "old", kind: "diff", title: "Old" },
    { id: "log", kind: "log", title: "Log" },
    { id: "latest", kind: "diff", title: "Latest" },
  ], { content: "+new" });
  assert.equal(artifacts[0]?.content, undefined);
  assert.equal(artifacts[2]?.content, "+new");
});

test("does not follow untracked symbolic links outside the worktree", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workstation-diff-link-"));
  const outside = join(await mkdtemp(join(tmpdir(), "workstation-diff-secret-")), "secret.txt");
  await execFileAsync("git", ["init", "-q", directory]);
  await writeFile(outside, "outside-secret-marker\n");
  try {
    await symlink(outside, join(directory, "leak.txt"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  const result = await readWorkingTreeDiff(directory);

  assert.doesNotMatch(result.content ?? "", /outside-secret-marker/);
  assert.match(result.content ?? "", /non-regular file is not previewed/);
});

test("does not load oversized untracked files into the diff preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workstation-diff-large-"));
  await execFileAsync("git", ["init", "-q", directory]);
  await writeFile(join(directory, "large.txt"), Buffer.alloc(128 * 1_024 + 1, "x"));

  const result = await readWorkingTreeDiff(directory);

  assert.match(result.content ?? "", /Untracked file is too large to preview/);
  assert.ok((result.content?.length ?? 0) < 1_000);
});
