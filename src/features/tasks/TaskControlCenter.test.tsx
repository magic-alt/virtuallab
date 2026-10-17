import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn(),confirm:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:native.listen}));
vi.mock('@tauri-apps/plugin-dialog',()=>({confirm:native.confirm,open:vi.fn()}));
import { TaskControlCenter } from './TaskControlCenter';
import { useTaskObserver } from './useTaskObserver';
import { refreshTasks, runTaskAction, useTaskStore } from '@/stores/tasks';
import { taskFixture,readinessFixture } from './fixtures';
import type { TaskRecord } from '@/types/tasks';
import type { RepositoryRecord } from '@/types/workbench';
const repo: RepositoryRecord = {id:'r',name:'工作仓库',path:'/repo',lastOpenedAt:1};
let tasks:TaskRecord[];
let ready=readinessFixture();
function Harness(props: Partial<React.ComponentProps<typeof TaskControlCenter>>) {
  useTaskObserver(props.repositories ?? [repo]);
  return <TaskControlCenter view="tasks" repositories={[repo]} activeRepository={repo} onOpenWorkspace={vi.fn()} {...props}/>;
}
beforeEach(()=>{
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
  tasks=[taskFixture()];ready=readinessFixture();
  useTaskStore.setState({activeTaskId:null,pending:{},cancelling:{},actionErrors:{},observerError:null});
  native.listen.mockResolvedValue(vi.fn());native.confirm.mockResolvedValue(false);
  native.invoke.mockImplementation(async(command,args)=>{
    if(command==='task_list')return tasks;
    if(command==='task_events')return [];
    if(command==='task_readiness')return ready;
    if(command==='inspect_repository')return {root:'/repo',headSha:'b'.repeat(40)};
    if(command==='task_accept_plan')return args.request.tasks.map((t:TaskRecord,i:number)=>taskFixture({...t,id:`new-${i}`}));
    if(command==='task_integration_preview')return {planId:'plan',taskId:'task-1',repositoryRoot:'/repo',workspaceRoot:'/sibling',targetHeadSha:'sha',sourceCommits:['source'],expiresAtMs:Date.now()+60_000};
    return tasks[0];
  });
});
afterEach(()=>{Reflect.deleteProperty(window,'__TAURI_INTERNALS__');});
async function openTask(){await userEvent.click(await screen.findByRole('button',{name:'修复解析器'}));}
describe('task control center user flows',()=>{
  it('keeps selection across app views and routes all five detail tabs to workspace-owned tools',async()=>{
    const onOpen=vi.fn(); const page=render(<Harness onOpenWorkspace={onOpen}/>);await openTask();
    expect(within(screen.getByRole('article',{name:'任务详情'})).getByText('未运行')).toBeInTheDocument();
    page.rerender(<Harness view="evidence" onOpenWorkspace={onOpen}/>);
    expect(screen.getByRole('heading',{name:'修复解析器'})).toBeInTheDocument();
    for(const [tab,label,target] of [['概览','打开工作区','overview'],['执行','打开 Agents','agents'],['变更与审查','打开变更','changes'],['证据','打开 Run','run'],['交付','打开 GitHub','github']] as const){
      await userEvent.click(screen.getByRole('tab',{name:tab}));await userEvent.click(screen.getByRole('button',{name:label}));
      expect(onOpen).toHaveBeenLastCalledWith('/work/task-1',target,'/repo');
    }
    expect(native.invoke.mock.calls.some(([c])=>c==='task_start'||c==='task_prepare_workspace')).toBe(false);
  });
  it('requires explicit worktree form submission; duplicate start clicks cannot issue two writes',async()=>{
    tasks=[taskFixture({workspaceRoot:null})];render(<Harness/>);await openTask();
    await userEvent.type(screen.getByLabelText('工作区分支'),'task/unicode');
    await userEvent.click(screen.getByRole('button',{name:'创建任务工作区'}));
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_prepare_workspace',{request:{taskId:'task-1',branch:'task/unicode',targetPath:null}}));
    tasks=[taskFixture()];await act(async()=>{await import('@/stores/tasks').then(s=>s.refreshTasks());});
    await userEvent.click(screen.getByRole('tab',{name:'执行'}));
    let finish!: (value:TaskRecord)=>void;
    native.invoke.mockImplementation((c)=>c==='task_start'?new Promise<TaskRecord>(r=>{finish=r;}):Promise.resolve(c==='task_list'?tasks:c==='task_events'?[]:ready));
    const start=screen.getByRole('button',{name:'开始执行'});await userEvent.dblClick(start);
    expect(native.invoke.mock.calls.filter(([c])=>c==='task_start')).toHaveLength(1);
    await act(async()=>finish(tasks[0]));
  });
  it('review and acceptance bind the visible native SHA and require warning acknowledgment',async()=>{
    ready=readinessFixture({status:'warning',candidateSha:'exact-sha',warnings:['optional check missing'],reviewCurrent:true});
    render(<Harness/>);await openTask();await userEvent.click(screen.getByRole('tab',{name:'变更与审查'}));
    await userEvent.type(screen.getByLabelText('审查说明'),'检查完成');await userEvent.click(screen.getByRole('button',{name:'批准此修订'}));
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_review',{request:{taskId:'task-1',expectedHeadSha:'exact-sha',note:'检查完成',approved:true}}));
    await userEvent.click(screen.getByRole('tab',{name:'交付'}));
    const accept=screen.getByRole('button',{name:'验收此修订'});expect(accept).toBeDisabled();
    await userEvent.click(screen.getByLabelText('我已了解当前警告'));await userEvent.click(accept);
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_accept_result',{request:{taskId:'task-1',expectedHeadSha:'exact-sha',acknowledgedWarnings:true}}));
  });
  it('integration previews fixed sources and surfaces native confirmation cancellation',async()=>{
    tasks=[taskFixture({kind:'integration'})];render(<Harness/>);await openTask();await userEvent.click(screen.getByRole('tab',{name:'交付'}));
    await userEvent.click(screen.getByRole('button',{name:'预览集成'}));
    expect(await screen.findByText('source')).toBeInTheDocument();
    const original=native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((c,a)=>c==='task_integration_confirm'?Promise.reject(new Error('Integration cancelled')):original(c,a));
    await userEvent.click(screen.getByRole('button',{name:'确认集成（原生对话框）'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Integration cancelled');
    expect(native.invoke).toHaveBeenCalledWith('task_integration_confirm',{request:{planId:'plan'}});
    expect(native.confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button',{name:'确认集成（原生对话框）'})).not.toBeInTheDocument();
  });
  it('four steps allow manual implementation/integration nodes and preserve Profile paths',async()=>{
    render(<Harness/>);await screen.findByRole('button',{name:'修复解析器'});
    await userEvent.click(screen.getByRole('button',{name:'新建任务'}));
    const wizard=screen.getByRole('dialog',{name:'创建任务计划'});
    expect(within(wizard).getByRole('button',{name:'AI 生成计划'})).toBeDisabled();
    await userEvent.type(within(wizard).getByLabelText('计划标题'),'支持新功能');
    await userEvent.type(within(wizard).getByLabelText('目标'),'完成输入校验');
    await userEvent.click(within(wizard).getByRole('button',{name:'读取当前 HEAD'}));
    await waitFor(()=>expect(within(wizard).getByLabelText('基线 HEAD')).toHaveValue('b'.repeat(40)));
    await userEvent.click(within(wizard).getByRole('button',{name:'下一步'}));
    await userEvent.type(within(wizard).getByLabelText('允许修改的范围（每行一个）'),'src/');
    const profile={schemaVersion:1,id:'p',name:'测试',gates:[{id:'unit',label:'Unit',kind:'unit',required:true,approval:'none',executor:{type:'process',program:'npm',args:['test'],cwd:'workspace'}}],outputPaths:['dist'],sourcePaths:['ignored/source']};
    await userEvent.clear(within(wizard).getByLabelText('Profile JSON'));
    // paste avoids interpreting braces as user-event keyboard descriptors
    await userEvent.click(within(wizard).getByLabelText('Profile JSON'));await userEvent.paste(JSON.stringify(profile));
    await userEvent.click(within(wizard).getByRole('button',{name:'下一步'}));
    await userEvent.click(within(wizard).getByRole('button',{name:'添加集成节点'}));
    await userEvent.type(within(wizard).getByLabelText('节点 2 标题'),'集成验证');
    await userEvent.type(within(wizard).getByLabelText('节点 2 目标'),'验证最终结果');
    await userEvent.type(within(wizard).getByLabelText('节点 2 依赖键'),'impl-1');
    await userEvent.click(within(wizard).getByRole('button',{name:'下一步'}));
    expect(within(wizard).getByText(/接受计划不会创建工作区/)).toBeInTheDocument();
    await userEvent.click(within(wizard).getByRole('button',{name:'接受手动计划'}));
    await waitFor(()=>expect(native.invoke.mock.calls.some(([c])=>c==='task_accept_plan')).toBe(true));
    const request=native.invoke.mock.calls.find(([c])=>c==='task_accept_plan')?.[1].request;
    expect(request.tasks[0].scope).toEqual(['src']);expect(request.tasks[0].profile.outputPaths).toEqual(['dist']);expect(request.tasks[1].dependencyKeys).toEqual(['impl-1']);
    expect(native.invoke.mock.calls.some(([c])=>c==='task_prepare_workspace'||c==='task_start')).toBe(false);
  });
  it('explicitly verifies manually resolved failed integration without replaying merge or needing a sealed candidate',async()=>{
    tasks=[taskFixture({kind:'integration',profile:{schemaVersion:1,id:'p',name:'p',gates:[{id:'u',label:'u',kind:'unit',required:true,approval:'none',executor:{type:'process',program:'npm',args:['test'],cwd:'workspace'}}]},attempts:[{id:'failed',state:'failed',phase:'integration',candidateSha:null,failure:'Resolve conflicts manually',startedAtMs:1,endedAtMs:2,evidence:null}]})];
    render(<Harness/>);await openTask();await userEvent.click(screen.getByRole('tab',{name:'证据'}));
    await userEvent.click(screen.getByRole('button',{name:'验证已解决的集成'}));
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_verify',{request:{taskId:'task-1'}}));
    expect(native.invoke.mock.calls.some(([c])=>c==='task_integration_confirm'||c==='task_start')).toBe(false);
  });
  it('revokes warning acknowledgment after native refresh changes the candidate revision',async()=>{
    ready=readinessFixture({status:'warning',candidateSha:'first-sha',warnings:['check skipped'],reviewCurrent:true});
    render(<Harness/>);await openTask();await userEvent.click(screen.getByRole('tab',{name:'交付'}));
    await userEvent.click(screen.getByLabelText('我已了解当前警告'));expect(screen.getByRole('button',{name:'验收此修订'})).toBeEnabled();
    tasks=[taskFixture({revision:2})];ready={...ready,candidateSha:'next-sha'};
    await act(async()=>{await import('@/stores/tasks').then(s=>s.refreshTasks());});
    expect(screen.getByLabelText('我已了解当前警告')).not.toBeChecked();expect(screen.getByRole('button',{name:'验收此修订'})).toBeDisabled();
    expect(native.invoke.mock.calls.some(([c])=>c==='task_accept_result')).toBe(false);
  });
  it('shows native Attempt harness, actual CLI and version while older attempts remain unknown',async()=>{
    const prior={id:'previous',state:'failed' as const,phase:'implementation' as const,candidateSha:null,failure:null,startedAtMs:1,endedAtMs:2,evidence:null};
    tasks=[taskFixture({attempts:[prior,{...prior,id:'qualified',execution:{harness:'codex',executablePath:'/opt/工具/actual-cli',version:'cli 1.2.3',threadId:'thread',turnId:'turn'}}]})];
    render(<Harness/>);await openTask();await userEvent.click(screen.getByRole('tab',{name:'执行'}));
    expect(screen.getByText('codex')).toBeInTheDocument();expect(screen.getByText('/opt/工具/actual-cli')).toBeInTheDocument();expect(screen.getByText('cli 1.2.3')).toBeInTheDocument();
    expect(screen.getAllByText('未知')).toHaveLength(3);
  });
  it('makes older Attempt evidence inspectable without replacing the latest evidence',async()=>{
    const evidence={runId:'old-run',manifestDigest:'old-manifest',headSha:'old-head',profileDigest:'old-profile',inputDigest:'old-input',toolchainDigest:'old-tools',status:'fail' as const,checks:[{gateId:'unit',status:'fail' as const,detail:'old check failed',startedAtMs:1}],artifacts:[{id:'log',kind:'log' as const,path:'logs/old.log',sha256:'old-artifact'}],observedAtMs:2};
    const previous={id:'previous',state:'failed' as const,phase:'verification' as const,candidateSha:'old-head',failure:null,startedAtMs:1,endedAtMs:2,evidence};
    tasks=[taskFixture({attempts:[previous,{...previous,id:'latest',evidence:{...evidence,runId:'latest-run'}}]})];
    render(<Harness/>);await openTask();await userEvent.click(screen.getByRole('tab',{name:'执行'}));
    await userEvent.click(screen.getByText('历史证据 · previous'));
    expect(screen.getByText('old-run')).toBeVisible();expect(screen.getByText('old-manifest')).toBeVisible();expect(screen.getByText('old-input')).toBeVisible();expect(screen.getByText('old check failed')).toBeVisible();expect(screen.getByText('logs/old.log')).toBeVisible();
    await userEvent.click(screen.getByRole('tab',{name:'证据'}));expect(screen.getByText('latest-run')).toBeVisible();
  });
  it('can cancel a still-pending verification exactly once while keeping its operation lock',async()=>{
    let finishVerification!:(value:TaskRecord)=>void;let finishCancellation!:(value:TaskRecord)=>void;
    const original={id:'a',state:'succeeded' as const,phase:'implementation' as const,candidateSha:'sha',failure:null,startedAtMs:1,endedAtMs:2,evidence:null};
    tasks=[taskFixture({profile:{schemaVersion:1,id:'p',name:'p',gates:[{id:'u',label:'u',kind:'unit',required:true,approval:'none',executor:{type:'process',program:'npm',args:['test'],cwd:'workspace'}}]},attempts:[original]})];
    const fallback=native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((command,args)=>command==='task_verify'?new Promise<TaskRecord>(resolve=>{finishVerification=resolve;}):command==='task_cancel'?new Promise<TaskRecord>(resolve=>{finishCancellation=resolve;}):fallback(command,args));
    render(<Harness/>);await openTask();await userEvent.click(screen.getByRole('tab',{name:'证据'}));await userEvent.click(screen.getByRole('button',{name:'独立验证（新 Run）'}));
    tasks=[{...tasks[0],attempts:[{...original,phase:'verification',state:'running',endedAtMs:null}]}];
    await act(async()=>{await refreshTasks();});await userEvent.click(screen.getByRole('tab',{name:'执行'}));
    const cancel=screen.getByRole('button',{name:'取消执行'});expect(cancel).toBeEnabled();await userEvent.dblClick(cancel);
    expect(native.invoke.mock.calls.filter(([c])=>c==='task_cancel')).toEqual([['task_cancel',{request:{taskId:'task-1'}}]]);
    await expect(runTaskAction('task-1',async()=>tasks[0])).rejects.toThrow(/进行中/);
    tasks=[{...tasks[0],attempts:[{...tasks[0].attempts[0],state:'stopping'}]}];await act(async()=>finishCancellation(tasks[0]));
    expect(useTaskStore.getState().pending['task-1']).toBe(true);expect(screen.getByRole('button',{name:'重试（新 Attempt）'})).toBeDisabled();
    tasks=[{...tasks[0],attempts:[{...tasks[0].attempts[0],state:'cancelled',endedAtMs:3}]}];await act(async()=>finishVerification(tasks[0]));
    await waitFor(()=>expect(useTaskStore.getState().pending['task-1']).toBe(false));expect(screen.getByRole('button',{name:'取消执行'})).toBeDisabled();
  });
  it('displays decision Run/toolchain bindings as history and uses only native currentness flags',async()=>{
    const decision={headSha:'same-sha',inputDigest:'same-input',profileDigest:'same-profile',runId:'reviewed-run',toolchainDigest:'reviewed-tools'};
    tasks=[taskFixture({review:{...decision,approved:true,note:'Reviewed',createdAtMs:1},acceptance:{...decision,acceptedAtMs:2,acknowledgedWarnings:false}})];
    ready=readinessFixture({candidateSha:'same-sha',status:'unverified',reviewCurrent:false,acceptanceCurrent:false});
    render(<Harness/>);await openTask();await userEvent.click(screen.getByRole('tab',{name:'变更与审查'}));
    expect(screen.getByText('reviewed-run')).toBeVisible();expect(screen.getByText('reviewed-tools')).toBeVisible();expect(screen.getByText(/每次新的验证 Run/)).toBeVisible();
    expect(screen.getByText('审查状态：审查已过期')).toBeVisible();
    await userEvent.click(screen.getByRole('tab',{name:'交付'}));expect(screen.getByText('reviewed-run')).toBeVisible();expect(screen.getByRole('button',{name:'验收此修订'})).toBeDisabled();
  });
  it('offers explicit reconciliation only after uncertain native preparation and never retries creation implicitly',async()=>{
    tasks=[taskFixture({workspaceRoot:null})];const fallback=native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((command,args)=>{
      if(command==='task_prepare_workspace')return Promise.reject(new Error('Worktree exists but task persistence failed; manual reconciliation required (no automatic cleanup)'));
      if(command==='task_reconcile_workspace'){tasks=[taskFixture({workspaceRoot:'/work/recovered'})];return Promise.resolve(tasks[0]);}
      return fallback(command,args);
    });
    render(<Harness/>);await openTask();expect(screen.queryByRole('button',{name:'核对已创建工作区'})).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('工作区分支'),'task/recover');await userEvent.click(screen.getByRole('button',{name:'创建任务工作区'}));
    await screen.findByRole('alert');const reconcile=await screen.findByRole('button',{name:'核对已创建工作区'});
    expect(native.invoke.mock.calls.some(([c])=>c==='task_reconcile_workspace')).toBe(false);expect(screen.getByRole('button',{name:'创建任务工作区'})).toBeDisabled();
    await userEvent.click(reconcile);await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_reconcile_workspace',{request:{taskId:'task-1'}}));
    expect(native.invoke.mock.calls.filter(([c])=>c==='task_prepare_workspace')).toHaveLength(1);expect(await screen.findByText('/work/recovered')).toBeVisible();
    expect(screen.queryByRole('button',{name:'核对已创建工作区'})).not.toBeInTheDocument();expect(native.invoke.mock.calls.some(([c])=>c==='task_start')).toBe(false);
  });
  it('keeps preparation-reconciliation errors visible without running another Git creation',async()=>{
    tasks=[taskFixture({workspaceRoot:null})];useTaskStore.setState({actionErrors:{'task-1':'Preparation intent persistence uncertain; manual reconciliation required'}});
    const fallback=native.invoke.getMockImplementation()!;native.invoke.mockImplementation((command,args)=>command==='task_reconcile_workspace'?Promise.reject(new Error('Observed worktree cannot be qualified; manual reconciliation required')):fallback(command,args));
    render(<Harness/>);await openTask();await userEvent.click(await screen.findByRole('button',{name:'核对已创建工作区'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Observed worktree cannot be qualified');expect(native.invoke.mock.calls.some(([c])=>c==='task_prepare_workspace')).toBe(false);
    expect(screen.getByRole('button',{name:'核对已创建工作区'})).toBeInTheDocument();
  });
  it('allows a fresh explicit create after Native successfully reconciles a definitely absent workspace',async()=>{
    tasks=[taskFixture({workspaceRoot:null})];useTaskStore.setState({actionErrors:{'task-1':'Preparation intent persistence uncertain; manual reconciliation required'}});
    render(<Harness/>);await openTask();await userEvent.click(await screen.findByRole('button',{name:'核对已创建工作区'}));
    await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('task_reconcile_workspace',{request:{taskId:'task-1'}}));
    await userEvent.type(screen.getByLabelText('工作区分支'),'task/corrected');
    expect(screen.getByRole('button',{name:'创建任务工作区'})).toBeEnabled();expect(native.invoke.mock.calls.some(([c])=>c==='task_prepare_workspace')).toBe(false);
    expect(screen.getByText(/再次显式创建/)).toBeVisible();
  });
  it('native failure is visible and never displays fabricated PASS',async()=>{
    native.invoke.mockRejectedValue(new Error('task service unavailable'));
    render(<Harness/>);expect(await screen.findByRole('alert')).toHaveTextContent('task service unavailable');expect(screen.queryByText(/PASS/)).not.toBeInTheDocument();
  });
});
