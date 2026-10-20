import { useEffect, useRef, useState } from 'react';
import { inspectRepository, isDesktopRuntime } from '@/lib/backend';
import { workspaceKey } from '@/lib/workspaceKey';
import { useAgentsHubStore, type AgentHubTarget } from '@/stores/agentsHub';
import { useAgentSessionStore } from '@/stores/agentSessions';
import { useTaskStore } from '@/stores/tasks';
import type { RepositoryRecord, RepositorySnapshot, WorkspaceTab, WorktreeSummary } from '@/types/workbench';
import { AgentWorkspace } from './AgentWorkspace';
import './agentsHub.css';

export interface AgentSessionHubProps {
  repositories: RepositoryRecord[];
  activeRepository: RepositoryRecord | null;
  visible: boolean;
  onOpenWorkspace: (root: string, tab: WorkspaceTab, repositoryRoot?: string) => void;
  onOpenTask: (id: string) => void;
}

interface RepositoryInventory {
  workspaces: WorktreeSummary[];
  error: string | null;
}

interface Inventory {
  registrationKey: string;
  loading: boolean;
  repositories: Record<string, RepositoryInventory>;
}

const targetKey = (target: AgentHubTarget) => JSON.stringify([workspaceKey(target.repositoryRoot), workspaceKey(target.workspaceRoot)]);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function validatedWorkspaces(repositoryRoot: string, snapshot: RepositorySnapshot): WorktreeSummary[] {
  if (workspaceKey(snapshot.root) !== workspaceKey(repositoryRoot)) {
    throw new Error('工作区清单与所选仓库根目录不匹配。');
  }
  const primary: WorktreeSummary = { path: snapshot.root, head: snapshot.headSha, branch: snapshot.currentBranch, detached: !snapshot.currentBranch };
  return [...new Map([primary, ...snapshot.worktrees.filter(tree => tree.path.trim() && !tree.missing)]
    .map(tree => [workspaceKey(tree.path), tree])).values()];
}

function taskSourceOwners(repositories: RepositoryRecord[], target: AgentHubTarget, rows: Inventory['repositories']): string[] {
  const selectedRoot = workspaceKey(target.repositoryRoot);
  const workspaceRoot = workspaceKey(target.workspaceRoot);
  const siblings = new Set(rows[selectedRoot]?.workspaces.map(tree => workspaceKey(tree.path)));
  return repositories.filter(repository => {
    const root = workspaceKey(repository.path);
    const row = rows[root];
    // A worktree can also be registered directly. Either inventory can establish
    // ownership; an unreadable inventory cannot exclude another possible owner.
    return root === selectedRoot || siblings.has(root) || !row || !!row.error
      || row.workspaces.some(tree => workspaceKey(tree.path) === workspaceRoot);
  }).map(repository => workspaceKey(repository.path));
}

function taskSourceError(owners: string[], tasks: ReturnType<typeof useTaskStore.getState>): string | null {
  if (tasks.error) return tasks.error;
  for (const owner of owners) {
    const error = Object.entries(tasks.repositoryErrors).find(([root]) => workspaceKey(root) === owner)?.[1];
    if (error) return error;
    if (!tasks.roots.some(root => workspaceKey(root) === owner)) return '请等待任务来源恢复后重试。';
  }
  return null;
}

