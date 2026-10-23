import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateWorkbench } from './TemplateWorkbench';
import { TaskPlanWizard } from '../TaskPlanWizard';
import { useTaskStore } from '@/stores/tasks';
import { useTaskProfileStore } from '@/stores/taskProfiles';
import { useRepositoryContextStore } from '@/stores/repositoryContext';
import { taskFixture } from '../fixtures';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
const repo = { id: 'repo', name: 'Selected project', path: '/repo', lastOpenedAt: 1 };
const other = { id: 'other', name: 'Second project', path: '/other', lastOpenedAt: 1 };
const context = (repositoryRoot = repo.path) => ({
  repositoryRoot,
  recipes: [{ id: 'npm-build', name: 'npm · Frontend only', kind: 'build', tool: 'Node.js / npm', description: 'Detected package script', supported: true, steps: [{ name: 'Build', program: 'npm', args: ['run', 'build'] }] }],
  checks: [
    { id: 'npm-build', name: 'build', kind: 'build', program: 'npm', args: ['run', 'build'] },
    { id: 'npm-test', name: 'test', kind: 'unit', program: 'npm', args: ['run', 'test'] },
    { id: 'npm-typecheck', name: 'typecheck', kind: 'build', program: 'npm', args: ['run', 'typecheck'] },
  ],
  sourcePaths: ['src', 'tests'], manifestPaths: ['package.json'],
  documentationPaths: ['README.md', 'docs'], ciPaths: ['.github/workflows'],
  knownPaths: ['src', 'tests', 'package.json', 'README.md', 'docs', '.github/workflows'], warnings: [],
});

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  useTaskStore.setState({ tasks: [], pending: {}, actionErrors: {} });
  useTaskProfileStore.setState({ records: [], loading: false, error: null });
  useRepositoryContextStore.setState({ contexts: {} });
  native.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === 'task_recommendation_context') return context(args.repositoryRoot);
    if (command === 'inspect_repository') return { headSha: 'a'.repeat(40), worktrees: [] };
    return [];
  });
});

