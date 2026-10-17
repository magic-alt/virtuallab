import type {TaskDetailTab,TaskRecord,TaskReadiness} from '@/types/tasks';
import type {RepositoryRecord} from '@/types/workbench';
import {workspaceKey} from '@/lib/workspaceKey';
import {TaskStatusSummary} from './TaskDetail';
export function TaskList({tasks,readiness,repositories,selectedId,onOpenTask}:{tasks:TaskRecord[];readiness:Record<string,TaskReadiness>;repositories:RepositoryRecord[];selectedId:string|null;onOpenTask:(id:string,tab?:TaskDetailTab)=>void}) {
 return <div className="task-list">{tasks.map(t=><section key={t.id} className="task-list-item" data-selected={t.id===selectedId}><button className="task-title-button" aria-pressed={t.id===selectedId} onClick={()=>onOpenTask(t.id)}>{t.title}</button><p>{t.kind==='integration'?'集成':'实现'} · {repositories.find(r=>workspaceKey(r.path)===workspaceKey(t.repositoryRoot))?.name} · {t.id}</p><TaskStatusSummary task={t} readiness={readiness[t.id]}/></section>)}</div>;
}
