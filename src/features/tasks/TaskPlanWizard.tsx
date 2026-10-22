import { refreshTaskProfiles, useTaskProfileStore } from '@/stores/taskProfiles';
import { workspaceKey } from '@/lib/workspaceKey';
import { useEffect, useRef, useState } from 'react';
import { acceptTaskPlan } from '@/lib/tasks';
import { inspectRepository, isDesktopRuntime } from '@/lib/backend';
import { runTaskAction, useTaskStore, selectTask } from '@/stores/tasks';
import type { RepositoryRecord } from '@/types/workbench';
import type { TaskDraft, TaskKind, TaskPlanRequest, TaskRecord } from '@/types/tasks';
import { parseTaskProfile, validateTaskPlan } from './model';
import { RepositoryContextSelector } from '@/features/workspace/RepositoryContextSelector';
import { useRepositoryContextStore } from '@/stores/repositoryContext';
import { copyContextRepositories } from '@/lib/workspaceContext';
import type { ContextRepository } from '@/types/workspaceContext';
import { TaskDeliveryOptions } from './TaskDeliveryOptions';
import { RepositoryRecommendations } from './templates/RepositoryRecommendations';
import { useRepositoryRecommendations } from './templates/useRepositoryRecommendations';
import type { TaskRecommendation } from './templates/repositoryRecommendations';

