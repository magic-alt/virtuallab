import type { TaskPlanRequest, TaskRecord, TaskWorkspaceRequest } from '@/types/tasks';

export interface TemplateLaunchOptions { run: boolean; branch: string; executablePath: string | null }
export interface TemplateLaunchPorts {
  accept: (request: TaskPlanRequest) => Promise<TaskRecord[]>;
  prepare: (request: TaskWorkspaceRequest) => Promise<TaskRecord>;
  start: (taskId: string, executablePath: string | null) => Promise<TaskRecord>;
  canContinue: () => boolean;
  onCreated: (task: TaskRecord) => void;
  onPhase?: (phase: 'plan' | 'workspace' | 'start') => void;
}

/**
 * One user-triggered launch, never a mount effect, retry loop or background scheduler.
 * A failed write may already be durable: preserve it and use task-detail recovery.
 */
export async function launchTemplate(request: TaskPlanRequest, options: TemplateLaunchOptions, ports: TemplateLaunchPorts): Promise<TaskRecord> {
  const guard = () => {
    if (!ports.canContinue()) throw new Error('启动已停止：对话框或仓库上下文已改变。已保存任务请在任务列表核对，未自动重放操作。');
  };
  guard();
  if (request.tasks.length !== 1) throw new Error('模板启动只接受一个已确认的任务。');
  if (options.run && (!options.branch.trim() || !request.tasks[0].profile)) throw new Error('运行前需要分支名和验证 Profile。');
  ports.onPhase?.('plan');
  const records = await ports.accept(request);
  if (records.length !== 1 || !records[0]?.id) throw new Error('Native 未返回唯一任务；请刷新列表核对，不要重复创建。');
  let task = records[0];
  ports.onCreated(task);
  if (!options.run) return task;
  guard();
  ports.onPhase?.('workspace');
  const prepared = await ports.prepare({ taskId: task.id, branch: options.branch.trim(), targetPath: null });
  if (prepared.id !== task.id || !prepared.workspaceRoot) throw new Error('工作区绑定未确认；请在任务详情核对，未启动 Agent。');
  task = prepared;
  guard();
  ports.onPhase?.('start');
  const started = await ports.start(task.id, options.executablePath?.trim() || null);
  if (started.id !== task.id) throw new Error('Native 返回的任务身份不匹配；请刷新任务列表核对。');
  return started;
}
