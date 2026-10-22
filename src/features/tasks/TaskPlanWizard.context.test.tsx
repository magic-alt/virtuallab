import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskPlanWizard } from './TaskPlanWizard';
import { useRepositoryContextStore } from '@/stores/repositoryContext';
import { useTaskStore } from '@/stores/tasks';
import type { TaskPlanRequest } from '@/types/tasks';
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
const host = { id: 'host', name: 'Host', path: '/host', lastOpenedAt: 1 };
const companion = { id: 'companion', name: 'Companion', path: '/companion', lastOpenedAt: 1 };
const references = [{ repositoryRoot: '/companion', workspaceRoot: '/companion-review' }];
beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  useTaskStore.setState({ tasks: [], roots: [], pending: {}, actionErrors: {} });
  useRepositoryContextStore.setState({ contexts: {} });
  native.invoke.mockReset().mockResolvedValue([]);
});
describe('advanced task context snapshot', () => {
  it('retains each prefilled reference through all wizard steps and native acceptance', async () => {
    const prefill: TaskPlanRequest = { repositoryRoot: host.path, expectedHeadSha: 'a'.repeat(40), tasks: [{
      key: 'impl-1', title: 'Protocol compatibility', goal: 'Inspect the companion protocol', scope: ['src'],
      kind: 'implementation', dependencyKeys: [], profile: null, autoCommit: false, contextRepositories: references,
    }] };
    render(<TaskPlanWizard repositories={[host, companion]} activeRepository={host} prefill={prefill} onClose={vi.fn()}/>);
    act(() => useRepositoryContextStore.getState().setContextRepositories(host.path, [{ repositoryRoot: companion.path, workspaceRoot: companion.path }]));
    for (let step = 0; step < 3; step++) await userEvent.click(screen.getByRole('button', { name: '下一步' }));
    await userEvent.click(screen.getByRole('button', { name: '接受手动计划' }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('task_accept_plan', { request: prefill }));
  });
});
