import { describe, expect, it } from "vitest";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import type { RepositorySnapshot, WorktreeStatus } from "@/types/workbench";
import { mergeWorktreeStatus } from "./worktreeStatus";

const snapshot: RepositorySnapshot = {
  ...PREVIEW_SNAPSHOT,
  root: "D:/Projects/servo/.worktrees/a",
  currentBranch: "feat/a",
  headSha: "aabbccddee",
};

function status(overrides: Partial<WorktreeStatus> = {}): WorktreeStatus {
  return {
    root: snapshot.root,
    currentBranch: snapshot.currentBranch,
    headSha: snapshot.headSha,
    dirtyCount: snapshot.dirtyCount,
    stagedCount: snapshot.stagedCount,
    unstagedCount: snapshot.unstagedCount,
    untrackedCount: snapshot.untrackedCount,
    changes: snapshot.changes,
    ...overrides,
  };
}

describe("mergeWorktreeStatus", () => {
  it("preserves the original snapshot when Git status is unchanged", () => {
    expect(mergeWorktreeStatus(snapshot, status({
      root: "d:\\projects\\servo\\.worktrees\\a\\",
      changes: snapshot.changes.map((entry) => ({ ...entry })),
    }))).toBe(snapshot);
  });

  it("only updates porcelain status while keeping branch and worktree inventories", () => {
    const incoming = status({
      dirtyCount: 1, stagedCount: 0, unstagedCount: 0, untrackedCount: 1,
      changes: [{ path: "new.txt", indexStatus: "?", worktreeStatus: "?", kind: "untracked" }],
    });
    const next = mergeWorktreeStatus(snapshot, incoming);
    expect(next).toMatchObject({
      dirtyCount: 1, stagedCount: 0, unstagedCount: 0, untrackedCount: 1,
      changes: incoming.changes,
    });
    expect(next).not.toBe(snapshot);
    expect(next?.branches).toBe(snapshot.branches);
    expect(next?.worktrees).toBe(snapshot.worktrees);
    expect(next?.recentCommits).toBe(snapshot.recentCommits);
  });

  it("requests a full inspection when the worktree, branch or HEAD changed", () => {
    expect(mergeWorktreeStatus(snapshot, status({ root: "D:/Projects/other" }))).toBeNull();
    expect(mergeWorktreeStatus(snapshot, status({ currentBranch: "main" }))).toBeNull();
    expect(mergeWorktreeStatus(snapshot, status({ headSha: "1231231231" }))).toBeNull();
  });
});
