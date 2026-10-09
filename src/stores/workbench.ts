import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  ProcessProfile,
  RepositoryRecord,
  ReviewDraft,
  ReviewLoopPhase,
  WorkspacePersistedState,
  WorkspaceReviewState,
} from "@/types/workbench";

interface WorkbenchState {
  repositories: RepositoryRecord[];
  activeRepositoryId: string | null;
  profiles: ProcessProfile[];
  workspaceStates: Record<string, WorkspacePersistedState>;
  reviewStates: Record<string, WorkspaceReviewState>;
  addRepository: (repository: RepositoryRecord) => void;
  removeRepository: (id: string) => void;
  setActiveRepository: (id: string | null) => void;
  addProfile: (profile: ProcessProfile) => void;
  removeProfile: (id: string) => void;
  saveWorkspaceState: (state: WorkspacePersistedState) => void;
  addReviewDraft: (draft: ReviewDraft) => void;
  removeReviewDraft: (workspaceRoot: string, draftId: string) => void;
  markReviewDraftsStale: (workspaceRoot: string, headSha: string) => void;
  markReviewDraftPosted: (workspaceRoot: string, draftId: string, postedUrl: string) => void;
  setGithubReference: (workspaceRoot: string, reference: string | null) => void;
  setReviewPhase: (workspaceRoot: string, phase: ReviewLoopPhase, headSha?: string) => void;
}

