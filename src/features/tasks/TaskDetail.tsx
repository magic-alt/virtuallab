import { TaskEvidenceContext } from './TaskEvidenceContext';
import { useEffect, useRef, useState } from 'react';
import * as tasks from '@/lib/tasks';
import { isDesktopRuntime } from '@/lib/backend';
import { runTaskAction, runTaskCancellation, useTaskStore, selectTask } from '@/stores/tasks';
import type { IntegrationPreview, TaskReadiness, TaskRecord } from '@/types/tasks';
import type { WorkspaceTab } from '@/types/workbench';
import { statusLabels, taskStatus } from './model';
import { nextTaskStep } from './workflow';
import { TaskWorkspaceTools } from './TaskWorkspaceTools';

const tabs = ['概览','执行','变更与审查','证据','交付'] as const;
export type OpenTaskWorkspace = (root: string, tab: WorkspaceTab, repositoryRoot?: string) => void;
export function TaskStatusSummary({task, readiness}: {task: TaskRecord; readiness?: TaskReadiness}) {
  const status = taskStatus(task, readiness);
  return <dl className="task-status-grid">{[['执行',status.execution],['检查',status.checks],['交付就绪',status.readiness],['人工验收',status.acceptance]].map(([label,value]) => <div key={label}><dt>{label}</dt><dd data-status={value}>{statusLabels[value] ?? value}</dd></div>)}</dl>;
}
function TaskDecisionBinding({decision}: {decision: {runId?: string | null; toolchainDigest?: string | null}}) {
  return <dl className="task-facts"><dt>绑定 Run</dt><dd>{decision.runId ?? '历史记录（未绑定 Run）'}</dd><dt>绑定工具链摘要</dt><dd>{decision.toolchainDigest ?? '历史记录（工具链未绑定）'}</dd></dl>;
}
export function TaskDetail({task, onOpenWorkspace}: {task: TaskRecord; onOpenWorkspace: OpenTaskWorkspace}) {
  const tab = useTaskStore(state => state.activeTaskId === task.id ? state.activeTaskTab : '概览');
  const setTab = (value:typeof tabs[number]) => selectTask(task.id,value);
  const [branch,setBranch] = useState(() => 'task/' + task.id); const [targetPath,setTargetPath] = useState(''); const [executablePath,setExecutablePath] = useState('');
  const [preparationUncertain,setPreparationUncertain] = useState(false);
  const [preparationNotice,setPreparationNotice] = useState('');
  const [note,setNote] = useState(''); const [ackIdentity,setAckIdentity] = useState('');
  const [preview,setPreview] = useState<IntegrationPreview | null>(null); const [previewRevision,setPreviewRevision] = useState(0);
  const [now,setNow] = useState(Date.now()); const alive = useRef(true);
  const readiness = useTaskStore(state => state.readiness[task.id]); const readinessError = useTaskStore(state => state.readinessErrors[task.id]);
  const cancelling = useTaskStore(state => state.cancelling[task.id]);
  const pending = useTaskStore(state => state.pending[task.id]); const actionError = useTaskStore(state => state.actionErrors[task.id]);
  const events = useTaskStore(state => state.events);
  useEffect(() => {
    if (task.workspaceRoot) setPreparationUncertain(false);
    else if (actionError && /prepar|worktree|工作区|准备|创建/i.test(actionError) && /reconcil|uncertain|核对|不确定|未知/i.test(actionError)) setPreparationUncertain(true);
  }, [task.workspaceRoot, actionError]);
  useEffect(() => {alive.current = true;return () => {alive.current = false;};},[]);
  useEffect(() => {if (!preview) return; const timer = window.setInterval(() => setNow(Date.now()),1000);return () => clearInterval(timer);},[preview]);
  const attempt = task.attempts.at(-1); const evidence = attempt?.evidence;
  const reconcileIntegration = task.kind === 'integration' && !!attempt && ['failed','interrupted'].includes(attempt.state);
  const active = !!attempt && ['queued','running','stopping'].includes(attempt.state);
  const disabled = !!pending || !!cancelling || !isDesktopRuntime();
  const candidate = readiness?.candidateSha;
  const identity = JSON.stringify([task.revision,candidate,evidence?.runId,evidence?.inputDigest,evidence?.profileDigest,evidence?.toolchainDigest,readiness?.warnings]);
  const acknowledged = ackIdentity === identity;
  const previewCurrent = preview && preview.taskId === task.id && previewRevision === task.revision && now < preview.expiresAtMs;
  const act = <T,>(operation: () => Promise<T>, after?: (value: T) => void) => {
    void runTaskAction(task.id, operation).then(value => {if (alive.current) after?.(value);}).catch(() => { /* Store surfaces the native error. */ });
  };
  const open = (destination: WorkspaceTab) => {if (task.workspaceRoot) onOpenWorkspace(task.workspaceRoot,destination,task.repositoryRoot);};
  const tool = (label: string, destination: WorkspaceTab) => <button disabled={!task.workspaceRoot} onClick={() => open(destination)}>{label}</button>;
  const download = (json: string) => {
    const url = URL.createObjectURL(new Blob([json],{type:'application/json'}));
    const link = document.createElement('a');link.href = url;link.download = `task-${task.id.replace(/[^a-z0-9_-]/gi,'_')}-passport.json`;link.click();URL.revokeObjectURL(url);
  };
  return <article className="task-surface task-detail" aria-label="任务详情">
    <header><p>{task.kind === 'integration' ? '集成任务' : '实现任务'} · {task.id}</p><h2>{task.title}</h2><aside className="task-node" aria-label="任务下一步"><strong>{nextTaskStep(task,readiness).label}</strong><p>{nextTaskStep(task,readiness).detail}</p><button onClick={()=>setTab(nextTaskStep(task,readiness).tab)}>查看相关操作</button></aside><p>{task.repositoryRoot}</p></header>
    <TaskStatusSummary task={task} readiness={readiness}/>
    {actionError && <p role="alert" className="task-error">{actionError}</p>}
    {readinessError && <p className="task-error">就绪来源不可用：{readinessError}</p>}
    <div role="tablist" aria-label="任务详情标签" className="task-tabs">{tabs.map(label => <button key={label} role="tab" id={`task-tab-${label}`} aria-selected={tab === label} aria-controls="task-detail-panel" onClick={() => setTab(label)}>{label}</button>)}</div>
    <section role="tabpanel" id="task-detail-panel" aria-labelledby={`task-tab-${tab}`} className="task-panel">
      {tab === '概览' && <>
        <h3>目标</h3><p>{task.goal}</p><p>基线：<code>{task.baseSha}</code></p><h3>允许修改的范围</h3><ul>{task.scope.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        <h3>依赖任务</h3><p>{task.dependencies.join('、') || '无依赖'}</p>
        <p>Profile：{task.profile?.name ?? '未配置'} · 自动封存：{task.autoCommit ? '已允许' : '未允许'}</p>
        {task.workspaceRoot ? <><p>工作区：<code>{task.workspaceRoot}</code></p>{tool('打开工作区','overview')}</> : <form onSubmit={event => {event.preventDefault(); if (branch.trim() && !preparationUncertain) {setPreparationNotice('');act(() => tasks.prepareTaskWorkspace({taskId:task.id,branch:branch.trim(),targetPath:targetPath.trim() || null}));}}}>
          <h3>显式创建任务工作区</h3><p>任务附着于工作区；创建不会开始执行。工作区不是 OS 沙箱。</p>
          <fieldset disabled={disabled}><label>工作区分支<input required value={branch} onChange={event => setBranch(event.target.value)}/></label><label>工作区路径（可选）<input value={targetPath} onChange={event => setTargetPath(event.target.value)}/></label><button type="submit" disabled={!branch.trim() || preparationUncertain}>创建任务工作区</button></fieldset>
          {preparationNotice && <p role="status">{preparationNotice}</p>}
          {preparationUncertain && <section className="task-node"><p>Native 报告准备结果不确定。先核对已创建的工作区；此操作不会重新创建、删除或自动重放 Git 操作。</p><button type="button" disabled={disabled} onClick={() => act(() => tasks.reconcileTaskWorkspace(task.id), result => {setPreparationUncertain(false);setPreparationNotice(result.workspaceRoot ? 'Native 已核对并绑定工作区。' : 'Native 已核对准备状态，尚未绑定工作区。可修正输入后再次显式创建。');})}>核对已创建工作区</button></section>}
        </form>}
      </>}
      {tab === '执行' && <>
        <p>默认并发 2；排队任务等待原生调度和依赖。Retry 创建新的 Attempt。执行完成不代表检查通过。</p>
        <label>可执行程序路径（可选，不含参数）<input value={executablePath} onChange={event => setExecutablePath(event.target.value)}/></label>
        <div className="task-row"><button disabled={disabled || active || !!attempt || !task.workspaceRoot || task.kind === 'integration'} onClick={() => act(() => tasks.startTask(task.id,executablePath.trim() || null))}>开始执行</button>
          <button disabled={disabled || active || !attempt || !task.workspaceRoot || task.kind === 'integration'} onClick={() => act(() => tasks.retryTask(task.id,executablePath.trim() || null))}>重试（新 Attempt）</button>
          <button disabled={!isDesktopRuntime() || !active || !!cancelling} onClick={() => {void runTaskCancellation(task.id).catch(() => { /* Store surfaces native cancellation errors. */ });}}>取消执行</button>{tool('打开 Agents','agents')}{tool('打开终端','terminal')}</div>
        {task.kind === 'integration' && <p>集成任务请在交付标签预览并确认固定提交；不会启动实现 Agent。</p>}
        <h3>Attempts</h3>{!task.attempts.length && <p>尚无执行记录。</p>}
        <ol>{task.attempts.map(item => <li key={item.id}><strong>{item.id}</strong> · {statusLabels[item.state]} · {item.phase}<dl className="task-facts"><dt>Harness</dt><dd>{item.execution?.harness || '未知'}</dd><dt>实际 CLI</dt><dd>{item.execution?.executablePath || '未知'}</dd><dt>版本</dt><dd>{item.execution?.version || '未知'}</dd></dl><p>候选：{item.candidateSha ?? '未封存'} · {new Date(item.startedAtMs).toLocaleString()}</p>{item.failure && <p className="task-error">{item.failure}</p>}{item.id !== attempt?.id && item.evidence && <details className="task-node"><summary>历史证据 · {item.id}</summary><p>此记录为历史观察，不代表当前交付就绪。</p><TaskEvidenceContext evidence={item.evidence}/></details>}</li>)}</ol>
        <TaskWorkspaceTools mode="run" repositoryRoot={task.repositoryRoot} workspaceRoot={task.workspaceRoot} baseSha={task.baseSha}/>
        <h3>结构化事件</h3><ol className="task-scroll">{events.filter(event => event.taskId === task.id).map(event => <li key={event.eventId}>{event.seq} · {event.kind} · {new Date(event.timestampMs).toLocaleString()}</li>)}</ol>
      </>}
      {tab === '变更与审查' && <>
        <div className="task-row">{tool('打开变更','changes')}{tool('打开 GitHub','github')}</div>
        <p>审查绑定当前原生候选、验证 Run、输入/Profile 和工具链摘要。每次新的验证 Run 都需要重新进行人工审查和验收，即使源码未变化。适用性只由 Native 判断。</p>
        <p>待审查 SHA：<code>{candidate ?? '原生候选不可用'}</code></p>
        <p>审查状态：{task.review ? readiness ? readiness.reviewCurrent ? task.review.approved ? '当前修订已批准' : '当前修订未批准' : '审查已过期' : '适用性未知' : '尚未审查'}</p>
        {task.review && <><p>历史审查：{task.review.headSha} · {task.review.note}</p><TaskDecisionBinding decision={task.review}/></>}
        <label>审查说明<textarea value={note} onChange={event => setNote(event.target.value)}/></label>
        <div className="task-row"><button disabled={disabled || active || !candidate} onClick={() => {if (candidate) act(() => tasks.reviewTask({taskId:task.id,expectedHeadSha:candidate,note,approved:true}));}}>批准此修订</button><button disabled={disabled || active || !candidate} onClick={() => {if (candidate) act(() => tasks.reviewTask({taskId:task.id,expectedHeadSha:candidate,note,approved:false}));}}>请求修改</button></div>
        <p>AI Reviewer 未具备已验证的只读能力；请进行人工审查。</p>
        <TaskWorkspaceTools mode="changes" repositoryRoot={task.repositoryRoot} workspaceRoot={task.workspaceRoot} baseSha={task.baseSha}/>
      </>}
      {tab === '证据' && <>
        <div className="task-row"><button disabled={disabled || active || !task.workspaceRoot || !task.profile} onClick={() => act(() => tasks.verifyTask(task.id))}>{reconcileIntegration ? '验证已解决的集成' : '独立验证（新 Run）'}</button>{tool('打开 Run','run')}</div>
        {!candidate && <p>无候选时，可先提交修改，再验证干净的已提交版本以采用候选。Native 会重新检查范围、输入和依赖；Verify 不会重放创建或集成操作。</p>}
        {reconcileIntegration && <p>请先在 IDE 中解决并提交集成冲突。此操作验证干净的当前 HEAD 和固定依赖祖先关系，创建新的验证 Attempt；不会重放合并。</p>}
        <p>Manifest 摘要由 Native 绑定；缺少绑定的旧记录只作历史参考，UI 不计算摘要或授予信任。</p>
        <p>Task 证据由原生独立观察。现有 Run 工具的 v1 记录只作历史参考，不能自动授予任务资格。</p>
        {!task.profile && <p>未配置 Profile：无法独立验证。可在新计划中配置，已有任务的配置已冻结。</p>}
        {evidence ? <TaskEvidenceContext evidence={evidence}/> : <p>尚无本次 Attempt 的原生证据。</p>}
        <TaskWorkspaceTools mode="run" repositoryRoot={task.repositoryRoot} workspaceRoot={task.workspaceRoot} baseSha={task.baseSha}/>
        <h3>冻结的 Profile</h3><pre className="task-code task-scroll">{JSON.stringify(task.profile,null,2)}</pre>
      </>}
      {tab === '交付' && <>
        <p>执行、检查、当前就绪和人工验收独立记录。部分集成失败必须检查目标工作区，不会自动重放。</p>
        <h3>当前阻止原因</h3>{!readiness ? <p>当前原生就绪来源不可用，请刷新。</p> : <><ul>{readiness.blockers.map((reason,index) => <li key={index}>{reason}</li>)}</ul>{!readiness.blockers.length && <p>原生端未报告阻止原因。</p>}<h3>警告</h3><ul>{readiness.warnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul></>}
        {task.kind === 'integration' && <section className="task-node"><h3>本地集成</h3><button disabled={disabled || active || !task.workspaceRoot} onClick={() => act(() => tasks.previewTaskIntegration(task.id),value => {setPreview(value);setPreviewRevision(task.revision);setNow(Date.now());})}>预览集成</button>
          {preview && <><p>目标工作区：{preview.workspaceRoot}</p><p>目标 HEAD：<code>{preview.targetHeadSha}</code></p><h4>固定来源提交</h4><ul>{preview.sourceCommits.map(commit => <li key={commit}><code>{commit}</code></li>)}</ul><p>过期时间：{new Date(preview.expiresAtMs).toLocaleString()}</p>{!previewCurrent && <p>预览已过期或任务已变化，请重新预览。</p>}<button disabled={disabled || active || !previewCurrent} onClick={() => {setPreview(null);act(() => tasks.confirmTaskIntegration(preview));}}>确认集成（原生对话框）</button></>}
        </section>}
        <p>每次新的验证 Run 都需要重新人工审查和验收。旧决策保留为历史，不自动复用。</p>
        <p>验收 SHA：<code>{candidate ?? '原生候选不可用'}</code></p>
        {!!readiness?.warnings.length && <label className="task-checkbox"><input type="checkbox" checked={acknowledged} onChange={event => setAckIdentity(event.target.checked ? identity : '')}/>我已了解当前警告</label>}
        <div className="task-row"><button disabled={disabled || active || !candidate || !readiness?.reviewCurrent || !['ready','warning'].includes(readiness.status) || (!!readiness.warnings.length && !acknowledged)} onClick={() => {if (candidate) act(() => tasks.acceptTaskResult({taskId:task.id,expectedHeadSha:candidate,acknowledgedWarnings:acknowledged}));}}>验收此修订</button>
          <button disabled={disabled} onClick={() => act(() => tasks.exportTaskPassport(task.id),download)}>导出 Passport JSON</button>{tool('打开 GitHub','github')}</div>
        {task.acceptance && <><p>历史验收：{task.acceptance.headSha} · {new Date(task.acceptance.acceptedAtMs).toLocaleString()}</p><TaskDecisionBinding decision={task.acceptance}/></>}
      </>}
    </section>
  </article>;
}