describe('repository task recommendations', () => {
  it('opens a detected build with current repository scope and exact verification argv', async () => {
    render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);
    await userEvent.click(await screen.findByRole('button', { name: '使用推荐：构建 · npm · Frontend only' }));
    expect(screen.getByLabelText('模板任务标题')).toHaveValue('检查并修复项目构建');
    expect(screen.getByLabelText('模板允许修改范围')).toHaveValue('src\ntests\npackage.json');
    expect((screen.getByLabelText('任务需求与验收条件') as HTMLTextAreaElement).value).toContain('npm run build');
    const profile = screen.getByTestId('template-verification-profile').textContent ?? '';
    expect(JSON.parse(profile).gates[0].executor).toMatchObject({ program: 'npm', args: ['run', 'build'], cwd: 'workspace' });
    expect(native.invoke.mock.calls.some(([command]) => command === 'task_accept_plan')).toBe(false);
  });

  it('applies a recommendation to the advanced plan only when selected', async () => {
    render(<TaskPlanWizard repositories={[repo]} activeRepository={repo} onClose={vi.fn()}/>);
    expect(screen.getByLabelText('计划标题')).toHaveValue('');
    await userEvent.click(await screen.findByRole('button', { name: '填入推荐：补齐测试与回归检查' }));
    expect(screen.getByLabelText('计划标题')).toHaveValue('补齐测试与回归检查');
    expect((screen.getByLabelText('目标') as HTMLTextAreaElement).value).toContain('npm run test');
    fireEvent.change(screen.getByLabelText('基线 HEAD'), { target: { value: 'a'.repeat(40) } });
    await userEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByLabelText('允许修改的范围（每行一个）')).toHaveValue('src\ntests\npackage.json');
    const profile = JSON.parse((screen.getByLabelText('Profile JSON') as HTMLTextAreaElement).value);
    expect(profile.gates.map((gate: { executor: { args: string[] } }) => gate.executor.args)).toEqual([['run', 'test']]);
  });

  it('discards delayed recommendations after selecting another repository or removing it', async () => {
    let finish!: (value: ReturnType<typeof context>) => void;
    native.invoke.mockImplementation((command, args) => command === 'task_recommendation_context'
      ? args.repositoryRoot === repo.path ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ...context(other.path), recipes: [], checks: [], sourcePaths: [], ciPaths: [], documentationPaths: [] })
      : Promise.resolve([]));
    const view = render(<TemplateWorkbench repositories={[repo, other]} activeRepository={repo}/>);
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('task_recommendation_context', { repositoryRoot: repo.path }));
    await userEvent.selectOptions(screen.getByLabelText('推荐目标仓库'), other.path);
    await act(async () => finish(context()));
    expect(screen.queryByRole('button', { name: '使用推荐：构建 · npm · Frontend only' })).not.toBeInTheDocument();
    view.rerender(<TemplateWorkbench repositories={[]} activeRepository={null}/>);
    expect(screen.queryByRole('button', { name: /^使用推荐：/ })).not.toBeInTheDocument();
  });

  it('keeps incompatible native recipes visible without inventing a verification profile', async () => {
    native.invoke.mockImplementation(async (command) => command === 'task_recommendation_context' ? {
      ...context(), checks: [], recipes: [{ id: 'keil-firmware', name: 'Keil · firmware/project.uvprojx', kind: 'build', tool: 'Keil MDK', description: 'Windows build', supported: false, steps: [{ name: 'Compile', program: 'UV4.exe', args: ['-b', 'firmware/project.uvprojx'] }] }],
    } : []);
    render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);
    await userEvent.click(await screen.findByRole('button', { name: '使用推荐：构建 · Keil · firmware/project.uvprojx' }));
    expect(screen.getByTestId('template-verification-profile')).toHaveTextContent('null');
    expect(screen.getByRole('button', { name: '确认并运行模板' })).toBeDisabled();
    expect(screen.getByText(/当前平台不支持此 Run 配方/, { selector: '.task-template-notice' })).toBeInTheDocument();
  });

  it('shows discovery errors without hiding manual templates or replacing a manually edited draft', async () => {
    native.invoke.mockImplementation(async (command) => { if (command === 'task_recommendation_context') throw new Error('manifest unavailable'); return []; });
    render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);
    await screen.findByText(/manifest unavailable/);
    await userEvent.click(screen.getByRole('button', { name: '使用测试驱动功能开发模板' }));
    await userEvent.type(screen.getByLabelText('模板任务标题'), 'My feature');
    expect(screen.getByLabelText('模板任务标题')).toHaveValue('My feature');
  });

  it('starts a documentation task without fabricating formal verification after explicit run consent', async () => {
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'task_recommendation_context') return context(args.repositoryRoot);
      if (command === 'inspect_repository') return { headSha: 'a'.repeat(40), worktrees: [] };
      if (command === 'task_accept_plan') return [taskFixture({ id: 'docs-created', profile: null, workspaceRoot: null })];
      if (command === 'task_prepare_workspace' || command === 'task_start') return taskFixture({ id: 'docs-created', profile: null });
      return [];
    });
    render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);
    await userEvent.click(await screen.findByRole('button', { name: '使用推荐：核对并完善项目文档' }));
    await userEvent.click(screen.getByRole('button', { name: '读取模板基线' }));
    await userEvent.click(screen.getByLabelText('完成后创建本地提交'));
    await userEvent.click(screen.getByLabelText('确认创建独立 Worktree 并启动真实 Agent，接受实际调用费用'));
    const launch = screen.getByRole('button', { name: '确认并运行模板' });
    expect(launch).toBeEnabled();
    await userEvent.click(launch);
    await waitFor(() => expect(native.invoke.mock.calls.some(([command]) => command === 'task_start')).toBe(true));
    const plan = native.invoke.mock.calls.find(([command]) => command === 'task_accept_plan')![1].request;
    expect(plan.tasks[0]).toMatchObject({ profile: null, scope: ['README.md', 'docs'], autoCommit: true });
    expect(plan.tasks[0].autoDraftPr).not.toBe(true);
  });

  it('changes the workflow method when a different repository recommendation is explicitly applied', async () => {
    render(<TemplateWorkbench repositories={[repo]} activeRepository={repo}/>);
    await userEvent.click(await screen.findByRole('button', { name: '使用推荐：构建 · npm · Frontend only' }));
    await userEvent.selectOptions(screen.getByLabelText('当前仓库流程推荐'), 'docs');
    expect(screen.getByRole('heading', { name: '项目文档核对' })).toBeInTheDocument();
    expect(screen.getByText(/\[VirtualLab workflow:docs@1\]/, { selector: 'pre' })).toBeInTheDocument();
  });

  it('preserves an explicit branch while clearing old repository scope, verification and delivery authorization', async () => {
    render(<TemplateWorkbench repositories={[repo, other]} activeRepository={repo}/>);
    await userEvent.click(await screen.findByRole('button', { name: '使用推荐：构建 · npm · Frontend only' }));
    fireEvent.change(screen.getByLabelText('模板工作区分支'), { target: { value: 'fix/operator-chosen' } });
    fireEvent.change(screen.getByLabelText('模板任务标题'), { target: { value: 'Edited task title' } });
    expect(screen.getByLabelText('模板工作区分支')).toHaveValue('fix/operator-chosen');
    await userEvent.click(screen.getByLabelText('完成后自动创建 Draft PR'));
    expect(screen.getByLabelText('完成后创建本地提交')).toBeChecked();
    await userEvent.selectOptions(screen.getByLabelText('模板目标仓库'), other.path);
    expect(screen.getByLabelText('模板任务标题')).toHaveValue('Edited task title');
    expect(screen.getByLabelText('模板允许修改范围')).toHaveValue('');
    expect(screen.getByTestId('template-verification-profile')).toHaveTextContent('null');
    expect(screen.getByLabelText('完成后自动创建 Draft PR')).not.toBeChecked();
    expect(screen.getByLabelText('完成后创建本地提交')).not.toBeChecked();
  });
});