export function reviewWorkspaceKey(path: string) {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function isScopedProfile(value: unknown): value is ProcessProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<ProcessProfile>;
  return (
    typeof profile.id === "string" &&
    typeof profile.name === "string" &&
    ["build", "test", "package", "deploy"].includes(profile.kind ?? "") &&
    typeof profile.repositoryRoot === "string" &&
    profile.repositoryRoot.trim().length > 0 &&
    typeof profile.program === "string" &&
    Array.isArray(profile.args) &&
    profile.args.every((arg) => typeof arg === "string") &&
    (profile.steps === undefined ||
      (Array.isArray(profile.steps) &&
        profile.steps.length > 0 &&
        profile.steps.length <= 12 &&
        profile.steps.every((step) =>
          typeof step.name === "string" &&
          typeof step.program === "string" &&
          Array.isArray(step.args) &&
          step.args.every((arg) => typeof arg === "string"),
        )))
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

function isReviewDraft(value: unknown): value is ReviewDraft {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReviewDraft>;
  return (
    typeof item.id === "string" &&
    typeof item.workspaceRoot === "string" &&
    typeof item.headSha === "string" &&
    typeof item.path === "string" &&
    typeof item.line === "number" &&
    item.line > 0 &&
    (item.side === "LEFT" || item.side === "RIGHT") &&
    typeof item.body === "string" &&
    (item.status === "active" || item.status === "stale" || item.status === "posted") &&
    typeof item.createdAt === "number" &&
    typeof item.updatedAt === "number"
  );
}

function isWorkspaceReviewState(value: unknown): value is WorkspaceReviewState {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkspaceReviewState>;
  return (
    typeof item.workspaceRoot === "string" &&
    Array.isArray(item.drafts) &&
    item.drafts.every(isReviewDraft) &&
    typeof item.updatedAt === "number" &&
    (item.githubReference == null || typeof item.githubReference === "string")
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

function sanitizeReviewStates(value: unknown) {
  if (!value || typeof value !== "object") {
    return {} as Record<string, WorkspaceReviewState>;
  }

  const entries = Object.entries(value)
    .filter(([, item]) => isWorkspaceReviewState(item))
    .map(([, item]) => {
      const state = item as WorkspaceReviewState;
      return [reviewWorkspaceKey(state.workspaceRoot), state] as const;
    });
  return Object.fromEntries(entries) as Record<string, WorkspaceReviewState>;
}

function updateReviewState(
  states: Record<string, WorkspaceReviewState>,
  workspaceRoot: string,
  update: (current: WorkspaceReviewState) => WorkspaceReviewState,
) {
  const key = reviewWorkspaceKey(workspaceRoot);
  const current = states[key] ?? {
    workspaceRoot,
    drafts: [],
    githubReference: null,
    updatedAt: Date.now(),
  };
  return {
    ...states,
    [key]: update(current),
  };
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      repositories: [],
      activeRepositoryId: null,
      profiles: [],
      workspaceStates: {},
      reviewStates: {},

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
          const removed = state.repositories.find((item) => item.id === id);
          const repositories = state.repositories.filter((item) => item.id !== id);
          const workspaceStates = { ...state.workspaceStates };
          delete workspaceStates[id];

          const reviewStates = Object.fromEntries(
            Object.entries(state.reviewStates).filter(([, item]) => {
              if (!removed) return true;
              return !reviewWorkspaceKey(item.workspaceRoot).startsWith(
                reviewWorkspaceKey(removed.path),
              );
            }),
          );

          return {
            repositories,
            workspaceStates,
            reviewStates,
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

      addReviewDraft: (draft) =>
        set((state) => ({
          reviewStates: updateReviewState(
            state.reviewStates,
            draft.workspaceRoot,
            (current) => ({
              ...current,
              workspaceRoot: draft.workspaceRoot,
              drafts: [...current.drafts.filter((item) => item.id !== draft.id), draft],
              updatedAt: Date.now(),
            }),
          ),
        })),

      removeReviewDraft: (workspaceRoot, draftId) =>
        set((state) => ({
          reviewStates: updateReviewState(
            state.reviewStates,
            workspaceRoot,
            (current) => ({
              ...current,
              drafts: current.drafts.filter((item) => item.id !== draftId),
              updatedAt: Date.now(),
            }),
          ),
        })),

      markReviewDraftsStale: (workspaceRoot, headSha) =>
        set((state) => ({
          reviewStates: updateReviewState(
            state.reviewStates,
            workspaceRoot,
            (current) => ({
              ...current,
              phase: current.phase === "reviewed" &&
                current.lastReviewedHead !== headSha ? "needs_rereview" : current.phase,
              drafts: current.drafts.map((draft) =>
                draft.status === "active" && draft.headSha !== headSha
                  ? {
                      ...draft,
                      status: "stale" as const,
                      updatedAt: Date.now(),
                    }
                  : draft,
              ),
              updatedAt: Date.now(),
            }),
          ),
        })),

      markReviewDraftPosted: (workspaceRoot, draftId, postedUrl) =>
        set((state) => ({
          reviewStates: updateReviewState(
            state.reviewStates,
            workspaceRoot,
            (current) => ({
              ...current,
              drafts: current.drafts.map((draft) =>
                draft.id === draftId
                  ? {
                      ...draft,
                      status: "posted" as const,
                      postedAt: Date.now(),
                      postedUrl,
                      updatedAt: Date.now(),
                    }
                  : draft,
              ),
              updatedAt: Date.now(),
            }),
          ),
        })),

      setReviewPhase: (workspaceRoot, phase, headSha) =>
        set((state) => ({
          reviewStates: updateReviewState(state.reviewStates,workspaceRoot,(current)=>({
            ...current,
            phase,
            lastReviewedHead: phase === "reviewed" ? (headSha ?? null) : current.lastReviewedHead,
            lastRefreshAt: phase === "needs_rereview" ? Date.now() : current.lastRefreshAt,
            updatedAt: Date.now(),
          })),
        })),

      setGithubReference: (workspaceRoot, reference) =>
        set((state) => ({
          reviewStates: updateReviewState(
            state.reviewStates,
            workspaceRoot,
            (current) => ({
              ...current,
              githubReference: reference,
              updatedAt: Date.now(),
            }),
          ),
        })),
    }),
    {
      name: "virtuallab-workbench-v2",
      storage: createJSONStorage(() => window.localStorage),
      version: 6,
      migrate: (persistedState) => {
        const saved = persistedState as Partial<WorkbenchState>;
        return {
          ...saved,
          profiles: Array.isArray(saved.profiles)
            ? saved.profiles.filter(isScopedProfile)
            : [],
          workspaceStates: sanitizeWorkspaceStates(saved.workspaceStates),
          reviewStates: sanitizeReviewStates(saved.reviewStates),
        };
      },
      partialize: (state) => ({
        repositories: state.repositories,
        activeRepositoryId: state.activeRepositoryId,
        profiles: state.profiles,
        workspaceStates: state.workspaceStates,
        reviewStates: state.reviewStates,
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
          reviewStates: sanitizeReviewStates(saved.reviewStates),
        };
      },
    },
  ),
);
