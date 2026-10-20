import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { useWorkbenchStore } from "@/stores/workbench";
import { useTaskNotifications } from "@/stores/taskNotifications";
import type { AgentEvent } from "@/types/agent";
import type { RepositorySnapshot, WorktreeStatus } from "@/types/workbench";

const harness = vi.hoisted(() => ({
  inspect: vi.fn(),
  inspectStatus: vi.fn(),
  watchStart: vi.fn(),
  watchStop: vi.fn(),
  desktopNotify: vi.fn().mockResolvedValue(undefined),
  listeners: new Map<string, (event: { payload: { id: string; eventType: string } }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (channel: string, callback: (event: { payload: { id: string; eventType: string } }) => void) => {
    harness.listeners.set(channel, callback);
    return () => { if (harness.listeners.get(channel) === callback) harness.listeners.delete(channel); };
  }),
}));

vi.mock("@/lib/backend", () => ({
  isDesktopRuntime: () => true,
  getAppBuildInfo: vi.fn().mockResolvedValue({
    version: "0.5.0", gitCommit: "aaaaaaaaaa", gitBranch: "main",
    gitDirty: false, builtAtUnixSeconds: 1791849600, profile: "release",
  }),
  inspectRepository: harness.inspect,
  inspectWorktreeStatus: harness.inspectStatus,
  watchStart: harness.watchStart,
  watchStop: harness.watchStop,
  desktopNotify: harness.desktopNotify,
  chooseRepositoryDirectory: vi.fn(),
  openWorkspaceDirectory: vi.fn().mockResolvedValue(undefined),
  openWorkspaceInEditor: vi.fn().mockResolvedValue(undefined),
  createWorktree: vi.fn(),
  gitSwitchBranch: vi.fn(),
  gitFetchOrigin: vi.fn(),
  gitPullCurrent: vi.fn(),
  deleteLocalBranchAfterConfirmation: vi.fn(),
  deleteOriginBranchAfterConfirmation: vi.fn(),
  removeWorktreeAfterConfirmation: vi.fn(),
  resolveLocalChangesAfterConfirmation: vi.fn(),
}));

vi.mock("@/features/workspace/WorkspaceContent", () => ({
  WorkspaceContent: ({ snapshot, snapshotRevision }: {
    snapshot: RepositorySnapshot; snapshotRevision: number;
  }) => <div data-testid="live-status" data-dirty={snapshot.dirtyCount} data-revision={snapshotRevision} />,
}));

import { WorkbenchShell } from "./WorkbenchShell";

const primary = "/fixtures/virtuallab";
const secondary = "/fixtures/second-repo";
const initialBranch = "feat/agent";
const initialHead = "1111111111";

function snapshot(root = primary, branch = initialBranch, head = initialHead): RepositorySnapshot {
  return {
    ...PREVIEW_SNAPSHOT, root, name: root === primary ? "virtuallab" : "second-repo",
    currentBranch: branch, headSha: head,
    remoteUrl: null, dirtyCount: 0, stagedCount: 0, unstagedCount: 0, untrackedCount: 0,
    changes: [],
    worktrees: [{ path: root, branch, head, detached: false }],
    branches: [
      { name: "main", local: true, remote: false, worktreePath: branch === "main" ? root : null },
      { name: initialBranch, local: true, remote: false, worktreePath: branch === initialBranch ? root : null },
    ],
  };
}

function status(next: RepositorySnapshot): WorktreeStatus {
  const { root, currentBranch, headSha, dirtyCount, stagedCount, unstagedCount, untrackedCount, changes } = next;
  return { root, currentBranch, headSha, dirtyCount, stagedCount, unstagedCount, untrackedCount, changes };
}

const linked = "/fixtures/linked workspace 工程";

function linkedSnapshot(): RepositorySnapshot {
  return {
    ...snapshot(linked), name: "virtuallab",
    worktrees: [
      { path: primary, branch: "main", head: "2222222222", detached: false },
      { path: linked, branch: initialBranch, head: initialHead, detached: false },
    ],
    branches: [
      { name: "main", local: true, remote: true, worktreePath: primary },
      { name: initialBranch, local: true, remote: false, worktreePath: linked },
      { name: "feat/already-deleted", local: false, remote: true, worktreePath: null },
    ],
  };
}

