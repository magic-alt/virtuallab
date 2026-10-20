import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';
import { NotificationCenter } from '@/features/notifications/NotificationCenter';
import { useTaskNotifications } from '@/stores/taskNotifications';
import { savePreferredEditor, usePreferredEditor } from '@/lib/externalEditor';
import { setTerminalFontSize } from '@/features/terminal/terminalAppearance';

function EditorConsumer() { return <output aria-label="当前 IDE">{usePreferredEditor()}</output>; }

beforeEach(() => {
  window.localStorage.clear();
  useTaskNotifications.setState({desktopEnabled:true,desktopError:null,notices:[]});
});

describe('global Settings', () => {
  it('changes persisted preferences and updates existing consumers without a repository', async () => {
    const user = userEvent.setup();
    render(<><SettingsView/><EditorConsumer/><NotificationCenter onNavigate={vi.fn()}/></>);
    await user.selectOptions(screen.getByLabelText('默认 IDE'), 'zed');
    expect(screen.getByLabelText('当前 IDE')).toHaveTextContent('zed');
    expect(localStorage.getItem('virtuallab-external-editor')).toBe('zed');
    act(() => savePreferredEditor('cursor'));
    expect(screen.getByLabelText('默认 IDE')).toHaveValue('cursor');

    await user.click(screen.getByRole('switch', {name:'桌面任务通知'}));
    expect(useTaskNotifications.getState().desktopEnabled).toBe(false);
    expect(localStorage.getItem('virtuallab.desktopTaskNotifications.v1')).toBe('off');
    await user.click(screen.getByRole('button', {name:'Task notifications'}));
    expect(screen.getByRole('switch', {name:/Desktop alerts/})).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('switch', {name:/Desktop alerts/}));
    expect(screen.getByRole('switch', {name:'桌面任务通知'})).toHaveAttribute('aria-checked','true');

    await user.selectOptions(screen.getByLabelText('终端字号'), '20');
    expect(localStorage.getItem('virtuallab.terminal.fontSize')).toBe('20');
    act(() => setTerminalFontSize(17));
    expect(screen.getByLabelText('终端字号')).toHaveValue('17');
    await user.selectOptions(screen.getByLabelText('终端回滚行数'), '16000');
    expect(localStorage.getItem('virtuallab.terminal.scrollback')).toBe('16000');
    await user.click(screen.getByRole('switch', {name:'终端光标闪烁'}));
    expect(localStorage.getItem('virtuallab.terminal.cursorBlink')).toBe('false');
  });

  it('shows notification failures and links to Agent settings without execution controls', async () => {
    const onOpenAgentSettings = vi.fn();
    useTaskNotifications.setState({desktopError:'permission denied'});
    render(<SettingsView onOpenAgentSettings={onOpenAgentSettings}/>);
    expect(screen.getByRole('status')).toHaveTextContent('permission denied');
    expect(screen.queryByLabelText('默认 Codex 可执行程序')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name:'打开 Agent 执行配置'}));
    expect(onOpenAgentSettings).toHaveBeenCalledOnce();
  });
});
