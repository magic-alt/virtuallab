import type { TaskRecord } from '@/types/tasks';
import { statusLabels } from './model';

export type TaskActivity = 'active' | 'finished' | 'idle';

export function taskActivity(task: TaskRecord): TaskActivity {
  const state = task.attempts.at(-1)?.state;
  return !state ? 'idle' : ['queued', 'running', 'stopping'].includes(state) ? 'active' : 'finished';
}

/** Execution comes from the latest native Attempt, never from output text. */
export function executionLabel(task: TaskRecord): string {
  const attempt = task.attempts.at(-1);
  if (attempt?.phase === 'verification') {
    if (attempt.state === 'failed') return '验证失败';
    if (attempt.state === 'running') return '验证中';
    if (attempt.state === 'succeeded') return '验证结束';
  }
  return statusLabels[attempt?.state ?? 'not_started'];
}

export function sortTaskCollection(tasks: TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => Number(taskActivity(b) === 'active') - Number(taskActivity(a) === 'active')
    || b.updatedAtMs - a.updatedAtMs || b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id));
}

export function taskGoalPreview(task: TaskRecord): string {
  const goal = task.goal.trim();
  const remainder = goal.startsWith(task.title) ? goal.slice(task.title.length).trim() : goal;
  return (remainder || goal).replace(/\s+/g, ' ');
}
