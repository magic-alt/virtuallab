import { create } from 'zustand';
import { workspaceKey } from '@/lib/workspaceKey';
import { cancelTask, getTaskEvents, getTaskLaunchError, getTaskReadiness, listTasks, subscribeTaskEvents, taskLaunchFailure } from '@/lib/tasks';
import type { TaskRecord, TaskReadiness, TaskEvent, TaskDetailTab, TaskAttemptState } from '@/types/tasks';

interface TaskFilters {query:string;repositoryRoot:string;attention:boolean}
interface TaskState {
  activeTaskTab:TaskDetailTab; activeTaskRepositoryRoot:string|null; navigationRevision:number; filters:TaskFilters;
  tasks: TaskRecord[]; readiness: Record<string, TaskReadiness>; readinessErrors: Record<string, string>; launchErrors: Record<string,string>;
  events: TaskEvent[]; error: string | null; repositoryErrors: Record<string, string>; observerError: string | null;
  actionErrors: Record<string, string>; pending: Record<string, boolean>; cancelling: Record<string, boolean>;
  roots: string[]; loading: boolean; activeTaskId: string | null;
}
export const useTaskStore = create<TaskState>(() => ({
  activeTaskTab:'概览', activeTaskRepositoryRoot:null, navigationRevision:0, filters:{query:'',repositoryRoot:'',attention:false},
  tasks: [], readiness: {}, readinessErrors: {}, launchErrors: {}, events: [], error: null, repositoryErrors: {}, observerError: null,
  actionErrors: {}, pending: {}, cancelling: {}, roots: [], loading: false, activeTaskId: null,
}));
const errorText = (error: unknown) => taskLaunchFailure(error)?.message ?? (error instanceof Error ? error.message : String(error));
let generation = 0;
let refreshSequence = 0;
let observed = false;
let afterSeq = 0;
const activeAttempt = (state:TaskAttemptState) => ['queued','running','stopping'].includes(state);