function rememberLinkedWorkspace() {
  useWorkbenchStore.setState({
    workspaceStates: {
      "repo-1": {
        repositoryId: "repo-1", activeWorktreePath: linked,
        activeTab: "changes", updatedAt: 1,
      },
    },
  });
}

async function changed(eventType = "fs.changed") {
  await waitFor(() => expect(harness.watchStart).toHaveBeenCalled());
  await waitFor(() => expect(harness.listeners.has("workbench://event")).toBe(true));
  const id = harness.watchStart.mock.lastCall?.[0] as string;
  act(() => harness.listeners.get("workbench://event")?.({
    payload: { id, eventType },
  }));
}

describe("workbench quiet filesystem refresh", () => {
  beforeEach(() => {
    harness.listeners.clear();
    harness.inspect.mockReset().mockImplementation(async (path: string) => snapshot(path));
    harness.inspectStatus.mockReset().mockImplementation(async (path: string) => status(snapshot(path)));
    harness.watchStart.mockReset().mockResolvedValue(undefined);
    harness.watchStop.mockReset().mockResolvedValue(undefined);
    useWorkbenchStore.setState({
      repositories: [{ id: "repo-1", name: "virtuallab", path: primary, lastOpenedAt: 1 }],
      activeRepositoryId: "repo-1",
      workspaceStates: {},
    });
  });

  it("notifies for Agent completion when its retained workspace is hidden by the task view", async () => {
    useWorkbenchStore.setState({ workspaceStates: {
      "repo-1": { repositoryId: "repo-1", activeWorktreePath: primary, activeTab: "agents", updatedAt: 1 },
    } });
    useTaskNotifications.setState({ notices: [], desktopEnabled: true, desktopError: null });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    await waitFor(() => expect(harness.listeners.has("agent://event")).toBe(true));
    await screen.findByRole("button", { name: "Switch to main" });
    const complete = (turnId: string) => {
      const payload: AgentEvent = { eventType: "agent.turn_completed", workspaceRoot: primary,
        threadId: "thread-visibility", turnId, payload: { status: "completed" }, timestampMs: 1 };
      const callback = harness.listeners.get("agent://event") as unknown as (event: { payload: AgentEvent }) => void;
      act(() => callback({ payload }));
    };

    complete("visible-turn");
    expect(harness.desktopNotify).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "控制中心" }));
    complete("hidden-turn");
    await waitFor(() => expect(harness.desktopNotify).toHaveBeenCalledWith(
      "Agent task completed", "Agent turn completed. Open Agents to review.",
    ));
    expect(useTaskNotifications.getState().notices).toHaveLength(2);
  });

  it("coalesces Agent write bursts and never disables or remounts Git branch buttons", async () => {
    const dirty = {
      ...snapshot(), dirtyCount: 1, untrackedCount: 1,
      changes: [{ path: "generated.txt", indexStatus: "?", worktreeStatus: "?", kind: "untracked" as const }],
    };
    harness.inspectStatus.mockResolvedValue(status(dirty));
    render(<WorkbenchShell />);
    const button = await screen.findByRole("button", { name: "Switch to main" });
    await waitFor(() => expect(button).toBeEnabled());

    await waitFor(() => expect(harness.watchStart).toHaveBeenCalled());
    await waitFor(() => expect(harness.listeners.has("workbench://event")).toBe(true));
    const id = harness.watchStart.mock.lastCall?.[0] as string;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        for (let i = 0; i < 3; i += 1) {
          harness.listeners.get("workbench://event")?.({ payload: { id, eventType: "fs.changed" } });
        }
      });
      expect(button).toBeEnabled();
      expect(harness.inspect).toHaveBeenCalledTimes(1);

      // Advance the debounce clock explicitly: this tests coalescing rather
      // than spending the test's wall-clock budget waiting on a busy runner.
      await act(async () => { await vi.advanceTimersByTimeAsync(849); });
      expect(harness.inspectStatus).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(harness.inspectStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("live-status")).toHaveAttribute("data-dirty", "1");
      expect(harness.inspect).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Switch to main" })).toBe(button);
      expect(button).toBeEnabled();
      expect(harness.watchStart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not update review revisions or the branch list when status is identical", async () => {
    render(<WorkbenchShell />);
    const button = await screen.findByRole("button", { name: "Switch to main" });
    await waitFor(() => expect(button).toBeEnabled());
    const revision = screen.getByTestId("live-status").getAttribute("data-revision");

    await changed();
    await waitFor(() => expect(harness.inspectStatus).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(screen.getByTestId("live-status")).toHaveAttribute("data-revision", revision);
    expect(harness.inspect).toHaveBeenCalledTimes(1);
    expect(button).toBeEnabled();
  });

  it("reinspects branch inventory silently when terminal changes HEAD", async () => {
    let completeInspection!: (value: RepositorySnapshot) => void;
    harness.inspect.mockResolvedValueOnce(snapshot()).mockImplementationOnce(
      () => new Promise<RepositorySnapshot>((resolve) => { completeInspection = resolve; }),
    );
    harness.inspectStatus.mockResolvedValue(status(snapshot(primary, "main", "2222222222")));
    render(<WorkbenchShell />);
    const button = await screen.findByRole("button", { name: "Switch to main" });
    await waitFor(() => expect(button).toBeEnabled());
    await changed();

    await waitFor(() => expect(harness.inspect).toHaveBeenCalledTimes(2), { timeout: 4000 });
    // A silent metadata refresh must not enter global loading or flash the controls.
    expect(button).toBeEnabled();
    await act(async () => { completeInspection(snapshot(primary, "main", "2222222222")); });
    await waitFor(() => expect(button).toHaveTextContent("active"));
    expect(harness.watchStart).toHaveBeenCalledTimes(1);
  });

  it("updates the branch inventory after a terminal Git ref change without a loading flash", async () => {
    const fromCli = "feat/from-cli";
    harness.inspect.mockResolvedValueOnce(snapshot()).mockImplementationOnce(async () => ({
      ...snapshot(),
      branches: [...snapshot().branches, {
        name: fromCli, local: true, remote: false, worktreePath: null,
      }],
    }));
    render(<WorkbenchShell />);
    const stable = await screen.findByRole("button", { name: "Switch to main" });
    await waitFor(() => expect(stable).toBeEnabled());

    await changed("git.changed");
    await changed("git.changed");
    await waitFor(() => expect(harness.inspect).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(await screen.findByRole("button", { name: `Switch to ${fromCli}` })).toBeEnabled();
    expect(harness.inspectStatus).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Switch to main" })).toBe(stable);
    expect(harness.watchStart).toHaveBeenCalledTimes(1);
  });

  it("discards the old worktree's delayed status result after selecting another repository", async () => {
    let finishStatus!: (value: WorktreeStatus) => void;
    harness.inspectStatus.mockImplementation(
      () => new Promise<WorktreeStatus>((resolve) => { finishStatus = resolve; }),
    );
    useWorkbenchStore.setState({
      repositories: [
        { id: "repo-1", name: "virtuallab", path: primary, lastOpenedAt: 1 },
        { id: "repo-2", name: "second-repo", path: secondary, lastOpenedAt: 2 },
      ],
    });
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    await screen.findByRole("button", { name: "Switch to main" });
    await changed();
    await waitFor(() => expect(harness.inspectStatus).toHaveBeenCalledTimes(1), { timeout: 4000 });

    await user.click(screen.getByRole("button", { name: /second-repo.*fixtures\/second-repo/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "second-repo" })).toBeInTheDocument());
    await act(async () => {
      finishStatus(status({ ...snapshot(), dirtyCount: 10, untrackedCount: 10 }));
    });
    expect(screen.getByRole("heading", { name: "second-repo" })).toBeInTheDocument();
    expect(screen.getByTestId("live-status")).toHaveAttribute("data-dirty", "0");
  });

  it.each(["git.changed", "fs.changed"])(
    "recovers an externally removed active worktree after %s and drops stale branch actions",
    async (eventType) => {
      let removed = false;
      harness.inspect.mockImplementation(async (path: string) => {
        if (path === linked) {
          if (removed) throw new Error(`fatal: cannot change to '${linked}': No such file or directory`);
          return linkedSnapshot();
        }
        return snapshot(primary, "main", "2222222222");
      });
      harness.inspectStatus.mockRejectedValue(new Error("Workspace directory was removed"));
      rememberLinkedWorkspace();
      render(<WorkbenchShell />);
      const staleDelete = await screen.findByRole("button", { name: "Delete origin branch origin/feat/already-deleted" });
      await waitFor(() => expect(staleDelete).toBeEnabled());

      removed = true;
      await changed(eventType);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Switch to main" })).toHaveTextContent("active");
        expect(screen.queryByRole("button", { name: "Delete origin branch origin/feat/already-deleted" })).not.toBeInTheDocument();
      }, { timeout: 4000 });
      expect(screen.getByRole("button", { name: "Switch to main" })).toBeEnabled();
      expect(useWorkbenchStore.getState().workspaceStates["repo-1"]).toMatchObject({
        activeWorktreePath: primary, activeTab: "overview",
      });
      expect(screen.queryByText(/fatal: cannot change/)).not.toBeInTheDocument();
    },
  );

  it("restores a missing saved worktree to the primary workspace without leaving a fatal error", async () => {
    harness.inspect.mockImplementation(async (path: string) => {
      if (path === linked) throw new Error(`fatal: cannot change to '${linked}': No such file or directory`);
      return snapshot(primary, "main", "2222222222");
    });
    rememberLinkedWorkspace();
    render(<WorkbenchShell />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to main" })).toHaveTextContent("active"));
    expect(screen.queryByText(/fatal: cannot change/)).not.toBeInTheDocument();
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).toBe(primary);
  });

  it("keeps a registered worktree selected on a transient inspection failure", async () => {
    harness.inspect.mockImplementation(async (path: string) => path === linked ? linkedSnapshot() : {
      ...linkedSnapshot(), root: primary, currentBranch: "main", headSha: "2222222222",
    });
    rememberLinkedWorkspace();
    render(<WorkbenchShell />);
    const active = await screen.findByRole("button", { name: `Switch to ${initialBranch}` });
    await waitFor(() => expect(active).toBeEnabled());
    harness.inspect.mockImplementation(async (path: string) => {
      if (path === linked) throw new Error("Temporary Git index read failure");
      return { ...linkedSnapshot(), root: primary, currentBranch: "main", headSha: "2222222222" };
    });
    await changed("git.changed");
    await waitFor(() => expect(harness.inspect).toHaveBeenCalledTimes(3), { timeout: 3000 });
    expect(active).toHaveTextContent("active");
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).toBe(linked);
  });

  it("does not let a delayed recovery select a workspace in the previous repository", async () => {
    let finishRecovery!: (value: RepositorySnapshot) => void;
    harness.inspect.mockImplementation(async (path: string) => path === linked ? linkedSnapshot() : snapshot(path));
    rememberLinkedWorkspace();
    useWorkbenchStore.setState({ repositories: [
      { id: "repo-1", name: "virtuallab", path: primary, lastOpenedAt: 1 },
      { id: "repo-2", name: "second-repo", path: secondary, lastOpenedAt: 2 },
    ] });
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    await screen.findByRole("button", { name: `Switch to ${initialBranch}` });
    harness.inspect.mockImplementation(async (path: string) => {
      if (path === linked) throw new Error("Worktree was removed");
      if (path === primary) return new Promise<RepositorySnapshot>((resolve) => { finishRecovery = resolve; });
      return snapshot(path);
    });
    await changed("git.changed");
    await waitFor(() => expect(finishRecovery).toBeDefined(), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: /second-repo.*fixtures\/second-repo/ }));
    await screen.findByRole("heading", { name: "second-repo" });

    await act(async () => { finishRecovery(snapshot(primary, "main", "2222222222")); });
    expect(screen.getByRole("heading", { name: "second-repo" })).toBeInTheDocument();
    expect(useWorkbenchStore.getState().workspaceStates["repo-2"]?.activeWorktreePath).toBe(secondary);
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).toBe(linked);
  });


  it("unlocks foreground selection that joins a background recovery after switching away and back", async () => {
    let finishRecovery!: (value: RepositorySnapshot) => void;
    harness.inspect.mockImplementation(async (path: string) => path === linked ? linkedSnapshot() : snapshot(path));
    rememberLinkedWorkspace();
    useWorkbenchStore.setState({ repositories: [
      { id: "repo-1", name: "virtuallab", path: primary, lastOpenedAt: 1 },
      { id: "repo-2", name: "second-repo", path: secondary, lastOpenedAt: 2 },
    ] });
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    await screen.findByRole("button", { name: `Switch to ${initialBranch}` });
    harness.inspect.mockImplementation(async (path: string) => {
      if (path === linked) throw new Error("Worktree was removed");
      if (path === primary) return new Promise<RepositorySnapshot>((resolve) => { finishRecovery = resolve; });
      return snapshot(path);
    });
    await changed("git.changed");
    await waitFor(() => expect(finishRecovery).toBeDefined(), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: /second-repo.*fixtures\/second-repo/ }));
    await screen.findByRole("heading", { name: "second-repo" });
    await user.click(screen.getByRole("button", { name: /virtuallab.*fixtures\/virtuallab/ }));
    await act(async () => { finishRecovery(snapshot(primary, "main", "2222222222")); });

    await waitFor(() => {
      const main = screen.getByRole("button", { name: "Switch to main" });
      expect(main).toHaveTextContent("active");
      expect(main).toBeEnabled();
    });
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).toBe(primary);
  });


  it("does not let a queued refresh reclaim a removed path after another worktree is selected", async () => {
    const other = "/fixtures/another worktree";
    const otherBranch = "feat/other";
    const before = linkedSnapshot();
    before.worktrees.push({ path: other, branch: otherBranch, head: "3333333333", detached: false });
    before.branches.push({ name: otherBranch, local: true, remote: false, worktreePath: other });
    const remaining: RepositorySnapshot = {
      ...before, root: primary, currentBranch: "main", headSha: "2222222222",
      worktrees: before.worktrees.filter((tree) => tree.path !== linked),
      branches: before.branches.filter((branch) => branch.name !== initialBranch && branch.name !== "feat/already-deleted"),
    };
    let finishRecovery!: (value: RepositorySnapshot) => void;
    let deferRecovery = true;
    harness.inspect.mockResolvedValue(before);
    rememberLinkedWorkspace();
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    const otherButton = await screen.findByRole("button", { name: `Open worktree for ${otherBranch}` });
    await waitFor(() => expect(otherButton).toBeEnabled());
    harness.inspect.mockImplementation(async (path: string) => {
      if (path === linked) throw new Error("Worktree was removed");
      if (path === primary && deferRecovery) {
        deferRecovery = false;
        return new Promise<RepositorySnapshot>((resolve) => { finishRecovery = resolve; });
      }
      return { ...remaining, root: path, currentBranch: path === other ? otherBranch : "main" };
    });
    await changed("git.changed");
    await waitFor(() => expect(finishRecovery).toBeDefined(), { timeout: 3000 });
    // Deliver the second debounced event while the first inspection is pending.
    vi.useFakeTimers();
    try {
      act(() => harness.listeners.get("workbench://event")?.({
        payload: { id: harness.watchStart.mock.lastCall?.[0] as string, eventType: "git.changed" },
      }));
      await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    } finally { vi.useRealTimers(); }
    await user.click(otherButton);
    await waitFor(() => expect(screen.getByRole("button", { name: `Switch to ${otherBranch}` })).toHaveTextContent("active"));
    const inspections = harness.inspect.mock.calls.length;
    await act(async () => { finishRecovery(remaining); });

    expect(screen.getByRole("button", { name: `Switch to ${otherBranch}` })).toHaveTextContent("active");
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).toBe(other);
    expect(harness.inspect).toHaveBeenCalledTimes(inspections);
  });

});
