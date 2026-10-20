import { TaskEvidenceInventory } from '@/features/tasks/TaskEvidenceInventory';
import { ProfileSettings } from '@/features/task-profiles/ProfileSettings';
import { workspaceKey } from '@/lib/workspaceKey';
import { useEffect, useRef, useState } from 'react';
import { isDesktopRuntime } from '@/lib/backend';
import { refreshTasks, useTaskStore, selectTask, setTaskFilters } from '@/stores/tasks';
import { useAgentsHubStore } from '@/stores/agentsHub';
import { useAgentPreferences } from '@/stores/agentPreferences';
import { AgentSessionHub } from './AgentSessionHub';
import './agentsHub.css';
import type { RepositoryRecord, WorkspaceTab } from '@/types/workbench';
import { filterTasks } from '@/features/tasks/model';
import { TaskDashboard } from '@/features/tasks/TaskDashboard';
import { TaskList } from '@/features/tasks/TaskList';
import { TaskDetail } from '@/features/tasks/TaskDetail';
import { TaskPlanWizard } from '@/features/tasks/TaskPlanWizard';
import { TaskQuickCreate } from '@/features/tasks/TaskQuickCreate';
import type { TaskDetailTab, TaskPlanRequest } from '@/types/tasks';
import { TemplateWorkbench } from '@/features/tasks/templates/TemplateWorkbench';
import { TaskWorkflowGuide } from '@/features/tasks/templates/TaskWorkflowGuide';
import '@/features/tasks/tasks.css';
import '@/features/tasks/taskControlCenter.css';
export { useTaskObserver } from '@/features/tasks/useTaskObserver';

