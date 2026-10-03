export type AgentHarnessKind = "codex";

export interface AgentHarnessFeatures {
  persistentThreads: boolean;
  turns: boolean;
  steering: boolean;
  interrupt: boolean;
  structuredEvents: boolean;
}

export interface AgentHarnessCapabilities {
  harness: AgentHarnessKind;
  available: boolean;
  version?: string | null;
  detail: string;
  features: AgentHarnessFeatures;
}

export interface AgentSessionBinding {
  workspaceRoot: string;
  harness: AgentHarnessKind;
  threadId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AgentSessionStartRequest {
  workspaceRoot: string;
  harness: AgentHarnessKind;
  threadId?: string | null;
}

export interface AgentTurnStartRequest {
  workspaceRoot: string;
  threadId: string;
  text: string;
}

export interface AgentTurnStartResult {
  threadId: string;
  turnId: string;
}

export interface AgentTurnSteerRequest {
  workspaceRoot: string;
  threadId: string;
  turnId: string;
  text: string;
}

export interface AgentTurnInterruptRequest {
  workspaceRoot: string;
  threadId: string;
  turnId: string;
}

export interface AgentEvent {
  eventType: string;
  workspaceRoot: string;
  threadId?: string | null;
  turnId?: string | null;
  method?: string | null;
  payload?: unknown;
  timestampMs: number;
}
