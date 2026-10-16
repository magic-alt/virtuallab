import type { ChangeEntry, RepositorySnapshot, WorktreeStatus } from "@/types/workbench";
import { workspaceKey } from "@/lib/workspaceKey";

function sameChanges(left: ChangeEntry[], right: ChangeEntry[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return item.path === other.path &&
      item.oldPath === other.oldPath &&
      item.kind === other.kind &&
      item.indexStatus === other.indexStatus &&
      item.worktreeStatus === other.worktreeStatus;
  });
}

/**
 * Preserve the inventory and reference identity of a workspace on file edits.
 * A different HEAD, branch, or worktree requires a full repository inspection.
 * The unchanged result preserves React state and avoids unnecessary diffs.
 */
export function mergeWorktreeStatus(
  snapshot: RepositorySnapshot,
  status: WorktreeStatus,
): RepositorySnapshot | null {
  if (workspaceKey(snapshot.root) !== workspaceKey(status.root) ||
      snapshot.headSha !== status.headSha ||
      snapshot.currentBranch !== status.currentBranch) return null;

  if (snapshot.dirtyCount === status.dirtyCount &&
      snapshot.stagedCount === status.stagedCount &&
      snapshot.unstagedCount === status.unstagedCount &&
      snapshot.untrackedCount === status.untrackedCount &&
      sameChanges(snapshot.changes, status.changes)) return snapshot;

  return {
    ...snapshot,
    dirtyCount: status.dirtyCount,
    stagedCount: status.stagedCount,
    unstagedCount: status.unstagedCount,
    untrackedCount: status.untrackedCount,
    changes: status.changes,
  };
}
