import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangesReview } from "./ChangesReview";
import type { RepositorySnapshot } from "@/types/workbench";

const backend = vi.hoisted(() => ({ gitDiff: vi.fn() }));

vi.mock("@/lib/backend", () => ({ gitDiff: backend.gitDiff }));
vi.mock("./MonacoReviewSurface", () => ({
  MonacoReviewSurface: ({ path, layout }: { path: string; layout: string }) => (
    <div data-testid="monaco-review">{path}:{layout}</div>
  ),
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
    oldPath: null,
    files: [{ path: "src/a.ts", oldPath: null, status: "M" }],
    patch: "@@ -1 +1 @@\n-old\n+new",
    binary: false,
    truncated: false,
    returnedBytes: 24,
    originalText: "old\n",
    modifiedText: "new\n",
    contentTruncated: false,
    ...overrides,
  };
}

describe("ChangesReview", () => {
  beforeEach(() => {
    backend.gitDiff.mockReset();
    backend.gitDiff.mockResolvedValue(response());
  });

  it("loads a typed worktree diff and renders Monaco", async () => {
    const user = userEvent.setup();
    render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(backend.gitDiff).toHaveBeenCalledWith({
      repositoryRoot: "D:/repo",
      workspaceRoot: "D:/repo",
      path: "src/a.ts",
      oldPath: null,
      mode: "worktree",
      baseRef: null,
    });
    expect(await screen.findByTestId("monaco-review")).toHaveTextContent("src/a.ts:side-by-side");
  });

  it("switches Monaco layout without reloading Git", async () => {
    const user = userEvent.setup();
    render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(await screen.findByTestId("monaco-review")).toHaveTextContent("side-by-side");
    const calls = backend.gitDiff.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Unified" }));
    expect(screen.getByTestId("monaco-review")).toHaveTextContent("unified");
    expect(backend.gitDiff).toHaveBeenCalledTimes(calls);
  });

  it("filters staged files", async () => {
    const user = userEvent.setup();
    render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: "Staged" }));
    expect(screen.queryByRole("button", { name: "src/a.ts" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "src/b.ts" }));
    expect(backend.gitDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: "src/b.ts", mode: "index" }));
  });

  it("discovers base files and sends rename identity", async () => {
    backend.gitDiff
      .mockResolvedValueOnce(response({
        mode: "base", baseRef: "main", path: null,
        files: [{ path: "src/new.ts", oldPath: "src/old.ts", status: "R100" }],
        patch: "", originalText: null, modifiedText: null,
      }))
      .mockResolvedValueOnce(response({
        mode: "base", baseRef: "main", path: "src/new.ts", oldPath: "src/old.ts",
        files: [{ path: "src/new.ts", oldPath: "src/old.ts", status: "R100" }],
      }));
    const user = userEvent.setup();
    render(<ChangesReview snapshot={{...snapshot, changes: [], dirtyCount: 0}} repositoryRoot="D:/repo" workspaceRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: "Base" }));
    await user.click(screen.getByRole("button", { name: "Load base files" }));
    await user.click(screen.getByRole("button", { name: "src/old.ts → src/new.ts" }));
    expect(backend.gitDiff).toHaveBeenLastCalledWith({
      repositoryRoot:"D:/repo", workspaceRoot:"D:/repo", path:"src/new.ts", oldPath:"src/old.ts", mode:"base", baseRef:"main"
    });
  });

  it("shows explicit binary and truncated states", async () => {
    backend.gitDiff.mockResolvedValueOnce(response({binary:true, originalText:null, modifiedText:null}));
    const user = userEvent.setup();
    render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(await screen.findByText("Binary diff")).toBeInTheDocument();

    backend.gitDiff.mockResolvedValueOnce(response({truncated:true, contentTruncated:true}));
    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(await screen.findByText("truncated")).toBeInTheDocument();
    expect(screen.getByText(/Large diff content was bounded/)).toBeInTheDocument();
  });

  it("does not invoke native diff in preview mode", async () => {
    const user = userEvent.setup();
    render(<ChangesReview snapshot={snapshot} repositoryRoot="preview" workspaceRoot="preview" enabled={false} />);
    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(backend.gitDiff).not.toHaveBeenCalled();
  });
});
