import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskControlCenter as AgentsHub } from '@/features/tasks/TaskControlCenter';
import { useAgentsHubStore } from '@/stores/agentsHub';
import { useTaskStore } from '@/stores/tasks';

const repo = { id: 'repo', name: '工作仓库', path: '/repo', lastOpenedAt: 1 };

beforeEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  useAgentsHubStore.setState(useAgentsHubStore.getInitialState(), true);
  useTaskStore.setState({ tasks: [], loading: false, error: null, repositoryErrors: {},
    activeTaskId: null, filters: { query: '', repositoryRoot: '', attention: false } });
});

describe('Agents Hub unified surface', () => {
  it('starts with Agent tasks under one Hub heading', () => {
    render(<AgentsHub view="home" repositories={[repo]} activeRepository={repo} onOpenWorkspace={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Agents Hub' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Agent 任务' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '工作区会话' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByLabelText('你希望 Agent 完成什么？')).toBeVisible();
  });

  it('retains the task prompt while visiting workspace sessions and other app views', async () => {
    const onOpen = vi.fn();
    const page = render(<AgentsHub view="home" repositories={[repo]} activeRepository={repo} onOpenWorkspace={onOpen} />);
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'), '审查当前实现');
    await userEvent.click(screen.getByRole('tab', { name: '工作区会话' }));
    expect(screen.getByLabelText('你希望 Agent 完成什么？')).not.toBeVisible();
    expect(screen.getByRole('tab', { name: '工作区会话' })).toHaveAttribute('aria-selected', 'true');
    page.rerender(<AgentsHub view="settings" repositories={[repo]} activeRepository={repo} onOpenWorkspace={onOpen} />);
    page.rerender(<AgentsHub view="home" repositories={[repo]} activeRepository={repo} onOpenWorkspace={onOpen} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Agent 任务' }));
    expect(screen.getByLabelText('你希望 Agent 完成什么？')).toHaveValue('审查当前实现');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens Provider configuration in Hub while keeping Run a repository tool', async () => {
    const onOpen = vi.fn();
    const onHub = vi.fn();
    render(<AgentsHub view="settings" repositories={[repo]} activeRepository={repo} onOpenWorkspace={onOpen} onOpenControlCenter={onHub} />);
    await userEvent.click(screen.getByRole('button', { name: '管理 Provider 与会话' }));
    expect(useAgentsHubStore.getState()).toMatchObject({ section: 'sessions', sessionTarget: { repositoryRoot: '/repo', workspaceRoot: '/repo' } });
    expect(onHub).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '打开 Run 配置' }));
    expect(onOpen).toHaveBeenCalledWith('/repo', 'run', '/repo');
  });
});
