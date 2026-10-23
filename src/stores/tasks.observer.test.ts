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
  it.each(['preflight','push','create_pr'] as const)('catches a new delivery after a successful retry still carries an older %s failure', async stage => {
    const task = taskFixture({autoCommit:true,autoDraftPr:true,attempts:[{id:'new-attempt',state:'succeeded',phase:'review',candidateSha:'b'.repeat(40),failure:null,startedAtMs:4,endedAtMs:5,evidence:null}],
      delivery:{status:stage === 'preflight' ? 'failed' : 'reconcile_required',stage,attemptId:'old-attempt',candidateSha:(stage === 'preflight' ? 'a' : 'b').repeat(40),repository:'owner/repo',branch:'task/fix',baseBranch:'main',pullRequestUrl:null,pullRequestNumber:null,error:'Authentication or connectivity required',updatedAtMs:3}});
    let record = task;
    native.invoke.mockImplementation(async command => command === 'task_list' ? [record] : command === 'task_events' ? [] : command === 'task_readiness' ? readinessFixture() : null);
    vi.useFakeTimers();
    const stop = observeTasks(['/repo']);
    try {
      await vi.waitFor(() => expect(useTaskStore.getState().tasks[0]?.delivery?.attemptId).toBe('old-attempt'));
      record = {...task, delivery:{...task.delivery!,status:'delivered',stage:'complete',attemptId:'new-attempt',candidateSha:'b'.repeat(40),pullRequestUrl:'https://github.com/owner/repo/pull/17',pullRequestNumber:17,error:null}};
      await vi.advanceTimersByTimeAsync(5000);
      expect(useTaskStore.getState().tasks[0]?.delivery?.status).toBe('delivered');
    } finally { stop(); vi.useRealTimers(); }
  });
  it('catches missed PR delivery events after the execution attempt has already succeeded', async () => {
    const task = taskFixture({autoCommit:true,autoDraftPr:true,attempts:[{id:'attempt',state:'succeeded',phase:'review',candidateSha:'a'.repeat(40),failure:null,startedAtMs:1,endedAtMs:2,evidence:null}],
      delivery:{status:'running',attemptId:'attempt',candidateSha:'a'.repeat(40),repository:'owner/repo',branch:'task/fix',baseBranch:'main',pullRequestUrl:null,pullRequestNumber:null,error:null,updatedAtMs:3}});
    native.invoke.mockImplementation(async command => command === 'task_list' ? [task] : command === 'task_events' ? [] : command === 'task_readiness' ? readinessFixture() : null);
    vi.useFakeTimers();
    const stop = observeTasks(['/repo']);
    try {
      await vi.waitFor(() => expect(useTaskStore.getState().tasks[0]?.delivery?.status).toBe('running'));
      // Existing observer catches-up every five seconds, even with a working
      // event subscription; its timer must also observe completed providers.
      native.invoke.mockClear();
      await vi.advanceTimersByTimeAsync(5000);
      expect(native.invoke).toHaveBeenCalledWith('task_list',{repositoryRoots:['/repo']});
    } finally { stop(); vi.useRealTimers(); }
  });
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
