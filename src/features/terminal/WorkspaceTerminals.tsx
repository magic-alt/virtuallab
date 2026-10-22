import { useEffect, useRef, useState } from "react";
import { TerminalWorkspace, type TerminalOpenRequest } from "./TerminalWorkspace";
import { workspaceKey } from "@/lib/workspaceKey";
import { cn } from "@/lib/utils";

interface WorkspaceTerminal {
  key: string;
  cwd: string;
  enabled: boolean;
  repositoryId: string | null;
  repositoryRoot?: string;
}

/**
 * A long-lived host owns a separate PTY/xterm tree for every visited workspace.
 * Hiding a page never stops its sessions, but explicitly removing a repository
 * or worktree tears its native processes down via TerminalWorkspace unmount.
 */
export function WorkspaceTerminals({
  cwd, enabled, visible, repositoryId = null,
  repositoryRoot,
  openRequest = null,
  registeredRepositoryIds = [], retiredWorkspace = null,
}: {
  cwd: string;
  enabled: boolean;
  visible: boolean;
  repositoryId?: string | null;
  repositoryRoot?: string;
  openRequest?: TerminalOpenRequest | null;
  registeredRepositoryIds?: string[];
  retiredWorkspace?: { path: string; sequence: number } | null;
}) {
  const key = `${enabled ? "native" : "preview"}:${workspaceKey(cwd)}`;
  const [workspaces, setWorkspaces] = useState<WorkspaceTerminal[]>([]);
  // Each removal event must be consumed once. Otherwise opening another
  // worktree later could accidentally prune a newly created pane at that path.
  const handledRetirement = useRef<number | null>(null);
  const repositoryIds = registeredRepositoryIds.join("\u0000");

  useEffect(() => {
    // Do not install two native event listeners for every workspace merely
    // visited in the sidebar. A PTY pane is created on first Terminal visit.
    if (!visible) return;
    setWorkspaces((current) => {
      const existing = current.find(item => item.key === key);
      if (!existing) return [...current, { key, cwd, enabled, repositoryId, repositoryRoot }];
      // A worktree can also be registered as a repository row. Keep its PTYs
      // while updating the selected owner used by task actions and notices.
      if (existing.repositoryId === repositoryId && existing.repositoryRoot === repositoryRoot) return current;
      return current.map(item => item.key === key ? { ...item, repositoryId, repositoryRoot } : item);
    });
  }, [key, cwd, enabled, visible, repositoryId, repositoryRoot]);

  useEffect(() => {
    const registered = new Set(registeredRepositoryIds);
    const newlyRetired = retiredWorkspace && handledRetirement.current !== retiredWorkspace.sequence;
    const retiredKey = newlyRetired ? workspaceKey(retiredWorkspace.path) : null;
    if (newlyRetired) handledRetirement.current = retiredWorkspace.sequence;
    setWorkspaces((current) => {
      const next = current.filter((item) =>
        (item.repositoryId === null || registered.has(item.repositoryId)) &&
        !(retiredKey !== null && workspaceKey(item.cwd) === retiredKey));
      return next.length === current.length ? current : next;
    });
    // Reap a recreated directory on each explicit removal, even when the path
    // string equals the previous removal event.
  }, [repositoryIds, retiredWorkspace?.sequence]);

  return workspaces.map((workspace) => {
    const active = visible && workspace.key === key;
    return (
      <div
        key={workspace.key}
        className={cn("h-full min-h-0", !active && "hidden")}
        aria-hidden={!active}
        data-testid="terminal-pane"
      >
        <TerminalWorkspace cwd={workspace.cwd} enabled={workspace.enabled} visible={active}
          repositoryId={workspace.repositoryId} repositoryRoot={workspace.repositoryRoot}
          openRequest={active ? openRequest : null} />
      </div>
    );
  });
}
