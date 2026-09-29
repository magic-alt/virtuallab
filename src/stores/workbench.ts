import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { RepositoryRecord } from "@/types/workbench";

interface WorkbenchState {
  repositories: RepositoryRecord[];
  activeRepositoryId: string | null;
  addRepository: (repository: RepositoryRecord) => void;
  removeRepository: (id: string) => void;
  setActiveRepository: (id: string | null) => void;
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      repositories: [],
      activeRepositoryId: null,

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
          return {
            repositories,
            activeRepositoryId:
              state.activeRepositoryId === id
                ? (repositories[0]?.id ?? null)
                : state.activeRepositoryId,
          };
        }),

      setActiveRepository: (id) => set({ activeRepositoryId: id }),
    }),
    {
      name: "virtuallab-workbench-v1",
      partialize: (state) => ({
        repositories: state.repositories,
        activeRepositoryId: state.activeRepositoryId,
      }),
    },
  ),
);