/** Follow only the attempt the user was viewing, never a different task or tab. */
function refreshedTab(state:TaskState, tasks:TaskRecord[], navigationRevision:number):TaskDetailTab {
  const selected=tasks.find(task=>task.id===state.activeTaskId);
  if (!selected) return '概览';
  if (state.navigationRevision!==navigationRevision) return state.activeTaskTab;
  const previous=state.tasks.find(task=>task.id===selected.id)?.attempts.at(-1);
  const current=selected.attempts.at(-1);
  return state.activeTaskTab==='执行' && previous && current && previous.id===current.id
    && activeAttempt(previous.state) && !activeAttempt(current.state) ? '证据' : state.activeTaskTab;
}
function mergeEvents(current: TaskEvent[], incoming: TaskEvent[], tasks: TaskRecord[]) {
  const ids = new Set(tasks.map(task => task.id));
  return [...new Map([...current, ...incoming].filter(event => event.schemaVersion === 1 && ids.has(event.taskId)).map(event => [event.eventId, event])).values()]
    .sort((a, b) => a.seq - b.seq).slice(-1000);
}
/** Latest query wins; every refresh revokes old readiness before querying native. */
export async function refreshTasks(): Promise<void> {
  if (!observed) return;
  const epoch = generation; const sequence = ++refreshSequence;
  const snapshot = useTaskStore.getState();
  const roots = [...snapshot.roots];
  const navigationRevision = snapshot.navigationRevision;
  const current = () => observed && generation === epoch && refreshSequence === sequence;
  useTaskStore.setState({loading: true, readiness: {}, readinessErrors: {}, error: null});
  const [records, [events]] = await Promise.all([
    Promise.allSettled(roots.map(root => listTasks([root]))),
    Promise.allSettled([getTaskEvents(afterSeq)]),
  ]);
  if (!current()) return;
  const repositoryErrors: Record<string, string> = {};
  const scopedTasks: TaskRecord[] = [];
  records.forEach((result, index) => {
    const root = roots[index];
    if (result.status === 'rejected') repositoryErrors[root] = errorText(result.reason);
    else scopedTasks.push(...result.value.filter(task => workspaceKey(root) === workspaceKey(task.repositoryRoot)));
  });
  // Failed repository histories must be queried again when they become available.
  // Advancing the global event cursor here would permanently hide those events.
  if (Object.keys(repositoryErrors).length) afterSeq = 0;
  if (records.length && records.every(result => result.status === 'rejected')) {
    useTaskStore.setState({loading: false, tasks: [], readiness: {}, launchErrors: {}, events: [], repositoryErrors,
      activeTaskId:null, activeTaskRepositoryRoot:null, activeTaskTab:'概览',
      error: Object.entries(repositoryErrors).map(([root, reason]) => `${root}: ${reason}`).join('\n')});
    return;
  }
  const retained = new Map(useTaskStore.getState().tasks.map(task => [task.id, task]));
  const tasks = [...new Map(scopedTasks.map(task => {
    const existing = retained.get(task.id);
    return [task.id, existing && existing.revision > task.revision ? existing : task] as const;
  })).values()];
  if (events.status === 'fulfilled' && !Object.keys(repositoryErrors).length) afterSeq = Math.max(afterSeq, ...events.value.map(event => event.seq));
  // Execution is a durable structural snapshot. Do not wait for source hashing,
  // toolchain observation or another task's readiness to show its current state.
  useTaskStore.setState(state => ({
    tasks, repositoryErrors,
    launchErrors: Object.fromEntries(Object.entries(state.launchErrors).filter(([id]) => tasks.some(task => task.id === id && !task.attempts.length))),
    events: mergeEvents(state.events, events.status === 'fulfilled' ? events.value : [], tasks),
    observerError: events.status === 'rejected' ? `事件来源不可用: ${errorText(events.reason)}` : state.observerError,
    activeTaskId: state.activeTaskId && tasks.some(task => task.id === state.activeTaskId) ? state.activeTaskId : null,
    activeTaskRepositoryRoot: tasks.find(task => task.id === state.activeTaskId)?.repositoryRoot ?? null,
    activeTaskTab: refreshedTab(state,tasks,navigationRevision),
  }));
  const preparing=tasks.filter(task=>!task.attempts.length);
  const [results,launchResults] = await Promise.all([
    Promise.allSettled(tasks.map(task=>getTaskReadiness(task.id))),
    Promise.allSettled(preparing.map(task=>getTaskLaunchError(task.id))),
  ]);
  if (!current()) return;
  const readiness: Record<string, TaskReadiness> = {}; const readinessErrors: Record<string, string> = {};
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') readiness[tasks[index].id] = result.value;
    else readinessErrors[tasks[index].id] = errorText(result.reason);
  });
  const launchErrors:Record<string,string>={};
  launchResults.forEach((result,index)=>{
    if (result.status==='rejected') launchErrors[preparing[index].id]='启动记录不可用：'+errorText(result.reason);
    else if (typeof result.value==='string' && result.value) launchErrors[preparing[index].id]=result.value;
  });
  useTaskStore.setState(state => {
    // A confirmed launch can retain a newer record while readiness is in flight.
    // Never attach that earlier observation (or its errors) to a new revision.
    const currentRevisions = new Map(state.tasks.map(task => [task.id, task.revision]));
    const matching = new Set(tasks.filter(task => currentRevisions.get(task.id) === task.revision).map(task => task.id));
    const scoped = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([id]) => matching.has(id)));
    return {readiness: scoped(readiness), readinessErrors: scoped(readinessErrors),
      launchErrors: {...Object.fromEntries(Object.entries(state.launchErrors).filter(([id]) => !matching.has(id))), ...scoped(launchErrors)}, loading: false};
  });
}
/** Called once by the shell hook. Cleanup also handles a delayed native listener. */
export function observeTasks(roots: string[]): () => void {
  const epoch = ++generation; observed = true; afterSeq = 0;
  useTaskStore.setState(state => {
    const contains=(root:string)=>roots.some(value=>workspaceKey(value)===workspaceKey(root));
    const selected=state.tasks.find(task=>task.id===state.activeTaskId);
    const selectedRoot=selected?.repositoryRoot??(state.activeTaskId?state.activeTaskRepositoryRoot:null);
    const retained=!!selectedRoot&&contains(selectedRoot);
    return {roots:[...new Set(roots)].sort(),tasks:[],readiness:{},readinessErrors:{},launchErrors:{},events:[],error:null,repositoryErrors:{},observerError:null,
      activeTaskId:retained?state.activeTaskId:null,activeTaskTab:retained?state.activeTaskTab:'概览',activeTaskRepositoryRoot:retained?selectedRoot:null,
      filters:{...state.filters,repositoryRoot:contains(state.filters.repositoryRoot)?state.filters.repositoryRoot:''}};
  });
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
  // Native continues owning work while pages are hidden. Poll active attempts as
  // a catch-up path for lost events, including a failed listener installation.
  const pollTimer=setInterval(()=>{
    if (disposed || generation!==epoch) return;
    const state=useTaskStore.getState();
    if (state.observerError || state.tasks.some(task=>{
      const attempt=task.attempts.at(-1);return !!attempt && activeAttempt(attempt.state);
    })) void refreshTasks();
  },5000);
  void refreshTasks();
  void subscribeTaskEvents(event => {
    if (disposed || generation !== epoch) return;
    // Query the durable store, rather than treating an event as task/readiness data.
    void refreshTasks();
  }).then(stop => {
    if (disposed || generation !== epoch) stop();
    else {retainListener(stop); void refreshTasks();} // Catch events between first hydration and listener setup.
  }).catch(error => {
    if (!disposed && generation === epoch) useTaskStore.setState({observerError: `实时事件不可用: ${errorText(error)}。正在定时同步任务状态。`});
  });
  return () => {
    disposed = true; listeners.forEach(stop => stop());
    clearInterval(pollTimer);
    if (changeTimer !== undefined) clearTimeout(changeTimer);
    window.removeEventListener('focus', invalidate);
    document.removeEventListener('visibilitychange', visible);
    if (generation === epoch) {
      ++generation; ++refreshSequence; observed = false;
      useTaskStore.setState({roots: [], tasks: [], readiness: {}, readinessErrors: {}, launchErrors: {}, repositoryErrors: {}, events: [], loading: false});
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

/** Navigation only; never invokes Native. */
export function selectTask(taskId:string,tab?:TaskDetailTab):void {
 useTaskStore.setState(state=>{
  const task=state.tasks.find(t=>t.id===taskId&&state.roots.some(root=>workspaceKey(root)===workspaceKey(t.repositoryRoot)));
  return {navigationRevision:state.navigationRevision+1,...(task?{activeTaskId:taskId,activeTaskRepositoryRoot:task.repositoryRoot,activeTaskTab:tab??(state.activeTaskId===taskId?state.activeTaskTab:'概览')}:{activeTaskId:null,activeTaskRepositoryRoot:null,activeTaskTab:'概览' as const})};
 });
}
export function setTaskFilters(patch:Partial<TaskFilters>):void {useTaskStore.setState(state=>({filters:{...state.filters,...patch}}));}

/** Retain the confirmed Native result before selecting it, including partial setup. */
export function retainLaunchedTask(record:TaskRecord,launchError:string|null,select=true):void {
  useTaskStore.setState(state=>{
    if (!state.roots.some(root=>workspaceKey(root)===workspaceKey(record.repositoryRoot))) return state;
    const existing=state.tasks.find(task=>task.id===record.id);
    const task=existing && existing.revision>record.revision ? existing : record;
    const attempt=task.attempts.at(-1);
    return {
      tasks:existing ? state.tasks.map(item=>item.id===task.id?task:item) : [...state.tasks,task],
      ...(select ? {activeTaskId:task.id,activeTaskRepositoryRoot:task.repositoryRoot,
        activeTaskTab:!task.workspaceRoot?'概览' as const:attempt && !activeAttempt(attempt.state)?'证据' as const:'执行' as const,
        filters:{...state.filters,query:'',repositoryRoot:'',attention:false}} : {}),
      actionErrors:{...state.actionErrors,[task.id]:launchError??''},
      launchErrors:{...state.launchErrors,[task.id]:launchError??''},
    };
  });
}
