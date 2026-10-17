import { workspaceKey } from '@/lib/workspaceKey';
import { validateVerificationProfile } from '@/lib/verification';
import type { TaskRecord, TaskReadiness, TaskPlanRequest, TaskVerificationProfile } from '@/types/tasks';

export function taskStatus(task: TaskRecord, ready?: TaskReadiness) {
  const latest = task.attempts.at(-1);
  return {
    execution: latest?.state ?? 'not_started',
    checks: latest?.evidence?.status ?? 'not_run',
    readiness: ready?.status ?? 'unavailable',
    acceptance: task.acceptance ? ready ? ready.acceptanceCurrent ? 'current' : 'stale' : 'unknown' : 'none',
  };
}
export function needsAttention(task: TaskRecord, ready?: TaskReadiness) {
  const state = task.attempts.at(-1)?.state;
  return !ready || ready.status === 'blocked' || ready.status === 'warning'
    || ['failed', 'interrupted', 'stopping'].includes(state ?? '')
    || (!!task.acceptance && !ready.acceptanceCurrent) || (!!task.review && !ready.reviewCurrent);
}
export function filterTasks(tasks: TaskRecord[], readiness: Record<string, TaskReadiness>, filter: { repositoryRoot?: string; query?: string; attention?: boolean }) {
  const query = filter.query?.trim().toLocaleLowerCase();
  return tasks.filter(task => (!filter.repositoryRoot || workspaceKey(task.repositoryRoot) === workspaceKey(filter.repositoryRoot))
    && (!query || [task.id, task.title, task.goal, ...task.scope].join(' ').toLocaleLowerCase().includes(query))
    && (!filter.attention || needsAttention(task, readiness[task.id])));
}
function safeRelative(path: string) {
  return !!path.trim() && path.length <= 1024 && !/[\\\x00-\x1f:*?\[\]<>|"]/.test(path)
    && !path.startsWith('/') && !path.split('/').some(segment => !segment || segment === '.' || segment === '..'
      || /[. ]$/.test(segment) || segment.toLowerCase() === '.git' || /^\.env(?:[.-]|$)/i.test(segment));
}
export function parseTaskProfile(json: string): TaskVerificationProfile | null {
  const value: unknown = JSON.parse(json);
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('Profile 必须为对象或 null。');
  const profile = value as TaskVerificationProfile;
  validateVerificationProfile(profile);
  for (const gate of profile.gates) {
    if (!['build','unit','hil','hardware','soak','evidence'].includes(gate.kind)
      || typeof gate.required !== 'boolean' || !['none','human'].includes(gate.approval)) throw new Error('Profile gate 字段无效。');
    if (gate.executor.type === 'process') {
      if (!Array.isArray(gate.executor.args) || gate.executor.args.some(arg => typeof arg !== 'string')
        || !['workspace','repository'].includes(gate.executor.cwd)) throw new Error('Profile 使用 program 和参数数组。');
    } else if (gate.executor.type !== 'adapter' || !['hil','hardware'].includes(gate.executor.adapter)) throw new Error('Profile executor 无效。');
  }
  for (const key of ['sourcePaths','outputPaths'] as const) {
    if (profile[key] !== undefined && (!Array.isArray(profile[key]) || profile[key]!.some(path => typeof path !== 'string' || !safeRelative(path)))) {
      throw new Error(`Profile ${key} 必须是安全的相对路径数组，不能包含 .git 或 .env。`);
    }
  }
  if (profile.toolchainPrograms !== undefined) {
    if (!Array.isArray(profile.toolchainPrograms) || profile.toolchainPrograms.some(program => {
      if (typeof program !== 'string' || !program.trim() || /[\x00-\x1f]/.test(program)) return true;
      const absolute = /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(program);
      return !absolute && (!/^[a-z0-9_+.-]+$/i.test(program) || program.startsWith('-') || program === '.' || program === '..');
    })) throw new Error('Profile toolchainPrograms 仅支持命令名或绝对可执行路径，不含参数。');
  }
  return profile;
}
export function validateTaskPlan(request: TaskPlanRequest, existing: TaskRecord[] = []): string[] {
  const errors: string[] = [];
  if (!request.repositoryRoot.trim()) errors.push('请选择仓库。');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.expectedHeadSha)) errors.push('HEAD 必须为完整的小写提交 SHA（40 或 64 位）。');
  if (!request.tasks.length || request.tasks.length > 32) errors.push('计划需要 1–32 个任务。');
  const keys = new Set<string>();
  const existingIds = new Set(existing.filter(t => workspaceKey(t.repositoryRoot) === workspaceKey(request.repositoryRoot)).map(t => t.id));
  for (const task of request.tasks) {
    if (!/^[a-z0-9_-]{1,64}$/i.test(task.key) || keys.has(task.key) || existingIds.has(task.key)) errors.push('任务键必须为 1–64 位 ASCII 字母、数字、_ 或 -，且唯一。');
    keys.add(task.key);
    if (!task.title.trim() || !task.goal.trim()) errors.push(`${task.key}: 需要标题和目标。`);
    if (!task.scope.length || task.scope.length > 128 || new Set(task.scope).size !== task.scope.length || task.scope.some(path => !safeRelative(path))) errors.push(`${task.key}: 范围必须为安全的相对路径。`);
    if (task.kind !== 'implementation' && task.kind !== 'integration') errors.push(`${task.key}: 类型无效。`);
    if (task.profile) { try {parseTaskProfile(JSON.stringify(task.profile));} catch (error) {errors.push(`${task.key}: Profile ${String(error)}`);} }
  }
  const byKey = new Map(request.tasks.map(task => [task.key, task]));
  for (const task of request.tasks) for (const dependency of task.dependencyKeys) {
    if (!keys.has(dependency) && !existingIds.has(dependency)) errors.push(`${task.key}: 未知或跨仓库依赖 ${dependency}。`);
  }
  const visited = new Set<string>(); const active = new Set<string>();
  function visit(key: string): boolean {
    if (active.has(key)) return true;
    if (visited.has(key)) return false;
    active.add(key);
    for (const dep of byKey.get(key)?.dependencyKeys ?? []) if (keys.has(dep) && visit(dep)) return true;
    active.delete(key); visited.add(key); return false;
  }
  if (request.tasks.some(task => visit(task.key))) errors.push('任务依赖包含循环。');
  return [...new Set(errors)];
}
export const statusLabels: Record<string, string> = {
  not_started:'未开始', queued:'排队 / 等待依赖', running:'运行中', stopping:'正在停止', succeeded:'执行完成', failed:'执行失败', cancelled:'已取消', interrupted:'已中断',
  pass:'PASS（已观察）', warn:'有警告', fail:'FAIL（已观察）', not_run:'未运行', blocked:'被阻止', ready:'可交付', warning:'有警告', unverified:'未验证', unavailable:'原生来源不可用',
  current:'当前修订已验收', stale:'验收已过期', unknown:'验收适用性未知', none:'未验收',
};
