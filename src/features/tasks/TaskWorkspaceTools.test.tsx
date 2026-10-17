import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkbenchStore } from '@/stores/workbench';
import type { DiffResponse, RepositorySnapshot, WorkbenchEvent } from '@/types/workbench';

const native = vi.hoisted(() => ({invoke:vi.fn(),listen:vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({invoke:native.invoke}));
vi.mock('@tauri-apps/api/event', () => ({listen:native.listen}));
import { TaskWorkspaceTools } from './TaskWorkspaceTools';
import { inspectTaskWorkspace } from '@/lib/taskWorkspaceTools';

const snapshot = (root='/work/first', file='first.ts'): RepositorySnapshot => ({
  root, name:'workspace', currentBranch:'task/work', headSha:'a'.repeat(40), dirtyCount:1, stagedCount:0,unstagedCount:1,untrackedCount:0,
  changes:[{path:file,indexStatus:' ',worktreeStatus:'M',kind:'modified'}],worktrees:[],branches:[],recentCommits:[],
});
const binaryDiff: DiffResponse = {mode:'worktree',path:'first.ts',files:[],patch:'',binary:true,truncated:false,returnedBytes:0,originalText:null,modifiedText:null,contentTruncated:false};
const baseDiff = (file='first.ts'): DiffResponse => ({...binaryDiff,mode:'base',path:file,files:[{path:file,status:'M'}]});
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function calls(command:string) {return native.invoke.mock.calls.filter(([name])=>name===command);}
function workspaceEvent(event: Partial<WorkbenchEvent>) {
  const callback=native.listen.mock.calls.find(([channel])=>channel==='workbench://event')?.[1];
  callback({payload:{eventType:'fs.changed',id:calls('watch_start').at(-1)?.[1].id,timestampMs:1,...event}});
}
beforeEach(()=>{
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
  native.invoke.mockReset().mockImplementation(async(command,args)=>{
    if(command==='inspect_repository')return snapshot(args.path,args.path==='/work/next'?'next.ts':'first.ts');
    if(command==='git_diff')return baseDiff(args.request.workspaceRoot==='/work/next'?'next.ts':'first.ts');
    if(command==='list_runs'||command==='build_workflow_discover')return [];
    if(command==='build_workflow_self_update_available')return false;
  });
  native.listen.mockReset().mockResolvedValue(vi.fn());
  useWorkbenchStore.setState({profiles:[{id:'explore',name:'Exploratory check',kind:'test',repositoryRoot:'/repo',program:'compiler',args:['--check']}],reviewStates:{}});
});
describe('explicit task workspace context tools',()=>{
  it('loads only on expansion, embeds real read-only review and invalidates a same-HEAD diff on watcher events',async()=>{
    render(<TaskWorkspaceTools mode="changes" repositoryRoot="/repo" workspaceRoot="/work/first" baseSha={'b'.repeat(40)}/>);
    expect(native.invoke).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button',{name:'展开只读变更上下文'}));
    await screen.findByTestId('changes-review-root');await waitFor(()=>expect(calls('watch_start')).toHaveLength(1));
    expect(screen.queryByRole('button',{name:'Manage local changes'})).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:/first.ts/}));expect(await screen.findByText('Binary diff')).toBeInTheDocument();
    const initialInspections=calls('inspect_repository').length;
    const delayed=deferred<RepositorySnapshot>();
    native.invoke.mockImplementation((command)=>command==='inspect_repository'?delayed.promise:Promise.resolve(command==='git_diff'?baseDiff():undefined));
    act(()=>workspaceEvent({id:'unrelated'}));expect(calls('inspect_repository')).toHaveLength(initialInspections);
    act(()=>workspaceEvent({}));
    expect(screen.queryByText('Binary diff')).not.toBeInTheDocument();
    expect(screen.getByText(/Diff invalidated by workspace refresh/)).toBeInTheDocument();
    await act(async()=>delayed.resolve(snapshot()));
    expect(calls('git_local_changes')).toHaveLength(0);expect(calls('process_spawn')).toHaveLength(0);expect(calls('task_verify')).toHaveLength(0);
  });
  it('discards a previous task workspace load after context switches, even when it resolves last',async()=>{
    const old=deferred<RepositorySnapshot>();
    native.invoke.mockImplementation((command,args)=>command==='inspect_repository'?args.path==='/work/first'?old.promise:Promise.resolve(snapshot('/work/next','next.ts')):Promise.resolve(command==='git_diff'?baseDiff('next.ts'):undefined));
    const page=render(<TaskWorkspaceTools mode="changes" repositoryRoot="/repo" workspaceRoot="/work/first" baseSha={'b'.repeat(40)}/>);
    await userEvent.click(screen.getByRole('button',{name:'展开只读变更上下文'}));
    await waitFor(()=>expect(calls('inspect_repository')).toHaveLength(1));
    page.rerender(<TaskWorkspaceTools mode="changes" repositoryRoot="/other" workspaceRoot="/work/next" baseSha={'b'.repeat(40)}/>);
    await screen.findByRole('button',{name:/next.ts/});
    await act(async()=>old.resolve(snapshot('/work/first','stale.ts')));
    expect(screen.queryByRole('button',{name:/stale.ts/})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:/next.ts/})).toBeInTheDocument();
    expect(calls('watch_start').map(([,args])=>args.path)).toEqual(['/work/next']);
  });
  it('rejects mismatched native roots and keeps unavailable context explicit',async()=>{
    native.invoke.mockResolvedValue(snapshot('/wrong'));
    render(<TaskWorkspaceTools mode="changes" repositoryRoot="/repo" workspaceRoot="/work/first" baseSha={'b'.repeat(40)}/>);
    await userEvent.click(screen.getByRole('button',{name:'展开只读变更上下文'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('工作区路径不匹配');expect(screen.queryByTestId('changes-review-root')).not.toBeInTheDocument();expect(calls('watch_start')).toHaveLength(0);
  });
  it('compares Windows root aliases without rewriting native request paths',async()=>{
    native.invoke.mockResolvedValue(snapshot('C:/工程/Work'));
    await expect(inspectTaskWorkspace('c:\\工程\\work\\')).resolves.toHaveProperty('root','C:/工程/Work');
    expect(native.invoke).toHaveBeenCalledWith('inspect_repository',{path:'c:\\工程\\work\\'});
  });
  it('never auto-runs, and collapsing or changing context never stops native processes',async()=>{
    const page=render(<TaskWorkspaceTools mode="run" repositoryRoot="/repo" workspaceRoot="/work/first" baseSha={'b'.repeat(40)}/>);
    await userEvent.click(screen.getByRole('button',{name:'展开探索性 Run'}));
    await screen.findByTestId('run-layout');expect(screen.getByText(/不授予 Task 验证资格/)).toBeInTheDocument();
    expect(calls('process_spawn')).toHaveLength(0);expect(calls('build_workflow_start')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button',{name:/^Run$/}));
    expect(native.invoke).toHaveBeenCalledWith('process_spawn',{spec:expect.objectContaining({cwd:'/work/first',program:'compiler',args:['--check']})});
    await userEvent.click(screen.getByRole('button',{name:'折叠探索性 Run'}));
    expect(screen.queryByTestId('run-layout')).not.toBeInTheDocument();
    await waitFor(()=>expect(calls('watch_stop')).toHaveLength(1));
    page.rerender(<TaskWorkspaceTools mode="run" repositoryRoot="/other" workspaceRoot="/work/next" baseSha={'b'.repeat(40)}/>);
    page.unmount();
    expect(calls('process_stop')).toHaveLength(0);expect(calls('build_workflow_cancel')).toHaveLength(0);expect(calls('terminal_spawn')).toHaveLength(0);expect(calls('task_verify')).toHaveLength(0);
  });
  it('reinspects after watcher startup so a write in the inspection/startup gap cannot remain hidden',async()=>{
    const startup=deferred<void>();let file='before.ts';
    native.invoke.mockImplementation((command,args)=>command==='inspect_repository'?Promise.resolve(snapshot(args.path,file)):command==='watch_start'?startup.promise:Promise.resolve(command==='git_diff'?baseDiff(typeof file === 'string' ? file : 'first.ts'):undefined));
    render(<TaskWorkspaceTools mode="changes" repositoryRoot="/repo" workspaceRoot="/work/first" baseSha={'b'.repeat(40)}/>);
    await userEvent.click(screen.getByRole('button',{name:'展开只读变更上下文'}));await screen.findByRole('button',{name:'before.ts'});
    file='after.ts';await act(async()=>startup.resolve());
    expect(await screen.findByRole('button',{name:'after.ts'})).toBeInTheDocument();expect(screen.queryByRole('button',{name:'before.ts'})).not.toBeInTheDocument();
  });
  it('ignores an older same-workspace refresh when later watcher observations resolve first',async()=>{
    render(<TaskWorkspaceTools mode="changes" repositoryRoot="/repo" workspaceRoot="/work/first" baseSha={'b'.repeat(40)}/>);
    await userEvent.click(screen.getByRole('button',{name:'展开只读变更上下文'}));await screen.findByRole('button',{name:'first.ts'});
    const old=deferred<RepositorySnapshot>();const latest=deferred<RepositorySnapshot>();let reads=0;
    native.invoke.mockImplementation(command=>command==='inspect_repository'?(++reads===1?old.promise:latest.promise):Promise.resolve(command==='git_diff'?baseDiff('latest.ts'):undefined));
    act(()=>workspaceEvent({}));act(()=>workspaceEvent({}));
    await act(async()=>latest.resolve(snapshot('/work/first','latest.ts')));await screen.findByRole('button',{name:'latest.ts'});
    await act(async()=>old.resolve(snapshot('/work/first','obsolete.ts')));
    expect(screen.queryByRole('button',{name:'obsolete.ts'})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'latest.ts'})).toBeInTheDocument();
  });
  it('keeps listener failure visible after watcher registration and permits explicit read-only refresh',async()=>{
    native.listen.mockRejectedValue(new Error('subscription denied'));
    render(<TaskWorkspaceTools mode="changes" repositoryRoot="/repo" workspaceRoot="/work/first" baseSha={'b'.repeat(40)}/>);
    await userEvent.click(screen.getByRole('button',{name:'展开只读变更上下文'}));await screen.findByRole('button',{name:'first.ts'});
    await waitFor(()=>expect(calls('inspect_repository').length).toBeGreaterThan(1));
    expect(screen.getByText(/变更事件不可用.*subscription denied/)).toBeVisible();
    const before=calls('inspect_repository').length;await userEvent.click(screen.getByRole('button',{name:'刷新上下文'}));
    await waitFor(()=>expect(calls('inspect_repository').length).toBeGreaterThan(before));expect(screen.getByText(/变更事件不可用.*subscription denied/)).toBeVisible();
  });
  it('passes the exact task base for a clean committed workspace and changes it with task context',async()=>{
    const clean={...snapshot(),dirtyCount:0,unstagedCount:0,changes:[]};const firstBase='b'.repeat(40);const secondBase='d'.repeat(40);
    native.invoke.mockImplementation(async(command,args)=>command==='inspect_repository'?clean:command==='git_diff'?{...binaryDiff,mode:'base',files:[{path:args.request.baseRef===secondBase?'second-committed.bin':'first-committed.bin',status:'M'}]}:undefined);
    const page=render(<TaskWorkspaceTools mode="changes" repositoryRoot="/repo" workspaceRoot="/work/first" baseSha={firstBase}/>);
    await userEvent.click(screen.getByRole('button',{name:'展开只读变更上下文'}));await screen.findByRole('button',{name:'first-committed.bin'});
    expect(native.invoke).toHaveBeenCalledWith('git_diff',{request:{repositoryRoot:'/repo',workspaceRoot:'/work/first',path:null,oldPath:null,mode:'base',baseRef:firstBase}});
    page.rerender(<TaskWorkspaceTools mode="changes" repositoryRoot="/repo" workspaceRoot="/work/first" baseSha={secondBase}/>);
    await screen.findByRole('button',{name:'second-committed.bin'});expect(screen.queryByRole('button',{name:'first-committed.bin'})).not.toBeInTheDocument();
    expect(native.invoke).toHaveBeenCalledWith('git_diff',{request:{repositoryRoot:'/repo',workspaceRoot:'/work/first',path:null,oldPath:null,mode:'base',baseRef:secondBase}});
  });
  it('cleans up a watcher whose native startup resolves after collapse',async()=>{
    const startup=deferred<void>();const remove=vi.fn();native.listen.mockResolvedValue(remove);
    native.invoke.mockImplementation((command,args)=>command==='inspect_repository'?Promise.resolve(snapshot(args.path)):command==='watch_start'?startup.promise:Promise.resolve(command==='git_diff'?baseDiff():undefined));
    render(<TaskWorkspaceTools mode="changes" repositoryRoot="/repo" workspaceRoot="/work/first" baseSha={'b'.repeat(40)}/>);
    await userEvent.click(screen.getByRole('button',{name:'展开只读变更上下文'}));await waitFor(()=>expect(calls('watch_start')).toHaveLength(1));
    const id=calls('watch_start')[0][1].id;
    await userEvent.click(screen.getByRole('button',{name:'折叠只读变更上下文'}));expect(remove).toHaveBeenCalledOnce();
    await act(async()=>startup.resolve());await waitFor(()=>expect(native.invoke).toHaveBeenCalledWith('watch_stop',{id}));expect(calls('process_stop')).toHaveLength(0);
  });
});
