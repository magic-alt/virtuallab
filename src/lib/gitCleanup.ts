import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { isDesktopRuntime } from "./backend";

export interface CleanupTarget {
  branch: string;
  localSha: string | null;
  remoteSha: string | null;
  worktreePath: string | null;
}

export interface CleanupPlan {
  repositoryRoot: string;
  selectedWorkspace: string;
  baseRef: string;
  baseSha: string;
  originDefaultBranch: string | null;
  originDefaultSha: string | null;
  originUrl: string | null;
  pushUrl: string | null;
  targets: CleanupTarget[];
  skipped: string[];
}

export interface CleanupOutcome {
  removed: string[];
  failed: string[];
}

export interface CleanupSelection {
  branch: string;
  local: boolean;
  remote: boolean;
  worktree: boolean;
}

export interface CleanupRecommendation {
  branch: string;
  recommendation: "delete" | "keep";
  reason: string;
  risk: string;
}
export interface CleanupAnalysis {
  plan: CleanupPlan;
  report: { summary: string; recommendations: CleanupRecommendation[] };
}

export async function analyzeCleanup(
  repositoryRoot: string, selectedWorkspace: string, operationId: string,
  executablePath: string | null, onStage: (stage: string) => void,
  signal?: AbortSignal,
): Promise<CleanupAnalysis> {
  if (!isDesktopRuntime()) throw new Error("This action requires the Tauri desktop runtime.");
  const unlisten = await listen<{ operationId: string; stage: string }>("git-cleanup-analysis", ({ payload }) => {
    if (payload.operationId === operationId) onStage(payload.stage);
  });
  const cancel = () => { void cancelCleanupAnalysis(operationId).catch(() => {}); };
  try {
    if (signal?.aborted) throw new Error("Analysis cancelled");
    const pending = invoke<CleanupAnalysis>("git_cleanup_analyze", { repositoryRoot, selectedWorkspace, operationId, executablePath });
    signal?.addEventListener("abort", cancel, { once: true });
    return await pending;
  } finally { signal?.removeEventListener("abort", cancel); unlisten(); }
}

export async function cancelCleanupAnalysis(operationId: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("git_cleanup_cancel", { operationId });
}

interface CleanupProgress {
  operationId: string;
  completed: number;
  total: number;
  branch: string;
}

export async function previewCleanup(repositoryRoot: string, selectedWorkspace: string): Promise<CleanupPlan> {
  if (!isDesktopRuntime()) throw new Error("This action requires the Tauri desktop runtime.");
  return invoke("git_cleanup_preview", { repositoryRoot, selectedWorkspace });
}

export async function cleanupSelectedAfterConfirmation(
  plan: CleanupPlan, selection: CleanupSelection[], onProgress: (message: string) => void = () => {},
  isCurrent: () => boolean = () => true,
): Promise<CleanupOutcome | null> {
  if (!isDesktopRuntime()) throw new Error("This action requires the Tauri desktop runtime.");
  if (!selection.length) throw new Error("Select at least one cleanup action.");
  const seen = new Set<string>();
  const entries = selection.flatMap(item => {
    const target = plan.targets.find(target => target.branch === item.branch);
    if (!target || seen.has(item.branch) || !(item.local || item.remote || item.worktree) ||
        (item.local && !target.localSha) || (item.remote && !target.remoteSha) ||
        (item.worktree && !target.worktreePath) || (item.local && target.worktreePath && !item.worktree)) {
      throw new Error("Invalid cleanup selection; review again.");
    }
    seen.add(item.branch);
    return [
      ...(item.local ? [`Local: ${target.branch} @ ${target.localSha}`] : []),
      ...(item.remote ? [`Remote: origin/${target.branch} @ ${target.remoteSha}`] : []),
      ...(item.worktree ? [`Worktree: ${target.worktreePath}`] : []),
    ];
  });
  const approved = await confirm(
    `Repository: ${plan.repositoryRoot}\nBase: ${plan.baseRef} @ ${plan.baseSha}\n` +
    `${plan.pushUrl ? `Destination: ${plan.pushUrl}\n` : ""}\nDelete ONLY these selected items?\n${entries.join("\n")}\n\n` +
    "Remote deletion affects collaborators. Selected worktree directories will be removed. Changed state will be rejected.",
    { title: "Confirm selected Git cleanup", kind: "warning", okLabel: "Delete selected items", cancelLabel: "Cancel" },
  );
  if (!approved) return null;
  if (!isCurrent()) throw new Error("Workspace selection changed; review cleanup again.");
  const operationId = crypto.randomUUID();
  const unlisten = await listen<CleanupProgress>("git-cleanup-progress", ({ payload }) => {
    if (payload.operationId === operationId) onProgress(`Cleaning ${payload.completed}/${payload.total}: ${payload.branch}`);
  });
  try {
    if (!isCurrent()) throw new Error("Workspace selection changed; review cleanup again.");
    return await invoke("git_cleanup_selected", { plan, selection, operationId });
  }
  finally { unlisten(); }
}

/** Read-only preview followed by one explicit native destructive confirmation. */
export async function cleanupMergedAfterConfirmation(
  repositoryRoot: string,
  selectedWorkspace: string,
  onProgress: (message: string) => void = () => {},
): Promise<CleanupOutcome | null> {
  if (!isDesktopRuntime()) throw new Error("This action requires the Tauri desktop runtime.");
  onProgress("Inspecting merged branches…");
  const plan = await invoke<CleanupPlan>("git_cleanup_preview", { repositoryRoot, selectedWorkspace });
  const entries = plan.targets.flatMap(target => [
    ...(target.worktreePath ? [`Worktree: ${target.worktreePath}`] : []),
    ...(target.localSha ? [`Local: ${target.branch} @ ${target.localSha.slice(0, 10)}`] : []),
    ...(target.remoteSha ? [`Remote: origin/${target.branch} @ ${target.remoteSha.slice(0, 10)}`] : []),
  ]);
  const approved = await confirm(
    `Repository: ${plan.repositoryRoot}\n${plan.pushUrl ? `Origin: ${plan.pushUrl}\n` : ""}Merged into: ${plan.baseRef} @ ${plan.baseSha.slice(0, 10)}\n\n` +
    (entries.length ? `Delete these ${entries.length} items?\n${entries.join("\n")}\n\nRemote deletions affect collaborators. Worktree directories will be removed.\n` : "No eligible merged items to clean.\n") +
    "Current/primary worktrees, default branches, dirty/locked worktrees and commits not merged into the selected base are preserved.\n" +
    (plan.skipped.length ? `\nSkipped:\n${plan.skipped.join("\n")}` : ""),
    { title: entries.length ? "Clean merged branches and worktrees" : "Nothing to clean", kind: entries.length ? "warning" : "info", okLabel: entries.length ? "Delete listed items" : "Close", cancelLabel: "Cancel" },
  );
  if (!approved || !entries.length) return null;
  const operationId = crypto.randomUUID();
  const unlisten = await listen<CleanupProgress>("git-cleanup-progress", ({ payload }) => {
    if (payload.operationId === operationId) onProgress(`Cleaning ${payload.completed}/${payload.total}: ${payload.branch}`);
  });
  try {
    return await invoke<CleanupOutcome>("git_cleanup_merged", { plan, operationId });
  } finally { unlisten(); }
}
