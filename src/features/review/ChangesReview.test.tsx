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

function response(overrides = {}) {
  return {
    mode: "worktree",
    baseRef: null,
    path: "src/a.ts",
    files: [{ path: "src/a.ts", oldPath: null, status: "M" }],
    patch: "@@ -1 +1 @@\n-old\n+new",
    binary: false,
    truncated: false,
    returnedBytes: 24,
    ...overrides,
  };
}

describe("ChangesReview", () => {
  beforeEach(() => {
    backend.gitDiff.mockReset();
    backend.gitDiff.mockResolvedValue(response());
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

    await user.click(screen.getByRole("button", { name: "src/a.ts" }));

    expect(backend.gitDiff).toHaveBeenCalledWith({
      repositoryRoot: "D:/repo",
      workspaceRoot: "D:/repo",
      path: "src/a.ts",
      mode: "worktree",
      baseRef: null,
    });
    expect(await screen.findByText("+new", { exact: false })).toBeInTheDocument();
  });

  it("filters and loads the staged file list in index mode", async () => {
    const user = userEvent.setup();
    render(
      <ChangesReview
        snapshot={snapshot}
        repositoryRoot="D:/repo"
        workspaceRoot="D:/repo"
        enabled
      />,
    );

    await user.click(screen.getByRole("button", { name: "Staged" }));
    expect(screen.queryByRole("button", { name: "src/a.ts" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "src/b.ts" }));
    expect(backend.gitDiff).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: "src/b.ts",
        mode: "index",
      }),
    );
  });

  it("discovers base-ref files before loading a selected committed diff", async () => {
    backend.gitDiff
      .mockResolvedValueOnce(
        response({
          mode: "base",
          baseRef: "main",
          path: null,
          files: [{ path: "src/committed.ts", oldPath: null, status: "M" }],
          patch: "combined",
        }),
      )
      .mockResolvedValueOnce(
        response({
          mode: "base",
          baseRef: "main",
          path: "src/committed.ts",
          files: [{ path: "src/committed.ts", oldPath: null, status: "M" }],
          patch: "+committed",
        }),
      );

    const user = userEvent.setup();
    render(
      <ChangesReview
        snapshot={{ ...snapshot, dirtyCount: 0, changes: [] }}
        repositoryRoot="D:/repo"
        workspaceRoot="D:/repo"
        enabled
      />,
    );

    await user.click(screen.getByRole("button", { name: "Base" }));
    await user.click(screen.getByRole("button", { name: "Load base files" }));

    expect(backend.gitDiff).toHaveBeenNthCalledWith(1, {
      repositoryRoot: "D:/repo",
      workspaceRoot: "D:/repo",
      path: null,
      mode: "base",
      baseRef: "main",
    });

    await user.click(screen.getByRole("button", { name: "src/committed.ts" }));
    expect(backend.gitDiff).toHaveBeenNthCalledWith(2, {
      repositoryRoot: "D:/repo",
      workspaceRoot: "D:/repo",
      path: "src/committed.ts",
      mode: "base",
      baseRef: "main",
    });
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

    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(backend.gitDiff).not.toHaveBeenCalled();
  });
});
