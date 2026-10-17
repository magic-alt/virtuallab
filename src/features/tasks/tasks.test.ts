import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({invoke: vi.fn(), listen: vi.fn(), confirm: vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({invoke: native.invoke}));
vi.mock('@tauri-apps/api/event', () => ({listen: native.listen}));
vi.mock('@tauri-apps/plugin-dialog', () => ({confirm: native.confirm, open: vi.fn()}));
import * as api from '@/lib/tasks';
import { observeTasks, refreshTasks, runTaskAction, runTaskCancellation, useTaskStore } from '@/stores/tasks';
import { filterTasks, parseTaskProfile, taskStatus, validateTaskPlan } from './model';
import { draftFixture, readinessFixture, taskFixture } from './fixtures';
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {promise, resolve}; }
beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {value: {}, configurable: true});
  native.invoke.mockReset(); native.confirm.mockReset(); native.listen.mockReset().mockResolvedValue(vi.fn());
  useTaskStore.setState({tasks: [], readiness: {}, readinessErrors: {}, events: [], error: null, actionErrors: {}, pending: {}, cancelling: {}, roots: [], loading: false, activeTaskId: null});
});
describe('typed task boundary', () => {
  it('preserves profile source/output identity and all exact request envelopes', async () => {
    native.invoke.mockResolvedValue(taskFixture());
    const profile = {schemaVersion: 1 as const, id: 'p', name: '检查', gates: [{id:'t',label:'test',kind:'unit' as const,required:true,approval:'none' as const,executor:{type:'process' as const,program:'npm',args:['test'],cwd:'workspace' as const}}], sourcePaths:['ignored/source'],outputPaths:['dist']};
    const request = {repositoryRoot:'/repo',expectedHeadSha:'base',tasks:[draftFixture({profile})]};
    await api.acceptTaskPlan(request); expect(native.invoke).toHaveBeenLastCalledWith('task_accept_plan',{request});
    await api.prepareTaskWorkspace({taskId:'t',branch:'task/t',targetPath:null}); expect(native.invoke).toHaveBeenLastCalledWith('task_prepare_workspace',{request:{taskId:'t',branch:'task/t',targetPath:null}});
    for (const [fn, command] of [[api.startTask,'task_start'],[api.retryTask,'task_retry']] as const) {await fn('t',null);expect(native.invoke).toHaveBeenLastCalledWith(command,{request:{taskId:'t',executablePath:null}});}
    for (const [fn, command] of [[api.reconcileTaskWorkspace,'task_reconcile_workspace'],[api.cancelTask,'task_cancel'],[api.verifyTask,'task_verify'],[api.previewTaskIntegration,'task_integration_preview'],[api.exportTaskPassport,'task_export_passport']] as const) {await fn('t');expect(native.invoke).toHaveBeenLastCalledWith(command,{request:{taskId:'t'}});}
    await api.reviewTask({taskId:'t',expectedHeadSha:'sha',note:'ok',approved:true}); expect(native.invoke).toHaveBeenLastCalledWith('task_review',{request:{taskId:'t',expectedHeadSha:'sha',note:'ok',approved:true}});
    await api.acceptTaskResult({taskId:'t',expectedHeadSha:'sha',acknowledgedWarnings:true}); expect(native.invoke).toHaveBeenLastCalledWith('task_accept_result',{request:{taskId:'t',expectedHeadSha:'sha',acknowledgedWarnings:true}});
    await api.listTasks(['/repo']); expect(native.invoke).toHaveBeenLastCalledWith('task_list',{repositoryRoots:['/repo']});
    await api.getTask('t'); expect(native.invoke).toHaveBeenLastCalledWith('task_get',{taskId:'t'});
    await api.getTaskEvents(4); expect(native.invoke).toHaveBeenLastCalledWith('task_events',{afterSeq:4});
    await api.getTaskReadiness('t'); expect(native.invoke).toHaveBeenLastCalledWith('task_readiness',{taskId:'t'});
  });
  it('delegates the sole confirmation to native and rejects expired previews', async () => {
    const preview = {planId:'p',taskId:'t',repositoryRoot:'/repo',workspaceRoot:'/sibling/integration',targetHeadSha:'target',sourceCommits:['one','two'],expiresAtMs:Date.now()+60_000};
    native.invoke.mockRejectedValueOnce(new Error('Integration cancelled'));
    await expect(api.confirmTaskIntegration(preview)).rejects.toThrow('cancelled');
    expect(native.confirm).not.toHaveBeenCalled();
    native.invoke.mockResolvedValueOnce(taskFixture());
    await api.confirmTaskIntegration(preview);
    expect(native.invoke).toHaveBeenLastCalledWith('task_integration_confirm',{request:{planId:'p'}});
    native.invoke.mockClear(); await expect(api.confirmTaskIntegration({...preview,expiresAtMs:0})).rejects.toThrow(/过期/);expect(native.invoke).not.toHaveBeenCalled();
  });
  it('browser preview never fabricates native task data', async () => {
    Reflect.deleteProperty(window,'__TAURI_INTERNALS__');
    await expect(api.listTasks(['/repo'])).rejects.toThrow(/桌面/); expect(native.invoke).not.toHaveBeenCalled();
  });
});
describe('task semantics and manual plan validation', () => {
  it('never infers check PASS, readiness or acceptance from successful execution', () => {
    const task = taskFixture({attempts:[{id:'a',state:'succeeded',phase:'implementation',candidateSha:'sha',failure:null,startedAtMs:1,endedAtMs:2,evidence:null}]});
    expect(taskStatus(task, undefined)).toEqual({execution:'succeeded',checks:'not_run',readiness:'unavailable',acceptance:'none'});
    expect(taskStatus(task,readinessFixture({status:'blocked'})).readiness).toBe('blocked');
  });
  it('attention includes native warnings, failures and stale acceptance; filters by repository and query', () => {
    const a = taskFixture(); const b=taskFixture({id:'b',repositoryRoot:'/other',title:'其他'});
    expect(filterTasks([a,b],{[a.id]:readinessFixture({status:'warning'})},{repositoryRoot:'/repo',query:'Unicode',attention:true})).toEqual([a]);
    expect(filterTasks([a],{}, {attention:true})).toEqual([a]);
    expect(filterTasks([taskFixture({repositoryRoot:'C:/Repo'})],{}, {repositoryRoot:'c:\\repo\\'})).toHaveLength(1);
  });
  it('rejects unsafe literal paths and malformed baseline before the manual plan can be accepted', () => {
    const plan={repositoryRoot:'/repo',expectedHeadSha:'b'.repeat(40),tasks:[draftFixture()]};
    for (const path of ['src/','src/*','./src','src//file','.env-secret','src/\u0000file']) {
      expect(validateTaskPlan({...plan,tasks:[draftFixture({scope:[path]})]}).join()).toMatch(/范围/);
    }
    expect(validateTaskPlan({...plan,expectedHeadSha:'not-a-full-sha'}).join()).toMatch(/HEAD/);
    expect(validateTaskPlan({...plan,tasks:[draftFixture({key:'含空格 key'})]}).join()).toMatch(/任务键/);
  });
  it('preserves toolchain executable identities but rejects arguments and relative paths', () => {
    const base = {schemaVersion:1,id:'p',name:'p',gates:[{id:'u',label:'u',kind:'unit',required:true,approval:'none',executor:{type:'process',program:'npm',args:['test'],cwd:'workspace'}}]};
    const profile={...base,toolchainPrograms:['c++','/usr/bin/clang++','C:\\Program Files\\Toolchain\\cl.exe']};
    expect(parseTaskProfile(JSON.stringify(profile))?.toolchainPrograms).toEqual(profile.toolchainPrograms);
    for(const executable of ['cmake --version','../compiler','compiler/bin/cc','$(whoami)','cc;echo','']) {
      expect(()=>parseTaskProfile(JSON.stringify({...base,toolchainPrograms:[executable]}))).toThrow(/toolchainPrograms/);
    }
  });
  it('validates dependency keys, cycles, scope, profile JSON and safe relative output paths', () => {
    expect(validateTaskPlan({repositoryRoot:'/repo',expectedHeadSha:'b'.repeat(40),tasks:[draftFixture(),draftFixture({key:'merge',kind:'integration',dependencyKeys:['impl']})]})).toEqual([]);
    expect(validateTaskPlan({repositoryRoot:'/repo',expectedHeadSha:'',tasks:[]} ).join()).toMatch(/HEAD/);
    const validate = (tasks: ReturnType<typeof draftFixture>[]) => validateTaskPlan({repositoryRoot:'/repo',expectedHeadSha:'b'.repeat(40),tasks}).join();
    expect(validate([draftFixture({scope:['../escape']})])).toMatch(/范围/);
    expect(validate([draftFixture({dependencyKeys:['missing']})])).toMatch(/依赖/);
    expect(validate([draftFixture({dependencyKeys:['merge']}),draftFixture({key:'merge',dependencyKeys:['impl']})])).toMatch(/循环/);
    expect(validate([draftFixture({profile:{schemaVersion:1,id:'p',name:'p',gates:[],outputPaths:['.env']}})])).toMatch(/Profile/);
  });
});
describe('single task observer generation guards', () => {
  it('ignores delayed list and readiness from removed repositories and late listener setup', async () => {
    const first=deferred<ReturnType<typeof taskFixture>[]>(); const unlisten=vi.fn(); const listener=deferred<() => void>();
    native.listen.mockReturnValueOnce(listener.promise);
    native.invoke.mockImplementation((cmd, args) => cmd==='task_list' ? args.repositoryRoots[0]==='/repo' ? first.promise : Promise.resolve([taskFixture({id:'other',repositoryRoot:'/other'})]) : Promise.resolve(cmd==='task_events'?[]:readinessFixture()));
    const stopA=observeTasks(['/repo']); stopA(); const stopB=observeTasks(['/other']);
    first.resolve([taskFixture()]); listener.resolve(unlisten);
    await vi.waitFor(() => expect(useTaskStore.getState().tasks.map(t=>t.id)).toEqual(['other']));
    expect(unlisten).toHaveBeenCalledOnce();expect(useTaskStore.getState().readiness['task-1']).toBeUndefined(); stopB();
  });
  it('latest refresh wins and native readiness errors do not retain a ready badge', async () => {
    native.invoke.mockImplementation(cmd=>Promise.resolve(cmd==='task_list'?[taskFixture()]:cmd==='task_events'?[]:readinessFixture({status:'ready'})));
    const stop=observeTasks(['/repo']); await vi.waitFor(()=>expect(useTaskStore.getState().readiness['task-1']?.status).toBe('ready'));
    const old=deferred<ReturnType<typeof readinessFixture>>();
    native.invoke.mockImplementation(cmd=>cmd==='task_readiness'?old.promise:Promise.resolve(cmd==='task_list'?[taskFixture()]:[]));
    const stale=refreshTasks(); await vi.waitFor(()=>expect(useTaskStore.getState().readiness['task-1']).toBeUndefined());
    native.invoke.mockImplementation(cmd=>cmd==='task_readiness'?Promise.reject(new Error('input unavailable')):Promise.resolve(cmd==='task_list'?[taskFixture()]:[]));
    await refreshTasks();old.resolve(readinessFixture({status:'ready'}));await stale;
    expect(useTaskStore.getState().readiness['task-1']).toBeUndefined();expect(useTaskStore.getState().readinessErrors['task-1']).toContain('input unavailable');stop();
  });
  it('drops readiness already in flight when its repository is removed', async () => {
    const delayed=deferred<ReturnType<typeof readinessFixture>>();
    native.invoke.mockImplementation((cmd,args)=>Promise.resolve(cmd==='task_list'?[taskFixture({id:args.repositoryRoots[0]==='/repo'?'old':'new',repositoryRoot:args.repositoryRoots[0]})]:cmd==='task_events'?[]:args.taskId==='old'?delayed.promise:readinessFixture({status:'blocked'})));
    const stopOld=observeTasks(['/repo']);await vi.waitFor(()=>expect(native.invoke.mock.calls.some(([c,a])=>c==='task_readiness'&&a.taskId==='old')).toBe(true));
    stopOld(); const stopNew=observeTasks(['/other']);await vi.waitFor(()=>expect(useTaskStore.getState().readiness.new?.status).toBe('blocked'));
    delayed.resolve(readinessFixture({status:'ready'}));await Promise.resolve();
    expect(useTaskStore.getState().readiness.old).toBeUndefined();stopNew();
  });
  it('native source invalidation revokes readiness without taking over the workspace watcher channel', async () => {
    native.invoke.mockImplementation(cmd=>Promise.resolve(cmd==='task_list'?[taskFixture()]:cmd==='task_events'?[]:readinessFixture({status:'ready'})));
    const stop=observeTasks(['/repo']);await vi.waitFor(()=>expect(useTaskStore.getState().readiness['task-1']?.status).toBe('ready'));
    const taskListener=native.listen.mock.calls.find(([name])=>name==='task://event')?.[1];
    expect(native.listen.mock.calls.some(([name])=>name==='workbench://event')).toBe(false);
    const before=native.invoke.mock.calls.filter(([c])=>c==='task_list').length;
    taskListener({payload:{schemaVersion:1,eventId:'e',seq:5,taskId:'task-1',attemptId:null,kind:'evidence.invalidated',timestampMs:10}});
    expect(useTaskStore.getState().readiness['task-1']).toBeUndefined();
    await vi.waitFor(()=>expect(native.invoke.mock.calls.filter(([c])=>c==='task_list').length).toBeGreaterThan(before));
    await vi.waitFor(()=>expect(useTaskStore.getState().readiness['task-1']?.status).toBe('ready'));
    stop(); const count=native.invoke.mock.calls.length;taskListener({payload:{}});await Promise.resolve();expect(native.invoke.mock.calls).toHaveLength(count);
  });
  it('matches Windows repository aliases without changing native request paths', async () => {
    native.invoke.mockImplementation(cmd=>Promise.resolve(cmd==='task_list'?[taskFixture({repositoryRoot:'C:/工程/Repo'})]:cmd==='task_events'?[]:readinessFixture()));
    const stop=observeTasks(['c:\\工程\\repo\\']);await vi.waitFor(()=>expect(useTaskStore.getState().tasks).toHaveLength(1));
    expect(native.invoke).toHaveBeenCalledWith('task_list',{repositoryRoots:['c:\\工程\\repo\\']});stop();
  });
  it('a pre-mutation query cannot restore readiness while the native write is pending', async () => {
    native.invoke.mockImplementation(cmd=>Promise.resolve(cmd==='task_list'?[taskFixture()]:cmd==='task_events'?[]:readinessFixture({status:'ready'})));
    const stop=observeTasks(['/repo']);await vi.waitFor(()=>expect(useTaskStore.getState().readiness['task-1']?.status).toBe('ready'));
    const old=deferred<ReturnType<typeof readinessFixture>>();
    native.invoke.mockImplementation(cmd=>cmd==='task_readiness'?old.promise:Promise.resolve(cmd==='task_list'?[taskFixture()]:[]));
    const stale=refreshTasks();await vi.waitFor(()=>expect(useTaskStore.getState().loading).toBe(true));
    const mutation=deferred<void>();const action=runTaskAction('task-1',()=>mutation.promise);
    old.resolve(readinessFixture({status:'ready'}));await stale;
    expect(useTaskStore.getState().readiness['task-1']).toBeUndefined();
    mutation.resolve();await action;stop();
  });
  it('cancels through a separate duplicate guard while a write is pending and rejects stale pre-cancel refreshes', async () => {
    const running=taskFixture({attempts:[{id:'a',state:'running',phase:'verification',candidateSha:'sha',failure:null,startedAtMs:1,endedAtMs:null,evidence:null}]});
    const cancelled=taskFixture({...running,revision:2,attempts:[{...running.attempts[0],state:'cancelled',endedAtMs:2}]});
    let records=[running];native.invoke.mockImplementation(cmd=>Promise.resolve(cmd==='task_list'?records:cmd==='task_events'?[]:readinessFixture()));
    const stop=observeTasks(['/repo']);await vi.waitFor(()=>expect(useTaskStore.getState().tasks).toHaveLength(1));
    const original=deferred<ReturnType<typeof taskFixture>>();const owned=runTaskAction(running.id,()=>original.promise);
    const stale=deferred<ReturnType<typeof taskFixture>[]>();const cancellation=deferred<ReturnType<typeof taskFixture>>();let readCount=0;
    native.invoke.mockImplementation(cmd=>cmd==='task_cancel'?cancellation.promise:cmd==='task_list'?(++readCount===1?stale.promise:Promise.resolve(records)):Promise.resolve(cmd==='task_events'?[]:readinessFixture()));
    const staleRefresh=refreshTasks();const cancel=runTaskCancellation(running.id);
    await expect(runTaskCancellation(running.id)).rejects.toThrow(/取消.*进行中/);
    await expect(runTaskAction(running.id,()=>api.startTask(running.id))).rejects.toThrow(/进行中/);expect(native.invoke.mock.calls.some(([c])=>c==='task_start')).toBe(false);
    expect(native.invoke.mock.calls.filter(([c])=>c==='task_cancel')).toEqual([['task_cancel',{request:{taskId:running.id}}]]);
    records=[cancelled];cancellation.resolve(cancelled);await cancel;
    expect(useTaskStore.getState().pending[running.id]).toBe(true);
    stale.resolve([running]);await staleRefresh;expect(useTaskStore.getState().tasks[0].attempts[0].state).toBe('cancelled');
    original.resolve(running);await owned;expect(useTaskStore.getState().tasks[0].attempts[0].state).toBe('cancelled');expect(useTaskStore.getState().pending[running.id]).toBe(false);stop();
  });
  it('refreshes partial native state after cancellation failure without releasing the original operation', async () => {
    const attempt={id:'a',state:'running' as const,phase:'verification' as const,candidateSha:'sha',failure:null,startedAtMs:1,endedAtMs:null,evidence:null};
    let record=taskFixture({attempts:[attempt]});
    native.invoke.mockImplementation(cmd=>cmd==='task_cancel'?Promise.reject(new Error('Stop signal failed; inspect retained process')):Promise.resolve(cmd==='task_list'?[record]:cmd==='task_events'?[]:readinessFixture()));
    const stop=observeTasks(['/repo']);await vi.waitFor(()=>expect(useTaskStore.getState().tasks).toHaveLength(1));
    const exit=deferred<void>();const owned=runTaskAction(record.id,()=>exit.promise);
    record={...record,attempts:[{...attempt,state:'stopping'}]};
    await expect(runTaskCancellation(record.id)).rejects.toThrow('Stop signal failed');
    expect(useTaskStore.getState().tasks[0].attempts[0].state).toBe('stopping');expect(useTaskStore.getState().actionErrors[record.id]).toContain('Stop signal failed');expect(useTaskStore.getState().pending[record.id]).toBe(true);
    expect(useTaskStore.getState().cancelling[record.id]).toBe(false);
    record={...record,attempts:[{...attempt,state:'cancelled',endedAtMs:2}]};exit.resolve();await owned;stop();
  });
  it('deduplicates actions synchronously and refreshes after a failed native mutation', async () => {
    native.invoke.mockImplementation(cmd=>Promise.resolve(cmd==='task_list'?[taskFixture()]:cmd==='task_events'?[]:readinessFixture()));
    const stop=observeTasks(['/repo']); await vi.waitFor(()=>expect(useTaskStore.getState().tasks).toHaveLength(1));
    const pending=deferred<void>();const operation=vi.fn(()=>pending.promise);
    const first=runTaskAction('task-1',operation);await expect(runTaskAction('task-1',operation)).rejects.toThrow(/进行中/); expect(operation).toHaveBeenCalledOnce();
    pending.resolve();await first;expect(useTaskStore.getState().pending['task-1']).toBeFalsy();
    await expect(runTaskAction('task-1',async()=>{throw new Error('partial integration');})).rejects.toThrow('partial integration');
    expect(useTaskStore.getState().actionErrors['task-1']).toBe('partial integration');stop();
  });
});
