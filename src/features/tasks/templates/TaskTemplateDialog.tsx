import { useEffect, useRef, useState } from 'react';
import { inspectRepository, isDesktopRuntime } from '@/lib/backend';
import { acceptTaskPlan, prepareTaskWorkspace, startTask } from '@/lib/tasks';
import { workspaceKey } from '@/lib/workspaceKey';
import { refreshTaskProfiles, useTaskProfileStore } from '@/stores/taskProfiles';
import { runTaskAction, selectTask, useTaskStore } from '@/stores/tasks';
import type { RepositoryRecord } from '@/types/workbench';
import type { TaskRecord, TaskVerificationProfile } from '@/types/tasks';
import { validateTaskPlan } from '../model';
import { suggestTaskBranch } from '../taskBranch';
import { TaskDeliveryOptions } from '../TaskDeliveryOptions';
import { materializeTemplate, TASK_TEMPLATES, WORKFLOW_SKILLS, type TaskTemplate } from './catalog';
import { launchTemplate } from './launch';
import type { TaskRecommendation } from './repositoryRecommendations';
import { useRepositoryRecommendations } from './useRepositoryRecommendations';

interface Props {
  template: TaskTemplate;
  repositories: RepositoryRecord[];
  activeRepository: RepositoryRecord | null;
  recommendation?: TaskRecommendation;
  onClose: () => void;
}
const phaseLabels = { plan: '保存任务合同', workspace: '准备隔离工作区', start: '提交原生执行队列' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function TaskTemplateDialog({ template, recommendation, repositories, activeRepository, onClose }: Props) {
  const [instanceId] = useState(() => crypto.randomUUID());
  const [root, setRoot] = useState(() => repositories.find(repo => workspaceKey(repo.path) === workspaceKey(activeRepository?.path ?? ''))?.path ?? repositories[0]?.path ?? '');
  const [head, setHead] = useState('');
  const initialRecommendation = recommendation && workspaceKey(recommendation.repositoryRoot) === workspaceKey(root) ? recommendation : null;
  const [title, setTitle] = useState(initialRecommendation?.title ?? '');
  const [goal, setGoal] = useState(initialRecommendation?.goal ?? '');
  const [scope, setScope] = useState(initialRecommendation?.scope.join('\n') ?? '');
  const [profileId, setProfileId] = useState(initialRecommendation?.profile ? '@recommendation' : '');
  const [profile, setProfile] = useState<TaskVerificationProfile | null>(() => initialRecommendation?.profile ? structuredClone(initialRecommendation.profile) : null);
  const [applied, setApplied] = useState<TaskRecommendation | null>(initialRecommendation);
  const activeTemplate = TASK_TEMPLATES.find(item => item.id === applied?.templateId) ?? template;
  const [editedBranch, setEditedBranch] = useState<string | null>(null);
  const branch = editedBranch ?? suggestTaskBranch(title || activeTemplate.name, instanceId);
  const [executablePath, setExecutablePath] = useState('');
  const [autoCommit, setAutoCommit] = useState(false);
  const [autoDraftPr, setAutoDraftPr] = useState(false);
  const [baseBranch, setBaseBranch] = useState('');
  const [runConsent, setRunConsent] = useState(false);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [created, setCreated] = useState<TaskRecord | null>(null);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const writeStarted = useRef(false);
  const readGeneration = useRef(0);
  const context = useRef({ root, repositories });
  context.current = { root, repositories };
  const library = useTaskProfileStore();
  const existing = useTaskStore(state => state.tasks);
  const demo = template.id === 'node-demo';
  const registered = repositories.some(repo => workspaceKey(repo.path) === workspaceKey(root));
  const desktop = isDesktopRuntime();
  const recommendations = useRepositoryRecommendations(root, repositories, !demo);
  const draft = materializeTemplate(activeTemplate.id, {
    title, goal, scope: scope.split(/\r?\n/).map(path => path.trim().replaceAll('\\', '/').replace(/\/+$/, '')).filter(Boolean),
    profile, autoCommit, autoDraftPr, prBaseBranch: baseBranch,
  }, instanceId);
  const request = { repositoryRoot: root, expectedHeadSha: head, tasks: [draft] };
  const validation = validateTaskPlan(request, existing);
  const valid = registered && validation.length === 0 && (demo || (!!title.trim() && !!goal.trim()));

  useEffect(() => {
    alive.current = true;
    if (dialog.current?.showModal) dialog.current.showModal(); else dialog.current?.setAttribute('open', '');
    if (isDesktopRuntime()) void refreshTaskProfiles();
    return () => { alive.current = false; ++readGeneration.current; };
  }, []);

  const changeRoot = (value: string) => {
    ++readGeneration.current;
    setRoot(value); setHead(''); setReading(false); setRunConsent(false); setAutoCommit(false); setAutoDraftPr(false); setBaseBranch(''); setError('');
    setScope(''); setProfile(null); setProfileId('');
    if (applied) {
      setTitle(current => current === applied.title ? '' : current);
      setGoal(current => current === applied.goal ? '' : current);
    }
    setApplied(null);
    setNotice('已切换仓库，请重新确认目标、修改范围和验证配置。');
  };
  const applyRecommendation = (value: TaskRecommendation) => {
    if (workspaceKey(value.repositoryRoot) !== workspaceKey(root) || !registered) return;
    setTitle(value.title); setGoal(value.goal); setScope(value.scope.join('\n'));
    setProfile(value.profile ? structuredClone(value.profile) : null); setProfileId(value.profile ? '@recommendation' : '');
    setApplied(structuredClone(value)); setNotice('已填入当前仓库推荐，请确认实际目标与范围。');
  };
  const readHead = async () => {
    const generation = ++readGeneration.current;
    const selectedRoot = root;
    setReading(true); setHead(''); setError('');
    try {
      const snapshot = await inspectRepository(selectedRoot);
      if (alive.current && readGeneration.current === generation && context.current.repositories.some(repo => workspaceKey(repo.path) === workspaceKey(selectedRoot))) setHead(snapshot.headSha);
    } catch (error) { if (alive.current && readGeneration.current === generation) setError(errorText(error)); }
    finally { if (alive.current && readGeneration.current === generation) setReading(false); }
  };
  const submit = async (run: boolean) => {
    // The ref closes the double-click window before React commits disabled controls.
    if (writeStarted.current || !desktop || !valid || reading) return;
    if (run && (!runConsent || !autoCommit || !branch.trim())) return;
    writeStarted.current = true;
    setSubmitted(true); setBusy(true); setError('');
    const snapshot = structuredClone(request);
    const selectedRoot = root;
    try {
      const result = await launchTemplate(snapshot, { run, branch, executablePath: executablePath.trim() || null }, {
        canContinue: () => alive.current && workspaceKey(context.current.root) === workspaceKey(selectedRoot) && context.current.repositories.some(repo => workspaceKey(repo.path) === workspaceKey(selectedRoot)),
        accept: value => runTaskAction(`plan:${selectedRoot}`, () => acceptTaskPlan(value)),
        prepare: value => runTaskAction(value.taskId, () => prepareTaskWorkspace(value)),
        start: (id, executable) => runTaskAction(id, () => startTask(id, executable)),
        onCreated: task => { if (alive.current) setCreated(task); },
        onPhase: value => { if (alive.current) setPhase(phaseLabels[value]); },
      });
      if (alive.current) {
        setCreated(result);
        setNotice(run ? '已提交原生队列。请在任务详情观察真实 Agent、验证和错误；这不是任务完成通知。' : '计划已保存；尚未创建工作区或启动 Agent。');
        selectTask(result.id, run ? '执行' : '概览');
      }
    } catch (error) {
      if (alive.current) setError(`${errorText(error)}\n操作可能已经部分保存。请核对任务列表或已创建任务，不要重复启动；这里不会自动重放。`);
    } finally { if (alive.current) setBusy(false); }
  };

  return <dialog ref={dialog} className="task-plan-dialog task-surface" aria-label="使用流程模板" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="task-row"><h2>{activeTemplate.name}</h2><button disabled={busy} onClick={onClose}>关闭模板</button></header>
    <p>模板 v{activeTemplate.version} · 方法指导与执行状态分离。没有预制成功结果，也没有冒充独立 Reviewer。</p>
    {!desktop && <p role="status">浏览器仅可预览模板。运行需要 Tauri 桌面版、本地 Git、Node.js（案例）和已认证的任务 Agent。</p>}
    {!registered && <p role="status">请先在工程仓库视图添加本地 Git 仓库；此入口不会自行注册或切换仓库。</p>}
    <fieldset disabled={busy || submitted}>
      <label>模板目标仓库<select value={registered ? root : ''} onChange={event => changeRoot(event.target.value)}><option value="" disabled>选择已添加的仓库</option>{repositories.map(repo => <option key={repo.id} value={repo.path}>{repo.name} — {repo.path}</option>)}</select></label>
      <div className="task-row"><button disabled={!desktop || !registered || reading} onClick={() => void readHead()}>{reading ? '正在读取基线…' : '读取模板基线'}</button><span>HEAD：<code>{head || '未读取'}</code></span></div>
      <p>仅读取已提交基线；不会复制原工作区的未提交修改。Native 接受计划时再次校验 HEAD。</p>
      {!demo && <>
        <label>当前仓库流程推荐<select value="" disabled={recommendations.loading || !recommendations.recommendations.length} onChange={event => {
          const value = recommendations.recommendations.find(item => item.id === event.target.value);
          if (value) applyRecommendation(value);
        }}><option value="">选择后填入目标、范围和验证命令</option>{recommendations.recommendations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {recommendations.loading && <p role="status">正在检测当前仓库流程…</p>}
        {recommendations.error && <p role="status">仓库推荐暂不可用：{recommendations.error}。可继续填写任务。</p>}
        {applied && <p className="task-template-notice">{applied.profileSource}{applied.limitation ? `。${applied.limitation}` : ''}</p>}
        <label>模板任务标题<input value={title} onChange={event => setTitle(event.target.value)}/></label>
        <label>任务需求与验收条件<textarea value={goal} onChange={event => setGoal(event.target.value)} placeholder={activeTemplate.id === 'bugfix' ? '复现步骤、实际行为、预期行为和边界条件' : '希望实现的功能、约束、非目标和验收条件'}/></label>
        <label>模板允许修改范围<textarea value={scope} onChange={event => setScope(event.target.value)} placeholder={'src/feature\ntests/feature'}/></label>
        <label>模板验证配置<select value={profileId} onChange={event => {
          const record = library.records.find(item => item.id === event.target.value);
          setProfileId(event.target.value); setProfile(event.target.value === '@recommendation' && applied?.profile ? structuredClone(applied.profile) : record ? structuredClone(record.profile) : null);
        }}><option value="">未选择（实施结果标记未验证）</option>{applied?.profile && <option value="@recommendation">已复制的仓库推荐配置</option>}{library.records.map(record => <option key={record.id} value={record.id}>{record.profile.name} · 修订 {record.revision}{recommendations.matchingProfiles.some(item => item.id === record.id) ? ' · 匹配当前仓库' : ' · 需核对适用范围'}</option>)}</select></label>
        <p>验证配置保存为此任务的快照。没有配置时可执行实施任务，结果会标记未验证。请在运行前确认检查命令和环境。</p>
        {library.error && <p role="status">Profile 库不可用：{library.error}</p>}
      </>}
      {demo && <section className="task-template-notice"><h3>实际要完成什么？</h3><p>由 Agent 编写稳定的任务排序函数、单元测试、命令行示例和设计记录。所有新文件限定在 <code>{draft.scope[0]}</code>，不需要安装第三方包。</p><p>验证包括 Agent 编写的单元测试、任务合同中的验收参考脚本（需人工核对实际文件）、命令行示例。原工作区不写入业务文件；Worktree 与原仓库共享 Git 元数据，不是安全沙箱。</p></section>}
      <details><summary>查看流程方法与触发条件</summary><ol>{activeTemplate.skills.map(id => {const skill = WORKFLOW_SKILLS.find(item => item.id === id)!; return <li key={id}><strong>{skill.name} · {skill.trigger}</strong><p>{skill.instruction}</p></li>;})}</ol></details>
      <details><summary>查看发送给 Agent 的完整任务合同</summary><pre className="task-code task-scroll">{draft.goal}</pre><p>修改范围：{draft.scope.join('、') || '尚未填写'}</p></details>
      <details><summary>查看冻结验证配置与实际命令</summary><pre className="task-code task-scroll" data-testid="template-verification-profile">{JSON.stringify(draft.profile, null, 2)}</pre></details>
      <label>模板工作区分支<input value={branch} onChange={event => setEditedBranch(event.target.value)}/></label>
      <label>任务 Agent 可执行路径（可选，不含参数）<input value={executablePath} onChange={event => setExecutablePath(event.target.value)}/></label>
      <p>空路径由原生任务执行器解析。已安装或保存过会话不代表当前认证有效；资格与错误由 Native 返回。</p>
      <TaskDeliveryOptions autoCommit={autoCommit} autoDraftPr={autoDraftPr} baseBranch={baseBranch} onChange={value => { setAutoCommit(value.autoCommit); setAutoDraftPr(value.autoDraftPr); setBaseBranch(value.baseBranch); }}/>
      <label className="task-checkbox"><input type="checkbox" checked={runConsent} onChange={event => setRunConsent(event.target.checked)}/>确认创建独立 Worktree 并启动真实 Agent，接受实际调用费用</label>
      <p>确认运行会依次保存计划、创建工作区、提交执行队列。最终审查与验收仍需手动操作。原生执行未取得能力或认证时会失败，不回退到模拟结果。</p>
    </fieldset>
    {error && <p role="alert" className="task-error">{error}</p>}
    {busy && <p role="status">{phase}…</p>}
    {notice && <p role="status">{notice}</p>}
    {!submitted && <p className="task-template-validation">{!head ? '先读取已选仓库的基线。' : !valid ? validation.join('；') || '填写实际标题和需求。' : '任务合同可提交；要直接运行，请确认上方两项授权。'}</p>}
    {created && <p>已创建任务：<code>{created.id}</code>。异常恢复使用任务详情，不重复创建计划。</p>}
    <footer className="task-row">
      <button disabled={submitted || reading || !desktop || !valid} onClick={() => void submit(false)}>只保存模板计划</button>
      <button disabled={submitted || reading || !desktop || !valid || !autoCommit || !runConsent || !branch.trim()} onClick={() => void submit(true)}>确认并运行模板</button>
      {created && <button disabled={busy || !registered} onClick={() => { selectTask(created.id, '概览'); onClose(); }}>打开已创建任务</button>}
    </footer>
  </dialog>;
}
