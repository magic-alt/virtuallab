import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  ProcessProfile,
  RepositoryRecord,
} from "@/types/workbench";

const defaultProfiles = (): ProcessProfile[] => {
  const windows =
    typeof navigator !== "undefined" &&
    navigator.userAgent.toLowerCase().includes("windows");

  return [
    {
      id: "frontend-build",
      name: "Frontend build",
      kind: "build",
      program: windows ? "npm.cmd" : "npm",
      args: ["run", "build"],
    },
    {
      id: "rust-check",
      name: "Rust check",
      kind: "test",
      program: "cargo",
      args: ["check", "--manifest-path", "src-tauri/Cargo.toml"],
    },
  ];
};

interface WorkbenchState {
  repositories: RepositoryRecord[];
  activeRepositoryId: string | null;
  profiles: ProcessProfile[];
  addRepository: (repository: RepositoryRecord) => void;
  removeRepository: (id: string) => void;
  setActiveRepository: (id: string | null) => void;
  addProfile: (profile: ProcessProfile) => void;
  removeProfile: (id: string) => void;
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      repositories: [],
      activeRepositoryId: null,
      profiles: defaultProfiles(),

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

      addProfile: (profile) =>
        set((state) => ({
          profiles: [...state.profiles.filter((item) => item.id !== profile.id), profile],
        })),

      removeProfile: (id) =>
        set((state) => ({
          profiles: state.profiles.filter((item) => item.id !== id),
        })),
    }),
    {
      name: "virtuallab-workbench-v2",
      storage: createJSONStorage(() => window.localStorage),
      version: 2,
      partialize: (state) => ({
        repositories: state.repositories,
        activeRepositoryId: state.activeRepositoryId,
        profiles: state.profiles,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<WorkbenchState>;
        return {
          ...current,
          ...saved,
          profiles:
            saved.profiles && saved.profiles.length > 0
              ? saved.profiles
              : defaultProfiles(),
        };
      },
    },
  ),
);
