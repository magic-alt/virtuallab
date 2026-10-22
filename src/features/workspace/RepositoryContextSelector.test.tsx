import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RepositoryContextSelector } from './RepositoryContextSelector';
import { useRepositoryContextStore } from '@/stores/repositoryContext';
import { PREVIEW_SNAPSHOT } from '@/data/preview';
const backend = vi.hoisted(() => ({ inspectRepository: vi.fn(), isDesktopRuntime: vi.fn(() => true) }));
vi.mock('@/lib/backend', () => backend);
const repositories = [
  { id: 'host', name: 'Host', path: '/host', lastOpenedAt: 1 },
  { id: 'firmware', name: 'Firmware', path: '/firmware', lastOpenedAt: 1 },
];
const snapshot = () => ({ ...PREVIEW_SNAPSHOT, root: '/firmware', currentBranch: 'main', worktrees: [
  { path: '/firmware', branch: 'main', head: 'a'.repeat(40), detached: false },
  { path: '/linked firmware', branch: 'protocol', head: 'b'.repeat(40), detached: false },
] });
beforeEach(() => {
  useRepositoryContextStore.setState({ contexts: {} });
  backend.isDesktopRuntime.mockReturnValue(true);
  backend.inspectRepository.mockReset().mockResolvedValue(snapshot());
});
describe('fixed companion workspace selection', () => {
  it('inspects only on expansion and preserves an explicitly selected linked worktree', async () => {
    const view = render(<RepositoryContextSelector repositoryRoot="/host" repositories={repositories}/>);
    expect(backend.inspectRepository).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText(/协作仓库/));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '引用 Firmware' })).toBeEnabled());
    await userEvent.click(screen.getByRole('checkbox', { name: '引用 Firmware' }));
    await userEvent.selectOptions(screen.getByLabelText('Firmware 参考工作区'), '/linked firmware');
    expect(useRepositoryContextStore.getState().contexts['/host']).toEqual([{ repositoryRoot: '/firmware', workspaceRoot: '/linked firmware' }]);
    view.rerender(<RepositoryContextSelector repositoryRoot="/host" primaryWorkspaceRoot="/host-review" repositories={repositories}/>);
    expect(screen.getByLabelText('Firmware 参考工作区')).toHaveValue('/linked firmware');
    expect(screen.getByText(/仅供参考/)).toBeInTheDocument();
  });
  it('cannot select a foreign or unavailable inventory and shows the failure', async () => {
    backend.inspectRepository.mockResolvedValue({ ...snapshot(), root: '/foreign' });
    render(<RepositoryContextSelector repositoryRoot="/host" repositories={repositories}/>);
    await userEvent.click(screen.getByText(/协作仓库/));
    expect(await screen.findByText(/清单与所选仓库不匹配/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '引用 Firmware' })).toBeDisabled();
  });
  it('ignores an inventory response after the owner changes', async () => {
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    backend.inspectRepository.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<RepositoryContextSelector repositoryRoot="/host" repositories={repositories}/>);
    await userEvent.click(screen.getByText(/协作仓库/));
    await waitFor(() => expect(backend.inspectRepository).toHaveBeenCalled());
    view.rerender(<RepositoryContextSelector repositoryRoot="/firmware" repositories={repositories}/>);
    await act(async () => finish(snapshot()));
    expect(useRepositoryContextStore.getState().contexts).toEqual({});
  });
});