const lines = (text: string) => text.split(/\r?\n/).map(value => value.trim().replaceAll('\\','/').replace(/\/+$/, '')).filter(Boolean);
const profileHelp = 'Profile JSON 支持 outputPaths（相对生成输出，不可掩盖已跟踪源码）、sourcePaths（显式包含忽略的源码；空表示全部已跟踪及未忽略的新文件）、toolchainPrograms（命令名或绝对可执行路径，不含参数）。CMake 须先通过探索性 Run 配置 Ninja；正式验证支持默认目标与直接原生 C/C++ 编译器，使用 build/test Profile。未知 launcher、自定义目标或间接调用不能取得资格。';
interface NodeEditor {localId: number; key: string; title: string; goal: string; scopeText: string; kind: TaskKind; dependenciesText: string; profileJson: string; autoCommit: boolean; autoDraftPr: boolean; baseBranch: string; contextRepositories: ContextRepository[]; recommendation?: TaskRecommendation}
export function TaskPlanWizard({repositories, activeRepository, onClose, prefill = null}: {repositories: RepositoryRecord[]; activeRepository: RepositoryRecord | null; onClose: () => void; prefill?: TaskPlanRequest | null}) {
  const [root, setRoot] = useState(prefill?.repositoryRoot ?? activeRepository?.path ?? repositories[0]?.path ?? '');
  const [head, setHead] = useState(prefill?.expectedHeadSha ?? '');
  const [step, setStep] = useState(0);
  const [nodes, setNodes] = useState<NodeEditor[]>(() => prefill?.tasks.length
    ? prefill.tasks.map((node, index) => ({localId:index + 1,key:node.key,title:node.title,goal:node.goal,scopeText:node.scope.join('\n'),kind:node.kind,dependenciesText:node.dependencyKeys.join(', '),profileJson:JSON.stringify(node.profile,null,2),autoCommit:node.autoCommit,autoDraftPr:node.autoDraftPr??false,baseBranch:node.prBaseBranch??'',contextRepositories:copyContextRepositories(node.contextRepositories)}))
    : [{localId:1,key:'impl-1',title:'',goal:'',scopeText:'',kind:'implementation',dependenciesText:'',profileJson:'null',autoCommit:false,autoDraftPr:false,baseBranch:'',contextRepositories:copyContextRepositories(useRepositoryContextStore.getState().contexts[workspaceKey(root)])}]);
  const nextId = useRef((prefill?.tasks.length ?? 1) + 1);
  const liveContext=useRef({root,repositories});liveContext.current={root,repositories};
  const [error, setError] = useState(''); const [reading, setReading] = useState(false);
  const readGeneration = useRef(0); const alive = useRef(true); const dialog = useRef<HTMLDialogElement>(null);
  const library = useTaskProfileStore();
  const recommendations = useRepositoryRecommendations(root, repositories);
  useEffect(() => {if (isDesktopRuntime()) void refreshTaskProfiles();}, []);
  const tasks = useTaskStore(s => s.tasks); const pending = useTaskStore(s => s.pending[`plan:${root}`]);
  useEffect(() => {alive.current = true; if (dialog.current?.showModal) dialog.current.showModal(); else dialog.current?.setAttribute('open',''); return () => {alive.current = false; ++readGeneration.current;};}, []);
  useEffect(() => {++readGeneration.current; setReading(false); setHead(root === prefill?.repositoryRoot ? prefill.expectedHeadSha : '');}, [root]);
  const profiles = [...new Map(tasks.filter(task => workspaceKey(task.repositoryRoot) === workspaceKey(root) && task.profile).map(task => [task.profile!.id, task.profile!])).values()];
  const update = (index: number, patch: Partial<NodeEditor>) => setNodes(current => current.map((node, i) => i === index ? {...node, ...patch} : node));
  const applyRecommendation = (value: TaskRecommendation) => {
    if (workspaceKey(value.repositoryRoot) !== workspaceKey(root) || !repositories.some(repository => workspaceKey(repository.path) === workspaceKey(root))) return;
    update(0, { title: value.title, goal: value.goal, scopeText: value.scope.join('\n'), profileJson: JSON.stringify(value.profile, null, 2), recommendation: structuredClone(value) });
  };
  const readHead = async () => {
    const generation = ++readGeneration.current; setReading(true); setError('');
    try { const snapshot = await inspectRepository(root); if (alive.current && readGeneration.current === generation) setHead(snapshot.headSha); }
    catch (error) {if (alive.current && readGeneration.current === generation) setError(String(error));}
    finally {if (alive.current && readGeneration.current === generation) setReading(false);}
  };
  const plan = (): TaskPlanRequest => ({repositoryRoot:root,expectedHeadSha:head.trim(),tasks:nodes.map(node => ({
    key:node.key.trim(),title:node.title.trim(),goal:node.goal.trim(),scope:lines(node.scopeText),kind:node.kind,
    dependencyKeys:node.dependenciesText.split(/[\s,]+/).filter(Boolean),profile:parseTaskProfile(node.profileJson),autoCommit:node.autoCommit,
    ...(node.autoDraftPr && node.kind === 'implementation' ? { autoDraftPr: true, prBaseBranch: node.baseBranch.trim() || null } : {}),
    ...(node.contextRepositories.length ? { contextRepositories: copyContextRepositories(node.contextRepositories) } : {}),
  } satisfies TaskDraft))});
  const next = () => {
    try {
      if (step === 0 && (!root || !head.trim() || !nodes[0].title.trim() || !nodes[0].goal.trim())) throw new Error('请选择仓库并填写标题、目标和基线 HEAD。');
      if (!repositories.some(repo => workspaceKey(repo.path) === workspaceKey(root))) throw new Error('所选仓库已移除。');
      if (step >= 1) {const errors = validateTaskPlan(plan(), tasks); if (errors.length) throw new Error(errors.join('\n'));}
      setError(''); setStep(current => Math.min(3, current + 1));
    } catch (error) {setError(error instanceof Error ? error.message : String(error));}
  };
  const add = (kind: TaskKind) => {
    const id = nextId.current++;
    setNodes(current => [...current,{localId:id,key:`${kind === 'integration' ? 'integration' : 'impl'}-${id}`,title:'',goal:'',kind,scopeText:current[0].scopeText,profileJson:current[0].profileJson,autoCommit:false,autoDraftPr:false,baseBranch:'',dependenciesText:'',contextRepositories:copyContextRepositories(current[0].contextRepositories)}]);
  };
  const submit = async () => {
    try {
      const request = plan(); const errors = validateTaskPlan(request, tasks);
      if (!repositories.some(repo => workspaceKey(repo.path) === workspaceKey(root))) errors.push('所选仓库已移除。');
      if (errors.length) throw new Error(errors.join('\n'));
      const records: TaskRecord[] = await runTaskAction(`plan:${root}`, () => acceptTaskPlan(request));
      if (alive.current && workspaceKey(liveContext.current.root) === workspaceKey(request.repositoryRoot) && liveContext.current.repositories.some(repo => workspaceKey(repo.path) === workspaceKey(request.repositoryRoot))) {if (records[0]) selectTask(records[0].id,'概览'); onClose();}
    } catch (error) {if (alive.current) setError(error instanceof Error ? error.message : String(error));}
  };
  return <dialog ref={dialog} className="task-plan-dialog task-surface" aria-label="创建任务计划" onCancel={event => {event.preventDefault(); if (!pending) onClose();}}>
    <header className="task-row"><h2>创建任务计划</h2><button onClick={onClose} disabled={pending}>关闭</button></header>
    <ol className="task-steps" aria-label="创建步骤">{['目标与仓库','范围与验证','编辑任务图','确认计划'].map((label,index) => <li key={label} aria-current={step === index ? 'step' : undefined}>{index + 1}. {label}</li>)}</ol>
    <p>先从当前仓库的实际流程选择目标，再调整范围、验证和任务依赖。推荐内容可编辑；接受计划不会自动开始执行。</p>
    {error && <p className="task-error" role="alert">{error}</p>}
    <fieldset disabled={pending}>
      {step === 0 && <>
        <label>仓库<select value={root} onChange={event => {
          const nextRoot = event.target.value;
          ++readGeneration.current; setReading(false); setHead('');
          setRoot(nextRoot);
          setNodes(current => current.map(node => ({ ...node,
            title: node.title === node.recommendation?.title ? '' : node.title,
            goal: node.goal === node.recommendation?.goal ? '' : node.goal,
            scopeText: '', profileJson: 'null', autoCommit: false, autoDraftPr: false, baseBranch: '', recommendation: undefined,
            contextRepositories: copyContextRepositories(useRepositoryContextStore.getState().contexts[workspaceKey(nextRoot)]) })));
        }}>{repositories.map(repo => <option key={repo.id} value={repo.path}>{repo.name} — {repo.path}</option>)}</select></label>
        <RepositoryRecommendations state={recommendations} onSelect={applyRecommendation} disabled={pending}/>
        <RepositoryContextSelector repositoryRoot={root} repositories={repositories} value={nodes[0].contextRepositories}
          disabled={pending} onChange={references => update(0, { contextRepositories: copyContextRepositories(references) })}/>
        <label>计划标题<input value={nodes[0].title} onChange={event => update(0,{title:event.target.value})}/></label>
        <label>目标<textarea value={nodes[0].goal} onChange={event => update(0,{goal:event.target.value})}/></label>
        <label>基线 HEAD<input value={head} onChange={event => {++readGeneration.current;setReading(false);setHead(event.target.value);}}/></label>
        <button disabled={!root || reading || !isDesktopRuntime()} onClick={() => void readHead()}>{reading ? '读取中…' : '读取当前 HEAD'}</button>
        <p>Native 在接受时再次验证 HEAD；切换仓库后必须重新确认基线。</p>
      </>}
      {step === 1 && <>
        <label>允许修改的范围（每行一个）<textarea value={nodes[0].scopeText} onChange={event => update(0,{scopeText:event.target.value})}/></label>
        <p>范围使用相对字面路径；文件夹无需尾部斜杠，不支持通配符。</p>
        <label>已保存 Profile<select value="" onChange={event => {
          const record = library.records.find(record => `library:${record.id}` === event.target.value);
          if (record) update(0,{profileJson:JSON.stringify(record.profile,null,2)});
        }}><option value="">从 Profile 库复制配置</option>{library.records.map(record => <option key={record.id} value={`library:${record.id}`}>{record.profile.name} · 库修订 {record.revision}</option>)}</select></label>
        {nodes[0].recommendation && <p>{nodes[0].recommendation.profileSource}{nodes[0].recommendation.limitation ? `。${nodes[0].recommendation.limitation}` : ''}</p>}
        {library.error && <p role="status">Profile 库不可用：{library.error}。可使用下方手动 JSON。</p>}
        <label>当前任务 Profile<select defaultValue="" onChange={event => {const profile = profiles.find(profile => profile.id === event.target.value); if (profile) update(0,{profileJson:JSON.stringify(profile,null,2)});}}>
          <option value="">选择已有 Profile 或编辑 JSON</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select></label>
        <label>Profile JSON<textarea className="task-code" rows={9} value={nodes[0].profileJson} onChange={event => update(0,{profileJson:event.target.value})}/></label>
        <p>{profileHelp} null 表示未配置，不能获得验证资格。</p>
        <p>Gate 程序仅支持 cargo、cmake、ctest、ninja、npm、node 及对应的 .exe 名称；不接受绝对路径。绝对可执行路径仅可用于 toolchainPrograms 身份元数据，不含执行参数。</p>
        <TaskDeliveryOptions autoCommit={nodes[0].autoCommit} autoDraftPr={nodes[0].autoDraftPr} baseBranch={nodes[0].baseBranch} canDeliver={nodes[0].kind === 'implementation'} onChange={value => update(0, value)}/>
      </>}
      {step === 2 && <>
        <p>依赖可引用本计划的键或同仓库现有任务 ID；Native 最终校验依赖图。集成节点应依赖已封存的实现节点。</p>
        {nodes.map((node,index) => <section className="task-node" key={node.localId}>
          <h3>节点 {index + 1} · {node.kind === 'integration' ? '集成' : '实现'}</h3>
          <label>节点 {index + 1} 键<input value={node.key} onChange={event => update(index,{key:event.target.value})}/></label>
          <label>节点 {index + 1} 标题<input value={node.title} onChange={event => update(index,{title:event.target.value})}/></label>
          <label>节点 {index + 1} 目标<textarea value={node.goal} onChange={event => update(index,{goal:event.target.value})}/></label>
          <label>节点 {index + 1} 依赖键<input value={node.dependenciesText} onChange={event => update(index,{dependenciesText:event.target.value})}/></label>
          <label>节点 {index + 1} 范围<textarea value={node.scopeText} onChange={event => update(index,{scopeText:event.target.value})}/></label>
          <label>节点 {index + 1} Profile JSON<textarea className="task-code" value={node.profileJson} onChange={event => update(index,{profileJson:event.target.value})}/></label>
          <RepositoryContextSelector repositoryRoot={root} repositories={repositories} value={node.contextRepositories}
            disabled={pending} onChange={references => update(index, { contextRepositories: copyContextRepositories(references) })}/>
          <TaskDeliveryOptions autoCommit={node.autoCommit} autoDraftPr={node.autoDraftPr} baseBranch={node.baseBranch} canDeliver={node.kind === 'implementation'} onChange={value => update(index, value)}/>
          {index > 0 && <button onClick={() => setNodes(current => current.filter(item => item.localId !== node.localId))}>移除节点 {index + 1}</button>}
        </section>)}
        <div className="task-row"><button disabled={nodes.length >= 32} onClick={() => add('implementation')}>添加实现节点</button><button disabled={nodes.length >= 32} onClick={() => add('integration')}>添加集成节点</button></div>
        <p>同仓库现有任务：{tasks.filter(task => workspaceKey(task.repositoryRoot) === workspaceKey(root)).map(task => `${task.id} (${task.title})`).join('、') || '无'}</p>
      </>}
      {step === 3 && <>
        <p>接受计划不会创建工作区或开始执行。每个任务都需要后续显式操作。</p>
        <pre className="task-code task-scroll">{JSON.stringify(plan(),null,2)}</pre>
      </>}
    </fieldset>
    <footer className="task-row"><button disabled={step === 0 || pending} onClick={() => {setError('');setStep(current => current - 1);}}>上一步</button>
      {step < 3 ? <button disabled={pending} onClick={next}>下一步</button> : <button disabled={pending || !isDesktopRuntime()} onClick={() => void submit()}>{pending ? '正在接受…' : '接受手动计划'}</button>}
    </footer>
  </dialog>;
}
