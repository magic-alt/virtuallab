import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
import { TaskQuickCreate } from './TaskQuickCreate';
import { selectTask, useTaskStore } from '@/stores/tasks';
import { useTaskProfileStore } from '@/stores/taskProfiles';
import { taskFixture } from './fixtures';
import type { RepositoryRecord } from '@/types/workbench';

const a: RepositoryRecord = {id:'a', name:'Project A', path:'/repo-a', lastOpenedAt:1};
const b: RepositoryRecord = {id:'b', name:'Project B', path:'/repo-b', lastOpenedAt:1};
const headA = 'a'.repeat(40);
const headB = 'b'.repeat(40);
const snapshot = (root:string, sha:string) => ({root, headSha:sha, currentBranch:'main', dirtyCount:0});
const opening = () => ({
  repositories:[a,b],
  activeRepository:a,
  onClose:vi.fn(),
  onAdvanced:vi.fn(),
  onLaunched:vi.fn(),
});

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {value:{}, configurable:true});
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'inspect_repository') return snapshot(args.path, args.path === b.path ? headB : headA);
    if (command === 'task_profile_list') return [];
    if (command === 'task_launch') return {task:taskFixture({id:'created-task', repositoryRoot:args.request.plan.repositoryRoot}),launchError:null};
    return [];
  });
  useTaskStore.setState({tasks:[],roots:[a.path,b.path],pending:{},cancelling:{},actionErrors:{},activeTaskId:null,activeTaskTab:'概览'});
  useTaskProfileStore.setState({records:[],loading:false,error:null});
});
afterEach(() => { Reflect.deleteProperty(window,'__TAURI_INTERNALS__'); });

