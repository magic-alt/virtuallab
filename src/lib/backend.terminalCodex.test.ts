import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalSpawnCodex } from './backend';
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); invoke.mockClear(); });
describe('typed Codex terminal launch', () => {
  it('preserves paths and reference context as structured fields', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    const request = { id: 'pty', cwd: '/Host code', cols: 120, rows: 32, executablePath: 'C:/工具 & apps/codex.cmd',
      contextRepositories: [{ repositoryRoot: '/Firmware $(literal)', workspaceRoot: '/Firmware $(literal)/review' }] };
    await terminalSpawnCodex(request);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('terminal_spawn_codex', { request });
  });
  it('keeps a browser preview inert', async () => {
    await expect(terminalSpawnCodex({ id: 'pty', cwd: '/host', cols: 120, rows: 32, executablePath: null, contextRepositories: [] })).rejects.toThrow(/desktop/);
    expect(invoke).not.toHaveBeenCalled();
  });
});
