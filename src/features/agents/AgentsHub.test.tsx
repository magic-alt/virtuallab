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
  useTaskStore.setState(useTaskStore.getInitialState(), true);
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
    render(<AgentsHub view="home" repositories={[repo]} activeRepository={repo} onOpenWorkspace={onOpen} onOpenControlCenter={onHub} />);
    await userEvent.click(screen.getByRole('tab', { name: '执行配置' }));
    await userEvent.click(screen.getByRole('button', { name: '管理 Provider 与会话' }));
    expect(useAgentsHubStore.getState()).toMatchObject({ section: 'sessions', sessionTarget: { repositoryRoot: '/repo', workspaceRoot: '/repo' } });
    expect(onHub).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('tab', { name: '执行配置' }));
    await userEvent.click(screen.getByRole('button', { name: '打开 Run 配置' }));
    expect(onOpen).toHaveBeenCalledWith('/repo', 'run', '/repo');
  });

  it('retains unsaved Profile drafts across Hub sections and global settings', async () => {
    const props = { repositories: [repo], activeRepository: repo, onOpenWorkspace: vi.fn() };
    const page = render(<AgentsHub view="home" {...props} />);
    await userEvent.click(screen.getByRole('tab', { name: '执行配置' }));
    await userEvent.click(screen.getByRole('button', { name: '新建 Profile' }));
    await userEvent.clear(screen.getByLabelText('Profile 名称'));
    await userEvent.type(screen.getByLabelText('Profile 名称'), '待保存的构建配置');
    await userEvent.click(screen.getByRole('tab', { name: 'Agent 任务' }));
    await userEvent.click(screen.getByRole('tab', { name: '执行配置' }));
    expect(screen.getByLabelText('Profile 名称')).toHaveValue('待保存的构建配置');
    page.rerender(<AgentsHub view="settings" {...props} />);
    page.rerender(<AgentsHub view="home" {...props} />);
    expect(screen.getByLabelText('Profile 名称')).toHaveValue('待保存的构建配置');
  });

  it('keeps local task search editable when the shell supplies its empty global query', async () => {
    render(<AgentsHub view="home" searchQuery="" repositories={[repo]} activeRepository={repo} onOpenWorkspace={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('搜索任务'), '解析器');
    expect(screen.getByLabelText('搜索任务')).toHaveValue('解析器');
  });

  it('makes global settings usable without a repository or healthy task source', () => {
    useTaskStore.setState({ error: 'Task source unavailable' });
    render(<AgentsHub view="settings" repositories={[]} activeRepository={null} onOpenWorkspace={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeVisible();
    expect(screen.getByText('先添加一个仓库')).not.toBeVisible();
    expect(screen.queryByText(/Task source unavailable/)).not.toBeVisible();
    expect(screen.queryByLabelText('默认 Codex 可执行程序')).not.toBeInTheDocument();
  });

});
