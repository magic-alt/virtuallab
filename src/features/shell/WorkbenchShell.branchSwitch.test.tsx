import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { useTaskNotifications } from "@/stores/taskNotifications";
import { useWorkbenchStore } from "@/stores/workbench";
import type { RepositorySnapshot } from "@/types/workbench";

const harness = vi.hoisted(() => ({
  currentBranch: "codex/pr-15",
  detach: vi.fn(),
  restore: vi.fn(),
  choose: vi.fn(),
  inspect: vi.fn(),
  switchBranch: vi.fn(),
  openEditor: vi.fn(),
  stashChanges: vi.fn(),
  deleteOriginBranch: vi.fn(),
  removeWorktree: vi.fn(),
  watchStart: vi.fn(),
  watchStop: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("@/lib/backend", () => ({
  confirmNativeAction: vi.fn().mockResolvedValue(true),
  isDesktopRuntime: () => true,
  getAppBuildInfo: vi.fn().mockResolvedValue({
    version: "0.5.0", gitCommit: "aaaaaaaaaaaa1111111111111111111111111111",
    gitBranch: "build-source", gitDirty: false, builtAtUnixSeconds: 1791849600,
    profile: "release",
  }),
  inspectRepository: harness.inspect,
  gitSwitchBranch: harness.switchBranch,
  resolveLocalChangesAfterConfirmation: harness.stashChanges,
  openWorkspaceDirectory: vi.fn().mockResolvedValue(undefined),
  openWorkspaceInEditor: harness.openEditor,
  gitFetchOrigin: vi.fn(),
  gitPullCurrent: vi.fn(),
  deleteLocalBranchAfterConfirmation: vi.fn(),
  deleteOriginBranchAfterConfirmation: harness.deleteOriginBranch,
  chooseRepositoryDirectory: harness.choose,
  detachRepositoryAfterConfirmation: harness.detach,
  restoreRepositoryRegistration: harness.restore,
  createWorktree: vi.fn(),
  removeWorktreeAfterConfirmation: harness.removeWorktree,
  watchStart: harness.watchStart,
  watchStop: harness.watchStop,
}));

vi.mock("@/features/workspace/WorkspaceContent", () => ({
  WorkspaceContent: ({ tab, onTabChange }: { tab: string; onTabChange: (tab: "changes") => void }) => (
    <div data-testid="workspace-content" data-active-tab={tab}>
      <button type="button" onClick={() => onTabChange("changes")}>Changes</button>
    </div>
  ),
}));

import { WorkbenchShell } from "./WorkbenchShell";

const repoRoot = "/fixtures/virtuallab";

function snapshot(): RepositorySnapshot {
  return {
    ...PREVIEW_SNAPSHOT,
    name: "virtuallab",
    root: repoRoot,
    remoteUrl: "https://github.com/magic-alt/virtuallab.git",
    currentBranch: harness.currentBranch,
    headSha: harness.currentBranch === "main" ? "2222222222" : "1111111111",
    dirtyCount: 3,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 3,
    changes: ["generated.log", "build-cache.json", "tool-output.txt"].map((path) => ({
      path, indexStatus: "?", worktreeStatus: "?", kind: "untracked" as const,
    })),
    worktrees: [{
      path: repoRoot,
      head: harness.currentBranch === "main" ? "2222222222" : "1111111111",
      branch: harness.currentBranch,
      detached: false,
    }],
    branches: [
      { name: "main", local: true, remote: true, worktreePath: harness.currentBranch === "main" ? repoRoot : null },
      { name: "codex/pr-15", local: true, remote: false, worktreePath: harness.currentBranch === "codex/pr-15" ? repoRoot : null },
    ],
  };
}

const linkedPath = "/fixtures/virtuallab/.worktrees/joint17-brake";

function linkedSnapshot(path: string, hasLinkedWorktree = true): RepositorySnapshot {
  const next = snapshot();
  if (hasLinkedWorktree) {
    next.worktrees.push({
      path: linkedPath,
      head: "3333333333",
      branch: "feat/joint17-brake",
      detached: false,
    });
    next.branches.push({
      name: "feat/joint17-brake", local: true, remote: false, worktreePath: linkedPath,
    });
  }
  if (path === linkedPath) {
    next.root = linkedPath;
    next.currentBranch = "feat/joint17-brake";
    next.headSha = "3333333333";
  }
  return next;
}

describe("workbench branch switching with untracked artifacts", () => {
  beforeEach(() => {
    harness.currentBranch = "codex/pr-15";
    harness.detach.mockReset().mockResolvedValue(true);
    harness.restore.mockReset().mockResolvedValue(undefined);
    harness.choose.mockReset().mockResolvedValue(repoRoot);
    useTaskNotifications.setState({ notices: [{
      id: "notice-1", workspaceRoot: "/external/linked", repositoryId: "repo-1",
      source: "terminal", title: "Finished", detail: "done", severity: "complete", createdAt: 1, read: false,
    }] });
    harness.inspect.mockReset();
    harness.switchBranch.mockReset();
    harness.openEditor.mockReset().mockResolvedValue(undefined);
    window.localStorage.removeItem('virtuallab-external-editor');
    harness.stashChanges.mockReset().mockResolvedValue(true);
    harness.deleteOriginBranch.mockReset();
    harness.removeWorktree.mockReset();
    harness.watchStart.mockReset();
    harness.watchStop.mockReset();
    harness.inspect.mockImplementation(async () => snapshot());
    harness.switchBranch.mockImplementation(async (_repo: string, _workspace: string, next: string) => {
      harness.currentBranch = next;
    });
    harness.watchStart.mockResolvedValue(undefined);
    harness.watchStop.mockResolvedValue(undefined);
    useWorkbenchStore.setState({
      repositories: [{ id: "repo-1", name: "virtuallab", path: repoRoot, lastOpenedAt: 1 }],
      activeRepositoryId: "repo-1",
      workspaceStates: {},
    });
  });

  it("keeps repository and notices until native detach succeeds and blocks duplicate removal", async () => {
    let finish!: (approved: boolean) => void;
    harness.detach.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    const remove = await screen.findByRole("button", { name: "Remove virtuallab" });
    await user.click(remove);
    expect(useWorkbenchStore.getState().repositories).toHaveLength(1);
    expect(useTaskNotifications.getState().notices).toHaveLength(1);
    expect(remove).toBeDisabled();
    await user.click(remove);
    expect(harness.detach).toHaveBeenCalledTimes(1);
    finish(true);
    await waitFor(() => expect(useWorkbenchStore.getState().repositories).toHaveLength(0));
    expect(useTaskNotifications.getState().notices).toHaveLength(0);
  });

  it.each(["cancel", "busy"])("preserves repository and notices after %s", async (result) => {
    if (result === "cancel") harness.detach.mockResolvedValue(false);
    else harness.detach.mockRejectedValue(new Error("Workspace is reserved by terminal"));
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    const remove = await screen.findByRole("button", { name: "Remove virtuallab" });
    await user.click(remove);
    await waitFor(() => expect(remove).toBeEnabled());
    expect(useWorkbenchStore.getState().repositories).toHaveLength(1);
    expect(useWorkbenchStore.getState().activeRepositoryId).toBe("repo-1");
    expect(useTaskNotifications.getState().notices).toHaveLength(1);
    if (result === "busy") expect(await screen.findByText("Workspace is reserved by terminal")).toBeInTheDocument();
  });

  it("waits for native restoration before re-adding a removed repository", async () => {
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    await user.click(await screen.findByRole("button", { name: "Remove virtuallab" }));
    await waitFor(() => expect(useWorkbenchStore.getState().repositories).toHaveLength(0));
    let restore!: () => void;
    harness.restore.mockReturnValue(new Promise<void>((resolve) => { restore = resolve; }));
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    await waitFor(() => expect(harness.restore).toHaveBeenCalledWith(repoRoot));
    expect(useWorkbenchStore.getState().repositories).toHaveLength(0);
    restore();
    await waitFor(() => expect(useWorkbenchStore.getState().repositories).toHaveLength(1));
  });

  it("does not register a repository when native restore fails", async () => {
    harness.restore.mockRejectedValue(new Error("Cannot restore inventory"));
    useWorkbenchStore.setState({ repositories: [], activeRepositoryId: null, workspaceStates: {} });
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    await user.click(screen.getByRole("button", { name: "工程仓库" }));
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    expect(await screen.findByText("Cannot restore inventory")).toBeInTheDocument();
    expect(useWorkbenchStore.getState().repositories).toHaveLength(0);
  });

  it("opens selected, linked and repository roots in the chosen IDE without switching Git", async () => {
    const user = userEvent.setup();
    harness.inspect.mockImplementation(async (path: string) => linkedSnapshot(path));
    render(<WorkbenchShell />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open in IDE" })).toBeEnabled());

    await user.selectOptions(screen.getByRole("combobox", { name: "Preferred editor" }), "zed");
    expect(window.localStorage.getItem("virtuallab-external-editor")).toBe("zed");
    await user.click(screen.getByRole("button", { name: "Open in Zed" }));
    await waitFor(() => expect(harness.openEditor).toHaveBeenCalledWith(repoRoot, repoRoot, "zed"));

    await user.click(screen.getByRole("button", { name: "Open branch feat/joint17-brake in Zed" }));
    expect(harness.openEditor).toHaveBeenCalledWith(repoRoot, linkedPath, "zed");
    await user.click(screen.getByRole("button", { name: "Open repository in Zed virtuallab" }));
    expect(harness.openEditor).toHaveBeenCalledWith(repoRoot, repoRoot, "zed");
    expect(harness.switchBranch).not.toHaveBeenCalled();
  });

  it("reports missing editor binaries without altering repository state", async () => {
    const user = userEvent.setup();
    harness.openEditor.mockRejectedValueOnce(new Error("Zed CLI was not found"));
    render(<WorkbenchShell />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open in IDE" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Open in IDE" }));
    expect(await screen.findByText("Zed CLI was not found")).toBeInTheDocument();
    expect(harness.switchBranch).not.toHaveBeenCalled();
  });

  it("opens documentation from the application Help menu, not a workspace tab", async () => {
    const user = userEvent.setup();
    render(<WorkbenchShell />);

    const menu = screen.getByRole("button", { name: "Help" });
    expect(screen.queryByRole("button", { name: "Guide" })).not.toBeInTheDocument();
    await user.click(menu);
    await user.click(screen.getByRole("menuitem", { name: /使用文档/ }));
    expect(screen.getByRole("dialog", { name: "VirtualLab 使用文档" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "快速入门" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "VirtualLab 使用文档" })).not.toBeInTheDocument();
    expect(menu).toHaveFocus();
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeTab).toBe("overview");
  });

  it("does not change the workspace tab when opening and closing documentation", async () => {
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    await user.click(screen.getByRole("button", { name: "Changes" }));
    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(screen.getByRole("menuitem", { name: /使用文档/ }));
    await user.click(screen.getByRole("button", { name: "关闭文档" }));
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeTab).toBe("changes");
    expect(screen.getByTestId("workspace-content")).toHaveAttribute("data-active-tab", "changes");
  });

  it("makes documentation available even before adding a repository", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({ repositories: [], activeRepositoryId: null, workspaceStates: {} });
    render(<WorkbenchShell />);
    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(screen.getByRole("menuitem", { name: /使用文档/ }));
    expect(screen.getByRole("dialog", { name: "VirtualLab 使用文档" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "快速入门" })).toBeInTheDocument();
  });

  it("updates the active branch when switching codex/pr-15 to main and back", async () => {
    const user = userEvent.setup();
    render(<WorkbenchShell />);

    const main = await screen.findByRole("button", { name: "Switch to main" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Switch to codex/pr-15" })).toHaveTextContent("active");
    });

    await waitFor(() => expect(main).toBeEnabled());
    await user.click(main);
    await waitFor(() => {
      expect(harness.switchBranch).toHaveBeenCalledWith(repoRoot, repoRoot, "main");
      expect(screen.getByRole("button", { name: "Switch to main" })).toHaveTextContent("active");
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to codex/pr-15" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Switch to codex/pr-15" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to codex/pr-15" })).toHaveTextContent("active"));

    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to main" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Switch to main" }));
    await waitFor(() => {
      expect(harness.switchBranch).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("button", { name: "Switch to main" })).toHaveTextContent("active");
    });
    expect(harness.inspect.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("opens main's existing worktree without a duplicate checkout", async () => {
    const user = userEvent.setup();
    const mainRoot = "/fixtures/virtuallab-main";
    const codex = snapshot();
    codex.branches[0].worktreePath = mainRoot;
    codex.worktrees.push({
      path: mainRoot, head: "2222222222", branch: "main", detached: false,
    });
    harness.inspect.mockImplementation(async (path: string) => {
      if (path !== mainRoot) return codex;
      return {
        ...codex,
        root: mainRoot,
        currentBranch: "main",
        headSha: "2222222222",
        branches: codex.branches.map((branch) => ({
          ...branch,
          worktreePath: branch.name === "main" ? mainRoot : repoRoot,
        })),
      };
    });
    render(<WorkbenchShell />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to codex/pr-15" })).toHaveTextContent("active"),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Open worktree for main" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Open worktree for main" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Switch to main" })).toHaveTextContent("active");
      expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).toBe(mainRoot);
    });
    expect(harness.switchBranch).not.toHaveBeenCalled();
  });

  it("deletes origin independently and keeps the local branch after refresh", async () => {
    const user = userEvent.setup();
    let remoteExists = true;
    harness.inspect.mockImplementation(async () => {
      const next = snapshot();
      next.branches.push({
        name: "feat/shared", local: true, remote: remoteExists, worktreePath: null,
      });
      return next;
    });
    harness.deleteOriginBranch.mockImplementation(async () => {
      remoteExists = false;
      return true;
    });

    render(<WorkbenchShell />);
    const originAction = await screen.findByRole("button", { name: "Delete origin branch origin/feat/shared" });
    await waitFor(() => expect(originAction).toBeEnabled());
    await user.click(originAction);

    await waitFor(() => {
      expect(harness.deleteOriginBranch).toHaveBeenCalledWith(repoRoot, "feat/shared");
      expect(screen.queryByRole("button", { name: "Delete origin branch origin/feat/shared" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Delete local branch feat/shared" })).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: "Switch to feat/shared" })).toHaveTextContent("local");
  });

  it("allows deletion of an origin-only branch without creating a local branch", async () => {
    const user = userEvent.setup();
    let remoteExists = true;
    harness.inspect.mockImplementation(async () => {
      const next = snapshot();
      if (remoteExists) {
        next.branches.push({
          name: "feat/remote-only", local: false, remote: true, worktreePath: null,
        });
      }
      return next;
    });
    harness.deleteOriginBranch.mockImplementation(async () => {
      remoteExists = false;
      return true;
    });

    render(<WorkbenchShell />);
    const originAction = await screen.findByRole("button", { name: "Delete origin branch origin/feat/remote-only" });
    await waitFor(() => expect(originAction).toBeEnabled());
    await user.click(originAction);

    await waitFor(() => {
      expect(harness.deleteOriginBranch).toHaveBeenCalledWith(repoRoot, "feat/remote-only");
      expect(screen.queryByRole("button", { name: "Switch to feat/remote-only" })).not.toBeInTheDocument();
    });
    expect(harness.switchBranch).not.toHaveBeenCalled();
  });

  it("displays switch failures instead of swallowing them", async () => {
    const user = userEvent.setup();
    harness.switchBranch.mockRejectedValueOnce(new Error("Cannot switch branches with staged or modified tracked files"));
    render(<WorkbenchShell />);
    await screen.findByRole("button", { name: "Switch to main" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to main" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Switch to main" }));
    expect(await screen.findByText(/Cannot switch branches with staged or modified tracked files/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to codex/pr-15" })).toHaveTextContent("active");
  });
  it("keeps the active dirty worktree selected when the force dialog is cancelled", async () => {
    const user = userEvent.setup();
    let finishConfirmation!: (removed: boolean) => void;
    harness.inspect.mockImplementation(async (path: string) => linkedSnapshot(path));
    harness.removeWorktree.mockReturnValue(new Promise<boolean>((resolve) => {
      finishConfirmation = resolve;
    }));
    useWorkbenchStore.setState({
      workspaceStates: {
        "repo-1": {
          repositoryId: "repo-1", activeWorktreePath: linkedPath,
          activeTab: "changes", updatedAt: 1,
        },
      },
    });
    render(<WorkbenchShell />);
    await screen.findByRole("button", { name: "Remove workspace" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove workspace" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Remove workspace" }));
    expect(harness.removeWorktree).toHaveBeenCalledWith(repoRoot, linkedPath);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove workspace" })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Remove workspace" }));
    expect(harness.removeWorktree).toHaveBeenCalledTimes(1);
    finishConfirmation(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove workspace" })).toBeEnabled());
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).toBe(linkedPath);
    expect(screen.getByTestId("workspace-content")).toHaveAttribute("data-active-tab", "changes");
    expect(harness.inspect).toHaveBeenCalledTimes(1);
  });

  it("switches to the primary worktree only after a successful active removal", async () => {
    const user = userEvent.setup();
    let hasLinkedWorktree = true;
    harness.inspect.mockImplementation(async (path: string) => linkedSnapshot(path, hasLinkedWorktree));
    harness.removeWorktree.mockImplementation(async () => {
      hasLinkedWorktree = false;
      return true;
    });
    useWorkbenchStore.setState({
      workspaceStates: {
        "repo-1": {
          repositoryId: "repo-1", activeWorktreePath: linkedPath,
          activeTab: "changes", updatedAt: 1,
        },
      },
    });
    render(<WorkbenchShell />);
    await screen.findByRole("button", { name: "Remove workspace" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove workspace" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Remove workspace" }));
    await waitFor(() => {
      expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).toBe(repoRoot);
      expect(screen.queryByRole("button", { name: "Remove workspace" })).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("workspace-content")).toHaveAttribute("data-active-tab", "overview");
  });

  it("keeps the current tab and path when removing a non-active worktree", async () => {
    const user = userEvent.setup();
    let hasLinkedWorktree = true;
    harness.inspect.mockImplementation(async (path: string) => linkedSnapshot(path, hasLinkedWorktree));
    harness.removeWorktree.mockImplementation(async () => {
      hasLinkedWorktree = false;
      return true;
    });
    useWorkbenchStore.setState({
      workspaceStates: {
        "repo-1": {
          repositoryId: "repo-1", activeWorktreePath: repoRoot,
          activeTab: "changes", updatedAt: 1,
        },
      },
    });
    render(<WorkbenchShell />);
    await screen.findByRole("button", { name: "Remove workspace" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove workspace" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Remove workspace" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove workspace" })).not.toBeInTheDocument());
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).toBe(repoRoot);
    expect(screen.getByTestId("workspace-content")).toHaveAttribute("data-active-tab", "changes");
  });

  it("safely stashes tracked edits before switching, but never auto-applies them to the target branch", async () => {
    const user = userEvent.setup();
    harness.inspect.mockImplementation(async () => ({
      ...snapshot(), dirtyCount: 1, stagedCount: 0, unstagedCount: 1, untrackedCount: 0,
      changes: [{ path: "src/app.ts", indexStatus: " ", worktreeStatus: "M", kind: "modified" }],
    }));
    render(<WorkbenchShell />);
    const button = await screen.findByRole("button", { name: "Switch to main" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(harness.stashChanges).toHaveBeenCalledWith(expect.objectContaining({
      repositoryRoot: repoRoot, workspaceRoot: repoRoot, action: "stashAll",
      expectedBranch: "codex/pr-15", path: null,
    })));
    await waitFor(() => expect(harness.switchBranch).toHaveBeenCalledWith(repoRoot, repoRoot, "main"));
    expect(screen.getByRole("button", { name: "Switch to main" })).toHaveTextContent("active");
  });

  it("does not change branches when the user cancels the stash confirmation", async () => {
    const user = userEvent.setup();
    harness.stashChanges.mockResolvedValueOnce(false);
    harness.inspect.mockImplementation(async () => ({
      ...snapshot(), dirtyCount: 1, stagedCount: 0, unstagedCount: 1, untrackedCount: 0,
      changes: [{ path: "changes.txt", indexStatus: " ", worktreeStatus: "M", kind: "modified" }],
    }));
    render(<WorkbenchShell />);
    const button = await screen.findByRole("button", { name: "Switch to main" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(harness.stashChanges).toHaveBeenCalledTimes(1));
    expect(harness.switchBranch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Switch to codex/pr-15" })).toHaveTextContent("active");
  });

  it("reports a failed checkout after stashing and preserves recovery instructions", async () => {
    const user = userEvent.setup();
    harness.inspect.mockImplementation(async () => ({
      ...snapshot(), dirtyCount: 1, stagedCount: 0, unstagedCount: 1, untrackedCount: 0,
      changes: [{ path: "src/app.ts", indexStatus: " ", worktreeStatus: "M", kind: "modified" }],
    }));
    harness.switchBranch.mockRejectedValueOnce(new Error("ignored files would be overwritten"));
    render(<WorkbenchShell />);
    const button = await screen.findByRole("button", { name: "Switch to main" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText(/Your local edits are preserved in Git stash/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to codex/pr-15" })).toHaveTextContent("active");
  });

  it("does not let a late inspection from repository A replace repository B", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (value: RepositorySnapshot) => void;
    harness.inspect.mockImplementation((path: string) => {
      if (path === repoRoot) {
        return new Promise<RepositorySnapshot>((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({
        ...snapshot(), root: "/fixtures/other", name: "second-repo",
        currentBranch: "main",
        worktrees: [{ path: "/fixtures/other", head: "aaaaaaaaaa", branch: "main", detached: false }],
        branches: [{ name: "main", local: true, remote: false, worktreePath: "/fixtures/other" }],
      });
    });
    useWorkbenchStore.setState({
      repositories: [
        { id: "repo-1", name: "virtuallab", path: repoRoot, lastOpenedAt: 1 },
        { id: "repo-2", name: "second-repo", path: "/fixtures/other", lastOpenedAt: 2 },
      ],
      activeRepositoryId: "repo-1",
    });
    render(<WorkbenchShell />);
    await waitFor(() => expect(harness.inspect).toHaveBeenCalledWith(repoRoot));
    await user.click(screen.getByRole("button", { name: /^second-repo /i }));
    await waitFor(() => expect(screen.getByText("second-repo", { selector: "h1" })).toBeInTheDocument());
    resolveFirst(snapshot());
    await waitFor(() => expect(useWorkbenchStore.getState().workspaceStates["repo-2"]?.activeWorktreePath).toBe("/fixtures/other"));
    expect(screen.getByText("second-repo", { selector: "h1" })).toBeInTheDocument();
    expect(useWorkbenchStore.getState().activeRepositoryId).toBe("repo-2");
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).not.toBe("/fixtures/other");
  });


  it("clears a previous removal error when selecting another workspace lane", async () => {
    const user = userEvent.setup();
    harness.inspect.mockImplementation(async (path: string) => linkedSnapshot(path));
    harness.removeWorktree.mockRejectedValueOnce(new Error("Workspace is reserved by terminal; wait for observed completion."));
    render(<WorkbenchShell />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove workspace" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Remove workspace" }));
    await screen.findByText(/Workspace is reserved by terminal/);
    await user.click(screen.getByRole("button", { name: /feat\/joint17-brake.*fixtures/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to feat/joint17-brake" })).toHaveTextContent("active"));
    expect(screen.queryByText(/Workspace is reserved by terminal/)).not.toBeInTheDocument();
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeWorktreePath).toBe(linkedPath);
  });

});
