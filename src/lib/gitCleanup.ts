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

interface CleanupProgress {
  operationId: string;
  completed: number;
  total: number;
  branch: string;
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
    "Current/primary worktrees, default branches, dirty/locked worktrees and commits not merged into main are preserved.\n" +
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
