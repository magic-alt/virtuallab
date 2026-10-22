import { workspaceKey } from './workspaceKey';
import type { ContextRepository } from '@/types/workspaceContext';

export const MAX_CONTEXT_REPOSITORIES = 8;
export const EMPTY_CONTEXT_REPOSITORIES: ContextRepository[] = [];

/** UI identity only; Native validates canonical paths and worktree ownership. */
export function contextRepositoriesKey(references: readonly ContextRepository[] = []): string {
  return JSON.stringify(references.map(reference => [workspaceKey(reference.repositoryRoot), workspaceKey(reference.workspaceRoot)]).sort());
}

export function copyContextRepositories(references: readonly ContextRepository[] = []): ContextRepository[] {
  return references.map(({ repositoryRoot, workspaceRoot }) => ({ repositoryRoot, workspaceRoot }));
}
