import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkbenchStore } from '@/stores/workbench';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock('@/features/terminal/TerminalWorkspace', () => ({ TerminalWorkspace: () => <div>Terminal rendering boundary</div> }));
vi.mock('@/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/backend')>(), isDesktopRuntime: () => false,
}));
import { WorkbenchShell } from './WorkbenchShell';

describe('Task-first application navigation', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({ repositories: [], activeRepositoryId: null, workspaceStates: {} });
  });
  it('opens a fresh installation at the control center without starting native work', () => {
    render(<WorkbenchShell />);
    expect(screen.getByRole('navigation', { name: '工程控制中心导航' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '控制中心' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '工程仓库' })).not.toHaveAttribute('aria-current');
  });
  it('keeps the workspace host mounted across application navigation', async () => {
    const user = userEvent.setup(); render(<WorkbenchShell />);
    const workspace = screen.getByTestId('workspace-main');
    await user.click(screen.getByRole('button', { name: '工程仓库' }));
    expect(workspace).toBeVisible();
    await user.click(screen.getByRole('button', { name: '任务' }));
    expect(workspace).not.toBeVisible();
    expect(workspace.isConnected).toBe(true);
    await user.click(screen.getByRole('button', { name: '工程仓库' }));
    expect(screen.getByTestId('workspace-main')).toBe(workspace);
    for (const name of ['证据','设置','控制中心','任务']) {
      await user.click(screen.getByRole('button',{name}));
      expect(screen.getByTestId('workspace-main')).toBe(workspace);
      expect(workspace.isConnected).toBe(true);
    }

  });
});
