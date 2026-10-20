import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentPreferences } from '@/stores/agentPreferences';
import { useTaskStore } from '@/stores/tasks';
import { taskFixture } from './fixtures';
import { TaskDetail } from './TaskDetail';
import type { TaskRecord } from '@/types/tasks';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }));
let task: TaskRecord;

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  task = taskFixture();
  useTaskStore.setState({ ...useTaskStore.getInitialState(), roots: ['/repo'], tasks: [task], activeTaskId: task.id, activeTaskTab: '执行' });
  useAgentPreferences.getState().setCodexExecutablePath('C:\\Program Files\\Codex\\codex.exe');
  native.invoke.mockImplementation(async name => name === 'task_list' ? [task] : name === 'task_events' ? [] : name === 'task_start' || name === 'task_retry' ? task : null);
});
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); useAgentPreferences.getState().setCodexExecutablePath(''); });

describe('task executable defaults', () => {
  it('uses the configured executable for manual start', async () => {
    render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '开始执行' }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('task_start', { request: { taskId: task.id, executablePath: 'C:\\Program Files\\Codex\\codex.exe' } }));
  });

  it('uses the configured executable for a new retry attempt', async () => {
    task = taskFixture({ attempts: [{ id: 'failed', state: 'failed', phase: 'implementation', failure: 'old error',
      candidateSha: null, startedAtMs: 1, endedAtMs: 2, evidence: null }] });
    render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '重试（新 Attempt）' }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('task_retry', { request: { taskId: task.id, executablePath: 'C:\\Program Files\\Codex\\codex.exe' } }));
  });

  it('preserves an explicit blank override as native auto-detection', async () => {
    render(<TaskDetail task={task} onOpenWorkspace={vi.fn()} />);
    await userEvent.click(screen.getByText('重试时使用的执行程序'));
    await userEvent.clear(screen.getByLabelText('可执行程序路径（可选，不含参数）'));
    await userEvent.click(screen.getByRole('button', { name: '开始执行' }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('task_start', { request: { taskId: task.id, executablePath: null } }));
  });
});
