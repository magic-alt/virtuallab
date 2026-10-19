import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
import { TaskQuickCreate } from './TaskQuickCreate';
import { useTaskStore } from '@/stores/tasks';
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
});

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {value:{}, configurable:true});
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'inspect_repository') return snapshot(args.path, args.path === b.path ? headB : headA);
    if (command === 'task_profile_list') return [];
    if (command === 'task_accept_plan') return [taskFixture({id:'created-task', repositoryRoot:args.request.repositoryRoot})];
    return [];
  });
  useTaskStore.setState({tasks:[],roots:[a.path,b.path],pending:{},cancelling:{},actionErrors:{}});
  useTaskProfileStore.setState({records:[],loading:false,error:null});
});
afterEach(() => { Reflect.deleteProperty(window,'__TAURI_INTERNALS__'); });

describe('natural-language task creation', () => {
  it('reads HEAD automatically and accepts one scoped draft without AI-planning, worktree or execution side effects', async () => {
    const props=opening();
    render(<TaskQuickCreate {...props}/>);
    const dialog=screen.getByRole('dialog',{name:'自然语言创建任务'});
    expect(within(dialog).queryByLabelText('基线 HEAD')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Profile JSON')).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText(headA.slice(0,12))).toBeInTheDocument());
    await userEvent.type(within(dialog).getByLabelText('你希望 Agent 完成什么？'),'修复一个问题并补充测试');
    await userEvent.click(within(dialog).getByRole('button',{name:'创建任务'}));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('task_accept_plan', {request:expect.any(Object)}));
    const request=native.invoke.mock.calls.find(([cmd])=>cmd==='task_accept_plan')![1].request;
    expect(request).toEqual({
      repositoryRoot:a.path,expectedHeadSha:headA,
      tasks:[{key:'impl-1',title:'修复一个问题并补充测试',goal:'修复一个问题并补充测试',
        scope:['.'],kind:'implementation',dependencyKeys:[],profile:null,autoCommit:false}],
    });
    expect(native.invoke.mock.calls.filter(([cmd])=>['task_prepare_workspace','task_start','task_retry'].includes(cmd))).toEqual([]);
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  });

  it('rejects a changed HEAD until the user sees the updated baseline and clicks again', async () => {
    let observations=0;
    native.invoke.mockImplementation(async (cmd,args) => {
      if(cmd==='inspect_repository') return snapshot(args.path,++observations === 1 ? headA : headB);
      if(cmd==='task_profile_list')return [];
      if(cmd==='task_accept_plan')return [taskFixture()];
      return [];
    });
    render(<TaskQuickCreate {...opening()}/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'更新构建流程');
    await userEvent.click(screen.getByRole('button',{name:'创建任务'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('HEAD');
    expect(native.invoke.mock.calls.filter(([cmd])=>cmd==='task_accept_plan')).toHaveLength(0);
    expect(screen.getByText(headB.slice(0,12))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:'创建任务'}));
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_accept_plan',{request:expect.objectContaining({expectedHeadSha:headB})}));
  });

  it('ignores a stale repository inspection and never submits another repository HEAD', async () => {
    let completeOld!: (value:ReturnType<typeof snapshot>)=>void;
    native.invoke.mockImplementation((cmd,args) => {
      if(cmd==='inspect_repository') return args.path===a.path ? new Promise(resolve => {completeOld=resolve;}) : Promise.resolve(snapshot(b.path,headB));
      if(cmd==='task_profile_list')return Promise.resolve([]);
      if(cmd==='task_accept_plan')return Promise.resolve([taskFixture()]);
      return Promise.resolve([]);
    });
    render(<TaskQuickCreate {...opening()}/>);
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('inspect_repository',{path:a.path}));
    await userEvent.selectOptions(screen.getByLabelText('工作仓库'),b.path);
    await screen.findByText(headB.slice(0,12));
    await act(async()=>completeOld(snapshot(a.path,headA)));
    expect(screen.queryByText(headA.slice(0,12))).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'新增测试');
    await userEvent.click(screen.getByRole('button',{name:'创建任务'}));
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_accept_plan',{request:expect.objectContaining({repositoryRoot:b.path,expectedHeadSha:headB})}));
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
    expect(native.invoke.mock.calls.some(([cmd])=>cmd==='task_accept_plan')).toBe(false);
  });

  it('does not submit malformed custom paths or claim native access in browser preview', async () => {
    const props=opening();
    render(<TaskQuickCreate {...props}/>);
    await screen.findByText(headA.slice(0,12));
    await userEvent.type(screen.getByLabelText('你希望 Agent 完成什么？'),'修复组件');
    await userEvent.click(screen.getByText(/可选设置 · 修改范围/));
    await userEvent.selectOptions(screen.getByLabelText('允许修改范围'),'custom');
    await userEvent.type(screen.getByLabelText('文件或目录（每行一个，相对于仓库根目录）'),'../escape');
    await userEvent.click(screen.getByRole('button',{name:'创建任务'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('范围');
    expect(native.invoke.mock.calls.some(([cmd])=>cmd==='task_accept_plan')).toBe(false);
  });
});
