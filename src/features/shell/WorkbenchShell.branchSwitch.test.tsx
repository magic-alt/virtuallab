import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { useWorkbenchStore } from "@/stores/workbench";
import type { RepositorySnapshot } from "@/types/workbench";

const harness = vi.hoisted(() => ({
  currentBranch: "codex/pr-15",
  inspect: vi.fn(),
  switchBranch: vi.fn(),
  deleteOriginBranch: vi.fn(),
  watchStart: vi.fn(),
  watchStop: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("@/lib/backend", () => ({
  confirmNativeAction: vi.fn().mockResolvedValue(true),
  isDesktopRuntime: () => true,
  inspectRepository: harness.inspect,
  gitSwitchBranch: harness.switchBranch,
  gitFetchOrigin: vi.fn(),
  gitPullCurrent: vi.fn(),
  deleteLocalBranchAfterConfirmation: vi.fn(),
  deleteOriginBranchAfterConfirmation: harness.deleteOriginBranch,
  chooseRepositoryDirectory: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  watchStart: harness.watchStart,
  watchStop: harness.watchStop,
}));

vi.mock("@/features/workspace/WorkspaceContent", () => ({
  WorkspaceContent: ({ tab, onTabChange }: { tab: string; onTabChange: (tab: "history") => void }) => (
    <div data-testid="workspace-content" data-active-tab={tab}>
      <button type="button" onClick={() => onTabChange("history")}>History</button>
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

describe("workbench branch switching with untracked artifacts", () => {
  beforeEach(() => {
    harness.currentBranch = "codex/pr-15";
    harness.inspect.mockReset();
    harness.switchBranch.mockReset();
    harness.deleteOriginBranch.mockReset();
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
    await user.click(screen.getByRole("button", { name: "History" }));
    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(screen.getByRole("menuitem", { name: /使用文档/ }));
    await user.click(screen.getByRole("button", { name: "关闭文档" }));
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]?.activeTab).toBe("history");
    expect(screen.getByTestId("workspace-content")).toHaveAttribute("data-active-tab", "history");
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
});