export interface AgentsHubProps {
  view: 'home' | 'tasks' | 'evidence' | 'settings';
  repositories: RepositoryRecord[];
  activeRepository: RepositoryRecord | null;
  onOpenWorkspace: (root: string, tab: WorkspaceTab, repositoryRoot?: string) => void;
  onOpenHub?: () => void;
  /** Compatibility callback for existing task-surface callers. */
  onOpenControlCenter?: () => void;
  visible?: boolean;
  searchQuery?: string;
}
// Retain the old in-memory view alias and detail keys for existing callers.
const titles = {home:'Agents Hub', tasks:'Agents Hub', evidence:'报告', settings:'设置'};
export function AgentsHub({view, repositories, activeRepository, onOpenWorkspace, onOpenHub, onOpenControlCenter, visible = true, searchQuery}: AgentsHubProps) {
  const state = useTaskStore();
  const {query,repositoryRoot,attention}=state.filters;
  const [creating,setCreating] = useState<'quick' | 'advanced' | null>(null);
  const [prefill,setPrefill] = useState<TaskPlanRequest | null>(null);
  const detailPane = useRef<HTMLDivElement>(null);
  const home = view === 'home' || view === 'tasks';
  const hub = useAgentsHubStore();
  const preferences = useAgentPreferences();
  const taskHome = home && hub.section === 'tasks';
  const sessionsVisible = visible && home && hub.section === 'sessions';
  const [sessionsMounted, setSessionsMounted] = useState(false);
  useEffect(() => { if (sessionsVisible) setSessionsMounted(true); }, [sessionsVisible]);
  const roots = new Set(repositories.map(repo => workspaceKey(repo.path)));
  const tasks = state.tasks.filter(task => roots.has(workspaceKey(task.repositoryRoot)));
  const selected = tasks.find(task => task.id === state.activeTaskId);
  const filtered = filterTasks(tasks,state.readiness,{query:searchQuery ?? query,repositoryRoot:roots.has(workspaceKey(repositoryRoot)) ? repositoryRoot : undefined,attention});
  const profiles = [...new Map(tasks.filter(task => task.profile).map(task => [task.profile!.id,task.profile!])).values()];
  const repositoryFailures = Object.entries(state.repositoryErrors).filter(([root]) => roots.has(workspaceKey(root)));
  const filteredError = repositoryFailures.find(([root]) => workspaceKey(root) === workspaceKey(repositoryRoot))?.[1];
  const unavailable = !isDesktopRuntime() || !!state.error || !!filteredError;
  const sourceError = unavailable ? state.error || filteredError || '原生来源不可用' : null;
  const openTask = (id: string, tab?: TaskDetailTab) => {
    selectTask(id, view === 'evidence' ? '证据' : tab);
  };
  const openAdvanced = (draft: TaskPlanRequest) => { setPrefill(draft); setCreating('advanced'); };
  const launched = () => {
    // The launch store has already retained the task and selected its correct recovery/execution tab.
    setCreating(null);
    hub.showTasks();
    (onOpenHub ?? onOpenControlCenter)?.();
    requestAnimationFrame(() => detailPane.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  };
  const openSession = () => {
    const target = hub.sessionTarget ?? (activeRepository && roots.has(workspaceKey(activeRepository.path))
        ? {repositoryRoot: activeRepository.path, workspaceRoot: activeRepository.path}
        : repositories[0] ? {repositoryRoot: repositories[0].path, workspaceRoot: repositories[0].path} : null);
    if (target) hub.showSession(target);
    else useAgentsHubStore.setState({section: 'sessions', visibleSessionRoot: null});
    (onOpenHub ?? onOpenControlCenter)?.();
  };
  const openSessionTask = (id: string) => {
    hub.showTasks(); selectTask(id, '执行'); (onOpenHub ?? onOpenControlCenter)?.();
  };
  return <main className="task-center agents-hub" aria-label="Agents Hub">
    <header className="task-row task-center-heading"><div><h1>{titles[view]}</h1><p>{home ? '统一管理 Agent 任务、工作区会话和执行结果。' : view === 'evidence' ? '查看完成总结、发现的问题和验证结果。' : '管理执行与验证配置。'}</p></div><div className="task-row">{!(home && hub.section === 'sessions') && <button disabled={state.loading} onClick={() => void refreshTasks()}>{state.loading ? '正在刷新…' : '刷新任务'}</button>}{!home && <button disabled={!repositories.length} onClick={() => {setPrefill(null);setCreating('quick');}}>新建任务</button>}</div></header>
    {home && <div role="tablist" aria-label="Agents Hub 功能" className="task-tabs agents-hub-tabs">
      <button role="tab" id="agents-hub-tasks-tab" aria-controls="agents-hub-task-panel" aria-selected={hub.section === 'tasks'} onClick={hub.showTasks}>Agent 任务</button>
      <button role="tab" id="agents-hub-sessions-tab" aria-controls="agents-hub-session-panel" aria-selected={hub.section === 'sessions'} onClick={openSession}>工作区会话</button>
    </div>}
    {state.error && <p role="alert" className="task-error">任务原生来源不可用：{state.error}</p>}
    {!state.error && repositoryFailures.length > 0 && <section role="status" className="task-error"><p>部分仓库的任务来源不可用；下方仅显示可用仓库的任务。恢复仓库后可刷新任务。</p><ul>{repositoryFailures.map(([root, reason]) => <li key={root}>{root}：{reason}</li>)}</ul></section>}
    {!isDesktopRuntime() && !state.error && <p>当前为浏览器预览；任务原生来源不可用。没有模拟执行或验证结果。</p>}
    {state.observerError && <p role="status" className="task-error">{state.observerError}</p>}
    {!repositories.length && <section className="task-surface"><h2>先添加一个仓库</h2><p>在工程仓库中选择本地 Git 仓库，然后在 Agents Hub 描述要完成的任务。</p></section>}
    <div id="agents-hub-task-panel" role={home ? 'tabpanel' : undefined} aria-labelledby={home ? 'agents-hub-tasks-tab' : undefined} hidden={home && hub.section !== 'tasks'}>
    <div hidden={!taskHome}><TaskQuickCreate inline active={visible && taskHome && creating === null} repositories={repositories} activeRepository={activeRepository} onClose={() => undefined} onAdvanced={openAdvanced} onLaunched={launched}/></div>
    {view === 'settings' ? <section className="task-surface">
      <h2>能力与配置</h2><p>Provider 与会话在 Agents Hub 中管理；Run 配置继续使用工程仓库工具。</p>
      <h3>Provider 资格</h3><p>任务执行资格、身份认证和只读规划资格均由 Native 决定。当前 UI 没有已资格验证的认证/只读规划记录。</p>
      <p>在工作区会话中查看保存的线程、实际 CLI、角色与技能、恢复记录。保存的线程不证明 Provider 当前可用或已认证。</p>
      <label>默认 Codex 可执行程序<input value={preferences.codexExecutablePath} onChange={event => preferences.setCodexExecutablePath(event.target.value)} placeholder="留空时自动检测本机 Codex"/></label>
      <p>供新任务和新连接共用；已接受的任务请求保持原来的执行程序。每个任务也可以单独指定路径。</p>
      <ProfileSettings/>
      <h3>任务中的冻结 Profile</h3>{profiles.length ? <ul>{profiles.map(profile => <li key={profile.id}>{profile.name} · {profile.gates.length} gates</li>)}</ul> : <p>尚无任务 Profile；可在新计划的 JSON 编辑器中配置。</p>}
      <p>outputPaths 用于生成输出；sourcePaths 可显式包含忽略的源码；toolchainPrograms 声明额外可执行程序身份，不包含参数。CMake 需声明实际编译器。路径和资格由原生验证。</p>
      {activeRepository && roots.has(workspaceKey(activeRepository.path)) && <div className="task-row"><button onClick={openSession}>管理 Provider 与会话</button><button onClick={() => onOpenWorkspace(activeRepository.path,'run',activeRepository.path)}>打开 Run 配置</button></div>}
      <h3>执行与恢复</h3><p>Agent 任务默认并发 2，队列最多 32 个叶任务。提交任务时会创建工作区并启动执行。重启后结果不明的任务标记为中断，可在详情中核对并恢复。</p>
    </section> : <>
      <div className="task-control-layout">
      <section className="task-surface task-collection" aria-label={view === 'evidence' ? '任务报告列表' : '任务列表'}>
        <h2>{view === 'evidence' ? '任务结果' : '任务列表'}</h2>
        <div className="task-filters"><label>搜索任务<input placeholder="标题、目标或范围" value={searchQuery ?? query} readOnly={searchQuery !== undefined} onChange={event => setTaskFilters({query:event.target.value})}/></label>
          <label>筛选仓库<select value={roots.has(workspaceKey(repositoryRoot)) ? repositoryRoot : ''} onChange={event => setTaskFilters({repositoryRoot:event.target.value})}><option value="">全部仓库</option>{repositories.map(repo => <option key={repo.id} value={repo.path}>{repo.name}</option>)}</select></label>
          <label className="task-checkbox"><input type="checkbox" checked={attention} onChange={event => setTaskFilters({attention:event.target.checked})}/>仅需关注</label>
        </div>
        <TaskList tasks={filtered} readiness={state.readiness} repositories={repositories} selectedId={selected?.id??null} onOpenTask={openTask}/>
        {!filtered.length && !state.loading && !unavailable && !repositoryFailures.length && <p>{tasks.length ? '没有匹配筛选条件的任务。' : '尚无任务。在上方输入目标并开始执行。'}</p>}
      </section>
      <div className="task-detail-pane" ref={detailPane}>
        {selected ? <><TaskDetail key={selected.id} task={selected} onOpenWorkspace={onOpenWorkspace}/><details className="task-secondary task-surface"><summary>交付流程与人工验收</summary><TaskWorkflowGuide task={selected} readiness={state.readiness[selected.id]} onNavigate={tab => selectTask(selected.id, tab)}/></details></>
          : <section className="task-surface task-detail-placeholder"><h2>{view === 'evidence' ? '任务报告' : '执行与结果'}</h2><p>{tasks.length ? '选择左侧任务，查看执行日志、完成总结和发现的问题。' : '任务启动后，执行面板会自动打开；完成后在报告中查看结果。'}</p></section>}
      </div>
      </div>
      {home && <>
        <details className="task-secondary task-surface"><summary>状态看板</summary><TaskDashboard tasks={filtered} readiness={state.readiness} loading={state.loading} error={sourceError} onOpenTask={selectTask}/></details>
        <details className="task-secondary task-surface"><summary>流程模板与高级任务</summary><TemplateWorkbench repositories={repositories} activeRepository={activeRepository}/></details>
      </>}
      {view === 'evidence' && <details className="task-secondary task-surface"><summary>历史验证 Run</summary><TaskEvidenceInventory tasks={filtered} readiness={state.readiness} loading={state.loading} error={sourceError} onOpenTask={selectTask}/></details>}
    </>}
    </div>
    {(sessionsMounted || sessionsVisible) && <div id="agents-hub-session-panel" role="tabpanel" aria-labelledby="agents-hub-sessions-tab" hidden={!sessionsVisible}>
      <AgentSessionHub repositories={repositories} activeRepository={activeRepository} visible={sessionsVisible} onOpenWorkspace={onOpenWorkspace} onOpenTask={openSessionTask}/>
    </div>}
    {creating === 'quick' && <TaskQuickCreate active={visible} repositories={repositories} activeRepository={activeRepository} onClose={() => setCreating(null)} onAdvanced={openAdvanced} onLaunched={launched}/>}
    {creating === 'advanced' && <TaskPlanWizard repositories={repositories} activeRepository={activeRepository} prefill={prefill} onClose={() => setCreating(null)}/>}
  </main>;
}
