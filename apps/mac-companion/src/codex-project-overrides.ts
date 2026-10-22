import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

const CodexProjectOverridesSchema = z.object({
  version: z.literal(1),
  projectsByThread: z.record(z.string().min(1), z.string().min(1)),
});

export function defaultCodexProjectOverridesPath(
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): string {
  return join(codexHome, "ai-workstation-remote-projects.json");
}

export async function loadCodexProjectOverrides(path: string): Promise<Map<string, string>> {
  try {
    const parsed = CodexProjectOverridesSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return new Map(Object.entries(parsed.projectsByThread));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

export async function saveCodexProjectOverrides(
  path: string,
  projectsByThread: ReadonlyMap<string, string>,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const projects = Object.fromEntries([...projectsByThread.entries()].sort(([left], [right]) => left.localeCompare(right)));
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, projectsByThread: projects }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
