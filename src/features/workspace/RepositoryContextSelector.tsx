import { useEffect, useRef, useState } from 'react';
import { inspectRepository, isDesktopRuntime } from '@/lib/backend';
import { workspaceKey } from '@/lib/workspaceKey';
import { EMPTY_CONTEXT_REPOSITORIES, MAX_CONTEXT_REPOSITORIES } from '@/lib/workspaceContext';
import { useRepositoryContextStore } from '@/stores/repositoryContext';
import { useWorkbenchStore } from '@/stores/workbench';
import type { RepositoryRecord, WorktreeSummary } from '@/types/workbench';
import type { ContextRepository } from '@/types/workspaceContext';
import './repositoryContext.css';

interface Props {
  repositoryRoot: string;
  primaryWorkspaceRoot?: string;
  repositories?: RepositoryRecord[];
  value?: ContextRepository[];
  onChange?: (references: ContextRepository[]) => void;
  disabled?: boolean;
  active?: boolean;
}
interface Inventory { workspaces: WorktreeSummary[]; error?: string }

export function ContextRepositoryList({ references, label = '参考仓库' }: { references?: ContextRepository[]; label?: string }) {
  if (!references?.length) return null;
  return <div className="repository-context-list" aria-label={label}>
    <strong>{label}</strong>
    <ul>{references.map(reference => <li key={JSON.stringify([reference.repositoryRoot, reference.workspaceRoot])}>
      <code>{reference.workspaceRoot}</code>
      {workspaceKey(reference.repositoryRoot) !== workspaceKey(reference.workspaceRoot) && <span>所属仓库：{reference.repositoryRoot}</span>}
    </li>)}</ul>
  </div>;
}

