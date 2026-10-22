import { beforeEach, describe, expect, it } from 'vitest';
import { useRepositoryContextStore } from './repositoryContext';
import { useWorkbenchStore } from './workbench';

describe('repository collaboration context', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useRepositoryContextStore.setState({ contexts: {} });
    useWorkbenchStore.setState({ repositories: [], activeRepositoryId: null, workspaceStates: {}, reviewStates: {} });
  });

  it('persists fixed companion worktrees independently for each owner', async () => {
    const refs = [{ repositoryRoot: '/firmware', workspaceRoot: '/linked firmware' }];
    useRepositoryContextStore.getState().setContextRepositories('/host', refs);
    refs[0].workspaceRoot = '/changed-after-selection';
    useRepositoryContextStore.getState().setContextRepositories('/other', [{ repositoryRoot: '/library', workspaceRoot: '/library' }]);
    const saved = window.localStorage.getItem('virtuallab-repository-context-v1');
    useRepositoryContextStore.setState({ contexts: {} });
    window.localStorage.setItem('virtuallab-repository-context-v1', saved!);
    await useRepositoryContextStore.persist.rehydrate();
    expect(useRepositoryContextStore.getState().contexts).toEqual({
      '/host': [{ repositoryRoot: '/firmware', workspaceRoot: '/linked firmware' }],
      '/other': [{ repositoryRoot: '/library', workspaceRoot: '/library' }],
    });
  });

  it('normalizes Windows identities while preserving distinct POSIX owners', () => {
    const store = useRepositoryContextStore.getState();
    store.setContextRepositories('C:\\Host\\', [
      { repositoryRoot: 'C:/Firmware', workspaceRoot: 'C:/Firmware/review' },
      { repositoryRoot: 'c:\\firmware\\', workspaceRoot: 'c:\\firmware\\review\\' },
      { repositoryRoot: 'C:/Host', workspaceRoot: 'C:/Host' },
    ]);
    store.setContextRepositories('/Host', [{ repositoryRoot: '/Lib', workspaceRoot: '/Lib' }]);
    store.setContextRepositories('/host', [{ repositoryRoot: '/lib', workspaceRoot: '/lib' }]);
    expect(useRepositoryContextStore.getState().contexts['c:/host']).toHaveLength(1);
    expect(useRepositoryContextStore.getState().contexts['/Host'][0].workspaceRoot).toBe('/Lib');
    expect(useRepositoryContextStore.getState().contexts['/host'][0].workspaceRoot).toBe('/lib');
  });

  it('preserves trailing whitespace in companion paths across persistence', async () => {
    const references = [
      { repositoryRoot: '/reference 仓库 ', workspaceRoot: '/linked 工作区 ' },
      { repositoryRoot: '/reference 仓库', workspaceRoot: '/linked 工作区' },
    ];
    useRepositoryContextStore.getState().setContextRepositories('/host ', references);
    expect(useRepositoryContextStore.getState().contexts['/host ']).toEqual(references);

    const saved = window.localStorage.getItem('virtuallab-repository-context-v1');
    useRepositoryContextStore.setState({ contexts: {} });
    window.localStorage.setItem('virtuallab-repository-context-v1', saved!);
    await useRepositoryContextStore.persist.rehydrate();
    expect(useRepositoryContextStore.getState().contexts['/host ']).toEqual(references);
  });

  it('removes inbound references when a registered repository is removed', () => {
    const records = ['host', 'firmware', 'other'].map(id => ({ id, name: id, path: '/' + id, lastOpenedAt: 1 }));
    useWorkbenchStore.setState({ repositories: records });
    const store = useRepositoryContextStore.getState();
    store.setContextRepositories('/host', [{ repositoryRoot: '/firmware', workspaceRoot: '/firmware-review' }]);
    store.setContextRepositories('/firmware', [{ repositoryRoot: '/other', workspaceRoot: '/other' }]);
    store.setContextRepositories('/other', [{ repositoryRoot: '/host', workspaceRoot: '/host' }]);
    useWorkbenchStore.getState().removeRepository('firmware');
    expect(useRepositoryContextStore.getState().contexts['/host'] ?? []).toEqual([]);
    expect(useRepositoryContextStore.getState().contexts['/firmware']).toBeUndefined();
    expect(useRepositoryContextStore.getState().contexts['/other']).toHaveLength(1);
  });

  it('drops malformed persisted entries and bounds reference selection to eight', async () => {
    window.localStorage.setItem('virtuallab-repository-context-v1', JSON.stringify({ version: 1, state: { contexts: {
      '/host': [null, {}, { repositoryRoot: 2, workspaceRoot: '/bad' },
        { repositoryRoot: ' ', workspaceRoot: '/bad' }, { repositoryRoot: '/bad', workspaceRoot: ' ' },
        ...Array.from({ length: 10 }, (_, i) => ({ repositoryRoot: '/repo-' + i, workspaceRoot: '/tree-' + i }))],
    } } }));
    await useRepositoryContextStore.persist.rehydrate();
    expect(useRepositoryContextStore.getState().contexts['/host']).toHaveLength(8);
    expect(useRepositoryContextStore.getState().contexts['/host'][0].repositoryRoot).toBe('/repo-0');
  });
});
