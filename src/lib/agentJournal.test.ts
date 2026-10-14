import { describe, expect, it } from "vitest";
import { unresolvedJournalTurns, type AgentJournalEntry } from "./agentJournal";

function row(sequence: number, eventKind: string, turnKey: string | null): AgentJournalEntry {
  return {
    schemaVersion: 1, sequence, eventId: "event-" + sequence, workspaceId: "workspace",
    harness: "codex", threadKey: "thread", turnKey, eventKind, outcome: "unknown",
    timestampMs: sequence, visibility: "metadata_only", redactionStatus: "payload_omitted",
  };
}

describe("native journal recovery interpretation", () => {
  it("does not treat a started but unfinished turn as verified running", () => {
    expect(unresolvedJournalTurns([row(1, "turn.started", "turn-a")])).toEqual(["turn-a"]);
  });

  it("closes a started turn after completion even when results arrive unordered", () => {
    expect(unresolvedJournalTurns([
      row(2, "turn.completed", "turn-a"),
      row(1, "turn.started", "turn-a"),
      row(3, "turn.started", "turn-b"),
    ])).toEqual(["turn-b"]);
  });

  it("never carries turn state between records with unrelated identities", () => {
    expect(unresolvedJournalTurns([
      row(1, "turn.started", "turn-A"),
      row(2, "turn.completed", "turn-B"),
    ])).toEqual(["turn-A"]);
  });
});