describe('natural-language task creation', () => {
  it('launches the exact natural-language goal through one native operation and opens its execution', async () => {
    const props=opening();
    render(<TaskQuickCreate {...props}/>);
    const dialog=screen.getByRole('dialog',{name:'自然语言创建任务'});
    expect(within(dialog).queryByLabelText('基线 HEAD')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Profile JSON')).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText(headA.slice(0,12))).toBeInTheDocument());
    await userEvent.type(within(dialog).getByLabelText('你希望 Agent 完成什么？'),'修复一个问题并补充测试');
    await userEvent.click(within(dialog).getByRole('button',{name:'开始任务'}));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('task_launch', {request:expect.any(Object)}));
    const request=native.invoke.mock.calls.find(([cmd])=>cmd==='task_launch')![1].request;
    expect(request.requestId).toEqual(expect.any(String));
    expect(request.executablePath).toBeNull();
    expect(request.plan).toEqual({
      repositoryRoot:a.path,expectedHeadSha:headA,
      tasks:[{key:'impl-1',title:'修复一个问题并补充测试',goal:'修复一个问题并补充测试',
        scope:['.'],kind:'implementation',dependencyKeys:[],profile:null,autoCommit:false}],
    });
    expect(native.invoke.mock.calls.filter(([cmd])=>['task_prepare_workspace','task_start','task_retry'].includes(cmd))).toEqual([]);
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(props.onLaunched).toHaveBeenCalledWith(expect.objectContaining({id:'created-task',repositoryRoot:a.path}));
    expect(useTaskStore.getState().activeTaskId).toBe('created-task');
    expect(useTaskStore.getState().activeTaskTab).toBe('执行');
  });

  it('rejects a changed HEAD until the user sees the updated baseline and clicks again', async () => {
    let observations=0;
    native.invoke.mockImplementation(async (cmd,args) => {
      if(cmd==='inspect_repository') return snapshot(args.path,++observations === 1 ? headA : headB);
      if(cmd==='task_profile_list')return [];
      if(cmd==='task_launch')return {task:taskFixture({repositoryRoot:args.request.plan.repositoryRoot}),launchError:null};
      return [];
    });
    render(<TaskQuickCreate {...opening()}/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'更新构建流程');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('HEAD');
    expect(native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch')).toHaveLength(0);
    expect(screen.getByText(headB.slice(0,12))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_launch',{request:expect.objectContaining({plan:expect.objectContaining({expectedHeadSha:headB})})}));
  });

  it('ignores a stale repository inspection and never submits another repository HEAD', async () => {
    let completeOld!: (value:ReturnType<typeof snapshot>)=>void;
    native.invoke.mockImplementation((cmd,args) => {
      if(cmd==='inspect_repository') return args.path===a.path ? new Promise(resolve => {completeOld=resolve;}) : Promise.resolve(snapshot(b.path,headB));
      if(cmd==='task_profile_list')return Promise.resolve([]);
      if(cmd==='task_launch')return Promise.resolve({task:taskFixture({repositoryRoot:args.request.plan.repositoryRoot}),launchError:null});
      return Promise.resolve([]);
    });
    render(<TaskQuickCreate {...opening()}/>);
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('inspect_repository',{path:a.path}));
    await userEvent.selectOptions(screen.getByLabelText('工作仓库'),b.path);
    await screen.findByText(headB.slice(0,12));
    await act(async()=>completeOld(snapshot(a.path,headA)));
    expect(screen.queryByText(headA.slice(0,12))).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'新增测试');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_launch',{request:expect.objectContaining({plan:expect.objectContaining({repositoryRoot:b.path,expectedHeadSha:headB})})}));
  });

  it('keeps advanced profile and scope explicit; forwards a seeded draft to the original task-graph editor', async () => {
    const props=opening();
    const profile={schemaVersion:1,id:'checks',name:'Unit tests',gates:[{id:'unit',label:'Test',kind:'unit',required:true,approval:'none',executor:{type:'process',program:'npm',args:['test'],cwd:'workspace'}}]};
    const original=native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((cmd,args)=>cmd==='task_profile_list'
      ? Promise.resolve([{id:'checks',revision:1,profile,updatedAtMs:1}]) : original(cmd,args));
    render(<TaskQuickCreate {...props}/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'优化页面布局');
    await userEvent.click(screen.getByText(/可选设置 · 修改范围/));
    await userEvent.selectOptions(screen.getByLabelText('允许修改范围'),'custom');
    await userEvent.type(screen.getByLabelText('文件或目录（每行一个，相对于仓库根目录）'),'src/');
    await waitFor(()=>expect(screen.getByRole('option',{name:'Unit tests · r1'})).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText('正式验证 Profile（可选）'),'checks');
    await userEvent.click(screen.getByRole('button',{name:'高级任务图 / JSON'}));
    expect(props.onAdvanced).toHaveBeenCalledWith({
      repositoryRoot:a.path, expectedHeadSha:headA,
      tasks:[expect.objectContaining({goal:'优化页面布局',scope:['src'],profile:expect.objectContaining({name:'Unit tests'})})],
    });
    expect(native.invoke.mock.calls.some(([cmd])=>cmd==='task_launch')).toBe(false);
  });

  it('shows a read-only browser preview without calling native methods', () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    native.invoke.mockClear();
    render(<TaskQuickCreate {...opening()}/>);
    expect(screen.getByRole('button',{name:'开始任务'})).toBeDisabled();
    expect(screen.getByText('仓库基线尚不可用')).toBeInTheDocument();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('does not submit malformed custom paths or claim native access in browser preview', async () => {
    const props=opening();
    render(<TaskQuickCreate {...props}/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复组件');
    await userEvent.click(screen.getByText(/可选设置 · 修改范围/));
    await userEvent.selectOptions(screen.getByLabelText('允许修改范围'),'custom');
    await userEvent.type(screen.getByLabelText('文件或目录（每行一个，相对于仓库根目录）'),'../escape');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('范围');
    expect(native.invoke.mock.calls.some(([cmd])=>cmd==='task_launch')).toBe(false);
  });

  it('submits inline without a modal and prevents concurrent launches', async () => {
    let complete!: (value:unknown)=>void;
    const original=native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((cmd,args)=>cmd==='task_launch' ? new Promise(resolve=>{complete=resolve;}) : original(cmd,args));
    const props=opening();
    render(<TaskQuickCreate {...props} inline/>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复 git 提交错误');
    const form=screen.getByRole('button',{name:'开始任务'}).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(()=>expect(native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch')).toHaveLength(1));
    expect(screen.getByRole('button',{name:'正在启动…'})).toBeDisabled();
    await act(async()=>complete({task:taskFixture({repositoryRoot:a.path}),launchError:null}));
    expect(props.onLaunched).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('你希望 Agent 完成什么？')).toHaveValue('');
  });

  it('reuses a launch request ID after a lost response and retains the prompt', async () => {
    const original=native.invoke.getMockImplementation()!;
    let calls=0;
    native.invoke.mockImplementation((cmd,args)=>cmd==='task_launch' && ++calls===1
      ? Promise.reject(new Error('response lost')) : original(cmd,args));
    render(<TaskQuickCreate {...opening()} inline/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复构建');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('response lost');
    expect(screen.getByLabelText('你希望 Agent 完成什么？')).toHaveValue('修复构建');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch')).toHaveLength(2));
    const requests=native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch').map(([,args])=>args.request);
    expect(requests[1]).toEqual(requests[0]);
    await waitFor(()=>expect(screen.getByLabelText('你希望 Agent 完成什么？')).toHaveValue(''));
  });

  it('retains a partial launch failure as the selected task with its concrete error', async () => {
    const original=native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((cmd,args)=>cmd==='task_launch'
      ? Promise.resolve({task:taskFixture({id:'retained',repositoryRoot:a.path,workspaceRoot:null}),launchError:'Worktree creation failed: target exists'})
      : original(cmd,args));
    const props=opening();
    render(<TaskQuickCreate {...props} inline/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复配置');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(useTaskStore.getState().activeTaskId).toBe('retained'));
    expect(useTaskStore.getState().tasks).toEqual([expect.objectContaining({id:'retained',workspaceRoot:null})]);
    expect(useTaskStore.getState().actionErrors.retained).toContain('target exists');
    expect(props.onLaunched).toHaveBeenCalledOnce();
    expect(native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch')).toHaveLength(1);
  });

  it('recovers the original launch after a lost response even when repository HEAD subsequently moves', async () => {
    const original=native.invoke.getMockImplementation()!;
    let changed=false;
    native.invoke.mockImplementation((cmd,args)=>{
      if(cmd==='inspect_repository') return Promise.resolve(snapshot(args.path,changed?headB:headA));
      if(cmd==='task_launch' && !changed) {changed=true;return Promise.reject(new Error('response lost'));}
      return original(cmd,args);
    });
    render(<TaskQuickCreate {...opening()} inline/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复构建');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('response lost');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch')).toHaveLength(2));
    const requests=native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch').map(([,args])=>args.request);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[1].plan.expectedHeadSha).toBe(headA);
  });

  it('refreshes the plan after a definitive native rejection without trapping retries on the old HEAD', async () => {
    const original=native.invoke.getMockImplementation()!;
    let changed=false;
    native.invoke.mockImplementation((cmd,args)=>{
      if(cmd==='inspect_repository') return Promise.resolve(snapshot(args.path,changed?headB:headA));
      if(cmd==='task_launch' && !changed) {
        changed=true;
        return Promise.reject({requestId:args.request.requestId,acceptance:'rejected',message:'Repository HEAD changed; refresh the task plan.'});
      }
      return original(cmd,args);
    });
    render(<TaskQuickCreate {...opening()} inline/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复构建');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Repository HEAD changed');
    await screen.findByText(headB.slice(0,12));
    expect(screen.getByRole('alert')).toHaveTextContent('Repository HEAD changed');
    expect(screen.getByLabelText('你希望 Agent 完成什么？')).toHaveValue('修复构建');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch')).toHaveLength(2));
    const requests=native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch').map(([,args])=>args.request);
    expect(requests[1].requestId).not.toBe(requests[0].requestId);
    expect(requests[1].plan.expectedHeadSha).toBe(headB);
  });

  it('keeps the original request when native cannot prove whether acceptance completed', async () => {
    const original=native.invoke.getMockImplementation()!;
    let changed=false;
    native.invoke.mockImplementation((cmd,args)=>{
      if(cmd==='inspect_repository') return Promise.resolve(snapshot(args.path,changed?headB:headA));
      if(cmd==='task_launch' && !changed) {
        changed=true;
        return Promise.reject({requestId:args.request.requestId,acceptance:'unknown',message:'Launch receipt persistence is uncertain'});
      }
      return original(cmd,args);
    });
    render(<TaskQuickCreate {...opening()} inline/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复构建');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('receipt persistence is uncertain');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch')).toHaveLength(2));
    const requests=native.invoke.mock.calls.filter(([cmd])=>cmd==='task_launch').map(([,args])=>args.request);
    expect(requests[1]).toEqual(requests[0]);
  });

  it('uses the configured Codex executable as a structured path', async () => {
    window.localStorage.setItem('virtuallab-codex-executable-v1','C:/Tools/Codex 中文/codex.cmd');
    try {
      render(<TaskQuickCreate {...opening()} inline/>);
      await screen.findByText(headA.slice(0,12));
      await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复配置');
      await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
      await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_launch',{request:expect.objectContaining({executablePath:'C:/Tools/Codex 中文/codex.cmd'})}));
    } finally {window.localStorage.removeItem('virtuallab-codex-executable-v1');}
  });

  it('does not launch if the repository is removed during the final HEAD inspection', async () => {
    let complete!: (value:ReturnType<typeof snapshot>)=>void;
    let observations=0;
    const original=native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((cmd,args)=>cmd==='inspect_repository' && ++observations===2
      ? new Promise(resolve=>{complete=resolve;}) : original(cmd,args));
    const props=opening();
    const view=render(<TaskQuickCreate {...props} inline/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复配置');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    view.rerender(<TaskQuickCreate {...props} repositories={[b]} inline/>);
    await act(async()=>complete(snapshot(a.path,headA)));
    expect(native.invoke.mock.calls.some(([cmd])=>cmd==='task_launch')).toBe(false);
    expect(await screen.findByRole('alert')).toHaveTextContent('移除');
  });

  it('does not hijack task selection after the launch form has unmounted', async () => {
    let complete!: (value:unknown)=>void;
    const original=native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((cmd,args)=>cmd==='task_launch' ? new Promise(resolve=>{complete=resolve;}) : original(cmd,args));
    const props=opening();
    const view=render(<TaskQuickCreate {...props} inline/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复配置');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(native.invoke.mock.calls.some(([cmd])=>cmd==='task_launch')).toBe(true));
    view.unmount();
    await act(async()=>complete({task:taskFixture({repositoryRoot:a.path}),launchError:null}));
    expect(props.onLaunched).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(useTaskStore.getState().activeTaskId).toBeNull();
  });

  it('retains a late launch without replacing an explicit task review selected during startup', async () => {
    let complete!: (value:unknown)=>void;
    const original=native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((cmd,args)=>cmd==='task_launch' ? new Promise(resolve=>{complete=resolve;}) : original(cmd,args));
    const other=taskFixture({id:'other-task',repositoryRoot:a.path});
    useTaskStore.setState({tasks:[other]});
    const props=opening();
    render(<TaskQuickCreate {...props} inline/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复配置');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(native.invoke.mock.calls.some(([cmd])=>cmd==='task_launch')).toBe(true));
    act(()=>selectTask(other.id,'变更与审查'));
    await act(async()=>complete({task:taskFixture({id:'created-task',repositoryRoot:a.path}),launchError:null}));
    expect(useTaskStore.getState().tasks.map(task=>task.id)).toEqual(['other-task','created-task']);
    expect(useTaskStore.getState().activeTaskId).toBe('other-task');
    expect(useTaskStore.getState().activeTaskTab).toBe('变更与审查');
    expect(props.onLaunched).not.toHaveBeenCalled();
    expect(screen.getByLabelText('你希望 Agent 完成什么？')).toHaveValue('');
  });

  it('preserves an inline draft while hidden without inspecting the repository in the background', async () => {
    const props=opening();
    const view=render(<TaskQuickCreate {...props} inline active={false}/>);
    expect(native.invoke).not.toHaveBeenCalled();
    view.rerender(<TaskQuickCreate {...props} inline active/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'尚未提交的工作');
    view.rerender(<TaskQuickCreate {...props} inline active={false}/>);
    native.invoke.mockClear();
    await act(async()=>{});
    expect(native.invoke).not.toHaveBeenCalled();
    view.rerender(<TaskQuickCreate {...props} inline active/>);
    await screen.findByText(headA.slice(0,12));
    expect(screen.getByLabelText('你希望 Agent 完成什么？')).toHaveValue('尚未提交的工作');
  });

  it('selects the first newly added repository in a composer mounted before setup', async () => {
    const props=opening();
    const view=render(<TaskQuickCreate {...props} repositories={[]} activeRepository={null} inline/>);
    expect(screen.getByRole('button',{name:'开始任务'})).toBeDisabled();
    view.rerender(<TaskQuickCreate {...props} repositories={[b]} activeRepository={b} inline/>);
    await screen.findByText(headB.slice(0,12));
    expect(screen.getByLabelText('工作仓库')).toHaveValue(b.path);
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复配置');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_launch',{request:expect.objectContaining({plan:expect.objectContaining({repositoryRoot:b.path,expectedHeadSha:headB})})}));
  });

  it('lets the user select the remaining repository after the selected repository is removed', async () => {
    const props=opening();
    const view=render(<TaskQuickCreate {...props} inline/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'保留待执行的任务');
    view.rerender(<TaskQuickCreate {...props} repositories={[b]} activeRepository={b} inline/>);
    expect(screen.getByLabelText('工作仓库')).toHaveValue('');
    expect(screen.getByRole('button',{name:'开始任务'})).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('工作仓库'),b.path);
    await screen.findByText(headB.slice(0,12));
    expect(screen.getByLabelText('你希望 Agent 完成什么？')).toHaveValue('保留待执行的任务');
    await userEvent.click(screen.getByRole('button',{name:'开始任务'}));
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_launch',{request:expect.objectContaining({plan:expect.objectContaining({repositoryRoot:b.path,expectedHeadSha:headB})})}));
  });
});
