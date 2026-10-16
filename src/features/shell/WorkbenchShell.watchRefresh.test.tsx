import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { useWorkbenchStore } from "@/stores/workbench";
import type { RepositorySnapshot, WorktreeStatus } from "@/types/workbench";

const harness = vi.hoisted(() => ({
  inspect: vi.fn(),
  inspectStatus: vi.fn(),
  watchStart: vi.fn(),
  watchStop: vi.fn(),
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

  it("coalesces Agent write bursts and never disables or remounts Git branch buttons", async () => {
    const dirty = {
      ...snapshot(), dirtyCount: 1, untrackedCount: 1,
      changes: [{ path: "generated.txt", indexStatus: "?", worktreeStatus: "?", kind: "untracked" as const }],
    };
    harness.inspectStatus.mockResolvedValue(status(dirty));
    render(<WorkbenchShell />);
    const button = await screen.findByRole("button", { name: "Switch to main" });
    await waitFor(() => expect(button).toBeEnabled());

    await changed();
    await changed();
    await changed();
    expect(button).toBeEnabled();
    expect(harness.inspect).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(harness.inspectStatus).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await waitFor(() => expect(screen.getByTestId("live-status")).toHaveAttribute("data-dirty", "1"));
    expect(harness.inspect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Switch to main" })).toBe(button);
    expect(button).toBeEnabled();
    expect(harness.watchStart).toHaveBeenCalledTimes(1);
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
});
