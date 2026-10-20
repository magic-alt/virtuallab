import { beforeEach, describe, expect, it, vi } from 'vitest';
const native=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:native.listen}));
import {observeTasks,refreshTasks,retainLaunchedTask,selectTask,useTaskStore} from './tasks';
import {readinessFixture,taskFixture} from '@/features/tasks/fixtures';
import type {TaskAttemptState} from '@/types/tasks';
const task=(state:TaskAttemptState,id='task-1')=>taskFixture({id,attempts:[{id:'attempt-'+id,state,phase:'implementation',candidateSha:null,failure:null,startedAtMs:1,endedAtMs:state==='running'?null:2,evidence:null}]});
beforeEach(()=>{
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
  native.invoke.mockReset();native.listen.mockReset().mockResolvedValue(vi.fn());
  useTaskStore.setState({tasks:[],roots:['/repo'],activeTaskId:null,activeTaskTab:'概览',activeTaskRepositoryRoot:null,readiness:{},readinessErrors:{},pending:{},cancelling:{},actionErrors:{},observerError:null});
});
describe('launched task retention and completion following',()=>{
  it('hydrates retained launch failures after reopening without replacing local action errors',async()=>{
    native.invoke.mockImplementation(cmd=>Promise.resolve(cmd==='task_list'?[taskFixture({workspaceRoot:null})]:cmd==='task_events'?[]:cmd==='task_launch_error'?'Native preparation interrupted; reconcile the retained worktree':readinessFixture()));
    useTaskStore.setState({actionErrors:{'task-1':'Local action failed'}});
    const stop=observeTasks(['/repo']);
    try {
      await vi.waitFor(()=>expect(useTaskStore.getState().launchErrors?.['task-1']).toContain('preparation interrupted'));
      expect(useTaskStore.getState().actionErrors['task-1']).toBe('Local action failed');
      expect(useTaskStore.getState().tasks[0].attempts).toEqual([]);
    } finally {stop();}
  });
  it('retains a native result before selection but does not regress a newer observed revision',()=>{
    retainLaunchedTask(task('running'),null);
    expect(useTaskStore.getState().activeTaskId).toBe('task-1');
    expect(useTaskStore.getState().activeTaskTab).toBe('执行');
    const finished={...task('succeeded'),revision:3};
    useTaskStore.setState({tasks:[finished]});
    retainLaunchedTask(task('running'),null);
    expect(useTaskStore.getState().tasks).toEqual([finished]);
    expect(useTaskStore.getState().activeTaskTab).toBe('证据');
  });
  it('ignores removed repositories and exposes retained native launch errors',()=>{
    useTaskStore.setState({roots:[]});
    retainLaunchedTask(task('running'),'cannot prepare');
    expect(useTaskStore.getState().tasks).toEqual([]);
    expect(useTaskStore.getState().activeTaskId).toBeNull();
    useTaskStore.setState({roots:['/repo']});
    retainLaunchedTask(taskFixture({workspaceRoot:null}),'cannot prepare');
    expect(useTaskStore.getState().actionErrors['task-1']).toBe('cannot prepare');
    expect(useTaskStore.getState().activeTaskTab).toBe('概览');
  });
  it('opens the report when the selected running attempt finishes without switching tasks',async()=>{
    let records=[task('running'),task('running','other')];
    native.invoke.mockImplementation(cmd=>Promise.resolve(cmd==='task_list'?records:cmd==='task_events'?[]:readinessFixture()));
    const stop=observeTasks(['/repo']);
    try {
      await vi.waitFor(()=>expect(useTaskStore.getState().tasks).toHaveLength(2));
      selectTask('task-1','执行');
      records=[task('succeeded'),task('running','other')];
      await refreshTasks();
      expect(useTaskStore.getState().activeTaskId).toBe('task-1');
      expect(useTaskStore.getState().activeTaskTab).toBe('证据');
    } finally {stop();}
  });
  it('preserves an explicit review tab and another task while a background attempt finishes',async()=>{
    let records=[task('running'),task('running','other')];
    native.invoke.mockImplementation(cmd=>Promise.resolve(cmd==='task_list'?records:cmd==='task_events'?[]:readinessFixture()));
    const stop=observeTasks(['/repo']);
    try {
      await vi.waitFor(()=>expect(useTaskStore.getState().tasks).toHaveLength(2));
      selectTask('task-1','变更与审查');
      records=[task('succeeded'),task('running','other')];
      await refreshTasks();
      expect(useTaskStore.getState().activeTaskTab).toBe('变更与审查');
      selectTask('other','执行');
      records=[task('failed'),task('running','other')];
      await refreshTasks();
      expect(useTaskStore.getState().activeTaskId).toBe('other');
      expect(useTaskStore.getState().activeTaskTab).toBe('执行');
    } finally {stop();}
  });
  it('continues observing active work when the event listener is unavailable',async()=>{
    vi.useFakeTimers();
    let records=[task('running')];
    native.listen.mockRejectedValue(new Error('event channel unavailable'));
    native.invoke.mockImplementation(cmd=>Promise.resolve(cmd==='task_list'?records:cmd==='task_events'?[]:readinessFixture()));
    const stop=observeTasks(['/repo']);
    try {
      await vi.advanceTimersByTimeAsync(1);
      selectTask('task-1','执行');
      records=[task('succeeded')];
      await vi.advanceTimersByTimeAsync(5000);
      expect(useTaskStore.getState().tasks[0]?.attempts[0].state).toBe('succeeded');
      expect(useTaskStore.getState().activeTaskTab).toBe('证据');
    } finally {stop();vi.useRealTimers();}
  });
});
