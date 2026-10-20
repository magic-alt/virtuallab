import { useCallback, useEffect, useRef, useState } from 'react';
import { isDesktopRuntime } from '@/lib/backend';
import { getTaskAttemptReport, subscribeTaskReportEvents } from '@/lib/tasks';
import type { TaskAttempt, TaskAttemptReport } from '@/types/tasks';

export interface TaskReportObservation {
  report: TaskAttemptReport | null;
  loading: boolean;
  error: string | null;
  observerError: string | null;
  refresh: () => Promise<void>;
}
interface Snapshot extends Omit<TaskReportObservation, 'refresh'> { key: string }
const empty = (key: string, loading = false): Snapshot => ({ key, report: null, loading, error: null, observerError: null });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Report notifications invalidate a scoped native snapshot; they never become execution state. */
export function useTaskAttemptReport(taskId: string, attempt?: TaskAttempt): TaskReportObservation {
  const attemptId = attempt?.id;
  const key = JSON.stringify([taskId, attemptId ?? null]);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => empty(key, !!attemptId));
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let disposed = false;
    let requestSequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let reading = false;
    let readAgain = false;
    const inactive = async () => undefined;
    refreshRef.current = inactive;
    if (!attemptId) {
      setSnapshot(empty(key));
      return;
    }
    if (!isDesktopRuntime()) {
      setSnapshot({ ...empty(key), error: '执行报告需要桌面运行时。' });
      return;
    }
    const active = ['queued', 'running', 'stopping'].includes(attempt?.state ?? '');
    setSnapshot(previous => previous.key === key ? { ...previous, loading: true, error: null, observerError: null } : empty(key, true));
    const schedule = () => {
      if (!disposed && timer === undefined) timer = setTimeout(() => { timer = undefined; void read(); }, 80);
    };
    const read = async () => {
      if (disposed) return;
      // Notifications and catch-up polling share one reader. An event arriving
      // during native I/O requests a follow-up without starving that snapshot.
      if (reading) { readAgain = true; return; }
      reading = true;
      const sequence = ++requestSequence;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      setSnapshot(previous => ({ ...(previous.key === key ? previous : empty(key)), loading: true, error: null }));
      try {
        const report = await getTaskAttemptReport(taskId, attemptId);
        if (disposed || sequence !== requestSequence) return;
        if (report && (report.schemaVersion !== 1 || report.taskId !== taskId || report.attemptId !== attemptId)) {
          setSnapshot(previous => ({ ...previous, report: null, loading: false, error: '报告与当前任务或执行记录不匹配，请刷新后核对。' }));
          return;
        }
        setSnapshot(previous => ({ ...previous, key, report, loading: false, error: null }));
      } catch (error) {
        if (!disposed && sequence === requestSequence) {
          setSnapshot(previous => ({ ...previous, key, loading: false, error: errorText(error) }));
        }
      } finally {
        reading = false;
        if (readAgain) { readAgain = false; schedule(); }
      }
    };
    refreshRef.current = read;
    void read();
    void subscribeTaskReportEvents(event => {
      if (disposed || event.taskId !== taskId || event.attemptId !== attemptId) return;
      schedule();
    }).then(stop => {
      if (disposed) stop();
      else { unlisten = stop; void read(); }
    }).catch(error => {
      if (!disposed) setSnapshot(previous => ({ ...previous, observerError: `实时输出暂不可用：${errorText(error)}。${active ? '正在定时同步执行输出。' : '可手动刷新。'}` }));
    });
    const catchUp = () => { void read(); };
    const visible = () => { if (document.visibilityState === 'visible') catchUp(); };
    const pollTimer = active ? setInterval(catchUp, 5000) : undefined;
    window.addEventListener('focus', catchUp);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      ++requestSequence;
      if (timer !== undefined) clearTimeout(timer);
      if (pollTimer !== undefined) clearInterval(pollTimer);
      window.removeEventListener('focus', catchUp);
      document.removeEventListener('visibilitychange', visible);
      unlisten?.();
      if (refreshRef.current === read) refreshRef.current = inactive;
    };
  }, [taskId, attemptId, attempt?.state, attempt?.phase, attempt?.endedAtMs, key]);

  const visible = snapshot.key === key ? snapshot : empty(key, !!attemptId);
  return { report: visible.report, loading: visible.loading, error: visible.error, observerError: visible.observerError, refresh };
}
