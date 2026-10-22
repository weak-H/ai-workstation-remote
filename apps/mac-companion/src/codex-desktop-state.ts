import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { WorkstationProjectSchema, type WorkstationProject } from "@ai-workstation/protocol";
import { z } from "zod";

const LocalProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rootPaths: z.array(z.string().min(1)).catch([]),
  updatedAt: z.number().catch(0),
}).passthrough();

const ThreadAssignmentSchema = z.object({
  projectKind: z.string(),
  projectId: z.string().min(1),
}).passthrough();

const CodexGlobalStateSchema = z.object({
  "local-projects": z.record(z.string(), LocalProjectSchema).catch({}),
  "project-order": z.array(z.string()).catch([]),
  "thread-project-assignments": z.record(z.string(), ThreadAssignmentSchema).catch({}),
  "projectless-thread-ids": z.array(z.string()).catch([]),
}).passthrough();

export interface CodexDesktopState {
  projects: WorkstationProject[];
  projectIdByThreadId: Map<string, string>;
  projectlessThreadIds: Set<string>;
  rootPathByProjectId: Map<string, string>;
}

export function parseCodexDesktopState(input: unknown): CodexDesktopState {
  const state = CodexGlobalStateSchema.parse(input);
  const projectIds = new Set(Object.keys(state["local-projects"]));
  const orderedIds = state["project-order"].filter((id, index, values) => (
    projectIds.has(id) && values.indexOf(id) === index
  ));
  const missingIds = [...projectIds]
    .filter((id) => !orderedIds.includes(id))
    .sort((left, right) => state["local-projects"][right]!.updatedAt - state["local-projects"][left]!.updatedAt);

  const projects = [...orderedIds, ...missingIds].map((id, order) => {
    const project = state["local-projects"][id]!;
    return WorkstationProjectSchema.parse({
      id: project.id,
      name: project.name,
      order,
      source: "codex",
    });
  });

  const projectIdByThreadId = new Map<string, string>();
  for (const [threadId, assignment] of Object.entries(state["thread-project-assignments"])) {
    if (assignment.projectKind === "local" && projectIds.has(assignment.projectId)) {
      projectIdByThreadId.set(threadId, assignment.projectId);
    }
  }

  const rootPathByProjectId = new Map<string, string>();
  for (const [projectId, project] of Object.entries(state["local-projects"])) {
    const rootPath = project.rootPaths[0];
    if (rootPath) rootPathByProjectId.set(projectId, rootPath);
  }

  return {
    projects,
    projectIdByThreadId,
    projectlessThreadIds: new Set(state["projectless-thread-ids"]),
    rootPathByProjectId,
  };
}

export async function loadCodexDesktopState(
  statePath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), ".codex-global-state.json"),
): Promise<CodexDesktopState> {
  const paths = [statePath, `${statePath}.bak`];
  let lastError: unknown;
  for (const path of paths) {
    try {
      return parseCodexDesktopState(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法读取 Codex 桌面项目状态");
}
