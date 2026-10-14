import { useEffect, useState } from "react";
import { TerminalWorkspace } from "./TerminalWorkspace";
import { workspaceKey } from "@/lib/workspaceKey";
import { cn } from "@/lib/utils";

interface WorkspaceTerminal {
  key: string;
  cwd: string;
  enabled: boolean;
  repositoryId: string | null;
}

/**
 * A long-lived host owns a separate PTY/xterm tree for every visited workspace.
 * Hiding a page never stops its sessions, but explicitly removing a repository
 * or worktree tears its native processes down via TerminalWorkspace unmount.
 */
export function WorkspaceTerminals({
  cwd, enabled, visible, repositoryId = null,
  registeredRepositoryIds = [], retiredWorkspace = null,
}: {
  cwd: string;
  enabled: boolean;
  visible: boolean;
  repositoryId?: string | null;
  registeredRepositoryIds?: string[];
  retiredWorkspace?: { path: string; sequence: number } | null;
}) {
  const key = `${enabled ? "native" : "preview"}:${workspaceKey(cwd)}`;
  const [workspaces, setWorkspaces] = useState<WorkspaceTerminal[]>([]);
  const repositoryIds = registeredRepositoryIds.join("\u0000");

  useEffect(() => {
    // Do not install two native event listeners for every workspace merely
    // visited in the sidebar. A PTY pane is created on first Terminal visit.
    if (!visible) return;
    setWorkspaces((current) => current.some((item) => item.key === key)
      ? current
      : [...current, { key, cwd, enabled, repositoryId }]);
  }, [key, cwd, enabled, visible, repositoryId]);

  useEffect(() => {
    const registered = new Set(registeredRepositoryIds);
    const retiredKey = retiredWorkspace ? workspaceKey(retiredWorkspace.path) : null;
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
        <TerminalWorkspace cwd={workspace.cwd} enabled={workspace.enabled} visible={active} />
      </div>
    );
  });
}
