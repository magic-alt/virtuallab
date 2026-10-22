import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_SNAPSHOT } from '@/data/preview';
import { TaskDetail, type OpenTaskWorkspace } from '@/features/tasks/TaskDetail';
import { taskFixture } from '@/features/tasks/fixtures';
import { workspaceKey } from '@/lib/workspaceKey';
import { useTaskStore } from '@/stores/tasks';
import { useTaskNotifications } from '@/stores/taskNotifications';
import { useWorkbenchStore } from '@/stores/workbench';
import type { RepositorySnapshot } from '@/types/workbench';

const native = vi.hoisted(() => ({
  inspect: vi.fn(), spawn: vi.fn(), stop: vi.fn(), write: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  holdTerminalListener: false,
  releaseListeners: [] as Array<() => void>,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    if (name === 'terminal://output' && native.holdTerminalListener) {
      await new Promise<void>(resolve => { native.releaseListeners.push(resolve); });
    }
    const listeners = native.listeners.get(name) ?? new Set();
    listeners.add(callback);
    native.listeners.set(name, listeners);
    return () => listeners.delete(callback);
  }),
}));
vi.mock('@/lib/backend', async original => ({
  ...await original<typeof import('@/lib/backend')>(),
  isDesktopRuntime: () => true,
  inspectRepository: native.inspect,
  inspectWorktreeStatus: vi.fn(),
  terminalSpawn: native.spawn,
  terminalStop: native.stop,
  terminalWrite: native.write,
  terminalResize: vi.fn().mockResolvedValue(undefined),
  watchStart: vi.fn().mockResolvedValue(undefined),
  watchStop: vi.fn().mockResolvedValue(undefined),
  getAppBuildInfo: vi.fn().mockResolvedValue({
    version: '0.5.12', gitCommit: 'abc123', gitBranch: 'main',
    gitDirty: false, builtAtUnixSeconds: 1, profile: 'release',
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = {}; cols = 120; rows = 32;
    loadAddon() {} open() {} write() {} focus() {} dispose() {}
    onData() { return { dispose() {} }; }
  },
}));
vi.mock('@/features/tasks/useTaskObserver', () => ({ useTaskObserver: vi.fn() }));
vi.mock('@/features/agents/AgentsHub', () => ({
  AgentsHub: ({ onOpenWorkspace }: { onOpenWorkspace: OpenTaskWorkspace }) => {
    const task = useTaskStore(state => state.tasks.find(item => item.id === state.activeTaskId));
    return task ? <TaskDetail task={task} onOpenWorkspace={onOpenWorkspace} /> : null;
  },
}));
vi.mock('@/features/workspace/RepositoryContextSelector', () => ({
  RepositoryContextSelector: () => null, ContextRepositoryList: () => null,
}));
vi.mock('@/features/execution/ProcessRunner', () => ({ ProcessRunner: () => null }));
vi.mock('@/features/review/ChangesReview', () => ({ ChangesReview: () => null }));
vi.mock('@/features/github/GithubPanel', () => ({ GithubPanel: () => null }));

import { WorkbenchShell } from './WorkbenchShell';

const primary = 'C:/repositories/primary repo';
const linked = 'D:/任务 worktrees/feature & review';
const other = 'E:/other repo';
function snapshot(root: string, worktrees = [primary, linked]): RepositorySnapshot {
  return {
    ...PREVIEW_SNAPSHOT, root, name: root === other ? 'Other' : 'Primary', currentBranch: 'main',
    worktrees: worktrees.map(path => ({ path, branch: path === primary ? 'main' : 'feature', head: 'abc123', detached: false })),
    branches: [],
  };
}
async function openTaskTerminal() {
  await userEvent.click(screen.getByRole('button', { name: 'Agents Hub' }));
  await userEvent.click(screen.getByRole('button', { name: '打开终端' }));
}
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: '在 Agents Hub 中管理' })).toBeEnabled());
}
function emit(eventType: string, id: string) {
  act(() => {
    for (const callback of native.listeners.get('workbench://event') ?? []) callback({ payload: { eventType, id } });
  });
}

