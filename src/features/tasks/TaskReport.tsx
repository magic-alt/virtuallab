import type { TaskAttempt, TaskReadiness, TaskRecord } from '@/types/tasks';
import type { TaskReportObservation } from './useTaskAttemptReport';
import { statusLabels } from './model';

const sourceLabels = { native: '执行问题', provider: 'Agent 报告', verification: '验证检查' };
interface Problem { source: string; message: string }

export function TaskReport({ task, readiness, launchError, observation, implementationObservation, implementationAttempt }: {
  task: TaskRecord;
  readiness?: TaskReadiness;
  launchError?: string;
  observation: TaskReportObservation;
  implementationObservation?: TaskReportObservation;
  implementationAttempt?: TaskAttempt;
}) {
  const attempt = task.attempts.at(-1);
  const active = !!attempt && ['queued', 'running', 'stopping'].includes(attempt.state);
  const summaryReport = observation.report?.summary?.trim() ? observation.report : implementationObservation?.report;
  const summary = summaryReport?.summary?.trim();
  const problems: Problem[] = [
    ...(observation.report?.problems ?? []).map(problem => ({ source: sourceLabels[problem.source], message: problem.message })),
    ...(implementationObservation?.report?.problems ?? []).map(problem => ({ source: sourceLabels[problem.source], message: problem.message })),
    ...(attempt?.failure ? [{ source: '执行问题', message: attempt.failure }] : []),
    ...(launchError ? [{ source: '启动问题', message: launchError }] : []),
    ...(attempt?.evidence?.checks ?? []).filter(check => ['fail', 'warn', 'blocked'].includes(check.status)).map(check => ({ source: `验证检查 · ${check.gateId}`, message: check.detail })),
    ...(readiness?.blockers ?? []).map(message => ({ source: '交付待办', message })),
    ...(readiness?.warnings ?? []).map(message => ({ source: '提醒', message })),
  ];
  const uniqueProblems = [...new Map(problems.filter(problem => problem.message.trim()).map(problem => [problem.message, problem])).values()];
  const loading = observation.loading || !!implementationObservation?.loading;
  const errors = [...new Set([observation.error, implementationObservation?.error].filter((error): error is string => !!error))];
  const refresh = () => Promise.all([observation.refresh(), implementationObservation?.refresh()]);

  return <section className="task-result-report" aria-label="任务结果报告">
    <header className="task-row task-report-heading"><div><h3>结果摘要</h3><p>{attempt ? statusLabels[attempt.state] : '尚未执行'}{attempt?.endedAtMs ? ` · ${new Date(attempt.endedAtMs).toLocaleString()}` : ''}</p></div>
      <button type="button" disabled={!attempt || loading} onClick={() => void refresh()}>{loading ? '正在读取报告…' : '刷新报告'}</button></header>
    {errors.map(error => <p role="status" className="task-error" key={error}>报告读取失败：{error}</p>)}
    {observation.observerError && <p role="status" className="task-error">{observation.observerError}</p>}
    {summary ? <div className="task-report-summary">{summary.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      : <p className="task-muted">{!attempt ? '启动任务后，这里会显示完成总结和发现的问题。' : loading ? '正在读取执行总结…' : active ? '任务仍在执行，完成后会显示总结。' : '此执行记录没有可读取的 Agent 总结。请结合执行状态、日志和检查结果核对。'}</p>}
    {summary && implementationAttempt && summaryReport?.attemptId === implementationAttempt.id && <p className="task-muted">实现总结来自执行记录 {implementationAttempt.id}；下方检查状态来自最新执行记录。</p>}
    {!task.profile && <p className="task-report-verification-note">未配置验证 Profile，尚未进行独立验证。Agent 的测试说明保留在总结中。</p>}
    <h3>发现的问题</h3>
    {uniqueProblems.length ? <ul className="task-report-problems">{uniqueProblems.map(problem => <li key={problem.message}><span>{problem.source}</span><p>{problem.message}</p></li>)}</ul>
      : <p className="task-muted">{loading ? '正在读取问题记录…' : errors.length ? '问题记录暂不可用，请刷新报告。' : active ? '执行中，尚未收到问题记录。' : '尚未收到单独的问题记录。具体发现与未解决事项请查看上方总结。'}</p>}
    {(observation.report?.truncated || implementationObservation?.report?.truncated) && <p className="task-muted">执行输出已达到保留上限，日志仅包含保留的部分。</p>}
  </section>;
}
