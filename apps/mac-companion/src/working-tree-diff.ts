import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import type { Artifact } from "@ai-workstation/protocol";

const execFileAsync = promisify(execFile);
const maxDiffBytes = 400_000;
const maxUntrackedFileBytes = 128_000;

export interface DiffContentResult {
  content?: string;
  truncated?: boolean;
  error?: string;
}

export function boundedDiffContent(content: string): DiffContentResult {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= maxDiffBytes) return { content };
  const bounded = Buffer.from(content, "utf8").subarray(0, maxDiffBytes).toString("utf8");
  return { content: `${bounded}\n\n# Diff truncated after ${maxDiffBytes} bytes`, truncated: true };
}

function untrackedPatch(path: string, content: Buffer): string {
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
  if (content.includes(0)) return `${header}Binary files /dev/null and b/${path} differ`;
  const text = content.toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export async function readWorkingTreeDiff(cwd: string): Promise<DiffContentResult> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { error: "该项目不是 Git 工作区，无法生成文件差异" };
  }

  let tracked = "";
  try {
    tracked = await git(cwd, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--"]);
  } catch {
    try {
      tracked = await git(cwd, ["diff", "--no-ext-diff", "--no-color", "--"]);
    } catch (error) {
      return { error: `读取 Git diff 失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const patches: string[] = tracked.trim() ? [tracked.trimEnd()] : [];
  try {
    const worktreeRoot = await realpath(cwd);
    const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);
    for (const path of untracked) {
      if (Buffer.byteLength(patches.join("\n"), "utf8") >= maxDiffBytes) break;
      const candidate = join(worktreeRoot, path);
      const file = await lstat(candidate);
      if (!file.isFile() || file.isSymbolicLink()) {
        patches.push(`diff --git a/${path} b/${path}\n# Untracked non-regular file is not previewed`);
        continue;
      }
      const resolved = await realpath(candidate);
      const resolvedRelative = relative(worktreeRoot, resolved);
      if (isAbsolute(resolvedRelative) || resolvedRelative === ".." || resolvedRelative.startsWith(`..${sep}`)) {
        patches.push(`diff --git a/${path} b/${path}\n# Untracked file outside the worktree is not previewed`);
        continue;
      }
      const handle = await open(
        resolved,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      let content: Buffer | undefined;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > maxUntrackedFileBytes) {
          content = undefined;
        } else {
          const buffer = Buffer.alloc(maxUntrackedFileBytes + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
          if (bytesRead <= maxUntrackedFileBytes) content = buffer.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
      if (!content) {
        patches.push(`diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n# Untracked file is too large to preview`);
      } else {
        patches.push(untrackedPatch(path, content));
      }
    }
  } catch {
    // A tracked diff is still useful when an untracked file disappears mid-read.
  }

  if (patches.length === 0) return { error: "当前工作区没有可显示的未提交文件差异" };
  return boundedDiffContent(patches.join("\n\n"));
}

export function artifactsWithDiffContent(
  artifacts: readonly Artifact[],
  result: DiffContentResult,
): Artifact[] {
  const index = (() => {
    for (let index = artifacts.length - 1; index >= 0; index -= 1) {
      if (artifacts[index]?.kind === "diff") return index;
    }
    return -1;
  })();
  if (index < 0) return [...artifacts];
  return artifacts.map((artifact, artifactIndex) => {
    if (artifactIndex !== index) return artifact;
    const {
      content: _content,
      contentTruncated: _contentTruncated,
      contentError: _contentError,
      ...base
    } = artifact;
    return {
      ...base,
      ...(result.content ? { content: result.content } : {}),
      ...(result.truncated ? { contentTruncated: true } : {}),
      ...(result.error ? { contentError: result.error } : {}),
    };
  });
}

export function preserveArtifactContent(
  artifacts: readonly Artifact[],
  previous: readonly Artifact[] | undefined,
): Artifact[] {
  if (!previous) return [...artifacts];
  const previousById = new Map(previous.map((artifact) => [artifact.id, artifact]));
  return artifacts.map((artifact) => {
    const prior = previousById.get(artifact.id);
    if (!prior) return artifact;
    return {
      ...artifact,
      ...(prior.content ? { content: prior.content } : {}),
      ...(prior.contentTruncated ? { contentTruncated: true } : {}),
      ...(prior.contentError ? { contentError: prior.contentError } : {}),
    };
  });
}
