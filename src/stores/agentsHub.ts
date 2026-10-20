import { create } from 'zustand';

export interface AgentHubTarget {
  repositoryRoot: string;
  workspaceRoot: string;
}

interface AgentsHubState {
  section: 'tasks' | 'sessions' | 'configuration';
  sessionTarget: AgentHubTarget | null;
  visibleSessionRoot: string | null;
  showTasks: () => void;
  showConfiguration: () => void;
  showSession: (target: AgentHubTarget) => void;
  setVisibleSessionRoot: (root: string | null) => void;
}

/** Application navigation only. Native processes and repository selection stay with their owners. */
export const useAgentsHubStore = create<AgentsHubState>()((set) => ({
  section: 'tasks',
  sessionTarget: null,
  visibleSessionRoot: null,
  showTasks: () => set({ section: 'tasks', visibleSessionRoot: null }),
  showConfiguration: () => set({ section: 'configuration', visibleSessionRoot: null }),
  showSession: (sessionTarget) => set({ section: 'sessions', sessionTarget, visibleSessionRoot: null }),
  setVisibleSessionRoot: (visibleSessionRoot) => set({ visibleSessionRoot }),
}));
