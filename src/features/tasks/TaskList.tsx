import type { TaskDetailTab, TaskRecord, TaskReadiness } from '@/types/tasks';
import type { RepositoryRecord } from '@/types/workbench';
import { workspaceKey } from '@/lib/workspaceKey';
import { executionLabel, taskGoalPreview } from './taskPresentation';

interface Props {
  tasks: TaskRecord[];
  readiness: Record<string, TaskReadiness>;
  repositories: RepositoryRecord[];
  selectedId: string | null;
  onOpenTask: (id: string, tab?: TaskDetailTab) => void;
  launchErrors?: Record<string, string>;
}

export function TaskList({ tasks, repositories, selectedId, onOpenTask, launchErrors = {} }: Props) {
  return <div className="task-list">{tasks.map(task => {
    const attempt = task.attempts.at(-1);
    const selected = task.id === selectedId;
    const failure = attempt?.state === 'failed' || attempt?.state === 'interrupted' ? attempt.failure : !attempt ? launchErrors[task.id] : null;
    const repository = repositories.find(repo => workspaceKey(repo.path) === workspaceKey(task.repositoryRoot));
    return <section key={task.id} className="task-list-item" aria-label={`任务 ${task.id}`} data-selected={selected}>
      <div className="task-list-meta"><span className="task-execution-badge" data-state={attempt?.state ?? 'not_started'}>{executionLabel(task)}</span>{selected && <span className="task-selected-label">当前查看</span>}</div>
      <button className="task-title-button" aria-pressed={selected} onClick={() => onOpenTask(task.id)}>{task.title}</button>
      <p className="task-goal-preview" title={task.goal}>{taskGoalPreview(task)}</p>
      <div className="task-list-meta"><span title={task.repositoryRoot}>{repository?.name ?? task.repositoryRoot}</span><code title={task.id}>#{task.id.slice(-12)}</code></div>
      <div className="task-list-meta"><time dateTime={new Date(task.updatedAtMs).toISOString()}>更新于 {new Date(task.updatedAtMs).toLocaleString()}</time><span>{task.attempts.length ? `第 ${task.attempts.length} 次执行` : '尚未执行'}</span></div>
      {failure && <p className="task-list-failure" title={failure}>{failure}</p>}
    </section>;
  })}</div>;
}
