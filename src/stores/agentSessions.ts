import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AgentSessionBinding } from "@/types/agent";
import { workspaceKey } from "@/lib/workspaceKey";

export function agentWorkspaceKey(path: string) {
  return workspaceKey(path);
}

function isAgentSessionBinding(value: unknown): value is AgentSessionBinding {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AgentSessionBinding>;
  return (
    typeof item.workspaceRoot === "string" &&
    item.workspaceRoot.trim().length > 0 &&
    ["codex", "deepseek", "claude", "opencode"].includes(item.harness ?? "") &&
    typeof item.threadId === "string" &&
    item.threadId.trim().length > 0 &&
    typeof item.createdAtMs === "number" &&
    typeof item.updatedAtMs === "number"
  );
}

function sanitizeBindings(value: unknown) {
  if (!value || typeof value !== "object") {
    return {} as Record<string, AgentSessionBinding>;
  }

  return Object.fromEntries(
    Object.values(value)
      .filter(isAgentSessionBinding)
      .map((binding) => [agentWorkspaceKey(binding.workspaceRoot), binding] as const),
  ) as Record<string, AgentSessionBinding>;
}

interface AgentSessionState {
  bindings: Record<string, AgentSessionBinding>;
  setBinding: (binding: AgentSessionBinding) => void;
  clearBinding: (workspaceRoot: string) => void;
  clearRepositoryBindings: (repositoryRoot: string) => void;
}

export const useAgentSessionStore = create<AgentSessionState>()(
  persist(
    (set) => ({
      bindings: {},
      setBinding: (binding) =>
        set((state) => ({
          bindings: {
            ...state.bindings,
            [agentWorkspaceKey(binding.workspaceRoot)]: binding,
          },
        })),
      clearBinding: (workspaceRoot) =>
        set((state) => {
          const bindings = { ...state.bindings };
          delete bindings[agentWorkspaceKey(workspaceRoot)];
          return { bindings };
        }),
      clearRepositoryBindings: (repositoryRoot) =>
        set((state) => {
          const root = agentWorkspaceKey(repositoryRoot);
          return {
            bindings: Object.fromEntries(
              Object.entries(state.bindings).filter(([key]) => {
                if (key === root) return false;
                return !key.startsWith(`${root}/`);
              }),
            ),
          };
        }),
    }),
    {
      name: "virtuallab-agent-sessions-v1",
      storage: createJSONStorage(() => window.localStorage),
      version: 2,
      migrate: (persistedState) => {
        const saved = persistedState as Partial<AgentSessionState>;
        return {
          ...saved,
          bindings: sanitizeBindings(saved.bindings),
        };
      },
      partialize: (state) => ({ bindings: state.bindings }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<AgentSessionState>;
        return {
          ...current,
          ...saved,
          bindings: sanitizeBindings(saved.bindings),
        };
      },
    },
  ),
);
