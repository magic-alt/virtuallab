import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { emptyTaskWorkspaceToolState, observeTaskWorkspaceTools, type TaskWorkspaceToolState } from '@/lib/taskWorkspaceTools';

const ChangesReview = lazy(() => import('@/features/review/ChangesReview').then(module => ({default: module.ChangesReview})));
const ProcessRunner = lazy(() => import('@/features/execution/ProcessRunner').then(module => ({default: module.ProcessRunner})));
interface TaskWorkspaceToolsProps {
  mode: 'changes' | 'run';
  repositoryRoot: string;
  workspaceRoot: string | null;
  baseSha: string;
}

/** Explicitly expanded context; never creates a worktree, session, or Task verification. */
export function TaskWorkspaceTools({mode, repositoryRoot, workspaceRoot, baseSha}: TaskWorkspaceToolsProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const label = mode === 'changes' ? '只读变更上下文' : '探索性 Run';
  return <section className="task-node" aria-label={label}>
    <button aria-expanded={expanded && !!workspaceRoot} aria-controls={panelId} disabled={!workspaceRoot} onClick={() => setExpanded(value => !value)}>
      {expanded ? '折叠' : '展开'}{label}
    </button>
    <p>{mode === 'changes'
      ? '只读工作区变更上下文；Git 恢复操作已禁用。本地审查草稿与 Task 修订批准分别记录。'
      : 'Legacy Run 仅用于探索，不授予 Task 验证资格或人工验收；展开不会执行命令。折叠后 Native 继续持有已启动的进程。'}</p>
    {!workspaceRoot && <p>先显式创建任务工作区后才能查看上下文。</p>}
    {expanded && workspaceRoot && <div id={panelId} className="task-embedded-tools">
      <WorkspaceToolPanel key={JSON.stringify([repositoryRoot, workspaceRoot, mode, mode === 'changes' ? baseSha : null])} mode={mode} repositoryRoot={repositoryRoot} workspaceRoot={workspaceRoot} baseSha={baseSha}/>
    </div>}
  </section>;
}

function WorkspaceToolPanel({mode, repositoryRoot, workspaceRoot, baseSha}: Omit<TaskWorkspaceToolsProps, 'workspaceRoot'> & {workspaceRoot: string}) {
  const [state,setState] = useState<TaskWorkspaceToolState>(emptyTaskWorkspaceToolState);
  const controller = useRef<ReturnType<typeof observeTaskWorkspaceTools> | null>(null);
  useEffect(() => {
    const observer = observeTaskWorkspaceTools(workspaceRoot, setState);
    controller.current = observer;
    return () => {controller.current = null; observer.dispose();};
  }, [workspaceRoot]);
  return <>
    <div className="task-row"><code>{workspaceRoot}</code><button disabled={state.loading} onClick={() => void controller.current?.refresh()}>刷新上下文</button></div>
    {state.loading && <p role="status">正在读取工作区上下文…</p>}
    {state.error && <p className="task-error" role="alert">上下文不可用：{state.error}</p>}
    {state.watchError && <p className="task-error" role="status">{state.watchError}</p>}
    {state.snapshot && <Suspense fallback={<p role="status">正在加载工作区工具…</p>}>
      {mode === 'changes'
        ? <ChangesReview snapshot={state.snapshot} repositoryRoot={repositoryRoot} workspaceRoot={workspaceRoot}
            taskBaseRef={baseSha} refreshRevision={state.refreshRevision} enabled={!state.loading && !state.error} gitMutationPending={true}/>
        : <ProcessRunner cwd={workspaceRoot} repositoryRoot={repositoryRoot} enabled={!state.loading && !state.error}/>}
    </Suspense>}
  </>;
}
