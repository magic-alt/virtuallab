import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskAttempt, TaskAttemptReport, TaskReportEvent } from '@/types/tasks';

const native = vi.hoisted(() => ({ read: vi.fn(), listen: vi.fn() }));
vi.mock('@/lib/tasks', () => ({ getTaskAttemptReport: native.read, subscribeTaskReportEvents: native.listen }));
vi.mock('@/lib/backend', () => ({ isDesktopRuntime: () => true }));
import { useTaskAttemptReport } from './useTaskAttemptReport';

const attempt: TaskAttempt = { id: 'attempt', state: 'running', phase: 'implementation', candidateSha: null,
  failure: null, startedAtMs: 1, endedAtMs: null, evidence: null };
const report = (summary: string): TaskAttemptReport => ({ schemaVersion: 1, taskId: 'task', attemptId: 'attempt',
  status: 'running', summary, entries: [], problems: [], truncated: false, updatedAtMs: 1 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  native.read.mockReset().mockResolvedValue(report('Initial output'));
  native.listen.mockReset().mockResolvedValue(vi.fn());
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('task report catch-up observation', () => {
  it('periodically catches up active output after listener installation fails and stops on unmount', async () => {
    native.listen.mockRejectedValue(new Error('event channel unavailable'));
    const hook = renderHook(() => useTaskAttemptReport('task', attempt));
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.report?.summary).toBe('Initial output');
    native.read.mockResolvedValue(report('Output received without an event'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(hook.result.current.report?.summary).toBe('Output received without an event');
    expect(hook.result.current.observerError).toMatch(/定时/);
    hook.unmount();
    const calls = native.read.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(native.read).toHaveBeenCalledTimes(calls);
  });

  it('catches up a completed report when the window regains focus', async () => {
    const hook = renderHook(() => useTaskAttemptReport('task', { ...attempt, state: 'succeeded', endedAtMs: 2 }));
    await act(async () => { await Promise.resolve(); });
    native.read.mockResolvedValue(report('Completed summary caught up'));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(hook.result.current.report?.summary).toBe('Completed summary caught up');
    const calls = native.read.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(native.read).toHaveBeenCalledTimes(calls);
  });

  it('coalesces events during a slow report read without overlapping or discarding its snapshot', async () => {
    const first = deferred<TaskAttemptReport>();
    const second = deferred<TaskAttemptReport>();
    native.read.mockReturnValueOnce(first.promise).mockReturnValue(second.promise);
    let listener!: (event: TaskReportEvent) => void;
    native.listen.mockImplementation(async (handler: typeof listener) => { listener = handler; return vi.fn(); });
    const hook = renderHook(() => useTaskAttemptReport('task', attempt));
    await act(async () => { await Promise.resolve(); });
    for (let sequence = 1; sequence <= 4; sequence++) {
      await act(async () => {
        listener({ taskId: 'task', attemptId: 'attempt', sequence });
        await vi.advanceTimersByTimeAsync(80);
      });
    }
    expect(native.read).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(report('Observed while events continued')); });
    expect(hook.result.current.report?.summary).toBe('Observed while events continued');
    await act(async () => { await vi.advanceTimersByTimeAsync(80); });
    expect(native.read).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(report('Latest observed output')); });
    expect(hook.result.current.report?.summary).toBe('Latest observed output');
  });
});
