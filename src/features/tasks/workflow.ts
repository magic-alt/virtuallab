import type {TaskRecord,TaskReadiness,TaskDetailTab} from '@/types/tasks';
export interface TaskStep {label:string;detail:string;tab:TaskDetailTab}
const active=(task:TaskRecord)=>['running','queued','stopping'].includes(task.attempts.at(-1)?.state??'');
// Native currently exposes review-only blocking through this structural message.
// Keep this conservative: additional/unknown blockers must remain verification work.
const needsReview=(ready?:TaskReadiness)=>ready?.status==='unverified'&&ready.blockers.length===1&&ready.blockers[0]==='需要对当前版本完成人工审查';
export function nextTaskStep(task:TaskRecord,ready?:TaskReadiness):TaskStep {
 const latest=task.attempts.at(-1);const detail=ready?.blockers.join('；');
 if(active(task))return {label:latest?.state==='stopping'?'等待停止观察':'查看执行',detail:'执行、排队或停止中的任务请查看原生状态；可使用现有取消操作。',tab:'执行'};
 if(!task.workspaceRoot)return {label:'准备工作区',detail:'在下方表单显式创建任务工作区；打开页面不会开始工作。',tab:'概览'};
 if(ready?.acceptanceCurrent&&task.acceptance)return {label:'查看已验收交付',detail:'验收当前性由 Native 确认；远端交付仍需独立操作。',tab:'交付'};
 if(needsReview(ready))return {label:'审查当前验证结果',detail:detail!,tab:'变更与审查'};
 if(ready?.reviewCurrent&&['ready','warning'].includes(ready.status))return {label:'确认交付验收',detail:'查看当前修订、Run 和警告，再显式验收。',tab:'交付'};
 if(task.kind==='integration'&&latest&&['failed','interrupted'].includes(latest.state))return {label:'修复并验证集成',detail:'保留部分集成状态；在工作区显式修复、提交，再使用报告页的“验证已解决的集成”。不要重放集成操作。',tab:'证据'};
 if(task.kind==='integration'&&!latest?.evidence)return {label:'检查集成前提',detail:detail||'确认依赖候选与验证结果，然后预览并显式确认集成。',tab:'交付'};
 if(latest?.state==='failed'||latest?.state==='interrupted')return {label:'检查失败并恢复',detail:latest.failure||detail||'检查执行与验证失败，显式修复或重试。',tab:latest.phase==='verification'?'证据':'执行'};
 if(!latest && task.kind==='implementation')return {label:'启动 Agent 执行',detail:task.profile?'确认工作区与 Provider 后启动 Agent。':'无需验证 Profile 也可以启动 Agent；但正式验证与交付需要新建带 Profile 的任务。',tab:'执行'};
 if(!task.profile)return {label:'补充正式验证计划',detail:'本任务的 Profile 已冻结且未配置；可继续查看当前执行记录。正式验证需要在新任务计划中选择 Profile。',tab:'证据'};
 return {label:'检查并重新验证',detail:detail||'当前验证适用性未知；历史成功不代表当前交付就绪。',tab:'证据'};
}
export function taskQueues(tasks:TaskRecord[],readiness:Record<string,TaskReadiness>) {
 const review=tasks.filter(t=>needsReview(readiness[t.id]));
 return {
  needsInput:tasks.filter(t=>!t.profile||!t.workspaceRoot||!t.attempts.length||readiness[t.id]?.status==='blocked'||(!!readiness[t.id]?.reviewCurrent&&['ready','warning'].includes(readiness[t.id].status)&&!readiness[t.id].acceptanceCurrent)),
  failedChecks:tasks.filter(t=>['failed','interrupted'].includes(t.attempts.at(-1)?.state??'')||t.attempts.at(-1)?.evidence?.status==='fail'),
  staleEvidence:tasks.filter(t=>!active(t)&&!review.includes(t)&&((!!t.attempts.at(-1)?.evidence&&(!readiness[t.id]||readiness[t.id].status==='unverified'))||(!!t.review&&!readiness[t.id]?.reviewCurrent)||(!!t.acceptance&&!readiness[t.id]?.acceptanceCurrent))),
  review,
  active:tasks.filter(active),
  accepted:tasks.filter(t=>!!t.acceptance&&readiness[t.id]?.acceptanceCurrent),
 };
}
