import { useEffect, useRef, useState } from 'react';
import { workspaceKey } from '@/lib/workspaceKey';
import { isDesktopRuntime } from '@/lib/backend';
import { refreshTasks, useTaskStore, selectTask, setTaskFilters } from '@/stores/tasks';
import { useAgentsHubStore } from '@/stores/agentsHub';
import { SettingsView } from '@/features/settings/SettingsView';
import { AgentSessionHub } from './AgentSessionHub';
import { AgentExecutionSettings } from './AgentExecutionSettings';
import type { RepositoryRecord, WorkspaceTab } from '@/types/workbench';
import { filterTasks } from '@/features/tasks/model';
import { sortTaskCollection, taskActivity, type TaskActivity } from '@/features/tasks/taskPresentation';
import { TaskList } from '@/features/tasks/TaskList';
import { TaskDetail } from '@/features/tasks/TaskDetail';
import { TaskEvidenceInventory } from '@/features/tasks/TaskEvidenceInventory';
import { TaskPlanWizard } from '@/features/tasks/TaskPlanWizard';
import { TaskQuickCreate } from '@/features/tasks/TaskQuickCreate';
import type { TaskDetailTab, TaskPlanRequest } from '@/types/tasks';
import { TemplateWorkbench } from '@/features/tasks/templates/TemplateWorkbench';
import './agentsHub.css';
import '@/features/tasks/tasks.css';
import '@/features/tasks/taskControlCenter.css';
export { useTaskObserver } from '@/features/tasks/useTaskObserver';

export interface AgentsHubProps {
  /** Retain legacy task/report/settings callers without separate Agent pages. */
  view: 'home' | 'tasks' | 'evidence' | 'settings';
  repositories: RepositoryRecord[];
  activeRepository: RepositoryRecord | null;
  onOpenWorkspace: (root: string, tab: WorkspaceTab, repositoryRoot?: string) => void;
  onOpenHub?: () => void;
  onOpenControlCenter?: () => void;
  visible?: boolean;
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
}

