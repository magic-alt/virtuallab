import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TaskList } from './TaskList';
import { taskFixture } from './fixtures';

describe('compact task collection', () => {
  it('distinguishes same-title failed and running tasks by identity and shows only each latest failure', async () => {
    const old = taskFixture({ id: 'older-task', title: '检查相关代码', attempts: [{
      id: 'old-attempt', state: 'failed', phase: 'implementation', startedAtMs: 1,
      endedAtMs: 2, failure: 'Codex 登录已失效', candidateSha: null, evidence: null,
    }] });
    const current = taskFixture({ id: 'current-task', title: old.title, goal: '检查相关代码\n修复 Git 提交错误',
      attempts: [old.attempts[0], { ...old.attempts[0], id: 'new-attempt', state: 'running', endedAtMs: null, failure: null }] });
    const open = vi.fn();
    render(<TaskList tasks={[current, old]} readiness={{}} repositories={[{ id: 'r', name: '仓库', path: '/repo', lastOpenedAt: 1 }]}
      selectedId={current.id} onOpenTask={open} />);
    const running = screen.getByRole('region', { name: '任务 current-task' });
    const failed = screen.getByRole('region', { name: '任务 older-task' });
    expect(within(running).getByText('运行中')).toBeVisible();
    expect(within(running).getByText('当前查看')).toBeVisible();
    expect(within(running).getByText('修复 Git 提交错误')).toBeVisible();
    expect(within(running).queryByText('Codex 登录已失效')).not.toBeInTheDocument();
    expect(within(failed).getByText('执行失败')).toBeVisible();
    expect(within(failed).getByText('Codex 登录已失效')).toBeVisible();
    await userEvent.click(within(failed).getByRole('button', { name: old.title }));
    expect(open).toHaveBeenCalledWith('older-task');
  });
});
