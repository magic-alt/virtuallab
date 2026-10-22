import { useEffect, useMemo, useState } from 'react';
import { isDesktopRuntime } from '@/lib/backend';
import { readRepositoryTaskContext, type RepositoryTaskContext } from '@/lib/taskRecommendations';
import { workspaceKey } from '@/lib/workspaceKey';
import { refreshTaskProfiles, useTaskProfileStore } from '@/stores/taskProfiles';
import type { RepositoryRecord } from '@/types/workbench';
import { matchingRepositoryProfiles, repositoryRecommendations } from './repositoryRecommendations';

interface Snapshot { root: string; revision: number; context: RepositoryTaskContext | null; error: string | null; loading: boolean }
export function useRepositoryRecommendations(root: string, repositories: RepositoryRecord[], enabled = true) {
  const library = useTaskProfileStore();
  const key = workspaceKey(root);
  const available = enabled && isDesktopRuntime() && !!key && repositories.some(repository => workspaceKey(repository.path) === key);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => { if (available) void refreshTaskProfiles(); }, [available]);
  useEffect(() => {
    let disposed = false;
    if (!available) return;
    setSnapshot({ root: key, revision, context: null, error: null, loading: true });
    void readRepositoryTaskContext(root).then(context => {
      if (disposed) return;
      if (workspaceKey(context.repositoryRoot) !== key) throw new Error('返回的推荐不属于当前仓库。');
      setSnapshot({ root: key, revision, context, error: null, loading: false });
    }).catch(error => {
      if (!disposed) setSnapshot({ root: key, revision, context: null, error: error instanceof Error ? error.message : String(error), loading: false });
    });
    return () => { disposed = true; };
  }, [root, key, available, revision]);
  const current = available && snapshot?.root === key && snapshot.revision === revision ? snapshot : null;
  const context = current?.context ?? null;
  const recommendations = useMemo(() => context ? repositoryRecommendations(context, library.records) : [], [context, library.records]);
  const matchingProfiles = useMemo(() => context ? matchingRepositoryProfiles(context, library.records) : [], [context, library.records]);
  return { available, loading: available && (!current || current.loading), error: current?.error ?? null, context, recommendations, matchingProfiles, refresh: () => setRevision(value => value + 1) };
}
