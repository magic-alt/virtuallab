import type { RepositorySnapshot } from "@/types/workbench";

export const PREVIEW_SNAPSHOT: RepositorySnapshot = {
  root: "Preview workspace — add a local Git repository to inspect real data",
  name: "Sample Repository",
  currentBranch: "feat/engineering-workbench-foundation",
  headSha: "preview",
  remoteUrl: "github.com/example-org/sample-repo",
  dirtyCount: 3,
  stagedCount: 1,
  unstagedCount: 1,
  untrackedCount: 1,
  changes: [
    {
      path: "src/features/workspace/WorkspaceContent.tsx",
      indexStatus: "M",
      worktreeStatus: " ",
      kind: "modified",
    },
    {
      path: "src-tauri/src/git.rs",
      indexStatus: " ",
      worktreeStatus: "M",
      kind: "modified",
    },
    {
      path: "docs/ROADMAP.md",
      indexStatus: "?",
      worktreeStatus: "?",
      kind: "untracked",
    },
  ],
  worktrees: [
    {
      path: "/workspace/sample-repo",
      head: "main",
      branch: "main",
      detached: false,
    },
    {
      path: "/workspace/sample-repo-feature",
      head: "feature",
      branch: "feat/engineering-workbench-foundation",
      detached: false,
    },
  ],
  recentCommits: [
    {
      sha: "9f8e4c1",
      subject: "feat: add local repository control plane",
      timestamp: Math.floor(Date.now() / 1000) - 780,
    },
    {
      sha: "61cdb94",
      subject: "chore: scaffold Tauri workbench stack",
      timestamp: Math.floor(Date.now() / 1000) - 4200,
    },
    {
      sha: "dc6e7fa",
      subject: "chore: initialize repository",
      timestamp: Math.floor(Date.now() / 1000) - 7800,
    },
  ],
};
