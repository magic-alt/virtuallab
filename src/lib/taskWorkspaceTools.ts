import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { inspectRepository, isDesktopRuntime, watchStart, watchStop } from './backend';
import { workspaceKey } from './workspaceKey';
import type { RepositorySnapshot, WorkbenchEvent } from '@/types/workbench';

export interface TaskWorkspaceToolState {
  snapshot: RepositorySnapshot | null;
  refreshRevision: number;
  loading: boolean;
  error: string | null;
  watchError: string | null;
}
export const emptyTaskWorkspaceToolState: TaskWorkspaceToolState = {
  snapshot: null, refreshRevision: 0, loading: true, error: null, watchError: null,
};
const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Inspection never authorizes redirecting a panel to a different worktree. */
export async function inspectTaskWorkspace(workspaceRoot: string): Promise<RepositorySnapshot> {
  const snapshot = await inspectRepository(workspaceRoot);
  if (workspaceKey(snapshot.root) !== workspaceKey(workspaceRoot)) {
    throw new Error('工作区路径不匹配；拒绝展示其他工作区的上下文。');
  }
  return snapshot;
}

/** Only events belonging to this read-only watcher invalidate its panel. */
export async function subscribeTaskWorkspaceEvents(watchId: string, changed: () => void): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) throw new Error('工作区观察需要 Tauri 桌面运行时。');
  return listen<WorkbenchEvent>('workbench://event', ({ payload }) => {
    if (payload.id === watchId && ['fs.changed','git.changed','git.status_changed'].includes(payload.eventType)) changed();
  });
}

let watcherSequence = 0;
/** Each expansion owns a unique watcher, never a process or terminal session. */
export function observeTaskWorkspaceTools(workspaceRoot: string, onState: (state: TaskWorkspaceToolState) => void) {
  const watchId = `task-context-${++watcherSequence}-${globalThis.crypto.randomUUID()}`;
  let state = { ...emptyTaskWorkspaceToolState };
  let disposed = false;
  let queryGeneration = 0;
  let unlisten: UnlistenFn | undefined;
  let watchRequested = false;
  let watchStarted = false;
  let eventError: string | null = null;
  const publish = (patch: Partial<TaskWorkspaceToolState>) => {
    if (!disposed) {state = { ...state, ...patch }; onState(state);}
  };
  const releaseWatch = () => {void watchStop(watchId).catch(() => undefined);};
  const startWatch = () => {
    if (disposed || watchRequested) return;
    watchRequested = true;
    void watchStart(watchId, workspaceRoot).then(() => {
      if (disposed) releaseWatch();
      else {watchStarted = true; publish({watchError: eventError}); void refresh();}
    }).catch(error => {
      watchRequested = false;
      publish({watchError: `变更观察不可用，请手动刷新：${describeError(error)}`});
    });
  };
  const refresh = async () => {
    const generation = ++queryGeneration;
    if (disposed) return;
    // Revoke open Diff content immediately, even when HEAD has not changed.
    publish({loading: true, error: null, refreshRevision: state.refreshRevision + 1});
    try {
      const snapshot = await inspectTaskWorkspace(workspaceRoot);
      if (disposed || generation !== queryGeneration) return;
      publish({snapshot, loading: false});
      startWatch();
    } catch (error) {
      if (!disposed && generation === queryGeneration) publish({snapshot: null, loading: false, error: describeError(error)});
    }
  };
  void subscribeTaskWorkspaceEvents(watchId, () => {if (!disposed) void refresh();}).then(stop => {
    if (disposed) stop();
    else {
      unlisten = stop;
      // Catch any writes between an earlier inspection and listener registration.
      if (state.snapshot) void refresh();
    }
  }).catch(error => {eventError = `变更事件不可用，请手动刷新：${describeError(error)}`; publish({watchError: eventError});});
  void refresh();
  return {
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true; ++queryGeneration; unlisten?.();
      if (watchStarted) releaseWatch();
      // A pending start releases its own unique watcher after native acknowledgement.
    },
  };
}
