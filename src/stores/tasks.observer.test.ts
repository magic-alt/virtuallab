import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));

import { observeTasks, refreshTasks, retainLaunchedTask, selectTask, useTaskStore } from './tasks';
import { readinessFixture, taskFixture } from '@/features/tasks/fixtures';
import type { TaskReadiness, TaskRecord } from '@/types/tasks';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  native.invoke.mockReset();
  native.listen.mockReset().mockResolvedValue(vi.fn());
  useTaskStore.setState({ tasks: [], readiness: {}, readinessErrors: {}, events: [], roots: [], loading: false,
    activeTaskId: null, activeTaskRepositoryRoot: null, activeTaskTab: '概览', navigationRevision: 0, observerError: null });
});

describe('task execution observation independent of delivery readiness', () => {
  it('publishes a terminal task snapshot while a readiness query is still pending', async () => {
    const running = taskFixture({ attempts: [{ id: 'attempt', state: 'running', phase: 'implementation',
      candidateSha: null, failure: null, startedAtMs: 1, endedAtMs: null, evidence: null }] });
    const failed = taskFixture({ ...running, revision: running.revision + 1,
      attempts: [{ ...running.attempts[0], state: 'failed', failure: 'Provider failed', endedAtMs: 2 }] });
    let record = running;
    let readiness: Promise<TaskReadiness> = Promise.resolve(readinessFixture());
    native.invoke.mockImplementation(command => command === 'task_list' ? Promise.resolve([record])
      : command === 'task_events' ? Promise.resolve([]) : readiness);
    const stop = observeTasks(['/repo']);
    const delayed = deferred<TaskReadiness>();
    let refresh: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(useTaskStore.getState().tasks).toHaveLength(1));
      selectTask(running.id, '执行');
      record = failed;
      readiness = delayed.promise;
      native.invoke.mockClear();
      refresh = refreshTasks();
      await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('task_readiness', { taskId: failed.id }));
      expect(useTaskStore.getState().readiness[failed.id]).toBeUndefined();
      expect(useTaskStore.getState().tasks[0].attempts[0].state).toBe('failed');
      expect(useTaskStore.getState().activeTaskTab).toBe('证据');
    } finally {
      delayed.resolve(readinessFixture());
      await refresh;
      stop();
    }
  });

  it('does not attach pending readiness to a newer retained task revision', async () => {
    const task = taskFixture();
    let readiness: Promise<TaskReadiness> = Promise.resolve(readinessFixture());
    native.invoke.mockImplementation(command => command === 'task_list' ? Promise.resolve([task])
      : command === 'task_events' ? Promise.resolve([]) : command === 'task_launch_error' ? Promise.resolve(null) : readiness);
    const stop = observeTasks(['/repo']);
    const delayed = deferred<TaskReadiness>();
    let refresh: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(useTaskStore.getState().readiness[task.id]).toBeDefined());
      readiness = delayed.promise;
      native.invoke.mockClear();
      refresh = refreshTasks();
      await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('task_readiness', { taskId: task.id }));
      const newer = taskFixture({ ...task, revision: task.revision + 1 });
      retainLaunchedTask(newer, null, false);
      delayed.resolve(readinessFixture({ status: 'ready', acceptanceCurrent: true }));
      await refresh;
      expect(useTaskStore.getState().tasks).toEqual([newer]);
      expect(useTaskStore.getState().readiness[task.id]).toBeUndefined();
    } finally {
      delayed.resolve(readinessFixture());
      await refresh;
      stop();
    }
  });

  it('retains explicit execution navigation made after a task-list read started', async () => {
    const running = taskFixture({ attempts: [{ id: 'attempt', state: 'running', phase: 'implementation',
      candidateSha: null, failure: null, startedAtMs: 1, endedAtMs: null, evidence: null }] });
    const other = taskFixture({ id: 'other' });
    let records = Promise.resolve([running, other]);
    native.invoke.mockImplementation(command => command === 'task_list' ? records
      : Promise.resolve(command === 'task_events' ? [] : command === 'task_launch_error' ? null : readinessFixture()));
    const stop = observeTasks(['/repo']);
    const delayed = deferred<TaskRecord[]>();
    let refresh: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(useTaskStore.getState().loading).toBe(false));
      selectTask(other.id, '概览');
      records = delayed.promise;
      refresh = refreshTasks();
      selectTask(running.id, '执行');
      const failed = taskFixture({ ...running, revision: running.revision + 1,
        attempts: [{ ...running.attempts[0], state: 'failed', failure: 'Provider failed', endedAtMs: 2 }] });
      delayed.resolve([failed, other]);
      await refresh;
      expect(useTaskStore.getState().tasks.find(task => task.id === running.id)?.attempts[0].state).toBe('failed');
      expect(useTaskStore.getState().activeTaskTab).toBe('执行');
    } finally {
      delayed.resolve([running, other]);
      await refresh;
      stop();
    }
  });
});
