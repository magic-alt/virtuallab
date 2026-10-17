import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isDesktopRuntime } from './backend';
import type { IntegrationPreview, TaskAcceptanceRequest, TaskEvent, TaskPlanRequest, TaskReadiness, TaskRecord, TaskReviewRequest, TaskWorkspaceRequest } from '@/types/tasks';

function desktopOnly() {
  if (!isDesktopRuntime()) throw new Error('任务数据需要 Tauri 桌面运行时；当前原生来源不可用。');
}
async function query<T>(command: string, args: Record<string, unknown>): Promise<T> {
  desktopOnly(); return invoke<T>(command, args);
}
export const listTasks = (repositoryRoots: string[]) => query<TaskRecord[]>('task_list', { repositoryRoots });
export const getTask = (taskId: string) => query<TaskRecord>('task_get', { taskId });
export const getTaskEvents = (afterSeq: number) => query<TaskEvent[]>('task_events', { afterSeq });
export const getTaskReadiness = (taskId: string) => query<TaskReadiness>('task_readiness', { taskId });
export const acceptTaskPlan = (request: TaskPlanRequest) => query<TaskRecord[]>('task_accept_plan', { request });
export const prepareTaskWorkspace = (request: TaskWorkspaceRequest) => query<TaskRecord>('task_prepare_workspace', { request });
export const startTask = (taskId: string, executablePath: string | null = null) => query<TaskRecord>('task_start', { request: { taskId, executablePath } });
export const cancelTask = (taskId: string) => query<TaskRecord>('task_cancel', { request: { taskId } });
export const retryTask = (taskId: string, executablePath: string | null = null) => query<TaskRecord>('task_retry', { request: { taskId, executablePath } });
export const verifyTask = (taskId: string) => query<TaskRecord>('task_verify', { request: { taskId } });
export const reviewTask = (request: TaskReviewRequest) => query<TaskRecord>('task_review', { request });
export const acceptTaskResult = (request: TaskAcceptanceRequest) => query<TaskRecord>('task_accept_result', { request });
export const previewTaskIntegration = (taskId: string) => query<IntegrationPreview>('task_integration_preview', { request: { taskId } });
export const exportTaskPassport = (taskId: string) => query<string>('task_export_passport', { request: { taskId } });

/** Native owns the single-use plan and final desktop confirmation dialog. */
export async function confirmTaskIntegration(preview: IntegrationPreview): Promise<TaskRecord> {
  desktopOnly();
  if (Date.now() >= preview.expiresAtMs) throw new Error('集成预览已过期，请重新预览。');
  return query<TaskRecord>('task_integration_confirm', { request: { planId: preview.planId } });
}
export async function subscribeTaskEvents(handler: (event: TaskEvent) => void): Promise<UnlistenFn> {
  desktopOnly();
  return listen<TaskEvent>('task://event', ({ payload }) => handler(payload));
}

export const reconcileTaskWorkspace = (taskId: string) => query<TaskRecord>('task_reconcile_workspace', { request: { taskId } });
