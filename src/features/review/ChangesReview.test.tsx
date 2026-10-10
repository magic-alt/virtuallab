import { act, render, screen } from "@testing-library/react";
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
  branches: [{ name: "feat/review", local: true, remote: false, worktreePath: "D:/repo" }],
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

  it("shows untracked files and grouped directories without requesting a tracked diff", async () => {
    const user = userEvent.setup();
    const untrackedSnapshot: RepositorySnapshot = {
      ...snapshot, dirtyCount: 2, stagedCount: 0, unstagedCount: 0, untrackedCount: 2,
      changes: [
        { path: "new file.ts", indexStatus: "?", worktreeStatus: "?", kind: "untracked" },
        { path: "generated/", indexStatus: "?", worktreeStatus: "?", kind: "untracked" },
      ],
    };
    render(<ChangesReview snapshot={untrackedSnapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: "new file.ts" }));
    expect(screen.getByText("Untracked file")).toBeInTheDocument();
    expect(backend.gitDiff).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "generated/" }));
    expect(screen.getByText("Untracked directory")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Staged" }));
    expect(screen.queryByRole("button", { name: "new file.ts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "generated/" })).not.toBeInTheDocument();
    expect(screen.queryByText("Untracked directory")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Base" }));
    expect(screen.queryByRole("button", { name: "new file.ts" })).not.toBeInTheDocument();
  });

  it("clears a loaded diff when selecting an untracked item", async () => {
    const user = userEvent.setup();
    render(<ChangesReview snapshot={{ ...snapshot, dirtyCount: 3, untrackedCount: 1, changes: [
      ...snapshot.changes,
      { path: "新 file.ts", indexStatus: "?", worktreeStatus: "?", kind: "untracked" },
    ] }} repositoryRoot="D:/repo" workspaceRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    await screen.findByTestId("monaco-review");
    await user.click(screen.getByRole("button", { name: "新 file.ts" }));
    expect(screen.queryByTestId("monaco-review")).not.toBeInTheDocument();
    expect(screen.getByText("Untracked file")).toBeInTheDocument();
    expect(backend.gitDiff).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(await screen.findByTestId("monaco-review")).toBeInTheDocument();
  });

  it("discards a pending tracked diff after selecting an untracked item", async () => {
    let resolveDiff!: (value: ReturnType<typeof response>) => void;
    backend.gitDiff.mockImplementationOnce(() => new Promise((resolve) => { resolveDiff = resolve; }));
    const user = userEvent.setup();
    render(<ChangesReview snapshot={{ ...snapshot, dirtyCount: 3, untrackedCount: 1, changes: [
      ...snapshot.changes,
      { path: "new.ts", indexStatus: "?", worktreeStatus: "?", kind: "untracked" },
    ] }} repositoryRoot="D:/repo" workspaceRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: "src/a.ts" }));
    await user.click(screen.getByRole("button", { name: "new.ts" }));
    await act(async () => { resolveDiff(response()); });
    expect(screen.getByText("Untracked file")).toBeInTheDocument();
    expect(screen.queryByTestId("monaco-review")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeDisabled();
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

  it("discards an in-flight diff response after workspace refresh", async()=>{
    let resolveDiff: ((value: ReturnType<typeof response>) => void) | undefined;
    backend.gitDiff.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDiff = resolve;
    }));
    const user=userEvent.setup();
    const view=render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo"
      workspaceRoot="D:/repo" enabled refreshRevision={1} />);
    await user.click(screen.getByRole("button",{name:"src/a.ts"}));
    view.rerender(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo"
      workspaceRoot="D:/repo" enabled refreshRevision={2} />);
    resolveDiff?.(response());
    expect(await screen.findByText(/Diff invalidated by workspace refresh/)).toBeInTheDocument();
    expect(screen.queryByTestId("monaco-review")).not.toBeInTheDocument();
  });


  it("exposes a reversible Stash all action for tracked and grouped untracked changes", async () => {
    const user = userEvent.setup();
    const recover = vi.fn().mockResolvedValue(true);
    const source = { ...snapshot, dirtyCount: 3, untrackedCount: 1, changes: [
      ...snapshot.changes,
      { path: "hardware/.history/", indexStatus: "?", worktreeStatus: "?", kind: "untracked" as const },
    ] };
    render(<ChangesReview snapshot={source} repositoryRoot="D:/repo" workspaceRoot="D:/repo"
      enabled onResolveLocalChanges={recover} />);
    expect(screen.getByRole("button", { name: "Discard all tracked…" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Stash all (safe)" }));
    expect(recover).toHaveBeenCalledWith("stashAll", undefined);
  });

  it("discards only the selected tracked change even when Staged mode is active", async () => {
    const user = userEvent.setup();
    const recover = vi.fn().mockResolvedValue(true);
    render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo"
      enabled onResolveLocalChanges={recover} />);
    await user.click(screen.getByRole("button", { name: "Staged" }));
    await user.click(screen.getByRole("button", { name: "src/b.ts" }));
    await user.click(screen.getByRole("button", { name: "Discard selected tracked…" }));
    expect(recover).toHaveBeenCalledWith("discardTrackedSelected", "src/b.ts");
  });

  it("cleans selected untracked directories only after explicit selection", async () => {
    const user = userEvent.setup();
    const recover = vi.fn().mockResolvedValue(true);
    const source = { ...snapshot, dirtyCount: 1, stagedCount: 0, unstagedCount: 0, untrackedCount: 1,
      changes: [{ path: "hardware/.history/", indexStatus: "?", worktreeStatus: "?", kind: "untracked" as const }] };
    render(<ChangesReview snapshot={source} repositoryRoot="D:/repo" workspaceRoot="D:/repo"
      enabled onResolveLocalChanges={recover} />);
    expect(screen.queryByRole("button", { name: "Delete selected untracked…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard all tracked…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "hardware/.history/" }));
    await user.click(screen.getByRole("button", { name: "Delete selected untracked…" }));
    expect(recover).toHaveBeenCalledWith("deleteUntrackedSelected", "hardware/.history/");
  });

  it("blocks repeat recovery while native confirmation is still pending", async () => {
    const user = userEvent.setup();
    let finish!: (value: boolean) => void;
    const recover = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo"
      enabled onResolveLocalChanges={recover} />);
    await user.click(screen.getByRole("button", { name: "Discard all tracked…" }));
    expect(screen.getByRole("button", { name: "Discard all tracked…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    await act(async () => { finish(false); });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Discard all tracked…" })).toBeEnabled();
  });

  it("disables recovery when Git is busy or the native callback is unavailable", () => {
    const recover = vi.fn();
    const view = render(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo"
      enabled gitMutationPending onResolveLocalChanges={recover} />);
    expect(screen.getByRole("button", { name: "Stash all (safe)" })).toBeDisabled();
    view.rerender(<ChangesReview snapshot={snapshot} repositoryRoot="D:/repo" workspaceRoot="D:/repo"
      enabled={false} onResolveLocalChanges={recover} />);
    expect(screen.getByRole("button", { name: "Stash all (safe)" })).toBeDisabled();
  });

});
