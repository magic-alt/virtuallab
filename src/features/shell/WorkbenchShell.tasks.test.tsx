import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkbenchStore } from '@/stores/workbench';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock('@/features/terminal/TerminalWorkspace', () => ({
  TerminalWorkspace: () => <div>Terminal rendering boundary</div>,
}));
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
    await user.click(screen.getByRole('button', { name: '控制中心' }));
    expect(workspace).not.toBeVisible();
    expect(workspace.isConnected).toBe(true);
    await user.click(screen.getByRole('button', { name: '工程仓库' }));
    expect(screen.getByTestId('workspace-main')).toBe(workspace);
    for (const name of ['报告','设置','控制中心']) {
      await user.click(screen.getByRole('button',{name}));
      expect(screen.getByTestId('workspace-main')).toBe(workspace);
      expect(workspace.isConnected).toBe(true);
    }

  });

  it('hides retained terminal panes when the operator visits another application view', async () => {
    const user = userEvent.setup();
    render(<WorkbenchShell />);
    await user.click(screen.getByRole('button', { name: '工程仓库' }));
    await user.click(screen.getByRole('button', { name: /^Terminal$/ }));
    const pane = screen.getByTestId('terminal-pane');
    expect(pane).toHaveAttribute('aria-hidden', 'false');

    for (const name of ['报告', '设置', '控制中心']) {
      await user.click(screen.getByRole('button', { name }));
      // Keeping the pane mounted must not leave its PTY resize/focus observer active.
      expect(pane.isConnected).toBe(true);
      expect(pane).toHaveAttribute('aria-hidden', 'true');
      await user.click(screen.getByRole('button', { name: '工程仓库' }));
      expect(screen.getByTestId('terminal-pane')).toBe(pane);
      expect(pane).toHaveAttribute('aria-hidden', 'false');
    }
  });

  it('keeps task work in the control center and exposes a report destination', () => {
    render(<WorkbenchShell />);
    expect(screen.queryByRole('button', { name: '任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '证据' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '报告' })).toBeInTheDocument();
  });
});