beforeEach(() => {
  native.listeners.clear(); native.holdTerminalListener = false; native.releaseListeners = [];
  native.inspect.mockReset().mockImplementation(async (root: string) => snapshot(root, workspaceKey(root) === workspaceKey(other) ? [other] : undefined));
  native.spawn.mockReset().mockResolvedValue(undefined);
  native.stop.mockReset().mockResolvedValue(undefined);
  native.write.mockReset().mockResolvedValue(undefined);
  useWorkbenchStore.setState({
    repositories: [
      { id: 'owner', name: 'Primary', path: primary, lastOpenedAt: 1 },
      { id: 'other', name: 'Other', path: other, lastOpenedAt: 1 },
    ],
    activeRepositoryId: 'other',
    workspaceStates: { other: { repositoryId: 'other', activeWorktreePath: other, activeTab: 'overview', updatedAt: 1 } },
  });
  useTaskStore.setState({
    roots: [primary], tasks: [taskFixture({ repositoryRoot: primary, workspaceRoot: linked })],
    activeTaskId: 'task-1', activeTaskTab: '执行', navigationRevision: 0,
    pending: {}, cancelling: {}, actionErrors: {}, launchErrors: {}, readiness: {}, readinessErrors: {}, events: [],
  });
  useTaskNotifications.setState({ notices: [], desktopEnabled: false, terminalTarget: null });
});

