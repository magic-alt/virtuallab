import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@/types/tasks';
import type { RepositoryRecord } from '@/types/workbench';
import { taskFixture } from '../fixtures';

const native = vi.hoisted(() => ({desktop:vi.fn(),inspect:vi.fn(),accept:vi.fn(),prepare:vi.fn(),start:vi.fn(),select:vi.fn()}));
vi.mock('@/lib/backend', () => ({isDesktopRuntime:native.desktop,inspectRepository:native.inspect}));
vi.mock('@/lib/tasks', () => ({acceptTaskPlan:native.accept,prepareTaskWorkspace:native.prepare,startTask:native.start}));
vi.mock('@/stores/tasks', () => ({
  useTaskStore:(selector:(state:{tasks:TaskRecord[]})=>unknown) => selector({tasks:[]}),
  selectTask:native.select,
  runTaskAction:(_id:string, operation:()=>Promise<unknown>) => operation(),
}));
vi.mock('@/stores/taskProfiles', () => ({refreshTaskProfiles:vi.fn().mockResolvedValue(undefined),useTaskProfileStore:()=>({records:[],error:null})}));
import { TemplateWorkbench } from './TemplateWorkbench';
const repo:RepositoryRecord = {id:'repo',name:'工程',path:'/repo',lastOpenedAt:1};
const second:RepositoryRecord = {...repo,id:'other',name:'另一个工程',path:'/other'};
const launchButton = () => screen.getByRole('button',{name:'确认并运行模板'});
const open = async () => userEvent.click(screen.getByRole('button',{name:'预览并运行案例'}));
const baseline = async () => {await userEvent.click(screen.getByRole('button',{name:'读取模板基线'}));await screen.findByText('a'.repeat(40));};
const consent = async () => {
  await userEvent.click(screen.getByLabelText('完成后创建本地提交'));
  await userEvent.click(screen.getByLabelText('确认创建独立 Worktree 并启动真实 Agent，接受实际调用费用'));
};
beforeEach(() => {
  vi.clearAllMocks();
  native.desktop.mockReturnValue(true);
  native.inspect.mockResolvedValue({headSha:'a'.repeat(40)});
  native.accept.mockResolvedValue([taskFixture({id:'created',workspaceRoot:null})]);
  native.prepare.mockResolvedValue(taskFixture({id:'created',workspaceRoot:'/work/demo'}));
  native.start.mockResolvedValue(taskFixture({id:'created',workspaceRoot:'/work/demo'}));
});
describe('template workbench', () => {
  it('previews methods without executing and keeps both consents off', async () => {
    render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);await open();
    expect(native.accept).not.toHaveBeenCalled();expect(native.prepare).not.toHaveBeenCalled();expect(native.start).not.toHaveBeenCalled();
    expect(screen.getAllByRole('checkbox').every(box => !(box as HTMLInputElement).checked)).toBe(true);
    await baseline();expect(launchButton()).toBeDisabled();
  });
  it('save-only accepts a template but never creates a workspace or starts', async () => {
    render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);await open();await baseline();
    await userEvent.click(screen.getByRole('button',{name:'只保存模板计划'}));
    await screen.findByText('计划已保存；尚未创建工作区或启动 Agent。');
    expect(native.accept).toHaveBeenCalledTimes(1);expect(native.accept.mock.calls[0][0].tasks[0].autoCommit).toBe(false);
    expect(native.prepare).not.toHaveBeenCalled();expect(native.start).not.toHaveBeenCalled();
  });
  it('runs exactly once after explicit consent and preserves the native sequence', async () => {
    const order:string[]=[];
    native.accept.mockImplementation(async () => {order.push('plan');return [taskFixture({id:'created',workspaceRoot:null})];});
    native.prepare.mockImplementation(async () => {order.push('workspace');return taskFixture({id:'created',workspaceRoot:'/work/demo'});});
    native.start.mockImplementation(async () => {order.push('start');return taskFixture({id:'created',workspaceRoot:'/work/demo'});});
    render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);await open();await baseline();await consent();
    await userEvent.dblClick(launchButton());
    await screen.findByText(/已提交原生队列。请在任务详情/);
    expect(order).toEqual(['plan','workspace','start']);expect(native.accept.mock.calls[0][0].tasks[0].autoCommit).toBe(true);
  });
  it('retains the created task when preparation is uncertain; no silent retry', async () => {
    native.prepare.mockRejectedValue(new Error('worktree creation uncertain'));
    render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);await open();await baseline();await consent();
    await userEvent.click(launchButton());await screen.findByRole('alert');
    expect(native.start).not.toHaveBeenCalled();expect(launchButton()).toBeDisabled();
    expect(screen.getByRole('button',{name:'打开已创建任务'})).toBeEnabled();
  });
  it('discards a baseline returned after switching repository', async () => {
    let finish!: (value:{headSha:string}) => void;
    native.inspect.mockReturnValue(new Promise(resolve => {finish=resolve;}));
    render(<TemplateWorkbench repositories={[repo,second]} activeRepository={repo}/>);await open();
    await userEvent.click(screen.getByRole('button',{name:'读取模板基线'}));
    await userEvent.selectOptions(screen.getByLabelText('模板目标仓库'),'/other');
    await act(async()=>finish({headSha:'a'.repeat(40)}));
    expect(screen.queryByText('a'.repeat(40))).not.toBeInTheDocument();expect(launchButton()).toBeDisabled();
  });
  it('unmounting during plan acceptance prevents subsequent workspace creation', async () => {
    let finish!: (value:TaskRecord[]) => void;
    native.accept.mockReturnValue(new Promise(resolve => {finish=resolve;}));
    const page=render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);await open();await baseline();await consent();
    await userEvent.click(launchButton());page.unmount();
    await act(async()=>finish([taskFixture({id:'created',workspaceRoot:null})]));
    expect(native.prepare).not.toHaveBeenCalled();expect(native.start).not.toHaveBeenCalled();
  });
  it('removing a repository during acceptance stops the launch chain', async () => {
    let finish!: (value:TaskRecord[]) => void;
    native.accept.mockReturnValue(new Promise(resolve => {finish=resolve;}));
    const page=render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);await open();await baseline();await consent();
    await userEvent.click(launchButton());page.rerender(<TemplateWorkbench repositories={[]} activeRepository={null}/>);
    await act(async()=>finish([taskFixture({id:'created',workspaceRoot:null})]));
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('仓库上下文已改变'));
    expect(native.prepare).not.toHaveBeenCalled();expect(native.start).not.toHaveBeenCalled();
  });
  it('browser preview cannot run or even inspect native state', async () => {
    native.desktop.mockReturnValue(false);
    render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);await open();
    expect(launchButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'读取模板基线'}));
    expect(native.inspect).not.toHaveBeenCalled();expect(native.accept).not.toHaveBeenCalled();
  });
});
