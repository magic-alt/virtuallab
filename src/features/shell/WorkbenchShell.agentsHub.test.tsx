import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { taskFixture } from "@/features/tasks/fixtures";
import { useAgentsHubStore } from "@/stores/agentsHub";
import { useTaskStore } from "@/stores/tasks";
import { useTaskNotifications, type TaskNotice } from "@/stores/taskNotifications";
import { useWorkbenchStore } from "@/stores/workbench";
import type { AgentEvent } from "@/types/agent";
import type { RepositorySnapshot, WorkspaceTab } from "@/types/workbench";

const native = vi.hoisted(() => ({
  inspect: vi.fn(), notify: vi.fn(),
  listeners: new Map<string, (event: { payload: AgentEvent }) => void>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (channel: string, callback: (event: { payload: AgentEvent }) => void) => {
    native.listeners.set(channel, callback);
    return () => native.listeners.delete(channel);
  }),
}));
vi.mock("@/lib/backend", async (original) => ({
  ...await original<typeof import("@/lib/backend")>(),
  isDesktopRuntime: () => true,
  inspectRepository: native.inspect,
  inspectWorktreeStatus: vi.fn(),
  watchStart: vi.fn().mockResolvedValue(undefined),
  watchStop: vi.fn().mockResolvedValue(undefined),
  desktopNotify: native.notify,
  getAppBuildInfo: vi.fn().mockResolvedValue({
    version: "0.5.9", gitCommit: "abc123", gitBranch: "main",
    gitDirty: false, builtAtUnixSeconds: 1, profile: "release",
  }),
}));
vi.mock("@/features/tasks/useTaskObserver", () => ({ useTaskObserver: vi.fn() }));
vi.mock("@/features/tasks/TaskControlCenter", () => ({ TaskControlCenter: HubBoundary, useTaskObserver: vi.fn() }));
vi.mock("@/features/agents/AgentsHub", () => ({ AgentsHub: HubBoundary }));
vi.mock("@/features/workspace/WorkspaceContent", () => ({
  WorkspaceContent: ({ snapshot, tab, onTabChange }: {
    snapshot: RepositorySnapshot; tab: WorkspaceTab; onTabChange: (tab: WorkspaceTab) => void;
  }) => <div data-testid="repository-tools" data-root={snapshot.root} data-tab={tab}>
    <button onClick={() => onTabChange("terminal")}>Terminal fixture</button>
  </div>,
}));

function HubBoundary({ view, visible }: { view: string; visible: boolean }) {
  const { section, sessionTarget, setVisibleSessionRoot } = useAgentsHubStore();
  useEffect(() => {
    setVisibleSessionRoot(visible && view === "home" && section === "sessions"
      ? sessionTarget?.workspaceRoot ?? null : null);
  }, [view, visible, section, sessionTarget, setVisibleSessionRoot]);
  return <div data-testid="hub" data-section={section} data-target={sessionTarget?.workspaceRoot ?? ""} />;
}

import { WorkbenchShell } from "./WorkbenchShell";

const primary = "/fixture/repository";
const linked = "/outside/linked 工程";
const another = "/outside/another";
function snapshot(root = primary, workspaces = [primary, linked]): RepositorySnapshot {
  return {
    ...PREVIEW_SNAPSHOT, root, name: "fixture", currentBranch: "main", headSha: "abc123",
    worktrees: workspaces.map(path => ({ path, branch: path === primary ? "main" : "feature", head: "abc123", detached: false })),
    branches: [],
  };
}
function task(workspaceRoot = linked) {
  return taskFixture({
    repositoryRoot: primary, workspaceRoot,
    attempts: [{
      id: "attempt-1", phase: "implementation", state: "succeeded", startedAtMs: 1, endedAtMs: 2,
      candidateSha: null, failure: null, evidence: null,
      execution: { harness: "codex", executablePath: null, version: null, threadId: "managed-thread", turnId: "managed-turn" },
    }],
  });
}
function notice(patch: Partial<TaskNotice> = {}): TaskNotice {
  return {
    id: "notice", source: "agent", workspaceRoot: linked, title: "Agent completed",
    detail: "Open the source", severity: "complete", createdAt: 1, read: false, ...patch,
  };
}
async function openNotice(value: TaskNotice) {
  act(() => { useTaskNotifications.getState().add(value); });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Task notifications/ }));
  await user.click(screen.getByRole("button", { name: /Agent completed/ }));
}
async function ready() {
  await waitFor(() => expect(screen.getByTestId("repository-tools")).toHaveAttribute("data-root", linked));
}
function complete(turnId: string, workspaceRoot = linked) {
  act(() => native.listeners.get("agent://event")?.({ payload: {
    eventType: "agent.turn_completed", workspaceRoot, turnId,
    threadId: "manual-thread", payload: { status: "completed" }, timestampMs: 1,
  } }));
}

