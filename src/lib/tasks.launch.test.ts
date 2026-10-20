import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({invoke:vi.fn(),listen:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:native.listen}));
import * as api from './tasks';
import { draftFixture } from '@/features/tasks/fixtures';

beforeEach(()=>{
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
  native.invoke.mockReset().mockResolvedValue(null);
  native.listen.mockReset().mockResolvedValue(vi.fn());
});
describe('native launch and report boundary',()=>{
  it('preserves the idempotent request and keeps executable identity separate from the task text',async()=>{
    const request={requestId:'unique-request',plan:{repositoryRoot:'C:/工程',expectedHeadSha:'a'.repeat(40),tasks:[draftFixture({goal:'修复 git；保留 Unicode'})]},executablePath:'C:/Program Files/Codex/codex.cmd'};
    await api.launchTask(request);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('task_launch',{request});
  });
  it('scopes report queries and invalidation events to native task and attempt IDs',async()=>{
    await api.getTaskAttemptReport('task','attempt');
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('task_attempt_report',{request:{taskId:'task',attemptId:'attempt'}});
    const handler=vi.fn();
    await api.subscribeTaskReportEvents(handler);
    const [name,listener]=native.listen.mock.calls[0];
    expect(name).toBe('task://report');
    const payload={taskId:'task',attemptId:'attempt',sequence:8};
    listener({payload});
    expect(handler).toHaveBeenCalledExactlyOnceWith(payload);
  });
  it('reads durable startup failures without inventing an execution attempt',async()=>{
    native.invoke.mockResolvedValue('Worktree target exists; reconcile retained task');
    await expect(api.getTaskLaunchError('retained-task')).resolves.toContain('target exists');
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('task_launch_error',{taskId:'retained-task'});
  });
  it('never fabricates execution or reports in browser preview',async()=>{
    Reflect.deleteProperty(window,'__TAURI_INTERNALS__');
    await expect(api.launchTask({requestId:'r',plan:{repositoryRoot:'/repo',expectedHeadSha:'a'.repeat(40),tasks:[draftFixture()]},executablePath:null})).rejects.toThrow(/桌面/);
    await expect(api.getTaskAttemptReport('task','attempt')).rejects.toThrow(/桌面/);
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
