import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskAttempt, TaskAttemptReport, TaskRecord } from '@/types/tasks';
import { useTaskStore } from '@/stores/tasks';
import { taskFixture, readinessFixture } from './fixtures';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
import { TaskDetail } from './TaskDetail';

const attempt = (patch: Partial<TaskAttempt> = {}): TaskAttempt => ({
  id: 'attempt-1', state: 'running', phase: 'implementation', candidateSha: null,
  failure: null, startedAtMs: 1, endedAtMs: null, evidence: null,
  execution: { harness: 'codex', executablePath: '/opt/codex', version: 'codex-cli', threadId: 'thread', turnId: 'turn' },
  ...patch,
});
const reportFixture = (patch: Partial<TaskAttemptReport> = {}): TaskAttemptReport => ({
  schemaVersion: 1, taskId: 'task-1', attemptId: 'attempt-1', status: 'running',
  summary: null, entries: [{ sequence: 1, timestampMs: 1, kind: 'assistant', text: '正在检查入口' }],
  problems: [], truncated: false, updatedAtMs: 1, ...patch,
});
let report: TaskAttemptReport | null;
let reportListener: ((event: { payload: { taskId: string; attemptId: string; sequence: number } }) => void) | undefined;

function select(task: TaskRecord, tab: '执行' | '证据' = '执行') {
  useTaskStore.setState({ tasks: [task], roots: ['/repo'], activeTaskId: task.id,
    activeTaskRepositoryRoot: '/repo', activeTaskTab: tab,
    readiness: { [task.id]: readinessFixture() }, readinessErrors: {}, actionErrors: {}, launchErrors: {}, pending: {}, cancelling: {}, events: [] });
}

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  report = reportFixture(); reportListener = undefined;
  native.invoke.mockReset(); native.listen.mockReset();
  native.invoke.mockImplementation(async command => command === 'task_attempt_report' ? report : null);
  native.listen.mockImplementation(async (name, listener) => {
    if (name === 'task://report') reportListener = listener;
    return vi.fn();
  });
});
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });

