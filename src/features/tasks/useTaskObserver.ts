import { useEffect } from 'react';
import { observeTasks } from '@/stores/tasks';
import type { RepositoryRecord } from '@/types/workbench';

/** Mount once in the persistent shell, independently of TaskControlCenter visibility. */
export function useTaskObserver(repositories: RepositoryRecord[]) {
  const rootsKey = JSON.stringify([...new Set(repositories.map(repository => repository.path))].sort());
  useEffect(() => observeTasks(JSON.parse(rootsKey) as string[]), [rootsKey]);
}
