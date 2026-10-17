import { create } from 'zustand';
import { workspaceKey } from '@/lib/workspaceKey';
import { cancelTask, getTaskEvents, getTaskReadiness, listTasks, subscribeTaskEvents } from '@/lib/tasks';
import type { TaskRecord, TaskReadiness, TaskEvent } from '@/types/tasks';

interface TaskState {
  tasks: TaskRecord[]; readiness: Record<string, TaskReadiness>; readinessErrors: Record<string, string>;
  events: TaskEvent[]; error: string | null; observerError: string | null;
  actionErrors: Record<string, string>; pending: Record<string, boolean>; cancelling: Record<string, boolean>;
  roots: string[]; loading: boolean; activeTaskId: string | null;
}
export const useTaskStore = create<TaskState>(() => ({
  tasks: [], readiness: {}, readinessErrors: {}, events: [], error: null, observerError: null,
  actionErrors: {}, pending: {}, cancelling: {}, roots: [], loading: false, activeTaskId: null,
}));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
let generation = 0;
let refreshSequence = 0;
let observed = false;
let afterSeq = 0;
function mergeEvents(current: TaskEvent[], incoming: TaskEvent[], tasks: TaskRecord[]) {
  const ids = new Set(tasks.map(task => task.id));
  return [...new Map([...current, ...incoming].filter(event => event.schemaVersion === 1 && ids.has(event.taskId)).map(event => [event.eventId, event])).values()]
    .sort((a, b) => a.seq - b.seq).slice(-1000);
}
/** Latest query wins; every refresh revokes old readiness before querying native. */
export async function refreshTasks(): Promise<void> {
  if (!observed) return;
  const epoch = generation; const sequence = ++refreshSequence;
  const roots = [...useTaskStore.getState().roots];
  const current = () => observed && generation === epoch && refreshSequence === sequence;
  useTaskStore.setState({loading: true, readiness: {}, readinessErrors: {}, error: null});
  const [records, events] = await Promise.allSettled([listTasks(roots), getTaskEvents(afterSeq)]);
  if (!current()) return;
  if (records.status === 'rejected') {
    useTaskStore.setState({loading: false, tasks: [], readiness: {}, events: [], error: errorText(records.reason)}); return;
  }
  const tasks = records.value.filter(task => roots.some(root => workspaceKey(root) === workspaceKey(task.repositoryRoot)));
  const results = await Promise.allSettled(tasks.map(task => getTaskReadiness(task.id)));
  if (!current()) return;
  const readiness: Record<string, TaskReadiness> = {}; const readinessErrors: Record<string, string> = {};
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') readiness[tasks[index].id] = result.value;
    else readinessErrors[tasks[index].id] = errorText(result.reason);
  });
  if (events.status === 'fulfilled') afterSeq = Math.max(afterSeq, ...events.value.map(event => event.seq));
  useTaskStore.setState(state => ({
    tasks, readiness, readinessErrors, loading: false,
    events: mergeEvents(state.events, events.status === 'fulfilled' ? events.value : [], tasks),
    observerError: events.status === 'rejected' ? `事件来源不可用: ${errorText(events.reason)}` : state.observerError,
    activeTaskId: state.activeTaskId && tasks.some(task => task.id === state.activeTaskId) ? state.activeTaskId : null,
  }));
}
/** Called once by the shell hook. Cleanup also handles a delayed native listener. */
export function observeTasks(roots: string[]): () => void {
  const epoch = ++generation; observed = true; afterSeq = 0;
  useTaskStore.setState({roots: [...new Set(roots)].sort(), tasks: [], readiness: {}, readinessErrors: {}, events: [], error: null, observerError: null});
  let disposed = false; const listeners: (() => void)[] = [];
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  const retainListener = (stop: () => void) => {
    if (disposed || generation !== epoch) stop(); else listeners.push(stop);
  };
  const invalidate = () => {
    if (disposed || generation !== epoch) return;
    ++refreshSequence; // An already-running query cannot restore pre-change readiness.
    useTaskStore.setState({readiness: {}, readinessErrors: {}});
    if (changeTimer === undefined) changeTimer = setTimeout(() => {
      changeTimer = undefined;
      if (!disposed && generation === epoch) void refreshTasks();
    }, 150);
  };
  const visible = () => {if (document.visibilityState === 'visible') invalidate();};
  window.addEventListener('focus', invalidate);
  document.addEventListener('visibilitychange', visible);
  void refreshTasks();
  void subscribeTaskEvents(event => {
    if (disposed || generation !== epoch) return;
    // Query the durable store, rather than treating an event as task/readiness data.
    void refreshTasks();
  }).then(stop => {
    if (disposed || generation !== epoch) stop();
    else {retainListener(stop); void refreshTasks();} // Catch events between first hydration and listener setup.
  }).catch(error => {
    if (!disposed && generation === epoch) useTaskStore.setState({observerError: `实时事件不可用: ${errorText(error)}。请手动刷新。`});
  });
  return () => {
    disposed = true; listeners.forEach(stop => stop());
    if (changeTimer !== undefined) clearTimeout(changeTimer);
    window.removeEventListener('focus', invalidate);
    document.removeEventListener('visibilitychange', visible);
    if (generation === epoch) {
      ++generation; ++refreshSequence; observed = false;
      useTaskStore.setState({roots: [], tasks: [], readiness: {}, readinessErrors: {}, events: [], loading: false});
    }
  };
}
/** Synchronous per-task lock covers dialog waits, writes and structural refresh. */
export async function runTaskAction<T>(id: string, operation: () => Promise<T>): Promise<T> {
  if (useTaskStore.getState().pending[id] || useTaskStore.getState().cancelling[id]) throw new Error('此任务的操作正在进行中。');
  const epoch = generation;
  ++refreshSequence; // Revoke any query that began before this write.
  useTaskStore.setState(state => ({pending: {...state.pending, [id]: true}, actionErrors: {...state.actionErrors, [id]: ''}, readiness: {}}));
  try { return await operation(); }
  catch (error) {
    if (generation === epoch) useTaskStore.setState(state => ({actionErrors: {...state.actionErrors, [id]: errorText(error)}}));
    throw error;
  } finally {
    if (generation === epoch) await refreshTasks();
    useTaskStore.setState(state => ({pending: {...state.pending, [id]: false}}));
  }
}

/** Cancellation can signal an owned long-running command without releasing its lock. */
export async function runTaskCancellation(id: string): Promise<TaskRecord> {
  if (useTaskStore.getState().cancelling[id]) throw new Error('此任务的取消操作正在进行中。');
  const epoch = generation;
  ++refreshSequence;
  useTaskStore.setState(state => ({cancelling: {...state.cancelling, [id]: true}, actionErrors: {...state.actionErrors, [id]: ''}, readiness: {}}));
  try {return await cancelTask(id);}
  catch (error) {
    if (generation === epoch) useTaskStore.setState(state => ({actionErrors: {...state.actionErrors, [id]: errorText(error)}}));
    throw error;
  } finally {
    if (generation === epoch) await refreshTasks();
    useTaskStore.setState(state => ({cancelling: {...state.cancelling, [id]: false}}));
  }
}
