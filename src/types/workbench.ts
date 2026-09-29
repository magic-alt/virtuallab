export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "other";

export interface ChangeEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: ChangeKind;
}

export interface WorktreeSummary {
  path: string;
  head: string;
  branch?: string | null;
  detached: boolean;
}

export interface CommitSummary {
  sha: string;
  subject: string;
  timestamp: number;
}

export interface RepositorySnapshot {
  root: string;
  name: string;
  currentBranch: string;
  headSha: string;
  remoteUrl?: string | null;
  dirtyCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  changes: ChangeEntry[];
  worktrees: WorktreeSummary[];
  recentCommits: CommitSummary[];
}

export interface RepositoryRecord {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: number;
}

export type WorkspaceTab =
  | "overview"
  | "changes"
  | "terminal"
  | "checks"
  | "history";
