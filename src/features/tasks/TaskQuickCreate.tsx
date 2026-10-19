import { useEffect, useRef, useState, type FormEvent } from 'react';
import { acceptTaskPlan } from '@/lib/tasks';
import { inspectRepository, isDesktopRuntime } from '@/lib/backend';
import { workspaceKey } from '@/lib/workspaceKey';
import { refreshTaskProfiles, useTaskProfileStore } from '@/stores/taskProfiles';
import { runTaskAction, selectTask, useTaskStore } from '@/stores/tasks';
import type { RepositoryRecord, RepositorySnapshot } from '@/types/workbench';
import type { TaskPlanRequest, TaskVerificationProfile } from '@/types/tasks';
import { validateTaskPlan } from './model';
import { quickTaskPlan } from './quickTaskPlan';

interface Props {
  repositories: RepositoryRecord[];
  activeRepository: RepositoryRecord | null;
  onClose: () => void;
  onAdvanced: (draft: TaskPlanRequest) => void;
}

const suggestions = [
  '修复当前工程中的一个问题，并补充回归测试',
  '优化现有功能的操作流程，保证兼容原有行为',
  '检查相关代码，修复问题并完成构建验证',
];

export function TaskQuickCreate({ repositories, activeRepository, onClose, onAdvanced }: Props) {
  const [root, setRoot] = useState(activeRepository?.path ?? repositories[0]?.path ?? '');
  const [description, setDescription] = useState('');
  const [scopeText, setScopeText] = useState<string | null>(null);
  const [profileId, setProfileId] = useState('');
  const [profile, setProfile] = useState<TaskVerificationProfile | null>(null);
  const [autoCommit, setAutoCommit] = useState(false);
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [reading, setReading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inspectionId = useRef(0);
  const sending = useRef(false);
  const alive = useRef(true);
  const current = useRef({ root, repositories });
  current.current = { root, repositories };
  const dialog = useRef<HTMLDialogElement>(null);
  const library = useTaskProfileStore();
  const tasks = useTaskStore(state => state.tasks);
  const pending = useTaskStore(state => !!state.pending['plan:' + root]);
  const registered = repositories.some(repo => workspaceKey(repo.path) === workspaceKey(root));
  const descriptionBytes = new TextEncoder().encode(description.trim()).byteLength;

  useEffect(() => {
    alive.current = true;
    if (dialog.current?.showModal) dialog.current.showModal();
    else dialog.current?.setAttribute('open', '');
    if (isDesktopRuntime()) void refreshTaskProfiles();
    return () => { alive.current = false; ++inspectionId.current; };
  }, []);

  useEffect(() => {
    const id = ++inspectionId.current;
    setSnapshot(null);
    setError('');
    if (!root || !isDesktopRuntime()) { setReading(false); return; }
    setReading(true);
    void inspectRepository(root).then(value => {
      if (alive.current && inspectionId.current === id) setSnapshot(value);
    }).catch(reason => {
      if (alive.current && inspectionId.current === id) setError('读取仓库失败：' + String(reason));
    }).finally(() => {
      if (alive.current && inspectionId.current === id) setReading(false);
    });
    return () => { ++inspectionId.current; };
  }, [root, refreshKey]);

  const draft = () => quickTaskPlan({
    repositoryRoot: root, headSha: snapshot?.headSha ?? '', description, scopeText, profile, autoCommit,
  });
  const close = () => { if (!sending.current && !pending) onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending.current || pending) return;
    sending.current = true;
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
      // Reinspect before accepting: a changed baseline must be visible before consent.
      const latest = await inspectRepository(root);
      if (latest.headSha !== snapshot.headSha || latest.currentBranch !== snapshot.currentBranch || workspaceKey(latest.root) !== workspaceKey(root)) {
        if (alive.current) setSnapshot(latest);
        throw new Error('仓库 HEAD 或根目录已发生变化，已更新预览；请确认后重新创建。');
      }
      const records = await runTaskAction('plan:' + root, () => acceptTaskPlan(request));
      if (alive.current && workspaceKey(current.current.root) === workspaceKey(request.repositoryRoot)
        && current.current.repositories.some(repo => workspaceKey(repo.path) === workspaceKey(root))) {
        if (records[0]) selectTask(records[0].id, '概览');
        onClose();
      }
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      sending.current = false;
      if (alive.current) setSubmitting(false);
    }
  };

  return <dialog ref={dialog} className="task-plan-dialog task-surface task-quick-dialog" aria-label="自然语言创建任务"
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="task-row"><div><h2>创建任务</h2><p>告诉 Agent 你想完成什么，其他配置按需展开。</p></div>
      <button type="button" disabled={submitting || pending} onClick={close}>关闭</button></header>
    <form onSubmit={event => void submit(event)}>
      <fieldset disabled={submitting || pending}>
        <label>工作仓库
          <select value={root} onChange={event => {setRoot(event.target.value);setScopeText(null);setProfileId('');setProfile(null);setAutoCommit(false);}}>
            {repositories.map(repo => <option key={repo.id} value={repo.path}>{repo.name} — {repo.path}</option>)}
          </select>
        </label>
        <div className="task-quick-baseline" role="status">
          {reading ? '正在自动读取分支与 HEAD…' : snapshot
            ? <><strong>{snapshot.currentBranch || '当前分支'}</strong> · HEAD <code>{snapshot.headSha.slice(0, 12)}</code>
              {snapshot.dirtyCount > 0 && <span> · 主工作区有 {snapshot.dirtyCount} 处本地修改，任务工作区不会自动带入</span>}</>
            : '仓库基线尚不可用'}
          <button type="button" onClick={() => setRefreshKey(key => key + 1)} disabled={!root || reading || !isDesktopRuntime()}>刷新</button>
        </div>
        <label className="task-quick-prompt-label">你希望 Agent 完成什么？
          <textarea className="task-quick-prompt" value={description} onChange={event => setDescription(event.target.value)}
            placeholder="例如：优化控制中心创建任务的体验。用户只需要描述需求，自动读取仓库信息；保留现有验证、安全和多工作区能力，并补充测试。"
            autoFocus/>
        </label>
        <div className="task-quick-suggestions" aria-label="描述示例">
          {suggestions.map(item => <button key={item} type="button" onClick={() => setDescription(item)}>{item}</button>)}
        </div>
        <p className="task-quick-hint">描述原样交给执行 Agent，不会假装生成 AI 计划。默认创建一个实现任务，后续显式创建独立 Worktree 并启动 Agent。{descriptionBytes} / 8192 字节{descriptionBytes > 8192 ? ' · 描述过长，请缩短' : ''}</p>
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
          <label className="task-checkbox"><input type="checkbox" checked={autoCommit} onChange={event => setAutoCommit(event.target.checked)}/>
            完成后允许 Native 检查范围并封存本地提交（不推送）</label>
        </details>
        <div className="task-quick-summary">
          <strong>即将创建</strong>
          <span>单个实现任务 · {scopeText === null ? '整个仓库' : '限定目录'}</span>
          <span>{profile ? '验证：' + profile.name : '未配置正式验证（可稍后新建任务时配置）'}</span>
          <span>{autoCommit ? '允许本地自动封存' : '不自动提交'}</span>
        </div>
        {error && <p role="alert" className="task-error">{error}</p>}
        <footer className="task-row task-quick-actions">
          <button type="button" onClick={() => onAdvanced(draft())} disabled={submitting || pending}>高级任务图 / JSON</button>
          <button type="submit" disabled={!description.trim() || descriptionBytes > 8192 || !root || !registered || !snapshot || reading || !isDesktopRuntime()}>
            {submitting || pending ? '正在创建…' : '创建任务'}
          </button>
        </footer>
      </fieldset>
    </form>
  </dialog>;
}
