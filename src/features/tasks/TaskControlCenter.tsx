import { TaskEvidenceInventory } from './TaskEvidenceInventory';
import { ProfileSettings } from '@/features/task-profiles/ProfileSettings';
import { workspaceKey } from '@/lib/workspaceKey';
import { useState } from 'react';
import { isDesktopRuntime } from '@/lib/backend';
import { refreshTasks, useTaskStore, selectTask, setTaskFilters } from '@/stores/tasks';
import { useAgentSessionStore } from '@/stores/agentSessions';
import type { RepositoryRecord, WorkspaceTab } from '@/types/workbench';
import { filterTasks } from './model';
import { TaskDashboard } from './TaskDashboard';
import { TaskList } from './TaskList';
import { TaskDetail } from './TaskDetail';
import { TaskPlanWizard } from './TaskPlanWizard';
import { TaskQuickCreate } from './TaskQuickCreate';
import type { TaskPlanRequest } from '@/types/tasks';
import { TemplateWorkbench } from './templates/TemplateWorkbench';
import { TaskWorkflowGuide } from './templates/TaskWorkflowGuide';
import './tasks.css';
export { useTaskObserver } from './useTaskObserver';

export interface TaskControlCenterProps {
  view: 'home' | 'tasks' | 'evidence' | 'settings';
  repositories: RepositoryRecord[];
  activeRepository: RepositoryRecord | null;
  onOpenWorkspace: (root: string, tab: WorkspaceTab, repositoryRoot?: string) => void;
  searchQuery?: string;
}
const titles = {home:'控制中心', tasks:'任务', evidence:'证据', settings:'设置'};
export function TaskControlCenter({view, repositories, activeRepository, onOpenWorkspace, searchQuery}: TaskControlCenterProps) {
  const state = useTaskStore();
  const {query,repositoryRoot,attention}=state.filters;
  const [creating,setCreating] = useState<'quick' | 'advanced' | null>(null);
   const [prefill,setPrefill] = useState<TaskPlanRequest | null>(null);
  const bindings = useAgentSessionStore(store => store.bindings);
  const roots = new Set(repositories.map(repo => workspaceKey(repo.path)));
  const tasks = state.tasks.filter(task => roots.has(workspaceKey(task.repositoryRoot)));
  const selected = tasks.find(task => task.id === state.activeTaskId);
  const filtered = filterTasks(tasks,state.readiness,{query:searchQuery ?? query,repositoryRoot:roots.has(workspaceKey(repositoryRoot)) ? repositoryRoot : undefined,attention});
  const profiles = [...new Map(tasks.filter(task => task.profile).map(task => [task.profile!.id,task.profile!])).values()];
  const attached = Object.values(bindings).filter(binding => roots.has(workspaceKey(binding.workspaceRoot)) || tasks.some(task => task.workspaceRoot && workspaceKey(task.workspaceRoot) === workspaceKey(binding.workspaceRoot)));
  const unavailable = !isDesktopRuntime() || !!state.error;
  return <main className="task-center" aria-label="任务控制中心">
    <header className="task-row task-center-heading"><div><h1>{titles[view]}</h1><p>任务附着于工作区 · 本地工程交付</p></div><div className="task-row"><button disabled={state.loading} onClick={() => void refreshTasks()}>{state.loading ? '正在刷新…' : '刷新任务'}</button><button disabled={!repositories.length} onClick={() => {setPrefill(null);setCreating('quick');}}>新建任务</button></div></header>
    {state.error && <p role="alert" className="task-error">任务原生来源不可用：{state.error}</p>}
    {!isDesktopRuntime() && !state.error && <p>当前为浏览器预览；任务原生来源不可用。没有模拟执行或验证结果。</p>}
    {state.observerError && <p role="status" className="task-error">{state.observerError}</p>}
    {!repositories.length && <section className="task-surface"><h2>先添加一个仓库</h2><p>在仓库视图选择本地 Git 仓库，然后手动创建计划。</p></section>}
    {view === 'settings' ? <section className="task-surface">
      <h2>能力与配置</h2><p>验证配置可在此管理；Provider 和 Run 配置保留在工作区工具中。</p>
      <h3>Provider 资格</h3><p>任务执行资格、身份认证和只读规划资格均由 Native 决定。当前 UI 没有已资格验证的认证/只读规划记录。</p>
      <p>已保存会话附着：{attached.length ? attached.map(binding => `${binding.harness} · ${binding.workspaceRoot}`).join('；') : '无可见会话附着记录'}。保存的会话不证明 Provider 当前可用或已认证。</p>
      <ProfileSettings/>
      <h3>任务中的冻结 Profile</h3>{profiles.length ? <ul>{profiles.map(profile => <li key={profile.id}>{profile.name} · {profile.gates.length} gates</li>)}</ul> : <p>尚无任务 Profile；可在新计划的 JSON 编辑器中配置。</p>}
      <p>outputPaths 用于生成输出；sourcePaths 可显式包含忽略的源码；toolchainPrograms 声明额外可执行程序身份，不包含参数。CMake 需声明实际编译器。路径和资格由原生验证。</p>
      {activeRepository && roots.has(workspaceKey(activeRepository.path)) && <div className="task-row"><button onClick={() => onOpenWorkspace(activeRepository.path,'agents',activeRepository.path)}>打开 Provider / Agents 配置</button><button onClick={() => onOpenWorkspace(activeRepository.path,'run',activeRepository.path)}>打开 Run 配置</button></div>}
      <h3>执行与恢复</h3><p>默认并发 2，队列最多 32 个叶任务。重启后未知结果标记为中断，不自动重放 Git 操作。任务工作区必须显式创建。</p>
    </section> : <>
      {(view === 'home' || view === 'tasks') && <TemplateWorkbench repositories={repositories} activeRepository={activeRepository}/>}
      {view === 'evidence' && <p>下方检查结果为 Attempt 的原生观察记录；交付就绪与验收适用性会在每次刷新重新计算。旧 Run v1 记录仅作历史参考。</p>}
      <section className="task-surface">
        <div className="task-filters"><label>搜索任务<input placeholder="标题、目标或范围" value={searchQuery ?? query} readOnly={searchQuery !== undefined} onChange={event => setTaskFilters({query:event.target.value})}/></label>
          <label>筛选仓库<select value={roots.has(workspaceKey(repositoryRoot)) ? repositoryRoot : ''} onChange={event => setTaskFilters({repositoryRoot:event.target.value})}><option value="">全部仓库</option>{repositories.map(repo => <option key={repo.id} value={repo.path}>{repo.name}</option>)}</select></label>
          <label className="task-checkbox"><input type="checkbox" checked={attention} onChange={event => setTaskFilters({attention:event.target.checked})}/>仅需关注</label>
        </div>
        {view === 'evidence' ? <TaskEvidenceInventory tasks={filtered} readiness={state.readiness} loading={state.loading} error={unavailable ? state.error || '原生来源不可用' : null} onOpenTask={selectTask}/> : view === 'home' ? <TaskDashboard tasks={filtered} readiness={state.readiness} loading={state.loading} error={unavailable ? state.error || '原生来源不可用' : null} onOpenTask={selectTask}/> : <TaskList tasks={filtered} readiness={state.readiness} repositories={repositories} selectedId={selected?.id??null} onOpenTask={selectTask}/>}
        {!filtered.length && !state.loading && !unavailable && <p>{tasks.length ? '没有匹配筛选条件的任务。' : '尚无任务。创建手动计划后再显式准备工作区和开始执行。'}</p>}
      </section>
      {selected ? <><TaskWorkflowGuide task={selected} readiness={state.readiness[selected.id]} onNavigate={tab => selectTask(selected.id, tab)}/><TaskDetail key={selected.id} task={selected} onOpenWorkspace={onOpenWorkspace}/></> : tasks.length > 0 && <p>选择一个任务查看详情。</p>}
    </>}
    {creating === 'quick' && <TaskQuickCreate repositories={repositories} activeRepository={activeRepository} onClose={() => setCreating(null)} onAdvanced={draft => {setPrefill(draft);setCreating('advanced');}}/>}
    {creating === 'advanced' && <TaskPlanWizard repositories={repositories} activeRepository={activeRepository} prefill={prefill} onClose={() => setCreating(null)}/>}
  </main>;
}
