import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { workspaceKey } from '@/lib/workspaceKey';
import { MAX_CONTEXT_REPOSITORIES } from '@/lib/workspaceContext';
import type { ContextRepository } from '@/types/workspaceContext';

interface RepositoryContextState {
  contexts: Record<string, ContextRepository[]>;
  setContextRepositories: (repositoryRoot: string, references: readonly ContextRepository[]) => void;
  removeRepository: (repositoryRoot: string) => void;
  retainRepositories: (repositoryRoots: string[]) => void;
}

function sanitizeReferences(owner: string, value: unknown): ContextRepository[] {
  if (!Array.isArray(value)) return [];
  const result: ContextRepository[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate.repositoryRoot !== 'string' || typeof candidate.workspaceRoot !== 'string') continue;
    // Paths come from the native inventory; whitespace can be part of a name.
    // Keep their spelling intact so persistence cannot retarget a reference.
    const repositoryRoot = candidate.repositoryRoot;
    const workspaceRoot = candidate.workspaceRoot;
    const root = workspaceKey(repositoryRoot);
    if (!repositoryRoot.trim() || !workspaceRoot.trim() || root === workspaceKey(owner) || seen.has(root)) continue;
    seen.add(root);
    result.push({ repositoryRoot, workspaceRoot });
    if (result.length === MAX_CONTEXT_REPOSITORIES) break;
  }
  return result;
}

function sanitizeContexts(value: unknown): Record<string, ContextRepository[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([root]) => root.trim())
    .map(([root, references]) => [workspaceKey(root), sanitizeReferences(root, references)]));
}

export const useRepositoryContextStore = create<RepositoryContextState>()(persist((set) => ({
  contexts: {},
  setContextRepositories: (root, references) => set(state => ({ contexts: {
    ...state.contexts, [workspaceKey(root)]: sanitizeReferences(root, references),
  } })),
  removeRepository: root => set(state => {
    const key = workspaceKey(root);
    return { contexts: Object.fromEntries(Object.entries(state.contexts).filter(([owner]) => owner !== key)
      .map(([owner, references]) => [owner, references.filter(reference => workspaceKey(reference.repositoryRoot) !== key && workspaceKey(reference.workspaceRoot) !== key)])) };
  }),
  retainRepositories: roots => set(state => {
    const registered = new Set(roots.map(workspaceKey));
    const contexts = Object.fromEntries(Object.entries(state.contexts).filter(([owner]) => registered.has(owner))
      .map(([owner, references]) => [owner, references.filter(reference => registered.has(workspaceKey(reference.repositoryRoot)))]));
    return JSON.stringify(contexts) === JSON.stringify(state.contexts) ? state : { contexts };
  }),
}), {
  name: 'virtuallab-repository-context-v1',
  version: 1,
  storage: createJSONStorage(() => window.localStorage),
  partialize: state => ({ contexts: state.contexts }),
  merge: (stored, current) => ({ ...current, contexts: sanitizeContexts((stored as Partial<RepositoryContextState> | null)?.contexts) }),
}));
