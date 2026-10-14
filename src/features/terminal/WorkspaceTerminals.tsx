import { useState } from "react";
import { TerminalWorkspace } from "./TerminalWorkspace";
import { workspaceKey } from "@/lib/workspaceKey";
import { cn } from "@/lib/utils";

interface WorkspaceTerminal {
  key: string;
  cwd: string;
  enabled: boolean;
}

// This host lives for the workbench lifetime. Navigation changes visibility,
// never the ownership of an existing workspace's PTYs or xterm buffers.
export function WorkspaceTerminals({ cwd, enabled, visible }: {
  cwd: string;
  enabled: boolean;
  visible: boolean;
}) {
  // Preview and native instances must not share a session lifetime.
  const key = `${enabled ? "native" : "preview"}:${workspaceKey(cwd)}`;
  const [workspaces, setWorkspaces] = useState<WorkspaceTerminal[]>([]);
  let panes = workspaces;
  if (!workspaces.some((workspace) => workspace.key === key)) {
    panes = [...workspaces, { key, cwd, enabled }];
    setWorkspaces(panes);
  }

  return panes.map((workspace) => {
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
