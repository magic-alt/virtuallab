import type {TaskDetailTab,TaskReadiness,TaskRecord} from '@/types/tasks';
import {taskQueues,nextTaskStep} from './workflow';
interface Props {tasks:TaskRecord[];readiness:Record<string,TaskReadiness>;loading:boolean;error?:string|null;onOpenTask:(id:string,tab:TaskDetailTab)=>void}
const labels={needsInput:'需要输入',failedChecks:'执行或检查失败',staleEvidence:'证据过期或未知',review:'等待人工审查',active:'执行中或排队',accepted:'当前修订已验收'};
export function TaskDashboard({tasks,readiness,loading,error,onOpenTask}:Props) {
 const queues=taskQueues(tasks,readiness);const unavailable=loading||!!error;const missingReadiness=tasks.some(task=>!readiness[task.id]);
 return <section aria-label="任务看板"><p>一个任务可同时属于多个队列；计数使用相同的任务筛选规则。</p><div className="task-dashboard-grid">{(Object.keys(labels) as (keyof typeof labels)[]).map(key=><section key={key} className="task-surface"><h2>{labels[key]}</h2><strong>{unavailable||(missingReadiness&&!['active','failedChecks'].includes(key))?'—':queues[key].length}</strong>
 {unavailable?<p>任务来源尚不可用。</p>:<ul>{queues[key].map(t=>{const step=nextTaskStep(t,readiness[t.id]);return <li key={t.id}><button onClick={()=>onOpenTask(t.id,step.tab)}>{t.title} · {step.label}</button></li>;})}</ul>}</section>)}</div></section>;
}
