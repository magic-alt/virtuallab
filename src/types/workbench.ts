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

export interface WorkspaceMutationResult {
  path: string;
  branch: string;
}

export type ProcessProfileKind = "build" | "test";

export interface ProcessProfile {
  id: string;
  name: string;
  kind: ProcessProfileKind;
  repositoryRoot: string;
  program: string;
  args: string[];
}

export interface ProcessSpec {
  id: string;
  cwd: string;
  program: string;
  args: string[];
}

export interface WorkbenchEvent {
  eventType: string;
  id: string;
  stream?: string | null;
  data?: string | null;
  exitCode?: number | null;
  path?: string | null;
  timestampMs: number;
}

export interface TerminalOutput {
  id: string;
  data: number[];
}

export type WorkspaceTab =
  | "overview"
  | "changes"
  | "terminal"
  | "run"
  | "checks"
  | "history";

export interface WorkspacePersistedState {
  repositoryId: string;
  activeWorktreePath: string;
  activeTab: WorkspaceTab;
  updatedAt: number;
}

export type CheckStatus = "pass" | "warn" | "fail" | "running" | "not_run";
export type CheckSource = "repository" | "process";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  source: CheckSource;
  observedAtMs: number;
  exitCode?: number | null;
}


export type DiffMode = "worktree" | "index" | "base";

export interface DiffRequest {
  repositoryRoot: string;
  workspaceRoot: string;
  path?: string | null;
  mode: DiffMode;
  baseRef?: string | null;
}

export interface DiffFileSummary {
  path: string;
  oldPath?: string | null;
  status: string;
}

export interface DiffResponse {
  mode: DiffMode;
  baseRef?: string | null;
  path?: string | null;
  files: DiffFileSummary[];
  patch: string;
  binary: boolean;
  truncated: boolean;
  returnedBytes: number;
}
