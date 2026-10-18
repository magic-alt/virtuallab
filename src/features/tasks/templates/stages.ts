import type { TaskDetailTab, TaskReadiness, TaskRecord } from '@/types/tasks';
export interface WorkflowStage { id: string; label: string; state: 'done' | 'active' | 'pending' | 'blocked'; detail: string; tab: TaskDetailTab }

/** A presentation projection only. Never stores or grants verification/acceptance. */
export function workflowStages(task: TaskRecord, readiness?: TaskReadiness): WorkflowStage[] {
  const latest = task.attempts.at(-1);
  const active = !!latest && ['queued','running','stopping'].includes(latest.state);
  const failed = !!latest && ['failed','cancelled','interrupted'].includes(latest.state);
  const reviewOnly = readiness?.status === 'unverified' && readiness.blockers.length === 1 && readiness.blockers[0] === '需要对当前版本完成人工审查';
  const verified = !!latest?.evidence && ['pass','warn'].includes(latest.evidence.status) && !active && !failed && !!readiness && (['ready','warning'].includes(readiness.status) || reviewOnly);
  const reviewed = verified && !!readiness?.reviewCurrent && !!task.review?.approved;
  const accepted = reviewed && !!readiness?.acceptanceCurrent && !!task.acceptance;
  return [
    { id:'plan', label:'目标与计划', state:'done', detail:'已保存任务合同；不代表 AI 已完成设计。', tab:'概览' },
    { id:'workspace', label:'隔离工作区', state:task.workspaceRoot?'done':'pending', detail:task.workspaceRoot?'Native 已绑定工作区；Worktree 不是 OS 沙箱。':'需要显式创建，不在打开页面时创建。', tab:'概览' },
    { id:'execute', label:'任务执行', state:active?'active':failed?'blocked':latest?'done':'pending', detail:latest?`最近 Attempt：${latest.state} / ${latest.phase}。结束不等于检查通过。`:'等待真实 Agent；流程指令不构成执行记录。', tab:'执行' },
    { id:'verify', label:'独立验证', state:verified?'done':active&&latest?.phase==='verification'?'active':latest?.evidence?.status==='fail'?'blocked':'pending', detail:verified?'Native 确认当前检查适用；仍须人工审查。':latest?.evidence?'已有 Run 观察，当前适用性须由 Native 确认。':'没有验证证据，不展示模拟通过。', tab:'证据' },
    { id:'review', label:'人工审查', state:reviewed?'done':readiness?.reviewCurrent&&task.review&&!task.review.approved?'blocked':'pending', detail:reviewed?'当前版本人工审查已批准。':'检查规格、代码和测试；Agent 自查不能替代批准。', tab:'变更与审查' },
    { id:'delivery', label:'交付验收', state:accepted?'done':'pending', detail:accepted?'Native 确认当前验收；没有自动推送或合并。':'绑定当前候选、Run 和摘要后，显式验收。', tab:'交付' },
  ];
}
