import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewWorkspaceKey, useWorkbenchStore } from "@/stores/workbench";
import { ChangesReview } from "./ChangesReview";
import type { RepositorySnapshot } from "@/types/workbench";

const backend = vi.hoisted(() => ({ gitDiff: vi.fn() }));

vi.mock("@/lib/backend", () => ({ gitDiff: backend.gitDiff }));
vi.mock("./MonacoReviewSurface", () => ({
  MonacoReviewSurface: ({
    path,
    layout,
    onReviewLineSelect,
  }: {
    path: string;
    layout: string;
    onReviewLineSelect?: (selection: { line: number; side: "LEFT" | "RIGHT" }) => void;
  }) => (
    <div>
      <div data-testid="monaco-review">{path}:{layout}</div>
      <button onClick={() => onReviewLineSelect?.({ line: 12, side: "RIGHT" })} type="button">
        Select review line
      </button>
    </div>
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
    useWorkbenchStore.setState({ reviewStates: {} });
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

  it("creates and persists a line-scoped local review draft", async () => {
    const user = userEvent.setup();
    render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    await user.click(await screen.findByRole("button", { name: "Select review line" }));
    await user.type(screen.getByRole("textbox", { name: "Review draft body" }), "Please tighten this guard.");
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    const drafts =
      useWorkbenchStore.getState().reviewStates[reviewWorkspaceKey("D:/repo")]?.drafts ?? [];
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual(
      expect.objectContaining({
        path: "src/a.ts",
        line: 12,
        side: "RIGHT",
        headSha: "1234567890",
        body: "Please tighten this guard.",
        status: "active",
      }),
    );
    expect(screen.getByText("Please tighten this guard.")).toBeInTheDocument();
  });

  it("keeps the Monaco review area flex-sized instead of fixed-height", async () => {
    const user = userEvent.setup();
    render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    await screen.findByTestId("monaco-review");

    expect(screen.getByTestId("changes-review-root")).toHaveClass("h-full", "w-full", "flex");
    expect(screen.getByTestId("changes-review-grid")).toHaveClass("min-h-0", "flex-1");
    expect(screen.getByTestId("changes-file-list")).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(screen.getByTestId("changes-review-editor")).toHaveClass("min-h-0", "overflow-hidden");
    expect(screen.getByTestId("changes-review-editor-body")).toHaveClass("min-h-0", "flex-1", "overflow-hidden");
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
  it("invalidates an open diff on workspace refresh until it is loaded again", async()=>{
    const user=userEvent.setup();
    const view=render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo"
      workspaceRoot="D:/repo" enabled refreshRevision={1} />);
    await user.click(screen.getByRole("button",{name:"src/a.ts"}));
    expect(await screen.findByTestId("monaco-review")).toBeInTheDocument();
    view.rerender(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo"
      workspaceRoot="D:/repo" enabled refreshRevision={2} />);
    expect(screen.getByText(/Diff invalidated by workspace refresh/)).toBeInTheDocument();
    expect(screen.queryByTestId("monaco-review")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"src/a.ts"}));
    expect(await screen.findByTestId("monaco-review")).toBeInTheDocument();
    expect(screen.queryByText(/Diff invalidated by workspace refresh/)).not.toBeInTheDocument();
  });

  it("tracks the fix and re-review phase without editing repository files",async()=>{
    const user=userEvent.setup();
    const onRefreshForRereview=vi.fn().mockResolvedValue(undefined);
    render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo"
      workspaceRoot="D:/repo" enabled onRefreshForRereview={onRefreshForRereview} />);
    await user.click(screen.getByRole("button",{name:"Mark fix in progress"}));
    expect(useWorkbenchStore.getState().reviewStates[reviewWorkspaceKey("D:/repo")]?.phase).toBe("fix");
    await user.click(screen.getByRole("button",{name:"Refresh and re-review"}));
    expect(onRefreshForRereview).toHaveBeenCalledWith("D:/repo");
  });

});
