import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "./backend";

/** Read-only persisted native metadata, never raw prompts or model output. */
export interface AgentJournalEntry {
  schemaVersion: number;
  sequence: number;
  eventId: string;
  workspaceId: string;
  harness: "codex" | "deepseek" | "claude" | "opencode" | "unknown";
  threadKey: string | null;
  turnKey: string | null;
  eventKind: string;
  outcome: string;
  timestampMs: number;
  visibility: "metadata_only";
  redactionStatus: "payload_omitted";
}

/** Native replay never resumes or re-executes a historical task. */
export interface RecoveredAgentTurn {
  turnKey: string;
  state: "completed" | "failed" | "cancelled" | "unverified" | "in_flight_unverified";
  lastSequence: number;
  harness: AgentJournalEntry["harness"];
}

export interface AgentRecoverySnapshot {
  workspaceId: string;
  nativeSessionRegistered: boolean;
  turns: RecoveredAgentTurn[];
  retainedEvents: number;
}

export async function agentJournalRecover(workspaceRoot: string): Promise<AgentRecoverySnapshot> {
  if (!isDesktopRuntime()) {
    return { workspaceId: "", nativeSessionRegistered: false, turns: [], retainedEvents: 0 };
  }
  if (!workspaceRoot.trim()) throw new Error("Workspace path is required for journal recovery");
  return invoke<AgentRecoverySnapshot>("agent_journal_recover", { workspaceRoot });
}

/** Destructive privacy action: caller MUST obtain a native human confirmation. */
export async function agentJournalPurgeAll(): Promise<void> {
  if (!isDesktopRuntime()) throw new Error("The native desktop runtime is required");
  return invoke("agent_journal_purge_all");
}

export function unverifiedRecoveredTurns(recovery: AgentRecoverySnapshot | null): RecoveredAgentTurn[] {
  return recovery?.turns.filter((turn) => turn.state === "unverified" ||
    turn.state === "in_flight_unverified") ?? [];
}

export async function agentJournalRecent(workspaceRoot: string, limit = 100): Promise<AgentJournalEntry[]> {
  if (!isDesktopRuntime()) return [];
  if (!workspaceRoot.trim()) throw new Error("Workspace path is required for journal history");
  const entries = await invoke<AgentJournalEntry[]>("agent_journal_recent", { workspaceRoot, limit });
  // Defensive sorting/de-duplication; never allow a stale native response to
  // confuse ordering when the operator switches workspaces.
  return [...new Map(entries.map((entry) => [entry.eventId, entry])).values()]
    .sort((left, right) => left.sequence - right.sequence);
}

/** A saved turn start does not prove a process survived application restart. */
export function unresolvedJournalTurns(entries: AgentJournalEntry[]): string[] {
  const open = new Set<string>();
  for (const entry of [...entries].sort((a, b) => a.sequence - b.sequence)) {
    if (!entry.turnKey) continue;
    if (entry.eventKind === "turn.started") open.add(entry.turnKey);
    if (entry.eventKind === "turn.completed" || entry.eventKind === "process.exited" ||
        entry.eventKind === "session.stopped") open.delete(entry.turnKey);
  }
  return [...open];
}
