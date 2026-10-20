import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ChangeEvent } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAgentPreferences as useLivePreferences } from './agentPreferences';

const KEY = 'virtuallab-codex-executable-v1';

describe('shared agent launcher preference', () => {
  beforeEach(() => { vi.resetModules(); window.localStorage.clear(); });

  it('hydrates the existing raw launcher key without replacing its format', async () => {
    const path = 'C:\\工具 路径\\codex.cmd';
    window.localStorage.setItem(KEY, path);
    const { useAgentPreferences } = await import('./agentPreferences');
    expect(useAgentPreferences.getState().codexExecutablePath).toBe(path);
    expect(window.localStorage.getItem(KEY)).toBe(path);
  });

  it('publishes changes to subscribers and removes the raw key for automatic detection', async () => {
    const { useAgentPreferences } = await import('./agentPreferences');
    const observed: string[] = [];
    const stop = useAgentPreferences.subscribe(state => observed.push(state.codexExecutablePath));
    useAgentPreferences.getState().setCodexExecutablePath('/tools/Codex launcher');
    expect(window.localStorage.getItem(KEY)).toBe('/tools/Codex launcher');
    useAgentPreferences.getState().setCodexExecutablePath('');
    expect(useAgentPreferences.getState().codexExecutablePath).toBe('');
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(observed).toEqual(['/tools/Codex launcher', '']);
    stop();
  });

  it('retains an in-memory choice when browser preference storage is unavailable', async () => {
    const { useAgentPreferences } = await import('./agentPreferences');
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    expect(() => useAgentPreferences.getState().setCodexExecutablePath('/tools/codex')).not.toThrow();
    expect(useAgentPreferences.getState().codexExecutablePath).toBe('/tools/codex');
  });

  it('preserves spaces during sequential editing of a launcher path', async () => {
    useLivePreferences.setState({ codexExecutablePath: '' });
    function LauncherField() {
      const value = useLivePreferences(state => state.codexExecutablePath);
      const setValue = useLivePreferences(state => state.setCodexExecutablePath);
      return createElement('input', { 'aria-label': 'Codex launcher', value, onChange: (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value) });
    }
    render(createElement(LauncherField));
    const path = '/tools/Codex launcher';
    await userEvent.type(screen.getByRole('textbox', { name: 'Codex launcher' }), path);
    expect(screen.getByRole('textbox', { name: 'Codex launcher' })).toHaveValue(path);
    expect(window.localStorage.getItem(KEY)).toBe(path);
  });
});