beforeEach(() => {
  native.listeners.clear(); native.inspect.mockReset().mockImplementation(async (root: string) => snapshot(root));
  native.notify.mockReset().mockResolvedValue(undefined);
  useWorkbenchStore.setState({
    repositories: [{ id: "repo-1", name: "fixture", path: primary, lastOpenedAt: 1 }], activeRepositoryId: "repo-1",
    workspaceStates: { "repo-1": { repositoryId: "repo-1", activeWorktreePath: linked, activeTab: "changes", updatedAt: 1 } },
  });
  useTaskStore.setState({ roots: [primary], tasks: [], activeTaskId: null, activeTaskTab: "概览", navigationRevision: 0 });
  useAgentsHubStore.setState({ section: "tasks", sessionTarget: null, visibleSessionRoot: null });
  useTaskNotifications.setState({ notices: [], desktopEnabled: true, desktopError: null, terminalTarget: null });
});

describe("Agents Hub workspace and notification routing", () => {
  it("opens the exact current worktree in Hub without changing repository tooling", async () => {
    render(<WorkbenchShell />); await ready();
    await userEvent.click(screen.getByRole("button", { name: "在 Agents Hub 中管理" }));
    expect(screen.getByTestId("hub")).toBeVisible();
    expect(useAgentsHubStore.getState().sessionTarget).toEqual({ repositoryRoot: primary, workspaceRoot: linked });
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"].activeTab).toBe("changes");
    expect(screen.getByTestId("repository-tools")).not.toBeVisible();
  });

  it("opens managed task execution from the current workspace Hub action", async () => {
    useTaskStore.setState({ tasks: [task()] });
    render(<WorkbenchShell />); await ready();
    await userEvent.click(screen.getByRole("button", { name: "在 Agents Hub 中管理" }));
    expect(useTaskStore.getState().activeTaskId).toBe("task-1");
    expect(useTaskStore.getState().activeTaskTab).toBe("执行");
    expect(useAgentsHubStore.getState().section).toBe("tasks");
    expect(screen.getByTestId("hub")).toBeVisible();
  });

  it("routes an agent notice to the matching task execution identity", async () => {
    useTaskStore.setState({ tasks: [task()] });
    render(<WorkbenchShell />); await ready();
    await openNotice(notice({ threadId: "managed-thread", turnId: "managed-turn" }));
    expect(useTaskStore.getState().activeTaskId).toBe("task-1");
    expect(useTaskStore.getState().activeTaskTab).toBe("执行");
    expect(useAgentsHubStore.getState().section).toBe("tasks");
    expect(screen.getByTestId("hub")).toBeVisible();
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"].activeTab).toBe("changes");
  });

  it("keeps a different agent turn in the manual session Hub despite a task sharing its workspace", async () => {
    useTaskStore.setState({ tasks: [task()] });
    render(<WorkbenchShell />); await ready();
    await openNotice(notice({ threadId: "manual-thread", turnId: "manual-turn" }));
    expect(useTaskStore.getState().activeTaskId).toBeNull();
    expect(useAgentsHubStore.getState().section).toBe("sessions");
    expect(useAgentsHubStore.getState().sessionTarget).toEqual({ repositoryRoot: primary, workspaceRoot: linked });
  });

  it.each(["notice", "workspace action"])("retains managed task ownership through a %s when its worktree is also registered separately", async (entry) => {
    const repository = useWorkbenchStore.getState().repositories[0];
    useWorkbenchStore.setState({
      repositories: [{ id: "linked-repo", name: "linked", path: linked, lastOpenedAt: 2 }, repository],
      activeRepositoryId: "linked-repo",
      workspaceStates: { "linked-repo": { repositoryId: "linked-repo", activeWorktreePath: linked, activeTab: "changes", updatedAt: 1 } },
    });
    useTaskStore.setState({ tasks: [task()] });
    render(<WorkbenchShell />); await ready();
    if (entry === "notice") await openNotice(notice({ threadId: "managed-thread", turnId: "managed-turn" }));
    else await userEvent.click(screen.getByRole("button", { name: "在 Agents Hub 中管理" }));
    expect(useTaskStore.getState().activeTaskId).toBe("task-1");
    expect(useAgentsHubStore.getState().section).toBe("tasks");
    expect(useWorkbenchStore.getState().activeRepositoryId).toBe("linked-repo");
  });

  it("resolves an external worktree from a cached linked-worktree inventory", async () => {
    native.inspect.mockImplementation(async (root: string) => snapshot(root, [primary, linked, another]));
    render(<WorkbenchShell />); await ready();
    await openNotice(notice({ workspaceRoot: another }));
    expect(useAgentsHubStore.getState().sessionTarget).toEqual({ repositoryRoot: primary, workspaceRoot: another });
    expect(native.inspect).not.toHaveBeenCalledWith(primary);
  });

  it("reads registered inventories for an unknown sibling before opening the Hub", async () => {
    native.inspect.mockImplementation(async (root: string) => snapshot(root, root === primary ? [primary, linked, another] : [primary, linked]));
    render(<WorkbenchShell />); await ready();
    await openNotice(notice({ workspaceRoot: another }));
    await waitFor(() => expect(useAgentsHubStore.getState().sessionTarget).toEqual({ repositoryRoot: primary, workspaceRoot: another }));
    expect(native.inspect).toHaveBeenCalledWith(primary);
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"].activeWorktreePath).toBe(linked);
  });

  it("does not treat an arbitrary child directory as a registered workspace", async () => {
    render(<WorkbenchShell />); await ready();
    await openNotice(notice({ workspaceRoot: primary + "/unregistered" }));
    await waitFor(() => expect(native.inspect).toHaveBeenCalledWith(primary));
    expect(useAgentsHubStore.getState().sessionTarget).toBeNull();
    expect(screen.getByTestId("repository-tools")).toBeVisible();
  });

  it.each(["navigation", "detach"])("discards an inventory response after intervening %s", async (change) => {
    let finish!: (snapshot: RepositorySnapshot) => void;
    native.inspect.mockImplementation((root: string) => root === primary
      ? new Promise<RepositorySnapshot>(resolve => { finish = resolve; }) : Promise.resolve(snapshot(root)));
    render(<WorkbenchShell />); await ready();
    await openNotice(notice({ workspaceRoot: another }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (change === "navigation") await userEvent.click(screen.getByRole("button", { name: "设置" }));
    else act(() => useWorkbenchStore.getState().removeRepository("repo-1"));
    await act(async () => finish(snapshot(primary, [primary, linked, another])));
    expect(useAgentsHubStore.getState().sessionTarget).toBeNull();
    if (change === "navigation") expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute("aria-current", "page");
  });

  it("retains exact terminal routing while agent notices move to the Hub", async () => {
    render(<WorkbenchShell />); await ready();
    await userEvent.click(screen.getByRole("button", { name: "Agents Hub" }));
    await openNotice(notice({ source: "terminal", repositoryId: "repo-1", terminalId: "pty-2" }));
    await waitFor(() => expect(screen.getByTestId("repository-tools")).toBeVisible());
    expect(screen.getByTestId("repository-tools")).toHaveAttribute("data-tab", "terminal");
    expect(useTaskNotifications.getState().terminalTarget).toEqual(expect.objectContaining({ workspaceRoot: linked, id: "pty-2" }));
  });

  it("suppresses agent toasts only for the exact visible focused Hub session", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<WorkbenchShell />); await ready();
    await userEvent.click(screen.getByRole("button", { name: "在 Agents Hub 中管理" }));
    complete("visible");
    expect(native.notify).not.toHaveBeenCalled();
    complete("different-workspace", another);
    await waitFor(() => expect(native.notify).toHaveBeenCalledTimes(1));
    act(() => useAgentsHubStore.getState().showTasks());
    complete("task-section");
    await waitFor(() => expect(native.notify).toHaveBeenCalledTimes(2));
    act(() => useAgentsHubStore.getState().showSession({ repositoryRoot: primary, workspaceRoot: linked }));
    await userEvent.click(screen.getByRole("button", { name: "Help" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /使用文档/ }));
    complete("guide-overlay");
    await waitFor(() => expect(native.notify).toHaveBeenCalledTimes(3));
    expect(useTaskNotifications.getState().notices).toHaveLength(4);
  });
});
