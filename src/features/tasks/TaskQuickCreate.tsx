import { useEffect, useRef, useState, type FormEvent } from 'react';
import { launchTask, taskLaunchFailure } from '@/lib/tasks';
import { inspectRepository, isDesktopRuntime } from '@/lib/backend';
import { workspaceKey } from '@/lib/workspaceKey';
import { useAgentPreferences } from '@/stores/agentPreferences';
import { refreshTaskProfiles, useTaskProfileStore } from '@/stores/taskProfiles';
import { retainLaunchedTask, runTaskAction, useTaskStore } from '@/stores/tasks';
import type { RepositoryRecord, RepositorySnapshot } from '@/types/workbench';
import type { TaskLaunchRequest, TaskPlanRequest, TaskRecord, TaskVerificationProfile } from '@/types/tasks';
import { validateTaskPlan } from './model';
import { quickTaskPlan } from './quickTaskPlan';

interface Props {
  repositories: RepositoryRecord[];
  activeRepository: RepositoryRecord | null;
  onClose: () => void;
  onAdvanced: (draft: TaskPlanRequest) => void;
  inline?: boolean;
  active?: boolean;
  onLaunched?: (task: TaskRecord) => void;
}

const suggestions = [
  '修复 git 提交错误，并补充回归测试',
  '优化现有功能的操作流程，保证兼容原有行为',
  '检查相关代码，修复问题并完成构建验证',
];

