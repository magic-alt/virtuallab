import { create } from "zustand";
import { desktopNotify, isDesktopRuntime } from "@/lib/backend";
import { workspaceKey } from "@/lib/workspaceKey";
import type { AgentEvent } from "@/types/agent";

export type TaskNotice = {
  id: string;
  workspaceRoot: string;
  /** Repo owner is explicit because worktrees may be siblings outside the repo path. */
  repositoryId?: string | null;
  source: "terminal" | "agent";
  terminalId?: string;
  title: string;
  detail: string;
  severity: "complete" | "attention" | "failed";
  createdAt: number;
  read: boolean;
};

type TerminalTarget = { workspaceRoot: string; id: string; sequence: number };
type NotificationState = {
  notices: TaskNotice[];
  desktopEnabled: boolean;
  desktopError: string | null;
  terminalTarget: TerminalTarget | null;
  add: (notice: TaskNotice) => boolean;
  markRead: (id: string) => void;
  clear: () => void;
  discardWorkspace: (workspaceRoot: string) => void;
  discardRepository: (repositoryRoot: string, repositoryId: string) => void;
  setDesktopEnabled: (enabled: boolean) => void;
  setDesktopError: (error: string | null) => void;
  focusTerminal: (workspaceRoot: string, id: string) => void;
  consumeTerminalTarget: (sequence: number) => void;
};

const PREFERENCE = "virtuallab.desktopTaskNotifications.v1";
function savedPreference() {
  try { return window.localStorage.getItem(PREFERENCE) !== "off"; }
  catch { return true; }
}

export const useTaskNotifications = create<NotificationState>()((set, get) => ({
  notices: [],
  desktopEnabled: savedPreference(),
  desktopError: null,
  terminalTarget: null,
  add: (notice) => {
    if (get().notices.some((item) => item.id === notice.id)) return false;
    set((state) => ({ notices: [notice, ...state.notices].slice(0, 50) }));
    return true;
  },
  markRead: (id) => set((state) => ({
    notices: state.notices.map((item) => item.id === id ? { ...item, read: true } : item),
  })),
  clear: () => set({ notices: [] }),
  discardWorkspace: (path) => set((state) => ({
    notices: state.notices.filter((item) => workspaceKey(item.workspaceRoot) !== workspaceKey(path)),
  })),
  discardRepository: (path, repositoryId) => set((state) => {
    const key = workspaceKey(path);
    return { notices: state.notices.filter((item) => {
      const workspace = workspaceKey(item.workspaceRoot);
      return item.repositoryId !== repositoryId &&
        workspace !== key && !workspace.startsWith(key + "/");
    }) };
  }),
  setDesktopEnabled: (enabled) => {
    try { window.localStorage.setItem(PREFERENCE, enabled ? "on" : "off"); }
    catch { /* in-memory preference still works */ }
    set({ desktopEnabled: enabled, desktopError: null });
  },
  setDesktopError: (desktopError) => set({ desktopError }),
  focusTerminal: (workspaceRoot, id) => set((state) => ({
    terminalTarget: { workspaceRoot, id, sequence: (state.terminalTarget?.sequence ?? 0) + 1 },
  })),
  consumeTerminalTarget: (sequence) => set((state) => ({
    terminalTarget: state.terminalTarget?.sequence === sequence ? null : state.terminalTarget,
  })),
}));

/**
 * Notification content never includes prompts, assistant responses, shell output,
 * or OSC text. The inbox is in-memory; only the on/off preference persists.
 */
export function publishTaskNotice(
  input: Omit<TaskNotice, "createdAt" | "read">,
  targetVisibleAndFocused: boolean,
): boolean {
  const store = useTaskNotifications.getState();
  const added = store.add({ ...input, createdAt: Date.now(), read: false });
  if (!added) return false;
  if (!targetVisibleAndFocused && store.desktopEnabled && isDesktopRuntime()) {
    void desktopNotify(input.title, input.detail)
      .then(() => useTaskNotifications.getState().setDesktopError(null))
      .catch((error) => useTaskNotifications.getState().setDesktopError(String(error)));
  }
  return true;
}

/** Only structured completion events count; a crashed app-server is not success. */
export function noticeForAgentEvent(event: AgentEvent): Omit<TaskNotice, "createdAt" | "read"> | null {
  if (event.eventType !== "agent.turn_completed" && event.method !== "turn/completed"
      && event.method !== "turn/failed") return null;
  const payload = event.payload && typeof event.payload === "object"
    ? event.payload as Record<string, unknown> : {};
  const turn = payload.turn && typeof payload.turn === "object"
    ? payload.turn as Record<string, unknown> : {};
  const turnId = event.turnId ?? (typeof turn.id === "string" ? turn.id : null);
  if (!turnId) return null;
  const status = typeof payload.status === "string" ? payload.status
    : typeof turn.status === "string" ? turn.status : "";
  const failed = event.method === "turn/failed" || (status !== "" && status !== "completed" && status !== "success");
  const name = "Agent";
  return {
    id: "agent:" + workspaceKey(event.workspaceRoot) + ":" + (event.threadId ?? "") + ":" + turnId,
    workspaceRoot: event.workspaceRoot,
    source: "agent",
    title: failed ? name + " task failed" : name + " task completed",
    detail: failed ? "Agent turn ended unsuccessfully. Open Agents to review." : "Agent turn completed. Open Agents to review.",
    severity: failed ? "failed" : "complete",
  };
}
