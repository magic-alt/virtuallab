import type { TaskRecord, TaskReadiness, TaskDraft } from '@/types/tasks';
export const taskFixture = (patch: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 'task-1', repositoryRoot: '/repo', title: '修复解析器', goal: '支持 Unicode', scope: ['src'], baseSha: 'base', kind: 'implementation', dependencies: [], profile: null, autoCommit: false, revision: 1, workspaceRoot: '/work/task-1', attempts: [], review: null, acceptance: null, createdAtMs: 1, updatedAtMs: 1, ...patch,
});
export const readinessFixture = (patch: Partial<TaskReadiness> = {}): TaskReadiness => ({status: 'unverified', blockers: [], warnings: [], candidateSha: null, reviewCurrent: false, acceptanceCurrent: false, ...patch});
export const draftFixture = (patch: Partial<TaskDraft> = {}): TaskDraft => ({key: 'impl', title: '实现', goal: '完成目标', scope: ['src'], kind: 'implementation', dependencyKeys: [], profile: null, autoCommit: false, ...patch});