export function TaskQuickCreate({ repositories, activeRepository, onClose, onAdvanced, inline=false, active=true, onLaunched }: Props) {
  const [root, setRoot] = useState(activeRepository?.path ?? repositories[0]?.path ?? '');
  const [description, setDescription] = useState('');
  const [scopeText, setScopeText] = useState<string | null>(null);
  const [profileId, setProfileId] = useState('');
  const [profile, setProfile] = useState<TaskVerificationProfile | null>(null);
  const [autoCommit, setAutoCommit] = useState(false);
  const defaultExecutablePath = useAgentPreferences(state => state.codexExecutablePath);
  const [executableOverride, setExecutableOverride] = useState<string | null>(null);
  const executablePath = executableOverride ?? defaultExecutablePath;
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [reading, setReading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inspectionId = useRef(0);
  const sending = useRef(false);
  const submission = useRef<{intentKey:string;request:TaskLaunchRequest}|null>(null);
  const alive = useRef(true);
  const current = useRef({ root, repositories, active });
  current.current = { root, repositories, active };
  const dialog = useRef<HTMLDialogElement>(null);
  const library = useTaskProfileStore();
  const tasks = useTaskStore(state => state.tasks);
  const actionKey='launch:'+workspaceKey(root);
  const pending = useTaskStore(state => !!state.pending[actionKey]);
  const registered = repositories.some(repo => workspaceKey(repo.path) === workspaceKey(root));
  const descriptionBytes = new TextEncoder().encode(description.trim()).byteLength;

  useEffect(() => {
    alive.current = true;
    if (!inline && active) {
      if (dialog.current?.showModal) dialog.current.showModal();
      else dialog.current?.setAttribute('open', '');
    }
    return () => { alive.current = false; ++inspectionId.current; };
  }, [inline]);

  useEffect(()=>{
    if (active && isDesktopRuntime()) void refreshTaskProfiles();
  },[active]);

  useEffect(()=>{
    if (root || !repositories.length) return;
    const preferred=activeRepository && repositories.find(repo=>workspaceKey(repo.path)===workspaceKey(activeRepository.path));
    setRoot((preferred || repositories[0]).path);
  },[root,repositories,activeRepository]);

  useEffect(() => {
    const id = ++inspectionId.current;
    setSnapshot(null);
    if (!active || !root || !registered || !isDesktopRuntime()) { setReading(false); return; }
    setReading(true);
    void inspectRepository(root).then(value => {
      if (alive.current && inspectionId.current === id) setSnapshot(value);
    }).catch(reason => {
      if (alive.current && inspectionId.current === id) setError('读取仓库失败：' + String(reason));
    }).finally(() => {
      if (alive.current && inspectionId.current === id) setReading(false);
    });
    return () => { ++inspectionId.current; };
  }, [root, registered, refreshKey, active]);

  const draft = () => quickTaskPlan({
    repositoryRoot: root, headSha: snapshot?.headSha ?? '', description, scopeText, profile, autoCommit,
  });
  const close = () => { if (!sending.current && !pending) onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!active || sending.current || pending) return;
    sending.current = true;
    const navigationRevision=useTaskStore.getState().navigationRevision;
    setSubmitting(true);
    setError('');
    try {
      if (!isDesktopRuntime()) throw new Error('仅桌面应用可以创建任务。');
      if (!registered || !current.current.repositories.some(repo => workspaceKey(repo.path) === workspaceKey(root))) {
        throw new Error('当前仓库已移除，请重新选择。');
      }
      if (reading || !snapshot) throw new Error('尚未读取到当前仓库 HEAD，请重试。');
      const request = draft();
      if (new TextEncoder().encode(request.tasks[0].goal).byteLength > 8192) {
        throw new Error('任务描述不能超过 8192 字节，请缩短描述。');
      }
      const errors = validateTaskPlan(request, tasks);
      if (errors.length) throw new Error(errors.join('\n'));
      const selectedPath=executablePath.trim() || null;
      const intentKey=JSON.stringify({repositoryRoot:workspaceKey(root),tasks:request.tasks,executablePath:selectedPath});
      const recovery=submission.current?.intentKey===intentKey ? submission.current.request : null;
      // Reinspect before accepting: a changed baseline must be visible before consent.
      const latest = await inspectRepository(root);
      if (workspaceKey(latest.root)!==workspaceKey(root)
        || (!recovery && (latest.headSha!==snapshot.headSha || latest.currentBranch!==snapshot.currentBranch))) {
        if (alive.current) setSnapshot(latest);
        throw new Error('仓库 HEAD 或根目录已发生变化，已更新预览；请确认后重新创建。');
      }
      // Removing the repository or leaving the form during inspection revokes
      // this pending UI action before any worktree or process can be created.
      if (!alive.current) return;
      if (workspaceKey(current.current.root)!==workspaceKey(root)
        || !current.current.repositories.some(repo=>workspaceKey(repo.path)===workspaceKey(root))) {
        throw new Error('工作仓库已移除或切换，请重新选择后开始任务。');
      }
      const launchRequest=recovery ?? {requestId:crypto.randomUUID(),plan:request,executablePath:selectedPath};
      submission.current={intentKey,request:launchRequest};
      // A changed shared default cannot change an uncertain launch's retry identity.
      setExecutableOverride(selectedPath ?? '');
      // A transport failure retains this token and the prompt. Native returns
      // the same accepted task even if the repository HEAD moved meanwhile.
      const result=await runTaskAction(actionKey,()=>launchTask(launchRequest));
      const sameContext=alive.current && workspaceKey(current.current.root) === workspaceKey(request.repositoryRoot)
        && current.current.repositories.some(repo => workspaceKey(repo.path) === workspaceKey(root));
      const select=sameContext && current.current.active && useTaskStore.getState().navigationRevision===navigationRevision;
      // A delayed launch can hydrate the list without undoing a task or tab the
      // user explicitly selected while Native was preparing the workspace.
      retainLaunchedTask(result.task,result.launchError,select);
      submission.current=null;
      if (sameContext) {
        if (select) onLaunched?.(result.task);
        if (inline) {
          setDescription('');
          setExecutableOverride(null);
          setError(result.launchError ? `任务已保留，请在下方继续处理：${result.launchError}` : '');
        } else if (current.current.active) onClose();
      }
    } catch (reason) {
      const failure=taskLaunchFailure(reason);
      if (failure?.acceptance==='rejected' && failure.requestId===submission.current?.request.requestId) {
        // Native durably closes a rejected token, so an older queued command
        // cannot later accept it. Transport/persistence uncertainty keeps it.
        submission.current=null;
        if (alive.current) setRefreshKey(key=>key+1);
      }
      if (alive.current) setError(failure?.message ?? (reason instanceof Error ? reason.message : String(reason)));
    } finally {
      sending.current = false;
      if (alive.current) setSubmitting(false);
    }
  };

  const preview=<div className="task-quick-summary">
    <strong>开始后自动执行</strong>
    <span>独立 Worktree · Codex · {scopeText === null ? '整个仓库' : '限定目录'}</span>
    <span>{profile ? '验证：' + profile.name : '未配置独立验证'}</span>
    <span>{autoCommit ? '完成后本地提交' : '修改保留在任务工作区'}</span>
  </div>;
  const advancedButton=<button type="button" onClick={()=>onAdvanced(draft())} disabled={submitting || pending}>高级任务图 / JSON</button>;
  const content=<>
    <header className="task-row"><div><h2>{inline ? '工作任务' : '开始新任务'}</h2><p>描述要完成的工作，Codex 会在独立工作区中执行，并生成结果报告。</p></div>
      {!inline && <button type="button" disabled={submitting || pending} onClick={close}>关闭</button>}</header>
    <form onSubmit={event => void submit(event)}>
      <fieldset disabled={!active || submitting || pending}>
        <div className={inline ? 'task-quick-repository-row' : undefined}>
        <label>工作仓库
          <select value={registered ? root : ''} onChange={event => {setRoot(event.target.value);setError('');setScopeText(null);setProfileId('');setProfile(null);setAutoCommit(false);}}>
            {!registered && <option value="" disabled>请选择工作仓库</option>}
            {repositories.map(repo => <option key={repo.id} value={repo.path}>{repo.name} — {repo.path}</option>)}
          </select>
        </label>
        <div className="task-quick-baseline" role="status">
          {reading ? '正在自动读取分支与 HEAD…' : snapshot
            ? <><strong>{snapshot.currentBranch || '当前分支'}</strong> · HEAD <code>{snapshot.headSha.slice(0, 12)}</code>
              {snapshot.dirtyCount > 0 && <span> · 主工作区有 {snapshot.dirtyCount} 处本地修改，任务工作区不会自动带入</span>}</>
            : '仓库基线尚不可用'}
          <button type="button" onClick={() => {setError('');setRefreshKey(key => key + 1);}} disabled={!root || reading || !isDesktopRuntime()}>刷新</button>
        </div>
        </div>
        <label className="task-quick-prompt-label">你希望 Agent 完成什么？
          <textarea className="task-quick-prompt" value={description} onChange={event => setDescription(event.target.value)}
            placeholder="例如：修复 git 提交错误，检查原因、完成修复和测试，并总结发现的问题。"
            onKeyDown={event=>{
              if (event.key==='Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault();event.currentTarget.form?.requestSubmit();
              }
            }}
            autoFocus={active}/>
        </label>
        <div className="task-quick-suggestions" aria-label="描述示例">
          {suggestions.map(item => <button key={item} type="button" onClick={() => setDescription(item)}>{item}</button>)}
        </div>
        <p className="task-quick-hint">自动创建 Worktree → Codex 执行 → 完成报告。Ctrl / ⌘ + Enter 开始 · {descriptionBytes} / 8192 字节{descriptionBytes > 8192 ? ' · 描述过长，请缩短' : ''}</p>
        <details className="task-quick-advanced">
          <summary>可选设置 · 修改范围、验证 Profile、本地提交</summary>
          <label>允许修改范围
            <select value={scopeText === null ? 'all' : 'custom'} onChange={event => setScopeText(event.target.value === 'all' ? null : '')}>
              <option value="all">整个仓库（默认）</option><option value="custom">只允许指定文件或目录</option>
            </select>
          </label>
          {scopeText === null
            ? <p>仓库范围采用 <code>.</code>。原生端仍禁止 Git 元数据和环境机密文件；这不是操作系统沙箱。</p>
            : <label>文件或目录（每行一个，相对于仓库根目录）
                <textarea value={scopeText} onChange={event => setScopeText(event.target.value)} placeholder="src\ntests" />
              </label>}
          <label>正式验证 Profile（可选）
            <select value={profileId} onChange={event => {
              const item = library.records.find(item => item.id === event.target.value);
              setProfileId(item?.id ?? '');
              setProfile(item ? structuredClone(item.profile) : null);
            }}>
              <option value="">暂不配置验证</option>
              {library.records.map(item => <option key={item.id} value={item.id}>{item.profile.name} · r{item.revision}</option>)}
            </select>
          </label>
          {library.error && <p role="status">Profile 库不可用：{library.error}。仍可创建未验证任务。</p>}
          <label>Codex 可执行程序路径（可选）
            <input value={executablePath} onChange={event=>setExecutableOverride(event.target.value)} placeholder="自动检测本机 Codex；也可指定完整路径"/>
          </label>
          {executableOverride !== null && <button type="button" onClick={() => setExecutableOverride(null)}>使用 Hub 默认路径</button>}
          <label className="task-checkbox"><input type="checkbox" checked={autoCommit} onChange={event => setAutoCommit(event.target.checked)}/>
            完成后创建本地提交（不推送）</label>
          {inline && <>{preview}<div className="task-row task-quick-advanced-action">{advancedButton}</div></>}
        </details>
        {!inline && preview}
        {error && <p role="alert" className="task-error">{error}</p>}
        <footer className="task-row task-quick-actions">
          {!inline && advancedButton}
          <button type="submit" disabled={!description.trim() || descriptionBytes > 8192 || !root || !registered || !snapshot || reading || !isDesktopRuntime()}>
            {submitting || pending ? '正在启动…' : '开始任务'}
          </button>
        </footer>
      </fieldset>
    </form>
  </>;
  return inline ? <section className="task-surface task-quick-inline" aria-label="工作任务">{content}</section>
    : <dialog ref={dialog} className="task-plan-dialog task-surface task-quick-dialog" aria-label="自然语言创建任务"
      onCancel={event=>{event.preventDefault();close();}}>{content}</dialog>;
}
