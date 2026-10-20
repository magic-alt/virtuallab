import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentConfiguration } from '@/stores/agentConfiguration';
import { useAgentSessionStore } from '@/stores/agentSessions';
import { useAgentTimeline } from '@/stores/agentTimeline';
import { useAgentPreferences } from '@/stores/agentPreferences';
import { useAgentsHubStore } from '@/stores/agentsHub';
import { useTaskStore } from '@/stores/tasks';
import type { RepositoryRecord, RepositorySnapshot } from '@/types/workbench';
import { taskFixture } from '@/features/tasks/fixtures';
import { AgentSessionHub } from './AgentSessionHub';

const repo: RepositoryRecord = { id: 'repo', path: '/repo', name: 'Repository', lastOpenedAt: 1 };
const other: RepositoryRecord = { id: 'other', path: '/other', name: 'Other repository', lastOpenedAt: 1 };
const repositories = [repo, other];
const snapshot = (root: string, linked = root === '/repo' ? ['/linked feature'] : []): RepositorySnapshot => ({
  root, name: root, currentBranch: 'main', headSha: 'a'.repeat(40), dirtyCount: 0, stagedCount: 0,
  unstagedCount: 0, untrackedCount: 0, changes: [], branches: [], recentCommits: [],
  worktrees: [root, ...linked].map(path => ({ path, head: 'a'.repeat(40), branch: 'main', detached: false })),
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const invoke = vi.fn();
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
const props = () => ({ repositories, activeRepository: repo, visible: true, onOpenWorkspace: vi.fn(), onOpenTask: vi.fn() });
const mutations = () => invoke.mock.calls.filter(([name]) => ['agent_session_start', 'agent_turn_start', 'agent_session_stop', 'agent_cli_session_start', 'agent_cli_turn_start', 'task_launch'].includes(name));

beforeEach(() => {
  useAgentConfiguration.setState({ roles: [], skills: [], selections: {} });
  useAgentSessionStore.setState({ bindings: {} });
  useAgentTimeline.setState(useAgentTimeline.getInitialState(), true);
  useAgentPreferences.setState({ codexExecutablePath: '' });
  useAgentsHubStore.setState({ section: 'sessions', sessionTarget: null, visibleSessionRoot: null });
  useTaskStore.setState({ ...useTaskStore.getInitialState(), roots: repositories.map(item => item.path), loading: false });
  invoke.mockReset().mockImplementation(async (command: string, args?: Record<string, any>) => {
    if (command === 'inspect_repository') return snapshot(args?.path);
    if (command === 'agent_journal_recover') return { workspaceId: 'metadata', nativeSessionRegistered: false, retainedEvents: 0, turns: [] };
    if (command === 'agent_journal_recent') return [];
    throw new Error('Unexpected native command: ' + command);
  });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
});
afterEach(() => vi.unstubAllGlobals());

describe('Agents Hub workspace sessions', () => {
  it('discovers primary and sibling worktrees from registered repositories without starting a runtime', async () => {
    const callbacks = props();
    render(<AgentSessionHub {...callbacks}/>);
    await screen.findByRole('textbox', { name: 'Agent message' });
    expect(calls('inspect_repository').map(([, args]) => args.path).sort()).toEqual(['/other', '/repo']);
    expect(screen.getByRole('combobox', { name: '会话仓库' })).toHaveValue('/repo');
    const workspace = screen.getByRole('combobox', { name: '会话工作区' });
    expect(within(workspace).getByRole('option', { name: /\/linked feature/ })).toBeEnabled();
    await userEvent.selectOptions(workspace, '/linked feature');
    await waitFor(() => expect(useAgentsHubStore.getState().visibleSessionRoot).toBe('/linked feature'));
    expect(mutations()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: '打开终端' }));
    expect(callbacks.onOpenWorkspace).toHaveBeenCalledWith('/linked feature', 'terminal', '/repo');
  });

  it('honors an explicit target without selecting the active repository instead', async () => {
    useAgentsHubStore.getState().showSession({ repositoryRoot: '/other', workspaceRoot: '/other' });
    render(<AgentSessionHub {...props()}/>);
    await screen.findByRole('textbox', { name: 'Agent message' });
    expect(screen.getByRole('combobox', { name: '会话仓库' })).toHaveValue('/other');
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBe('/other');
  });

  it('retains one draft when the same linked workspace is also registered directly', async () => {
    const direct: RepositoryRecord = { id: 'linked', path: '/linked feature', name: 'Linked workspace', lastOpenedAt: 1 };
    useTaskStore.setState({ roots: ['/repo', '/linked feature'] });
    useAgentsHubStore.getState().showSession({ repositoryRoot: '/repo', workspaceRoot: '/linked feature' });
    render(<AgentSessionHub {...props()} repositories={[repo, direct]}/>);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Agent message' }), 'One workspace draft');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '会话仓库' }), '/linked feature');
    expect(screen.getByRole('textbox', { name: 'Agent message' })).toHaveValue('One workspace draft');
    expect(screen.getAllByTestId('agent-workspace')).toHaveLength(1);
    expect(useAgentsHubStore.getState().sessionTarget).toEqual({ repositoryRoot: '/linked feature', workspaceRoot: '/linked feature' });
  });

  it.each([false, true])('requires the primary Task source when viewing a direct worktree alias (primary inspection failed: %s)', async failedInspection => {
    const direct: RepositoryRecord = { id: 'linked', path: '/linked feature', name: 'Linked workspace', lastOpenedAt: 1 };
    useTaskStore.setState({ roots: ['/repo', '/linked feature'], repositoryErrors: { '/repo': 'Primary Task source unavailable' } });
    useAgentsHubStore.getState().showSession({ repositoryRoot: direct.path, workspaceRoot: direct.path });
    invoke.mockImplementation(async (command, args) => {
      if (command === 'inspect_repository') {
        if (args.path === '/repo' && failedInspection) throw new Error('Primary inventory unavailable');
        return snapshot(args.path, args.path === direct.path ? ['/repo'] : [direct.path]);
      }
      return command === 'agent_journal_recover' ? { workspaceId: 'metadata', nativeSessionRegistered: false, retainedEvents: 0, turns: [] } : [];
    });
    render(<AgentSessionHub {...props()} repositories={[repo, direct]}/>);
    await waitFor(() => expect(screen.getByRole('combobox', { name: '会话工作区' })).toHaveValue(direct.path));
    expect(screen.queryByRole('textbox', { name: 'Agent message' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Primary Task source unavailable');
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
    expect(mutations()).toEqual([]);
  });

  it('retains known Task owners when a later owner inventory becomes unavailable', async () => {
    const direct: RepositoryRecord = { id: 'linked', path: '/linked feature', name: 'Linked workspace', lastOpenedAt: 1 };
    useTaskStore.setState({ roots: ['/repo', '/linked feature'] });
    useAgentsHubStore.getState().showSession({ repositoryRoot: direct.path, workspaceRoot: direct.path });
    render(<AgentSessionHub {...props()} repositories={[repo, direct]}/>);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Agent message' }), 'Alias draft');
    invoke.mockImplementation(async (command, args) => {
      if (command === 'inspect_repository') {
        if (args.path === '/repo') throw new Error('Owner inventory unavailable');
        return snapshot(direct.path);
      }
      return command === 'agent_journal_recover' ? { workspaceId: 'metadata', nativeSessionRegistered: false, retainedEvents: 0, turns: [] } : [];
    });
    await userEvent.click(screen.getByRole('button', { name: '刷新工作区' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '会话工作区' })).toBeEnabled());
    act(() => useTaskStore.setState({ repositoryErrors: { '/repo': 'Owner Task source unavailable' }, tasks: [] }));
    expect(screen.queryByRole('textbox', { name: 'Agent message' })).not.toBeInTheDocument();
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
    expect(mutations()).toEqual([]);
  });

  it('checks Task sources for related owners discovered by launch preflight', async () => {
    const direct: RepositoryRecord = { id: 'linked', path: '/linked feature', name: 'Linked workspace', lastOpenedAt: 1 };
    let connected = false;
    useTaskStore.setState({ roots: ['/repo', '/linked feature'], repositoryErrors: { '/repo': 'Owner Task source unavailable' } });
    useAgentsHubStore.getState().showSession({ repositoryRoot: direct.path, workspaceRoot: direct.path });
    invoke.mockImplementation(async (command, args) => {
      if (command === 'inspect_repository') return snapshot(args.path, connected && args.path === direct.path ? ['/repo'] : []);
      if (command === 'agent_harness_capabilities') return { harness: 'codex', available: true, detail: 'Available', executablePath: '/tools/codex', features: {} };
      if (command === 'agent_session_start') return { workspaceRoot: direct.path, harness: 'codex', threadId: 'thread', createdAtMs: 1, updatedAtMs: 1 };
      if (command === 'agent_turn_start') return { threadId: 'thread', turnId: 'turn' };
      return command === 'agent_journal_recover' ? { workspaceId: 'metadata', nativeSessionRegistered: false, retainedEvents: 0, turns: [] } : [];
    });
    render(<AgentSessionHub {...props()} repositories={[repo, direct]}/>);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Agent message' }), 'Discover another owner');
    connected = true;
    await userEvent.click(screen.getByRole('button', { name: 'Connect & send' }));
    await waitFor(() => expect(calls('inspect_repository')).toHaveLength(3));
    expect(mutations()).toEqual([]);
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
  });

  it.each([
    { repositoryRoot: '/removed-repo', workspaceRoot: '/removed-repo' },
    { repositoryRoot: '/repo', workspaceRoot: '/not-a-worktree' },
  ])('does not silently replace an invalid explicit target $workspaceRoot', async target => {
    useAgentsHubStore.getState().showSession(target);
    useAgentSessionStore.getState().setBinding({ workspaceRoot: target.workspaceRoot, harness: 'codex', threadId: 'old', createdAtMs: 1, updatedAtMs: 1 });
    render(<AgentSessionHub {...props()}/>);
    await waitFor(() => expect(calls('inspect_repository')).toHaveLength(2));
    await act(async () => undefined);
    expect(screen.queryByRole('textbox', { name: 'Agent message' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/已移除|不属于|不可用/);
    expect(useAgentsHubStore.getState().sessionTarget).toEqual(target);
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
    expect(mutations()).toEqual([]);
  });

  it('keeps missing worktrees and saved-only paths out of the executable inventory', async () => {
    invoke.mockImplementation(async (command, args) => {
      if (command === 'inspect_repository') return { ...snapshot(args.path), worktrees: [...snapshot(args.path).worktrees, { path: '/missing', head: 'a'.repeat(40), detached: false, missing: true }] };
      return command === 'agent_journal_recover' ? { workspaceId: 'metadata', nativeSessionRegistered: false, retainedEvents: 0, turns: [] } : [];
    });
    useAgentSessionStore.getState().setBinding({ workspaceRoot: '/saved-only', harness: 'claude', threadId: 'saved', createdAtMs: 1, updatedAtMs: 1 });
    render(<AgentSessionHub {...props()}/>);
    await screen.findByRole('textbox', { name: 'Agent message' });
    const options = within(screen.getByRole('combobox', { name: '会话工作区' })).getAllByRole('option');
    expect(options.map(option => (option as HTMLOptionElement).value)).not.toContain('/missing');
    expect(options.map(option => (option as HTMLOptionElement).value)).not.toContain('/saved-only');
  });

  it('rechecks membership before attachment when a selected worktree disappears after discovery', async () => {
    let linked = true;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'inspect_repository') return snapshot(args.path, args.path === '/repo' && linked ? ['/linked feature'] : []);
      if (command === 'agent_journal_recover') return { workspaceId: 'metadata', nativeSessionRegistered: false, retainedEvents: 0, turns: [] };
      if (command === 'agent_journal_recent') return [];
      if (command === 'agent_harness_capabilities') return { harness: 'codex', available: true, detail: 'Available', executablePath: '/tools/codex', features: {} };
      if (command === 'agent_session_start') return { workspaceRoot: '/linked feature', harness: 'codex', threadId: 'thread', createdAtMs: 1, updatedAtMs: 1 };
      if (command === 'agent_turn_start') return { threadId: 'thread', turnId: 'turn' };
      throw new Error('Unexpected native command: ' + command);
    });
    useAgentsHubStore.getState().showSession({ repositoryRoot: '/repo', workspaceRoot: '/linked feature' });
    render(<AgentSessionHub {...props()}/>);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Agent message' }), 'Retain my draft');
    linked = false;
    await userEvent.click(screen.getByRole('button', { name: 'Connect & send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/工作区.*不可用|工作区.*移除/);
    expect(mutations()).toEqual([]);
    expect(screen.queryByRole('textbox', { name: 'Agent message' })).not.toBeInTheDocument();
    linked = true;
    await userEvent.click(screen.getByRole('button', { name: '刷新工作区' }));
    expect(await screen.findByRole('textbox', { name: 'Agent message' })).toHaveValue('Retain my draft');
  });

  it('revokes a confirmed panel when its launch preflight cannot read the repository', async () => {
    render(<AgentSessionHub {...props()}/>);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Agent message' }), 'Retain through failure');
    invoke.mockImplementation(async command => { if (command === 'inspect_repository') throw new Error('Repository unavailable'); return []; });
    await userEvent.click(screen.getByRole('button', { name: 'Connect & send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Repository unavailable');
    expect(screen.queryByRole('textbox', { name: 'Agent message' })).not.toBeInTheDocument();
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
    expect(mutations()).toEqual([]);
  });

  it('does not restore a removed workspace from a superseded launch preflight', async () => {
    useAgentsHubStore.getState().showSession({ repositoryRoot: '/repo', workspaceRoot: '/linked feature' });
    render(<AgentSessionHub {...props()}/>);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Agent message' }), 'Delayed preflight');
    const old = deferred<RepositorySnapshot>();
    let first = true;
    invoke.mockImplementation((command, args) => {
      if (command === 'inspect_repository' && args.path === '/repo' && first) { first = false; return old.promise; }
      if (command === 'inspect_repository') return Promise.resolve(snapshot(args.path, []));
      if (command === 'agent_journal_recover') return Promise.resolve({ workspaceId: 'metadata', nativeSessionRegistered: false, retainedEvents: 0, turns: [] });
      return Promise.resolve([]);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Connect & send' }));
    await waitFor(() => expect(calls('inspect_repository')).toHaveLength(3));
    await userEvent.click(screen.getByRole('button', { name: '刷新工作区' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('已移除');
    await act(async () => old.resolve(snapshot('/repo')));
    expect(screen.getByRole('alert')).toHaveTextContent('已移除');
    expect(screen.queryByRole('textbox', { name: 'Agent message' })).not.toBeInTheDocument();
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
    expect(mutations()).toEqual([]);
  });

  it.each(['queued', 'succeeded'] as const)('opens task execution for a %s task workspace instead of exposing a manual session controller', async state => {
    const callbacks = props();
    useTaskStore.setState({ tasks: [taskFixture({ workspaceRoot: '/linked feature', attempts: [{ id: 'attempt', state, phase: 'implementation', candidateSha: null, failure: null, startedAtMs: 1, endedAtMs: state === 'succeeded' ? 2 : null, evidence: null }] })] });
    useAgentsHubStore.getState().showSession({ repositoryRoot: '/repo', workspaceRoot: '/linked feature' });
    render(<AgentSessionHub {...callbacks}/>);
    await userEvent.click(await screen.findByRole('button', { name: /打开任务/ }));
    expect(callbacks.onOpenTask).toHaveBeenCalledWith('task-1');
    expect(screen.queryByRole('textbox', { name: 'Agent message' })).not.toBeInTheDocument();
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
    expect(mutations()).toEqual([]);
  });

  it.each(['loading', 'global-error', 'repository-error', 'unobserved'] as const)('inhibits manual execution while task ownership is %s', async reason => {
    if (reason === 'loading') useTaskStore.setState({ loading: true });
    if (reason === 'global-error') useTaskStore.setState({ error: 'Task source unavailable' });
    if (reason === 'repository-error') useTaskStore.setState({ repositoryErrors: { '/repo': 'Task source unavailable' } });
    if (reason === 'unobserved') useTaskStore.setState({ roots: [] });
    render(<AgentSessionHub {...props()}/>);
    await waitFor(() => expect(calls('inspect_repository')).toHaveLength(2));
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: 'Connect & send' })).not.toBeInTheDocument();
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
    expect(mutations()).toEqual([]);
  });

  it('preserves each visited workspace draft and configuration editor across switching and hiding', async () => {
    const callbacks = props();
    const page = render(<AgentSessionHub {...callbacks}/>);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Agent message' }), 'Primary draft');
    await userEvent.click(screen.getByText('Role & optional skills · advanced'));
    await userEvent.type(screen.getByRole('textbox', { name: 'New role name' }), 'Unfinished role');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '会话工作区' }), '/linked feature');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Agent message' }), 'Linked draft');
    page.rerender(<AgentSessionHub {...callbacks} visible={false}/>);
    await waitFor(() => expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull());
    const reads = calls('agent_journal_recent').length;
    await act(async () => undefined);
    expect(calls('agent_journal_recent')).toHaveLength(reads);
    page.rerender(<AgentSessionHub {...callbacks}/>);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Agent message' })).toHaveValue('Linked draft'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '会话工作区' })).toBeEnabled());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '会话工作区' }), '/repo');
    expect(await screen.findByRole('textbox', { name: 'Agent message' })).toHaveValue('Primary draft');
    expect(screen.getByRole('textbox', { name: 'New role name' })).toHaveValue('Unfinished role');
    page.unmount();
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
    expect(mutations()).toEqual([]);
  });

  it('keeps a previously confirmed panel visible with actions disabled during ownership refreshes', async () => {
    render(<AgentSessionHub {...props()}/>);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Agent message' }), 'Still visible');
    act(() => useTaskStore.setState({ loading: true }));
    expect(screen.getByRole('textbox', { name: 'Agent message' })).toHaveValue('Still visible');
    expect(screen.getByRole('button', { name: 'Connect & send' })).toBeDisabled();
    expect(screen.queryByText(/Native desktop runtime required/)).not.toBeInTheDocument();
    act(() => useTaskStore.setState({ loading: false }));
    expect(screen.getByRole('button', { name: 'Connect & send' })).toBeEnabled();
    const delayed = deferred<RepositorySnapshot>();
    invoke.mockImplementation((command, args) => command === 'inspect_repository' && args.path === '/repo' ? delayed.promise
      : Promise.resolve(command === 'inspect_repository' ? snapshot(args.path)
        : command === 'agent_journal_recover' ? { workspaceId: 'metadata', nativeSessionRegistered: false, retainedEvents: 0, turns: [] } : []));
    await userEvent.click(screen.getByRole('button', { name: '刷新工作区' }));
    expect(screen.getByRole('textbox', { name: 'Agent message' })).toHaveValue('Still visible');
    expect(screen.getByRole('button', { name: 'Connect & send' })).toBeDisabled();
    await act(async () => delayed.resolve(snapshot('/repo')));
    expect(screen.getByRole('button', { name: 'Connect & send' })).toBeEnabled();
  });

  it('rejects a foreign snapshot and ignores inventory that returns after its repository was removed', async () => {
    const delayed = deferred<RepositorySnapshot>();
    invoke.mockImplementation((command, args) => command === 'inspect_repository' ? args.path === '/repo' ? delayed.promise : Promise.resolve(snapshot('/foreign')) : Promise.resolve([]));
    const callbacks = props();
    const page = render(<AgentSessionHub {...callbacks}/>);
    page.rerender(<AgentSessionHub {...callbacks} repositories={[other]} activeRepository={other}/>);
    await act(async () => delayed.resolve(snapshot('/repo')));
    expect(await screen.findByRole('alert')).toHaveTextContent(/已移除|不匹配/);
    expect(screen.queryByRole('textbox', { name: 'Agent message' })).not.toBeInTheDocument();
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
  });
});
