import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentsHubStore } from './agentsHub';

beforeEach(() => useAgentsHubStore.setState(useAgentsHubStore.getInitialState(), true));

describe('Agents Hub navigation', () => {
  it('opens an exact repository/workspace session without changing the repository tool selection', () => {
    const target = { repositoryRoot: '/repo', workspaceRoot: '/external/任务工作区' };
    useAgentsHubStore.getState().showSession(target);
    expect(useAgentsHubStore.getState()).toMatchObject({ section: 'sessions', sessionTarget: target, visibleSessionRoot: null });
  });

  it('clears notification visibility when switching sections or session targets', () => {
    const hub = useAgentsHubStore.getState();
    hub.showSession({ repositoryRoot: '/repo', workspaceRoot: '/work/a' });
    hub.setVisibleSessionRoot('/work/a');
    hub.showSession({ repositoryRoot: '/repo', workspaceRoot: '/work/b' });
    expect(useAgentsHubStore.getState().visibleSessionRoot).toBeNull();
    hub.setVisibleSessionRoot('/work/b');
    hub.showTasks();
    expect(useAgentsHubStore.getState()).toMatchObject({ section: 'tasks', visibleSessionRoot: null,
      sessionTarget: { repositoryRoot: '/repo', workspaceRoot: '/work/b' } });
  });
});
