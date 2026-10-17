import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffResponse, RepositorySnapshot } from '@/types/workbench';
import { useWorkbenchStore } from '@/stores/workbench';

const native = vi.hoisted(() => ({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({invoke:native.invoke}));
import { ChangesReview } from './ChangesReview';

const base = 'b'.repeat(40);
const nextBase = 'd'.repeat(40);
const clean: RepositorySnapshot = {root:'/work/task',name:'task',currentBranch:'task/committed',headSha:'c'.repeat(40),dirtyCount:0,stagedCount:0,unstagedCount:0,untrackedCount:0,changes:[],worktrees:[],branches:[],recentCommits:[]};
const diff = (file='committed.bin'): DiffResponse => ({mode:'base',path:file,files:[{path:file,status:'M'}],patch:'',binary:true,truncated:false,returnedBytes:0,originalText:null,modifiedText:null,contentTruncated:false});
const props = {snapshot:clean,repositoryRoot:'/repo',workspaceRoot:clean.root,enabled:true};
beforeEach(()=>{
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
  native.invoke.mockReset().mockImplementation(async(_command,args)=>diff(args.request.baseRef===nextBase?'next.bin':'committed.bin'));
  useWorkbenchStore.setState({reviewStates:{}});
});
describe('fixed Task baseline review',()=>{
  it('loads committed changes from exact task base even when the worktree is clean, and keeps task mode read-only',async()=>{
    render(<ChangesReview {...props} taskBaseRef={base} onResolveLocalChanges={vi.fn()}/>);
    const file=await screen.findByRole('button',{name:'committed.bin'});
    expect(native.invoke).toHaveBeenCalledWith('git_diff',{request:{repositoryRoot:'/repo',workspaceRoot:clean.root,path:null,oldPath:null,mode:'base',baseRef:base}});
    expect(screen.queryByRole('button',{name:'Worktree'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Staged'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Manage local changes'})).not.toBeInTheDocument();
    await userEvent.click(file);expect(await screen.findByText('Binary diff')).toBeVisible();
    expect(native.invoke).toHaveBeenLastCalledWith('git_diff',{request:{repositoryRoot:'/repo',workspaceRoot:clean.root,path:'committed.bin',oldPath:null,mode:'base',baseRef:base}});
    await userEvent.click(screen.getByRole('button',{name:'Advanced review'}));expect(screen.getByLabelText('Base ref')).toHaveValue(base);expect(screen.getByLabelText('Base ref')).toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('button',{name:'Advanced review'}));expect(screen.getByRole('button',{name:'committed.bin'})).toBeInTheDocument();
  });
  it('reselects a changed task baseline on the same worktree and discards an older in-flight file diff',async()=>{
    let finishOld!:(value:DiffResponse)=>void;
    native.invoke.mockImplementation(async(_command,args)=>args.request.path==='committed.bin'?new Promise<DiffResponse>(resolve=>{finishOld=resolve;}):diff(args.request.baseRef===nextBase?'next.bin':'committed.bin'));
    const page=render(<ChangesReview {...props} taskBaseRef={base}/>);await userEvent.click(await screen.findByRole('button',{name:'committed.bin'}));
    page.rerender(<ChangesReview {...props} snapshot={{...clean,headSha:'e'.repeat(40)}} taskBaseRef={nextBase}/>);
    await userEvent.click(await screen.findByRole('button',{name:'next.bin'}));expect(await screen.findByText('Binary diff')).toBeVisible();
    await act(async()=>finishOld(diff('obsolete.bin')));expect(screen.queryByText('obsolete.bin')).not.toBeInTheDocument();
    expect(native.invoke.mock.calls.filter(([,args])=>args.request.baseRef===nextBase).every(([,args])=>args.request.mode==='base')).toBe(true);
    expect(native.invoke).toHaveBeenLastCalledWith('git_diff',{request:{repositoryRoot:'/repo',workspaceRoot:clean.root,path:'next.bin',oldPath:null,mode:'base',baseRef:nextBase}});
  });
  it('revokes old diff content immediately on snapshot refresh before the new base list is available',async()=>{
    const page=render(<ChangesReview {...props} taskBaseRef={base} refreshRevision={0}/>);await userEvent.click(await screen.findByRole('button',{name:'committed.bin'}));await screen.findByText('Binary diff');
    let finish!:(value:DiffResponse)=>void;native.invoke.mockImplementationOnce(()=>new Promise<DiffResponse>(resolve=>{finish=resolve;}));
    page.rerender(<ChangesReview {...props} taskBaseRef={base} refreshRevision={1}/>);
    expect(screen.queryByText('Binary diff')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'committed.bin'})).not.toBeInTheDocument();
    await waitFor(()=>expect(finish).toBeTypeOf('function'));await act(async()=>finish(diff('refreshed.bin')));expect(await screen.findByRole('button',{name:'refreshed.bin'})).toBeInTheDocument();
  });
});
