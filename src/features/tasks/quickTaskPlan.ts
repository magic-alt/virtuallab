import type { TaskPlanRequest, TaskVerificationProfile } from '@/types/tasks';
import type { ContextRepository } from '@/types/workspaceContext';
import { copyContextRepositories } from '@/lib/workspaceContext';

/** A single natural-language task does not require a qualified AI planning provider. */
export function quickScopePaths(value: string): string[] {
  return value.split(/\r?\n/).map(line => line.trim().replaceAll('\\', '/').replace(/\/+$/, '')).filter(Boolean);
}

function boundedTitle(description: string): string {
  const first = description.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  const plain = first.replace(/^[#>*\s-]+/, '').trim() || first;
  // Native title validation is byte-based (256 bytes), not JS string-length-based.
  let title = '';
  const encoder = new TextEncoder();
  for (const char of plain) {
    if (encoder.encode(title + char).byteLength > 200) break;
    title += char;
  }
  return title.trim();
}

export function quickTaskPlan(options: {
  repositoryRoot: string;
  headSha: string;
  description: string;
  scopeText: string | null;
  profile: TaskVerificationProfile | null;
  autoCommit: boolean;
  contextRepositories?: ContextRepository[];
}): TaskPlanRequest {
  const goal = options.description.trim();
  return {
    repositoryRoot: options.repositoryRoot,
    expectedHeadSha: options.headSha,
    tasks: [{
      key: 'impl-1',
      title: boundedTitle(goal),
      goal,
      scope: options.scopeText === null ? ['.'] : quickScopePaths(options.scopeText),
      kind: 'implementation',
      dependencyKeys: [],
      profile: options.profile ? structuredClone(options.profile) : null,
      autoCommit: options.autoCommit,
      ...(options.contextRepositories?.length ? { contextRepositories: copyContextRepositories(options.contextRepositories) } : {}),
    }],
  };
}
