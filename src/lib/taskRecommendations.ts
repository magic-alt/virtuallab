import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from './backend';
import type { BuildSuggestion } from '@/types/workbench';

export interface DetectedTaskCheck {
  id: string;
  name: string;
  kind: 'build' | 'unit';
  program: string;
  args: string[];
}
export interface RepositoryTaskContext {
  repositoryRoot: string;
  recipes: BuildSuggestion[];
  checks: DetectedTaskCheck[];
  sourcePaths: string[];
  manifestPaths: string[];
  documentationPaths: string[];
  ciPaths: string[];
  knownPaths: string[];
  warnings: string[];
}

/** Inspection only: Native reads bounded metadata and never runs a discovered command. */
export async function readRepositoryTaskContext(repositoryRoot: string): Promise<RepositoryTaskContext> {
  if (!isDesktopRuntime()) throw new Error('仓库推荐需要 Tauri 桌面运行时。');
  const value = await invoke<RepositoryTaskContext>('task_recommendation_context', { repositoryRoot });
  if (!value || typeof value.repositoryRoot !== 'string'
    || !['recipes', 'checks', 'sourcePaths', 'manifestPaths', 'documentationPaths', 'ciPaths', 'knownPaths', 'warnings']
      .every(key => Array.isArray(value[key as keyof RepositoryTaskContext]))) {
    throw new Error('当前原生版本未提供有效的仓库推荐信息。');
  }
  return value;
}
