import { describe, expect, it } from 'vitest';
import { taskFixture } from './fixtures';
import { executionLabel, sortTaskCollection, taskActivity, taskGoalPreview } from './taskPresentation';
import type { TaskAttempt } from '@/types/tasks';

const attempt = (state: TaskAttempt['state'], phase: TaskAttempt['phase'] = 'implementation'): TaskAttempt => ({
  id: 'a', state, phase, failure: null, candidateSha: null, evidence: null, startedAtMs: 1, endedAtMs: null,
});

describe('task collection presentation', () => {
  it('uses the latest native attempt and distinguishes verification from execution failure', () => {
    const task = taskFixture({ attempts: [attempt('failed'), attempt('running')] });
    expect(taskActivity(task)).toBe('active');
    expect(executionLabel(task)).toBe('运行中');
    expect(executionLabel(taskFixture({ attempts: [attempt('failed', 'verification')] }))).toBe('验证失败');
    expect(executionLabel(taskFixture({ attempts: [attempt('running', 'verification')] }))).toBe('验证中');
    expect(taskActivity(taskFixture())).toBe('idle');
  });

  it('keeps active work above historical tasks and sorts history by recent update without mutation', () => {
    const old = taskFixture({ id: 'old', updatedAtMs: 1, attempts: [attempt('failed')] });
    const recent = taskFixture({ id: 'recent', updatedAtMs: 3, attempts: [attempt('succeeded')] });
    const active = taskFixture({ id: 'active', updatedAtMs: 2, attempts: [attempt('running')] });
    const input = [old, recent, active];
    expect(sortTaskCollection(input).map(task => task.id)).toEqual(['active', 'recent', 'old']);
    expect(input).toEqual([old, recent, active]);
  });

  it('shows meaningful goal context below repeated title prefixes', () => {
    expect(taskGoalPreview(taskFixture({ title: '检查代码', goal: '检查代码\n修复串口连接问题' }))).toBe('修复串口连接问题');
    expect(taskGoalPreview(taskFixture({ title: '检查代码', goal: '检查代码' }))).toBe('检查代码');
  });
});
