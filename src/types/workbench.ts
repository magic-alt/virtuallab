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
  oldPath?: string | null;
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

export interface BranchSummary {
  name: string;
  local: boolean;
  remote: boolean;
  worktreePath?: string | null;
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
  originDefaultBranch?: string | null;
  dirtyCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  changes: ChangeEntry[];
  worktrees: WorktreeSummary[];
  branches: BranchSummary[];
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

export type ProcessProfileKind = "build" | "test" | "package" | "deploy";

export interface BuildStep {
  name: string;
  program: string;
  args: string[];
}

export interface BuildSuggestion {
  id: string;
  name: string;
  kind: ProcessProfileKind;
  tool: string;
  description: string;
  supported: boolean;
  steps: BuildStep[];
}

export interface BuildWorkflowSpec {
  id: string;
  cwd: string;
  steps: BuildStep[];
}

export interface BuildWorkflowEvent {
  eventType: "build.started" | "build.step_started" | "build.output" |
    "build.step_exited" | "build.finished";
  id: string;
  stepIndex?: number | null;
  stepName?: string | null;
  stream?: "stdout" | "stderr" | "system" | null;
  data?: string | null;
  exitCode?: number | null;
  result?: "passed" | "failed" | "stopped" | null;
  timestampMs: number;
}

export interface ProcessProfile {
  id: string;
  name: string;
  kind: ProcessProfileKind;
  repositoryRoot: string;
  program: string;
  args: string[];
  /** Multi-step profiles use steps. Legacy profiles use program + args. */
  steps?: BuildStep[];
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
  | "github"
  | "agents"
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

export type ReviewDraftSide = "LEFT" | "RIGHT";
export type ReviewDraftStatus = "active" | "stale" | "posted";

export interface ReviewLineSelection {
  line: number;
  side: ReviewDraftSide;
}

export interface ReviewDraft {
  id: string;
  workspaceRoot: string;
  headSha: string;
  path: string;
  line: number;
  side: ReviewDraftSide;
  body: string;
  status: ReviewDraftStatus;
  createdAt: number;
  updatedAt: number;
  postedAt?: number | null;
  postedUrl?: string | null;
}

export type ReviewLoopPhase = "review" | "fix" | "needs_rereview" | "reviewed";

export interface ReviewWorkspaceRequest {
  reference: string;
  kind: "issue" | "pr";
  number: number;
}

export interface WorkspaceReviewState {
  phase?: ReviewLoopPhase;
  lastReviewedHead?: string | null;
  lastRefreshAt?: number | null;
  workspaceRoot: string;
  drafts: ReviewDraft[];
  githubReference?: string | null;
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
  oldPath?: string | null;
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
  oldPath?: string | null;
  files: DiffFileSummary[];
  patch: string;
  binary: boolean;
  truncated: boolean;
  returnedBytes: number;
  originalText?: string | null;
  modifiedText?: string | null;
  contentTruncated: boolean;
}

export interface GithubCapabilities {
  installed: boolean;
  authenticated: boolean;
  repository?: string | null;
  mode: "connected" | "local_only";
  detail: string;
}

export interface GithubCheck {
  name: string;
  status: string;
  conclusion?: string | null;
  url?: string | null;
}

export interface GithubCheckSummary {
  total: number;
  success: number;
  pending: number;
  failure: number;
  neutral: number;
  checks: GithubCheck[];
}

export interface GithubChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface GithubPullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  baseSha?: string | null;
  isDraft: boolean;
  author?: string | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  changedFiles: GithubChangedFile[];
  checks: GithubCheckSummary;
}

export interface GithubPullRequestList {
  capabilities: GithubCapabilities;
  pullRequests: GithubPullRequest[];
}

export type GithubMergeMethod = "squash" | "merge" | "rebase";

export interface GithubMergeRequest {
  workspaceRoot: string;
  repository: string;
  prNumber: number;
  expectedHeadSha: string;
  mergeMethod: GithubMergeMethod;
}

export interface GithubMergeResponse {
  merged: boolean;
  sha?: string | null;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  author?: string | null;
  labels: string[];
}

export interface GithubContext {
  capabilities: GithubCapabilities;
  reference?: string | null;
  pullRequest?: GithubPullRequest | null;
  issue?: GithubIssue | null;
}

export interface GithubPostReviewCommentRequest {
  workspaceRoot: string;
  repository: string;
  prNumber: number;
  commitId: string;
  path: string;
  line: number;
  side: ReviewDraftSide;
  body: string;
}

export interface GithubPostReviewCommentResponse {
  id: number;
  url: string;
}
