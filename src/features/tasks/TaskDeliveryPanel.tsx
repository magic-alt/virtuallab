import type { TaskRecord } from '@/types/tasks';

const labels = {
  pending:'等待提交 PR', running:'正在提交 PR', failed:'PR 提交失败',
  reconcile_required:'PR 结果待核对', delivered:'已创建草稿 PR',
};

/** A publication receipt is separate from execution success and human acceptance. */
export function TaskDeliveryPanel({task,disabled,onDeliver}:{task:TaskRecord;disabled:boolean;onDeliver:()=>void}) {
  if (!task.autoDraftPr && !task.delivery) return null;
  const delivery = task.delivery;
  const attempt = task.attempts.at(-1);
  const current = !!delivery && delivery.attemptId === attempt?.id && delivery.candidateSha === attempt?.candidateSha;
  const active = !!attempt && ['queued','running','stopping'].includes(attempt.state);
  const publishing = current && delivery?.status === 'running';
  // Delivery is a task-level receipt. Later verification can refer to the same
  // candidate, but a later implementation cannot silently republish this task.
  const done = delivery?.status === 'delivered';
  const sameCandidate = !!delivery && delivery.candidateSha === attempt?.candidateSha;
  const canDeliver = task.autoDraftPr && !active && attempt?.state === 'succeeded' && !!attempt.candidateSha && !publishing && !done;
  const href = delivery?.pullRequestUrl && /^https:\/\/github\.com\/[a-z\d_.-]+\/[a-z\d_.-]+\/pull\/[1-9]\d*$/i.test(delivery.pullRequestUrl)
    ? delivery.pullRequestUrl : null;
  return <section className="task-node task-pr-delivery" aria-label="PR 提交">
    <div className="task-row"><h3>PR 提交</h3><span data-status={done ? 'delivered' : current ? delivery.status : 'pending'}>
      {done ? sameCandidate ? labels.delivered : '先前版本已创建草稿 PR' : current ? labels[delivery.status] : active || !attempt ? '等待任务完成' : attempt.state === 'succeeded' ? '等待提交 PR' : '任务未成功，暂不提交 PR'}
    </span></div>
    <p>{task.prRepository ?? delivery?.repository ?? '创建任务时绑定的 GitHub 仓库'} · 目标分支：<code>{task.prBaseBranch || delivery?.baseBranch || '仓库默认分支'}</code></p>
    {delivery?.branch && <p>任务分支：<code>{delivery.branch}</code></p>}
    {done && !sameCandidate && <p className="task-muted">下方 PR 对应先前版本，当前结果尚未发布；若要发布新的实现，请新建后续任务。</p>}
    {delivery && !current && !done && <p className="task-muted">下方保留的是先前执行的 PR 记录，当前执行尚未提交。</p>}
    {delivery?.error && <p className="task-error" role="status">{delivery.error}</p>}
    {current && delivery?.status === 'reconcile_required' && <p>上次远端操作结果尚未确认。核对会先查询已有 PR，确认后继续当前提交步骤。</p>}
    <div className="task-row">
      {href && <a href={href} target="_blank" rel="noopener noreferrer">打开 PR #{delivery?.pullRequestNumber}</a>}
      {canDeliver && <button type="button" disabled={disabled} onClick={onDeliver}>
        {current && delivery?.status === 'reconcile_required' ? '核对 PR 提交结果' : current && delivery?.status === 'failed' ? '重试提交 PR' : '提交 Draft PR'}
      </button>}
    </div>
    <p className="task-muted">草稿 PR 保留代码供审查；验证结果与人工验收状态继续显示在任务报告中。</p>
  </section>;
}
