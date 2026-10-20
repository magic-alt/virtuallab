import { useEffect, useRef } from 'react';
import type { TaskAttempt } from '@/types/tasks';
import type { TaskReportObservation } from './useTaskAttemptReport';
import { statusLabels } from './model';

const kindLabels = { assistant: 'Agent', command: '命令', fileChange: '文件变更', status: '状态', problem: '问题' };

export function TaskExecutionConsole({ attempt, observation }: { attempt?: TaskAttempt; observation: TaskReportObservation }) {
  const { report, loading, error, observerError, refresh } = observation;
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const entries = report?.entries.slice(-400) ?? [];
  const lastSequence = entries.at(-1)?.sequence;
  useEffect(() => {
    following.current = true;
  }, [attempt?.id]);
  useEffect(() => {
    if (following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [attempt?.id, lastSequence]);

  return <section className="task-execution-console" aria-label="任务执行输出">
    <header className="task-row task-console-heading">
      <div><h3>{attempt?.execution?.harness === 'codex' ? 'Codex 执行输出' : '任务执行输出'}</h3>
        <p>{attempt ? statusLabels[attempt.state] : '尚未启动'}{attempt && ' · 自动更新'}</p></div>
      <button type="button" disabled={!attempt || loading} onClick={() => void refresh()}>{loading ? '正在读取输出…' : '刷新输出'}</button>
    </header>
    {error && <p role="status" className="task-error">输出读取失败：{error}</p>}
    {observerError && <p role="status" className="task-error">{observerError}</p>}
    <div ref={viewport} className="task-console-viewport" role="log" aria-label="任务执行日志" aria-live="polite" aria-relevant="additions text"
      onScroll={() => { const element = viewport.current; if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72; }}>
      {entries.map(entry => <div className="task-console-entry" data-kind={entry.kind} key={entry.sequence}>
        <div className="task-console-entry-meta"><span>{kindLabels[entry.kind]}</span><time dateTime={new Date(entry.timestampMs).toISOString()}>{new Date(entry.timestampMs).toLocaleTimeString()}</time></div>
        <pre>{entry.text}</pre>
      </div>)}
      {!entries.length && <p className="task-console-empty">{!attempt ? '提交任务后，执行输出会自动显示在这里。' : loading ? '正在读取执行记录…' : ['queued', 'running', 'stopping'].includes(attempt.state) ? '正在等待执行输出…' : '此执行记录没有保存输出。'}</p>}
    </div>
    {(report?.truncated || (report?.entries.length ?? 0) > 400) && <p className="task-muted">输出超过保留上限；此处显示最近记录。</p>}
  </section>;
}