describe('task execution output and result report', () => {
  it('shows observed Codex output and refreshes only for the selected task and attempt', async () => {
    const task = taskFixture({ attempts: [attempt()] }); select(task);
    render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    const console = await screen.findByRole('region', { name: '任务执行输出' });
    expect(await within(console).findByText('正在检查入口')).toBeVisible();
    await waitFor(() => expect(reportListener).toBeDefined());
    const readCount = native.invoke.mock.calls.filter(([name]) => name === 'task_attempt_report').length;
    await act(async () => reportListener?.({ payload: { taskId: 'other', attemptId: 'attempt-1', sequence: 2 } }));
    expect(native.invoke.mock.calls.filter(([name]) => name === 'task_attempt_report')).toHaveLength(readCount);
    report = reportFixture({ entries: [...report!.entries, { sequence: 2, timestampMs: 2, kind: 'command', text: 'npm test\n3 tests passed' }], updatedAtMs: 2 });
    await act(async () => reportListener?.({ payload: { taskId: task.id, attemptId: 'attempt-1', sequence: 2 } }));
    expect(await within(console).findByText(/3 tests passed/)).toBeVisible();
    expect(native.invoke.mock.calls.some(([name]) => ['task_start', 'task_retry', 'task_prepare_workspace'].includes(name))).toBe(false);
  });

  it('shows a completed summary and recorded problems for a task without a Profile', async () => {
    const task = taskFixture({ attempts: [attempt({ state: 'succeeded', phase: 'review', endedAtMs: 5 })] });
    report = reportFixture({ status: 'succeeded', summary: '已完成 Unicode 输入支持。\n\n验证：3 项测试通过。',
      problems: [{ source: 'provider', message: '仍需确认空字符串的产品规则。' }] });
    select(task, '证据');
    render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    expect(screen.getByRole('tab', { name: '报告' })).toHaveAttribute('aria-selected', 'true');
    const result = await screen.findByRole('region', { name: '任务结果报告' });
    expect(await within(result).findByText(/已完成 Unicode 输入支持/)).toBeVisible();
    expect(within(result).getByText('仍需确认空字符串的产品规则。')).toBeVisible();
    expect(within(result).getByText(/未配置.*Profile/)).toBeVisible();
    expect(within(result).queryByText('当前可交付')).not.toBeInTheDocument();
  });

  it('does not replace the selected attempt output with a delayed response from a previous task', async () => {
    let finishOld!: (value: TaskAttemptReport) => void;
    const oldResponse = new Promise<TaskAttemptReport>(resolve => { finishOld = resolve; });
    native.invoke.mockImplementation(async (name, args) => name === 'task_attempt_report'
      ? args.request.taskId === 'task-1' ? oldResponse : reportFixture({ taskId: 'task-2', attemptId: 'attempt-2', entries: [{ sequence: 1, timestampMs: 1, kind: 'assistant', text: '当前任务输出' }] })
      : null);
    const first = taskFixture({ attempts: [attempt()] }); select(first);
    const page = render(<TaskDetail task={first} onOpenWorkspace={vi.fn()} />);
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('task_attempt_report', { request: { taskId: 'task-1', attemptId: 'attempt-1' } }));
    const second = taskFixture({ id: 'task-2', title: '另一个任务', attempts: [attempt({ id: 'attempt-2' })] });
    act(() => select(second));
    page.rerender(<TaskDetail task={second} onOpenWorkspace={vi.fn()} />);
    expect(await screen.findByText('当前任务输出')).toBeVisible();
    await act(async () => finishOld(reportFixture({ entries: [{ sequence: 1, timestampMs: 1, kind: 'assistant', text: '过期任务输出' }] })));
    expect(screen.queryByText('过期任务输出')).not.toBeInTheDocument();
    expect(screen.getByText('当前任务输出')).toBeVisible();
  });

  it('catches output written before a delayed listener attaches and releases that listener on unmount', async () => {
    let attach!: (stop: () => void) => void;
    const stop = vi.fn();
    native.listen.mockImplementation(() => new Promise<() => void>(resolve => { attach = resolve; }));
    const task = taskFixture({ attempts: [attempt()] }); select(task);
    const page = render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    expect(await screen.findByText('正在检查入口')).toBeVisible();
    report = reportFixture({ entries: [{ sequence: 2, timestampMs: 2, kind: 'assistant', text: '监听建立前的输出' }] });
    await act(async () => attach(stop));
    expect(await screen.findByText('监听建立前的输出')).toBeVisible();
    page.unmount(); expect(stop).toHaveBeenCalledTimes(1);
  });

  it('shows missing legacy reports and recoverable read failures without inventing a summary', async () => {
    report = null;
    const task = taskFixture({ attempts: [attempt({ state: 'failed', failure: 'CLI 身份验证失败', endedAtMs: 3 })] }); select(task, '证据');
    render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    const result = await screen.findByRole('region', { name: '任务结果报告' });
    expect(await within(result).findByText(/没有可读取的.*总结/)).toBeVisible();
    expect(within(result).getByText('CLI 身份验证失败')).toBeVisible();
    native.invoke.mockRejectedValueOnce(new Error('report source offline'));
    await userEvent.click(within(result).getByRole('button', { name: '刷新报告' }));
    expect(await within(result).findByText(/report source offline/)).toBeVisible();
    expect(within(result).queryByText(/已完成.*支持/)).not.toBeInTheDocument();
  });

  it('keeps the implementation summary available after a later verification attempt', async () => {
    const implemented = attempt({ state: 'succeeded', phase: 'review', endedAtMs: 3 });
    const verified = attempt({ id: 'verify-2', state: 'failed', phase: 'verification', execution: undefined, failure: '独立检查失败', endedAtMs: 4 });
    const task = taskFixture({ attempts: [implemented, verified] }); select(task, '证据');
    native.invoke.mockImplementation(async (name, args) => name === 'task_attempt_report'
      ? reportFixture({ attemptId: args.request.attemptId, status: args.request.attemptId === 'verify-2' ? 'failed' : 'succeeded',
          summary: args.request.attemptId === 'verify-2' ? null : '实现总结仍然可读', entries: [] }) : null);
    render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    const result = await screen.findByRole('region', { name: '任务结果报告' });
    expect(await within(result).findByText('实现总结仍然可读')).toBeVisible();
    expect(within(result).getByText('独立检查失败')).toBeVisible();
  });

  it('does not reuse an earlier Agent report when an implementation retry fails before Agent startup', async () => {
    const implemented = attempt({ state: 'succeeded', phase: 'review', endedAtMs: 3 });
    const failure = 'Git content conversion is not qualified; use a byte-preserving configuration or manual candidate review.';
    const retried = attempt({ id: 'retry-2', state: 'failed', execution: undefined, failure, endedAtMs: 4 });
    const task = taskFixture({ attempts: [implemented, retried] }); select(task, '证据');
    native.invoke.mockImplementation(async (name, args) => name === 'task_attempt_report'
      ? reportFixture({ attemptId: args.request.attemptId, status: args.request.attemptId === 'retry-2' ? 'failed' : 'succeeded',
          summary: args.request.attemptId === 'retry-2' ? null : '上次实现已经完成', entries: [],
          problems: args.request.attemptId === 'retry-2' ? [{ source: 'native', message: failure }] : [{ source: 'provider', message: '上次实现的问题' }] }) : null);
    render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    const result = await screen.findByRole('region', { name: '任务结果报告' });
    expect(await within(result).findByRole('button', { name: '刷新报告' })).toBeEnabled();
    expect(within(result).queryByText('上次实现已经完成')).not.toBeInTheDocument();
    expect(within(result).queryByText('上次实现的问题')).not.toBeInTheDocument();
    expect(within(result).getByText(/没有可读取的.*总结/)).toBeVisible();
    expect(within(result).getByText(failure)).toBeVisible();
  });

  it('does not present a superseded implementation problem as a current result', async () => {
    const task = taskFixture({ attempts: [attempt({ id: 'old-failure', state: 'failed', endedAtMs: 2 }), attempt({ state: 'succeeded', phase: 'review', endedAtMs: 3 })] });
    select(task, '证据');
    native.invoke.mockImplementation(async (name, args) => name === 'task_attempt_report'
      ? reportFixture({ attemptId: args.request.attemptId, status: args.request.attemptId === 'old-failure' ? 'failed' : 'succeeded',
        summary: args.request.attemptId === 'old-failure' ? '旧实现失败' : '已修复后成功执行',
        problems: args.request.attemptId === 'old-failure' ? [{ source: 'provider', message: '已经修复的旧问题' }] : [] }) : null);
    render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    const result = await screen.findByRole('region', { name: '任务结果报告' });
    expect(await within(result).findByText('已修复后成功执行')).toBeVisible();
    expect(within(result).queryByText('已经修复的旧问题')).not.toBeInTheDocument();
  });

  it('releases a listener that arrives after the task detail has unmounted', async () => {
    let attach!: (stop: () => void) => void;
    const stop = vi.fn();
    native.listen.mockImplementation(() => new Promise<() => void>(resolve => { attach = resolve; }));
    const task = taskFixture({ attempts: [attempt()] }); select(task);
    const page = render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    expect(await screen.findByText('正在检查入口')).toBeVisible();
    page.unmount();
    const reads = native.invoke.mock.calls.length;
    await act(async () => attach(stop));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(native.invoke.mock.calls).toHaveLength(reads);
  });

  it('shows a retained launch failure before any Attempt exists', () => {
    const task = taskFixture({ workspaceRoot: null, attempts: [] }); select(task, '证据');
    useTaskStore.setState({ launchErrors: { [task.id]: '独立工作区准备失败，请核对目标目录。' } });
    render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    const result = screen.getByRole('region', { name: '任务结果报告' });
    expect(within(result).getByText('独立工作区准备失败，请核对目标目录。')).toBeVisible();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