export function AgentsHub({ view, repositories, activeRepository, onOpenWorkspace, onOpenHub, onOpenControlCenter, visible = true, searchQuery, onSearchQueryChange }: AgentsHubProps) {
  const state = useTaskStore();
  const hub = useAgentsHubStore();
  const { query, repositoryRoot, attention } = state.filters;
  const [creating, setCreating] = useState<'advanced' | null>(null);
  const [prefill, setPrefill] = useState<TaskPlanRequest | null>(null);
  const [composerOpen, setComposerOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activity, setActivity] = useState<'all' | TaskActivity>('all');
  const detailPane = useRef<HTMLDivElement>(null);
  const home = view !== 'settings';
  const taskHome = home && hub.section === 'tasks';
  const sessionsVisible = visible && home && hub.section === 'sessions';
  const configurationVisible = visible && home && hub.section === 'configuration';
  const [sessionsMounted, setSessionsMounted] = useState(false);
  const [configurationMounted, setConfigurationMounted] = useState(false);
  useEffect(() => { if (sessionsVisible) setSessionsMounted(true); }, [sessionsVisible]);
  useEffect(() => { if (configurationVisible) setConfigurationMounted(true); }, [configurationVisible]);
  useEffect(() => { if (view === 'evidence') useAgentsHubStore.getState().showTasks(); }, [view]);

  const roots = new Set(repositories.map(repo => workspaceKey(repo.path)));
  const tasks = state.tasks.filter(task => roots.has(workspaceKey(task.repositoryRoot)));
  const selected = tasks.find(task => task.id === state.activeTaskId);
  const controlledQuery = searchQuery !== undefined && onSearchQueryChange !== undefined;
  const effectiveQuery = controlledQuery ? searchQuery : query;
  const matching = filterTasks(tasks, state.readiness, { query: effectiveQuery, repositoryRoot: roots.has(workspaceKey(repositoryRoot)) ? repositoryRoot : undefined, attention });
  const scoped = !controlledQuery && searchQuery?.trim() ? filterTasks(matching, state.readiness, { query: searchQuery }) : matching;
  const filtered = sortTaskCollection(scoped.filter(task => activity === 'all' || taskActivity(task) === activity));
  const selectedVisible = selected && filtered.some(task => task.id === selected.id);
  const repositoryFailures = Object.entries(state.repositoryErrors).filter(([root]) => roots.has(workspaceKey(root)));
  const filteredError = repositoryFailures.find(([root]) => workspaceKey(root) === workspaceKey(repositoryRoot))?.[1];
  const unavailable = !isDesktopRuntime() || !!state.error || !!filteredError;
  const sourceError = unavailable ? state.error || filteredError || '原生来源不可用' : null;
  const openHub = () => (onOpenHub ?? onOpenControlCenter)?.();
  const openTask = (id: string, tab?: TaskDetailTab) => {
    const target = tasks.find(task => task.id === id);
    const initialTab = state.activeTaskId === id ? undefined
      : !target?.attempts.length ? '概览' : taskActivity(target) === 'active' ? '执行' : '证据';
    selectTask(id, view === 'evidence' ? '证据' : tab ?? initialTab);
    setComposerOpen(false);
    if (window.innerWidth <= 900) requestAnimationFrame(() => detailPane.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  };
  const launched = () => { setCreating(null); setComposerOpen(false); hub.showTasks(); openHub(); };
  const openSession = () => {
    const target = hub.sessionTarget ?? (activeRepository && roots.has(workspaceKey(activeRepository.path))
      ? { repositoryRoot: activeRepository.path, workspaceRoot: activeRepository.path }
      : repositories[0] ? { repositoryRoot: repositories[0].path, workspaceRoot: repositories[0].path } : null);
    if (target) hub.showSession(target);
    else useAgentsHubStore.setState({ section: 'sessions', visibleSessionRoot: null });
    openHub();
  };
  const openConfiguration = () => { hub.showConfiguration(); openHub(); };
  const clearFilters = () => { setTaskFilters({query:'',repositoryRoot:'',attention:false}); onSearchQueryChange?.(''); setActivity('all'); };

  return <>
    {view === 'settings' && <SettingsView onOpenAgentSettings={openConfiguration}/>}
    <main className="task-center agents-hub" aria-label="Agents Hub" hidden={!home}>
      <header className="task-row task-center-heading">
        <div><h1>Agents Hub</h1><p>描述目标、跟进执行，在同一个任务中查看结果。</p></div>
        {hub.section === 'tasks' && <div className="task-row">
          <button type="button" disabled={state.loading} onClick={() => void refreshTasks()}>{state.loading ? '正在刷新…' : '刷新任务'}</button>
          <button type="button" className="task-primary-action" aria-expanded={composerOpen} onClick={() => setComposerOpen(value => !value)}>{composerOpen ? '收起新建任务' : '新建任务'}</button>
        </div>}
      </header>
      <div role="tablist" aria-label="Agents Hub 功能" className="task-tabs agents-hub-tabs">
        <button role="tab" id="agents-hub-tasks-tab" aria-controls="agents-hub-task-panel" aria-selected={hub.section === 'tasks'} onClick={hub.showTasks}>Agent 任务</button>
        <button role="tab" id="agents-hub-sessions-tab" aria-controls="agents-hub-session-panel" aria-selected={hub.section === 'sessions'} onClick={openSession}>工作区会话</button>
        <button role="tab" id="agents-hub-configuration-tab" aria-controls="agents-hub-configuration-panel" aria-selected={hub.section === 'configuration'} onClick={hub.showConfiguration}>执行配置</button>
      </div>
      <div id="agents-hub-task-panel" role="tabpanel" aria-labelledby="agents-hub-tasks-tab" hidden={!taskHome}>
        {state.error && <p role="alert" className="task-error">任务原生来源不可用：{state.error}</p>}
        {!state.error && repositoryFailures.length > 0 && <section role="status" className="task-error"><p>部分仓库的任务来源不可用；下方仅显示可用仓库的任务。恢复仓库后可刷新任务。</p><ul>{repositoryFailures.map(([root, reason]) => <li key={root}>{root}：{reason}</li>)}</ul></section>}
        {!isDesktopRuntime() && !state.error && <p className="task-muted">浏览器预览：连接桌面应用后可执行本地任务。</p>}
        {state.observerError && <p role="status" className="task-error">{state.observerError}</p>}
        {!repositories.length && <section className="task-surface"><h2>先添加一个仓库</h2><p>在工程仓库中选择本地 Git 仓库，然后在这里描述任务。</p></section>}
        <div hidden={!composerOpen}><TaskQuickCreate inline active={visible && taskHome && composerOpen && creating === null} repositories={repositories} activeRepository={activeRepository} onClose={() => setComposerOpen(false)} onAdvanced={draft => { setPrefill(draft); setCreating('advanced'); }} onLaunched={launched}/></div>
        <div className="task-control-layout">
          <section className="task-surface task-collection" aria-label="任务列表">
            <div className="task-row task-collection-heading"><h2>任务列表</h2><span>{filtered.length} / {tasks.length}</span></div>
            <div className="task-activity-filters" role="group" aria-label="执行状态筛选">{([['all','全部'],['active','进行中'],['finished','已结束'],['idle','未开始']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={activity === value} onClick={() => setActivity(value)}>{label}</button>)}</div>
            <div className="task-filters">
              <label>搜索任务<input placeholder="标题、目标或任务 ID" value={effectiveQuery} onChange={event => { setTaskFilters({query:event.target.value}); onSearchQueryChange?.(event.target.value); }}/></label>
              <label>筛选仓库<select value={roots.has(workspaceKey(repositoryRoot)) ? repositoryRoot : ''} onChange={event => setTaskFilters({repositoryRoot:event.target.value})}><option value="">全部仓库</option>{repositories.map(repo => <option key={repo.id} value={repo.path}>{repo.name}</option>)}</select></label>
              <label className="task-checkbox"><input type="checkbox" checked={attention} onChange={event => setTaskFilters({attention:event.target.checked})}/>仅需关注</label>
            </div>
            <TaskList tasks={filtered} readiness={state.readiness} repositories={repositories} selectedId={selected?.id ?? null} onOpenTask={openTask} launchErrors={state.launchErrors}/>
            {!filtered.length && !state.loading && !unavailable && !repositoryFailures.length && <p>{tasks.length ? '没有匹配的任务。' : '尚无任务。在上方输入目标并开始执行。'}</p>}
          </section>
          <div className="task-detail-pane" ref={detailPane}>
            {selected && !selectedVisible && <div className="task-selection-notice" role="status">当前查看的任务不在筛选结果中。<button type="button" onClick={clearFilters}>清除筛选</button></div>}
            {selected ? <TaskDetail key={selected.id} task={selected} onOpenWorkspace={onOpenWorkspace}/>
              : <section className="task-surface task-detail-placeholder"><h2>选择任务，查看执行与结果</h2><p>列表保留每个任务的独立状态；点击任务可查看日志、失败原因与完成报告。</p></section>}
          </div>
        </div>
        <details className="task-secondary task-surface"><summary>流程模板与高级任务</summary><TemplateWorkbench repositories={repositories} activeRepository={activeRepository}/></details>
        <details className="task-secondary task-surface" onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>历史验证 Run</summary>{historyOpen && <TaskEvidenceInventory tasks={tasks} readiness={state.readiness} loading={state.loading} error={sourceError} onOpenTask={(id,tab) => { hub.showTasks(); openTask(id,tab); }}/>}</details>
      </div>
      {(sessionsMounted || sessionsVisible) && <div id="agents-hub-session-panel" role="tabpanel" aria-labelledby="agents-hub-sessions-tab" hidden={!sessionsVisible}>
        <AgentSessionHub repositories={repositories} activeRepository={activeRepository} visible={sessionsVisible} onOpenWorkspace={onOpenWorkspace} onOpenTask={id => { hub.showTasks(); openTask(id,'执行'); openHub(); }}/>
      </div>}
      <div id="agents-hub-configuration-panel" role="tabpanel" aria-labelledby="agents-hub-configuration-tab" hidden={!configurationVisible}>
        {(configurationMounted || configurationVisible) && <AgentExecutionSettings onOpenSession={openSession} onOpenRun={activeRepository && roots.has(workspaceKey(activeRepository.path)) ? () => onOpenWorkspace(activeRepository.path,'run',activeRepository.path) : undefined}/>}
      </div>
      {home && visible && creating === 'advanced' && <TaskPlanWizard repositories={repositories} activeRepository={activeRepository} prefill={prefill} onClose={() => setCreating(null)}/>}
    </main>
  </>;
}
