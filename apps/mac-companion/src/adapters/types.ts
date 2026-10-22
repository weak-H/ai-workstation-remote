import type {
  AgentCapability,
  AgentSource,
  MobileCommand,
  WorkstationProject,
  WorkstationEvent,
} from "@ai-workstation/protocol";

export type EmitEvent = (event: WorkstationEvent) => void;
export type EmitProjects = (projects: readonly WorkstationProject[]) => void;
export type EmitAvailability = (active: boolean) => void;

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly source: AgentSource;
  readonly capabilities: readonly AgentCapability[];

  start(emit: EmitEvent, emitProjects: EmitProjects, emitAvailability?: EmitAvailability): Promise<void> | void;
  currentTaskIds(): readonly string[];
  taskCapabilities(taskId: string): readonly AgentCapability[];
  handleCommand(command: MobileCommand, emit: EmitEvent): Promise<void>;
  createTask(command: MobileCommand, emit: EmitEvent): Promise<void>;
}