/** Navigation and read-only inventory. Session actions remain bound to an inspected worktree. */
export function AgentSessionHub({ repositories, activeRepository, visible, onOpenWorkspace, onOpenTask }: AgentSessionHubProps) {
  const target = useAgentsHubStore(state => state.sessionTarget);
  const showSession = useAgentsHubStore(state => state.showSession);
  const setVisibleSessionRoot = useAgentsHubStore(state => state.setVisibleSessionRoot);
  const bindings = useAgentSessionStore(state => state.bindings);
  const taskState = useTaskStore();
  const native = isDesktopRuntime();
  const [revision, setRevision] = useState(0);
  const [inventory, setInventory] = useState<Inventory>({ registrationKey: '', loading: false, repositories: {} });
  const [visited, setVisited] = useState<AgentHubTarget[]>([]);
  const inventoryEpoch = useRef(0);
  const latestInventory = useRef(inventory);
  latestInventory.current = inventory;
  const registrationKey = JSON.stringify(repositories.map(repository => [repository.id, repository.path]).sort());
  const defaultRepository = repositories.find(repository => repository.id === activeRepository?.id) ?? repositories[0];
  const defaultRoot = defaultRepository?.path;
  const selectedTarget = target ?? (defaultRoot ? { repositoryRoot: defaultRoot, workspaceRoot: defaultRoot } : null);
  const currentContext = useRef({ registrationKey, visible, target: selectedTarget ? targetKey(selectedTarget) : null });
  currentContext.current = { registrationKey, visible, target: selectedTarget ? targetKey(selectedTarget) : null };

  useEffect(() => {
    if (visible && !target && defaultRoot) showSession({ repositoryRoot: defaultRoot, workspaceRoot: defaultRoot });
  }, [visible, target, defaultRoot, showSession]);

  useEffect(() => {
    const epoch = ++inventoryEpoch.current;
    if (!visible || !native) return;
    let cancelled = false;
    setInventory(previous => ({ registrationKey, loading: true, repositories: previous.repositories }));
    void Promise.allSettled(repositories.map(async repository => ({
      root: workspaceKey(repository.path),
      workspaces: validatedWorkspaces(repository.path, await inspectRepository(repository.path)),
    }))).then(results => {
      if (cancelled || inventoryEpoch.current !== epoch) return;
      setInventory(previous => {
        const rows: Record<string, RepositoryInventory> = {};
        results.forEach((result, index) => {
          const root = workspaceKey(repositories[index].path);
          rows[root] = result.status === 'fulfilled'
            ? { workspaces: result.value.workspaces, error: null }
            : { workspaces: previous.repositories[root]?.workspaces ?? [], error: errorText(result.reason) };
        });
        return { registrationKey, loading: false, repositories: rows };
      });
    });
    return () => { cancelled = true; ++inventoryEpoch.current; };
  }, [registrationKey, visible, native, revision]);

  const repository = repositories.find(item => selectedTarget && workspaceKey(item.path) === workspaceKey(selectedTarget.repositoryRoot));
  const currentInventory = inventory.registrationKey === registrationKey;
  const repositoryInventory = repository && currentInventory ? inventory.repositories[workspaceKey(repository.path)] : undefined;
  const reading = native && (!currentInventory || inventory.loading || (!!repository && !repositoryInventory));
  const workspace = repositoryInventory?.workspaces.find(item => selectedTarget && workspaceKey(item.path) === workspaceKey(selectedTarget.workspaceRoot));
  const boundTasks = taskState.tasks.filter(task => selectedTarget && task.workspaceRoot && workspaceKey(task.workspaceRoot) === workspaceKey(selectedTarget.workspaceRoot));
  const owners = selectedTarget ? taskSourceOwners(repositories, selectedTarget, currentInventory ? inventory.repositories : {}) : [];
  const repositoryTaskError = taskSourceError(owners, taskState);
  const taskSourceKnown = !!repository && !repositoryTaskError;
  const taskSourceAvailable = taskSourceKnown && !taskState.loading;
  const validWorkspace = native && !!repository && !!workspace && !repositoryInventory?.error;
  const previouslyShown = !!workspace && visited.some(item => workspaceKey(item.workspaceRoot) === workspaceKey(workspace.path));
  const actionsEnabled = validWorkspace && !reading && taskSourceAvailable && !boundTasks.length;
  const manualVisible = visible && validWorkspace && taskSourceKnown && !boundTasks.length && (actionsEnabled || previouslyShown);
  const manualTarget = manualVisible && repository && workspace ? { repositoryRoot: repository.path, workspaceRoot: workspace.path } : null;
  const manualKey = manualTarget ? targetKey(manualTarget) : null;
  const visibleRoot = manualTarget?.workspaceRoot ?? null;
  const panelTargets = manualTarget
    ? visited.some(item => workspaceKey(item.workspaceRoot) === workspaceKey(manualTarget.workspaceRoot))
      ? visited.map(item => workspaceKey(item.workspaceRoot) === workspaceKey(manualTarget.workspaceRoot) ? manualTarget : item)
      : [...visited, manualTarget]
    : visited;

  useEffect(() => {
    if (!manualTarget) return;
    setVisited(previous => previous.some(item => targetKey(item) === targetKey(manualTarget)) ? previous
      : previous.some(item => workspaceKey(item.workspaceRoot) === workspaceKey(manualTarget.workspaceRoot))
        ? previous.map(item => workspaceKey(item.workspaceRoot) === workspaceKey(manualTarget.workspaceRoot) ? manualTarget : item)
        : [...previous, manualTarget]);
  }, [manualKey]);

  useEffect(() => {
    setVisibleSessionRoot(visibleRoot);
    return () => { setVisibleSessionRoot(null); };
  }, [visibleRoot, setVisibleSessionRoot]);

  const selectionError = selectedTarget && !repository ? '所选会话仓库已移除，请显式选择一个已登记的仓库。'
    : repositoryInventory?.error ? `工作区清单不可用：${repositoryInventory.error}`
      : selectedTarget && repository && !reading && native && !workspace ? '所选工作区已移除或不属于此仓库，请显式选择其他可用工作区。'
        : null;
  const openTool = (tab: WorkspaceTab) => {
    if (validWorkspace && !reading && repository && workspace) onOpenWorkspace(workspace.path, tab, repository.path);
  };

  const validateSessionTarget = async (item: AgentHubTarget) => {
    const epoch = inventoryEpoch.current;
    const current = () => {
      const navigation = useAgentsHubStore.getState();
      return inventoryEpoch.current === epoch && currentContext.current.visible
        && currentContext.current.registrationKey === registrationKey && currentContext.current.target === targetKey(item)
        && navigation.section === 'sessions' && navigation.sessionTarget && targetKey(navigation.sessionTarget) === targetKey(item);
    };
    let workspaces: WorktreeSummary[];
    try {
      const latest = await inspectRepository(item.repositoryRoot);
      if (!current()) throw new Error('会话目标或工作区清单已变化，请在当前工作区重试。');
      workspaces = validatedWorkspaces(item.repositoryRoot, latest);
    } catch (error) {
      if (current()) setInventory(previous => ({
        ...previous,
        repositories: { ...previous.repositories, [workspaceKey(item.repositoryRoot)]: {
          workspaces: previous.repositories[workspaceKey(item.repositoryRoot)]?.workspaces ?? [], error: errorText(error),
        } },
      }));
      throw error;
    }
    // A launch preflight also revokes a stale selector, without discarding its retained draft.
    setInventory(previous => previous.registrationKey === registrationKey ? {
      ...previous,
      repositories: { ...previous.repositories, [workspaceKey(item.repositoryRoot)]: { workspaces, error: null } },
    } : previous);
    if (!workspaces.some(entry => workspaceKey(entry.path) === workspaceKey(item.workspaceRoot))) {
      throw new Error('所选工作区已移除或不可用，请刷新工作区后重试。');
    }
    const tasks = useTaskStore.getState();
    const ownerRows = { ...latestInventory.current.repositories, [workspaceKey(item.repositoryRoot)]: { workspaces, error: null } };
    if (tasks.loading || taskSourceError(taskSourceOwners(repositories, item, ownerRows), tasks)) {
      throw new Error('任务来源暂不可用，无法确认此工作区是否允许手动会话。');
    }
    if (tasks.tasks.some(task => task.workspaceRoot && workspaceKey(task.workspaceRoot) === workspaceKey(item.workspaceRoot))) {
      throw new Error('此工作区已关联任务，请从任务详情继续。');
    }
  };

  return <section className="agent-session-hub" aria-label="工作区会话" hidden={!visible}>
    <header className="agent-session-heading">
      <div><h2>工作区会话</h2><p>选择已有工作区，与 Provider 直接交互。线程、活动和草稿保留在各自的工作区。</p></div>
      <button type="button" disabled={!visible || !native || reading || !repositories.length} onClick={() => setRevision(value => value + 1)}>刷新工作区</button>
    </header>
    {!repositories.length && <p className="agent-session-notice">先在工程仓库中添加一个本地 Git 仓库。</p>}
    <div className="agent-session-selectors">
      <label>会话仓库
        <select value={repository?.path ?? ''} onChange={event => showSession({ repositoryRoot: event.target.value, workspaceRoot: event.target.value })}>
          {!repository && <option value="" disabled>请选择已登记的仓库</option>}
          {repositories.map(item => <option key={item.id} value={item.path}>{item.name} — {item.path}</option>)}
        </select>
      </label>
      <label>会话工作区
        <select value={workspace?.path ?? ''} disabled={!repository || reading || !native || !!repositoryInventory?.error}
          onChange={event => { if (repository) showSession({ repositoryRoot: repository.path, workspaceRoot: event.target.value }); }}>
          {!workspace && <option value="" disabled>{reading ? '正在读取工作区…' : '请选择可用工作区'}</option>}
          {repositoryInventory?.workspaces.map(item => <option key={workspaceKey(item.path)} value={item.path}>
            {item.branch || 'Detached HEAD'} · {item.path}{bindings[workspaceKey(item.path)] ? ' · 已保存线程' : ''}
          </option>)}
        </select>
      </label>
    </div>
    {selectionError && <p role="alert" className="agent-session-error">{selectionError}</p>}
    {!native && <p role="status" className="agent-session-notice">工作区会话需要桌面运行时。浏览器预览不会连接或启动 Provider。</p>}
    {reading && <p role="status" className="agent-session-notice">正在核对已登记仓库和工作区…</p>}
    {validWorkspace && repository && workspace && <div className="agent-session-context">
      <code>{workspace.path}</code>
      <div className="agent-session-tools"><button type="button" onClick={() => openTool('overview')}>打开 Git</button><button type="button" onClick={() => openTool('terminal')}>打开终端</button><button type="button" onClick={() => openTool('run')}>打开 Run</button></div>
    </div>}
    {validWorkspace && boundTasks.length > 0 && <section className="agent-session-task">
      <h3>任务工作区</h3><p>此工作区已关联任务。请从任务详情管理执行、结果和历史记录。</p>
      {boundTasks.map(task => <button key={task.id} type="button" onClick={() => onOpenTask(task.id)}>打开任务 · {task.title}</button>)}
    </section>}
    {validWorkspace && !boundTasks.length && !taskSourceAvailable && !manualVisible && <p role="status" className="agent-session-notice">
      {taskState.loading ? '正在读取任务归属，暂时无法开启手动会话。' : `任务来源暂不可用，无法确认此工作区是否已关联任务。${taskState.error || repositoryTaskError || '请等待任务来源恢复后重试。'}`}
    </p>}
    {panelTargets.filter(item => repositories.some(record => workspaceKey(record.path) === workspaceKey(item.repositoryRoot)
      || workspaceKey(record.path) === workspaceKey(item.workspaceRoot)
      || inventory.repositories[workspaceKey(record.path)]?.workspaces.some(tree => workspaceKey(tree.path) === workspaceKey(item.workspaceRoot)))).map(item => {
      const selected = manualKey === targetKey(item);
      return <div className="agent-session-panel" key={workspaceKey(item.workspaceRoot)} hidden={!selected} aria-hidden={!selected}>
        <AgentWorkspace key={workspaceKey(item.workspaceRoot)} workspaceRoot={item.workspaceRoot} enabled={selected && actionsEnabled} visible={selected}
          disabledReason={reading ? '正在更新工作区归属，确认完成后可继续操作。' : '正在更新任务归属，确认完成后可继续操作。'}
          validateWorkspace={() => validateSessionTarget(item)}/>
      </div>;
    })}
  </section>;
}
