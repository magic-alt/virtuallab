import { create } from "zustand";
import { agentWorkspaceKey, useAgentSessionStore } from "./agentSessions";
import type { AgentEvent, AgentSessionBinding } from "@/types/agent";

/** In-memory only. Never persist full model responses, prompts, or tool outputs. */
interface AgentTimelineState {
  entries: Record<string, AgentEvent[]>;
  activeTurns: Record<string, string>;
  append: (event: AgentEvent) => void;
  setActiveTurn: (workspaceRoot: string, turnId: string | null) => void;
  clear: (workspaceRoot: string) => void;
}
export const useAgentTimeline = create<AgentTimelineState>()((set) => ({
  entries: {}, activeTurns: {},
  append: (event) => {
    if (event.eventType === "agent.session_binding") {
      const binding = (event.payload as { binding?: AgentSessionBinding } | null)?.binding;
      if (binding && agentWorkspaceKey(binding.workspaceRoot) === agentWorkspaceKey(event.workspaceRoot)
        && binding.threadId.trim()) {
        useAgentSessionStore.getState().setBinding(binding);
      }
    }
    set((s) => {
      const key = agentWorkspaceKey(event.workspaceRoot);
      const entries = { ...s.entries, [key]: [...(s.entries[key] ?? []).slice(-299), event] };
      const activeTurns = { ...s.activeTurns };
      if (event.eventType === "agent.turn_started" || event.method === "turn/started") {
        if (event.turnId) activeTurns[key] = event.turnId;
      }
      if (event.eventType === "agent.turn_completed" || event.eventType === "agent.process_exited"
        || event.method === "turn/completed" || event.eventType === "agent.session_stopped") {
        delete activeTurns[key];
      }
      return { entries, activeTurns };
    });
  },
  setActiveTurn: (root, turnId) => set((s) => {
    const activeTurns = { ...s.activeTurns };
    const key = agentWorkspaceKey(root);
    if (turnId) activeTurns[key] = turnId;
    else delete activeTurns[key];
    return { activeTurns };
  }),
  clear: (root) => set((s) => {
    const key = agentWorkspaceKey(root);
    const entries = { ...s.entries };
    delete entries[key];
    return { entries };
  }),
}));
