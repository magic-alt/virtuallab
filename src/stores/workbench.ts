import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  ProcessProfile,
  RepositoryRecord,
  WorkspacePersistedState,
} from "@/types/workbench";

interface WorkbenchState {
  repositories: RepositoryRecord[];
  activeRepositoryId: string | null;
  profiles: ProcessProfile[];
  workspaceStates: Record<string, WorkspacePersistedState>;
  addRepository: (repository: RepositoryRecord) => void;
  removeRepository: (id: string) => void;
  setActiveRepository: (id: string | null) => void;
  addProfile: (profile: ProcessProfile) => void;
  removeProfile: (id: string) => void;
  saveWorkspaceState: (state: WorkspacePersistedState) => void;
}

function isScopedProfile(value: unknown): value is ProcessProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<ProcessProfile>;
  return (
    typeof profile.id === "string" &&
    typeof profile.name === "string" &&
    (profile.kind === "build" || profile.kind === "test") &&
    typeof profile.repositoryRoot === "string" &&
    profile.repositoryRoot.trim().length > 0 &&
    typeof profile.program === "string" &&
    Array.isArray(profile.args)
  );
}

function isWorkspaceState(value: unknown): value is WorkspacePersistedState {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkspacePersistedState>;
  return (
    typeof item.repositoryId === "string" &&
    typeof item.activeWorktreePath === "string" &&
    typeof item.activeTab === "string" &&
    typeof item.updatedAt === "number"
  );
}

function sanitizeWorkspaceStates(value: unknown) {
  if (!value || typeof value !== "object") {
    return {} as Record<string, WorkspacePersistedState>;
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([id, item]) => isWorkspaceState(item) && item.repositoryId === id,
    ),
  ) as Record<string, WorkspacePersistedState>;
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      repositories: [],
      activeRepositoryId: null,
      profiles: [],
      workspaceStates: {},

      addRepository: (repository) =>
        set((state) => {
          const existing = state.repositories.find(
            (item) => item.path.toLowerCase() === repository.path.toLowerCase(),
          );

          if (existing) {
            return {
              repositories: state.repositories.map((item) =>
                item.id === existing.id
                  ? { ...item, name: repository.name, lastOpenedAt: Date.now() }
                  : item,
              ),
              activeRepositoryId: existing.id,
            };
          }

          return {
            repositories: [repository, ...state.repositories],
            activeRepositoryId: repository.id,
          };
        }),

      removeRepository: (id) =>
        set((state) => {
          const repositories = state.repositories.filter((item) => item.id !== id);
          const workspaceStates = { ...state.workspaceStates };
          delete workspaceStates[id];

          return {
            repositories,
            workspaceStates,
            activeRepositoryId:
              state.activeRepositoryId === id
                ? (repositories[0]?.id ?? null)
                : state.activeRepositoryId,
          };
        }),

      setActiveRepository: (id) => set({ activeRepositoryId: id }),

      addProfile: (profile) =>
        set((state) => ({
          profiles: [...state.profiles.filter((item) => item.id !== profile.id), profile],
        })),

      removeProfile: (id) =>
        set((state) => ({
          profiles: state.profiles.filter((item) => item.id !== id),
        })),

      saveWorkspaceState: (workspaceState) =>
        set((state) => ({
          workspaceStates: {
            ...state.workspaceStates,
            [workspaceState.repositoryId]: workspaceState,
          },
        })),
    }),
    {
      name: "virtuallab-workbench-v2",
      storage: createJSONStorage(() => window.localStorage),
      version: 4,
      migrate: (persistedState) => {
        const saved = persistedState as Partial<WorkbenchState>;
        return {
          ...saved,
          profiles: Array.isArray(saved.profiles)
            ? saved.profiles.filter(isScopedProfile)
            : [],
          workspaceStates: sanitizeWorkspaceStates(saved.workspaceStates),
        };
      },
      partialize: (state) => ({
        repositories: state.repositories,
        activeRepositoryId: state.activeRepositoryId,
        profiles: state.profiles,
        workspaceStates: state.workspaceStates,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<WorkbenchState>;
        return {
          ...current,
          ...saved,
          profiles: Array.isArray(saved.profiles)
            ? saved.profiles.filter(isScopedProfile)
            : [],
          workspaceStates: sanitizeWorkspaceStates(saved.workspaceStates),
        };
      },
    },
  ),
);
