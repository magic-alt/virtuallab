import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangesReview } from "./ChangesReview";
import type { RepositorySnapshot } from "@/types/workbench";

const backend = vi.hoisted(() => ({
  gitDiff: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  gitDiff: backend.gitDiff,
}));

const snapshot: RepositorySnapshot = {
  root: "D:/repo",
  name: "repo",
  currentBranch: "feat/review",
  headSha: "1234567890",
  remoteUrl: null,
  dirtyCount: 2,
  stagedCount: 1,
  unstagedCount: 1,
  untrackedCount: 0,
  changes: [
    { path: "src/a.ts", indexStatus: " ", worktreeStatus: "M", kind: "modified" },
    { path: "src/b.ts", indexStatus: "A", worktreeStatus: " ", kind: "added" },
  ],
  worktrees: [{ path: "D:/repo", head: "1234567890", branch: "feat/review", detached: false }],
  recentCommits: [],
};

describe("ChangesReview", () => {
  beforeEach(() => {
    backend.gitDiff.mockReset();
    backend.gitDiff.mockResolvedValue({
      mode: "worktree",
      baseRef: null,
      path: "src/a.ts",
      files: [{ path: "src/a.ts", oldPath: null, status: "M" }],
      patch: "@@ -1 +1 @@\n-old\n+new",
      binary: false,
      truncated: false,
      returnedBytes: 24,
    });
  });

  it("loads a typed worktree diff for the selected file", async () => {
    const user = userEvent.setup();
    render(
      <ChangesReview
        snapshot={snapshot}
        repositoryRoot="D:/repo"
        workspaceRoot="D:/repo"
        enabled
      />,
    );

    await user.click(screen.getByRole("button", { name: /src\/a\.ts/i }));

    expect(backend.gitDiff).toHaveBeenCalledWith({
      repositoryRoot: "D:/repo",
      workspaceRoot: "D:/repo",
      path: "src/a.ts",
      mode: "worktree",
      baseRef: null,
    });
    expect(await screen.findByText("+new", { exact: false })).toBeInTheDocument();
  });

  it("switches to staged mode without exposing a shell command", async () => {
    const user = userEvent.setup();
    render(
      <ChangesReview
        snapshot={snapshot}
        repositoryRoot="D:/repo"
        workspaceRoot="D:/repo"
        enabled
      />,
    );

    await user.click(screen.getByRole("button", { name: /src\/b\.ts/i }));
    await user.click(screen.getByRole("button", { name: "Staged" }));

    expect(backend.gitDiff).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: "src/b.ts",
        mode: "index",
      }),
    );
  });

  it("does not invoke native diff in preview mode", async () => {
    const user = userEvent.setup();
    render(
      <ChangesReview
        snapshot={snapshot}
        repositoryRoot="preview"
        workspaceRoot="preview"
        enabled={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /src\/a\.ts/i }));
    expect(backend.gitDiff).not.toHaveBeenCalled();
  });
});