/** Selection is configuration only; opening this editor never starts a provider. */
export function RepositoryContextSelector({ repositoryRoot, primaryWorkspaceRoot = repositoryRoot, repositories: suppliedRepositories,
  value, onChange, disabled = false, active = true }: Props) {
  const registeredRepositories = useWorkbenchStore(state => state.repositories);
  const repositories = suppliedRepositories ?? registeredRepositories;
  const ownerKey = workspaceKey(repositoryRoot);
  const saved = useRepositoryContextStore(state => state.contexts[ownerKey] ?? EMPTY_CONTEXT_REPOSITORIES);
  const references = value ?? saved;
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [inventory, setInventory] = useState<{ key: string; loading: boolean; rows: Record<string, Inventory> }>({ key: '', loading: false, rows: {} });
  const epoch = useRef(0);
  const native = isDesktopRuntime();
  const candidates = repositories.filter(repository => workspaceKey(repository.path) !== ownerKey);
  const registrationKey = JSON.stringify(candidates.map(repository => [repository.id, repository.path]).sort());
  const inventoryKey = JSON.stringify([ownerKey, registrationKey]);
  const available = active && !disabled && native && repositories.some(repository => workspaceKey(repository.path) === ownerKey);

  useEffect(() => {
    const request = ++epoch.current;
    if (!expanded || !active || !native) return;
    setInventory({ key: inventoryKey, loading: true, rows: {} });
    void Promise.allSettled(candidates.map(async repository => {
      const snapshot = await inspectRepository(repository.path);
      if (workspaceKey(snapshot.root) !== workspaceKey(repository.path)) throw new Error('清单与所选仓库不匹配。');
      const primary: WorktreeSummary = { path: snapshot.root, head: snapshot.headSha, branch: snapshot.currentBranch, detached: !snapshot.currentBranch };
      return [...new Map([primary, ...(snapshot.worktrees ?? []).filter(tree => tree.path.trim() && !tree.missing)]
        .map(tree => [workspaceKey(tree.path), tree])).values()];
    })).then(results => {
      if (request !== epoch.current) return;
      const rows: Record<string, Inventory> = {};
      results.forEach((result, index) => {
        rows[workspaceKey(candidates[index].path)] = result.status === 'fulfilled'
          ? { workspaces: result.value }
          : { workspaces: [], error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
      });
      setInventory({ key: inventoryKey, loading: false, rows });
    });
    return () => { ++epoch.current; };
  }, [expanded, active, native, inventoryKey, revision]);

  const change = (next: ContextRepository[]) => {
    if (!available) return;
    if (onChange) onChange(next);
    else useRepositoryContextStore.getState().setContextRepositories(repositoryRoot, next);
  };
  const unknown = references.filter(reference => !candidates.some(repository => workspaceKey(repository.path) === workspaceKey(reference.repositoryRoot)));
  const reading = inventory.key !== inventoryKey || inventory.loading;

  return <details className="repository-context" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>协作仓库 <span>{references.length} / {MAX_CONTEXT_REPOSITORIES}</span></summary>
    <p>选定的工作区仅供参考；修改仍属于当前工作区。配置用于新会话、新 Codex 终端和新任务，运行中的会话保持原配置。</p>
    <p className="repository-context-primary">当前工作区：<code>{primaryWorkspaceRoot}</code></p>
    {!candidates.length && <p>添加其他本地仓库后，可在这里选择关联代码。</p>}
    {!native && <p>连接桌面应用后可读取并选择参考工作区。</p>}
    {unknown.map(reference => <div className="repository-context-error" key={reference.repositoryRoot}>
      已移除的参考仓库：{reference.repositoryRoot}
      <button type="button" disabled={!available} onClick={() => change(references.filter(item => item !== reference))}>移除此引用</button>
    </div>)}
    {candidates.map(repository => {
      const key = workspaceKey(repository.path);
      const selected = references.find(reference => workspaceKey(reference.repositoryRoot) === key);
      const row = inventory.key === inventoryKey ? inventory.rows[key] : undefined;
      const workspaces = row?.workspaces.filter(tree => workspaceKey(tree.path) !== workspaceKey(primaryWorkspaceRoot)) ?? [];
      const missing = !!selected && !reading && !!row && !row.error && !workspaces.some(tree => workspaceKey(tree.path) === workspaceKey(selected.workspaceRoot));
      return <div className="repository-context-row" key={key}>
        <label className="repository-context-check"><input type="checkbox" aria-label={`引用 ${repository.name}`} checked={!!selected}
          disabled={!available || (!selected && (reading || !!row?.error || !workspaces.length || references.length >= MAX_CONTEXT_REPOSITORIES))}
          onChange={event => change(event.target.checked && workspaces[0]
            ? [...references, { repositoryRoot: repository.path, workspaceRoot: workspaces[0].path }]
            : references.filter(reference => workspaceKey(reference.repositoryRoot) !== key))}/>{repository.name}</label>
        <code className="repository-context-root">{repository.path}</code>
        {selected && <label className="repository-context-worktree">参考工作区
          <select aria-label={`${repository.name} 参考工作区`} value={selected.workspaceRoot}
            disabled={!available || reading || !!row?.error} onChange={event => change(references.map(reference => reference === selected
              ? { repositoryRoot: repository.path, workspaceRoot: event.target.value } : reference))}>
            {!workspaces.some(tree => tree.path === selected.workspaceRoot) && <option value={selected.workspaceRoot}>{selected.workspaceRoot}{missing ? ' · 已不可用' : ''}</option>}
            {workspaces.map(tree => <option key={workspaceKey(tree.path)} value={tree.path}>{tree.branch || 'Detached HEAD'} · {tree.path}</option>)}
          </select>
        </label>}
        {(row?.error || missing) && <p className="repository-context-error">{row?.error || '参考工作区已移除，请重新选择。'}</p>}
      </div>;
    })}
    {!!candidates.length && <button type="button" className="repository-context-refresh" disabled={!available || reading} onClick={() => setRevision(current => current + 1)}>{reading ? '正在读取工作区…' : '刷新参考工作区'}</button>}
  </details>;
}