describe('Task terminal action through the workbench', () => {
  it('opens a native shell in the task worktree and owner repository from another selected repository', async () => {
    render(<StrictMode><WorkbenchShell /></StrictMode>); await ready();
    await openTaskTerminal();
    await waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(1));
    expect(native.spawn).toHaveBeenCalledWith(expect.any(String), linked, 120, 32);
    expect(useWorkbenchStore.getState().activeRepositoryId).toBe('owner');
    expect(useWorkbenchStore.getState().workspaceStates.owner).toMatchObject({ activeWorktreePath: linked, activeTab: 'terminal' });
    expect(screen.getByRole('button', { name: 'Terminal 1' })).toBeVisible();

    await openTaskTerminal();
    await ready();
    expect(native.spawn).toHaveBeenCalledTimes(1);
    expect(native.stop).not.toHaveBeenCalled();
  });

  it('does not start a shell merely by visiting the ordinary Terminal tab', async () => {
    render(<WorkbenchShell />); await ready();
    await userEvent.click(screen.getByRole('button', { name: /^Terminal$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Start terminal$/ })).toBeEnabled());
    expect(native.spawn).not.toHaveBeenCalled();
  });

  it('keeps the task action unavailable until a task has a workspace', async () => {
    useTaskStore.setState({ tasks: [taskFixture({ repositoryRoot: primary, workspaceRoot: null })] });
    render(<WorkbenchShell />); await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Agents Hub' }));
    expect(screen.getByRole('button', { name: '打开终端' })).toBeDisabled();
    expect(native.spawn).not.toHaveBeenCalled();
  });

  it('creates a new shell when the workspace has only a stopped terminal', async () => {
    render(<WorkbenchShell />); await ready();
    await openTaskTerminal();
    await waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(1));
    emit('terminal.exited', native.spawn.mock.calls[0][0]);
    await openTaskTerminal();
    await waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(2));
    expect(native.spawn.mock.calls[1][1]).toBe(linked);
    expect(screen.getByRole('button', { name: 'Terminal 1' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Terminal 2' })).toBeVisible();
  });

  it.each([false, true])('opens the task owner in an existing worktree alias pane (live shell: %s)', async liveShell => {
    useWorkbenchStore.setState({
      repositories: [...useWorkbenchStore.getState().repositories, { id: 'alias', name: 'Linked alias', path: linked, lastOpenedAt: 1 }],
      activeRepositoryId: 'alias',
      workspaceStates: { alias: { repositoryId: 'alias', activeWorktreePath: linked, activeTab: 'terminal', updatedAt: 1 } },
    });
    render(<WorkbenchShell />); await ready();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Start terminal$/ })).toBeEnabled());
    if (liveShell) await userEvent.click(screen.getByRole('button', { name: /^Start terminal$/ }));
    await openTaskTerminal();
    await waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(1));
    expect(native.spawn.mock.calls[0][1]).toBe(linked);
    expect(useWorkbenchStore.getState().activeRepositoryId).toBe('owner');
    await userEvent.click(screen.getByRole('button', { name: '设置' }));
    act(() => {
      for (const callback of native.listeners.get('terminal://output') ?? []) {
        callback({ payload: { id: native.spawn.mock.calls[0][0], data: [7] } });
      }
    });
    expect(useTaskNotifications.getState().notices[0].repositoryId).toBe('owner');
    expect(native.stop).not.toHaveBeenCalled();
  });

  it('does not reopen a removed task owner through a separately registered worktree', async () => {
    useWorkbenchStore.setState({
      repositories: [
        useWorkbenchStore.getState().repositories[1],
        { id: 'alias', name: 'Linked alias', path: linked, lastOpenedAt: 1 },
      ],
    });
    render(<WorkbenchShell />); await ready();
    await openTaskTerminal();
    expect(useWorkbenchStore.getState().activeRepositoryId).toBe('other');
    expect(screen.getByRole('button', { name: 'Agents Hub' })).toHaveAttribute('aria-current', 'page');
    expect(native.spawn).not.toHaveBeenCalled();
  });

  it('cancels the open request if navigation changes before terminal listeners attach', async () => {
    native.holdTerminalListener = true;
    render(<WorkbenchShell />); await ready();
    await openTaskTerminal();
    await waitFor(() => expect(native.releaseListeners.length).toBeGreaterThan(0));
    expect(native.spawn).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '设置' }));
    await act(async () => { for (const release of native.releaseListeners) release(); });
    await userEvent.click(screen.getByRole('button', { name: '工程仓库' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Start terminal$/ })).toBeEnabled());
    expect(native.spawn).not.toHaveBeenCalled();
    await openTaskTerminal();
    await waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(1));
  });

  it('does not spawn in the primary repository when the task worktree was removed', async () => {
    native.inspect.mockImplementation(async (root: string) => {
      if (workspaceKey(root) === workspaceKey(linked)) throw new Error('Task worktree was removed');
      return snapshot(root, root === other ? [other] : [primary]);
    });
    render(<WorkbenchShell />); await ready();
    await openTaskTerminal();
    await waitFor(() => expect(useWorkbenchStore.getState().workspaceStates.owner?.activeWorktreePath).toBe(primary));
    expect(native.spawn).not.toHaveBeenCalled();
  });

  it('opens only the latest task workspace when an earlier inspection completes late', async () => {
    const newer = 'D:/任务 worktrees/newer task';
    let finishOld!: (value: RepositorySnapshot) => void;
    native.inspect.mockImplementation((root: string) => root === linked
      ? new Promise<RepositorySnapshot>(resolve => { finishOld = resolve; })
      : Promise.resolve(snapshot(root, root === other ? [other] : [primary, linked, newer])));
    render(<WorkbenchShell />); await ready();
    await openTaskTerminal();
    await waitFor(() => expect(finishOld).toBeTypeOf('function'));
    await userEvent.click(screen.getByRole('button', { name: 'Agents Hub' }));
    act(() => useTaskStore.setState({
      tasks: [taskFixture({ id: 'task-2', repositoryRoot: primary, workspaceRoot: newer })],
      activeTaskId: 'task-2', navigationRevision: 1,
    }));
    await userEvent.click(screen.getByRole('button', { name: '打开终端' }));
    await waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(1));
    expect(native.spawn.mock.calls[0][1]).toBe(newer);
    await act(async () => finishOld(snapshot(linked, [primary, linked, newer])));
    expect(native.spawn).toHaveBeenCalledTimes(1);
    expect(useWorkbenchStore.getState().workspaceStates.owner.activeWorktreePath).toBe(newer);
  });

  it('reuses a shell that is still starting when the task action is repeated', async () => {
    let acknowledge!: () => void;
    native.spawn.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    render(<WorkbenchShell />); await ready();
    await openTaskTerminal();
    await waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Terminal 1' }).querySelector('span')).toHaveClass('bg-amber-400');
    await openTaskTerminal();
    await ready();
    expect(native.spawn).toHaveBeenCalledTimes(1);
    await act(async () => acknowledge());
    expect(screen.getByRole('button', { name: 'Terminal 1' }).querySelector('span')).toHaveClass('bg-emerald-400');
    expect(native.spawn).toHaveBeenCalledTimes(1);
  });
});
