import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type {
  BuildSuggestion,
  BuildWorkflowSpec,
  DiffRequest,
  DiffResponse,
  ProcessSpec,
  RepositorySnapshot,
  WorkspaceMutationResult,
} from "@/types/workbench";

export function isDesktopRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function requireDesktop() {
  if (!isDesktopRuntime()) {
    throw new Error("This action requires the Tauri desktop runtime.");
  }
}

export async function chooseRepositoryDirectory(): Promise<string | null> {
  requireDesktop();

  const selected = await open({
    directory: true,
    multiple: false,
    title: "Add Git repository",
  });

  return typeof selected === "string" ? selected : null;
}

export async function inspectRepository(path: string): Promise<RepositorySnapshot> {
  requireDesktop();
  return invoke<RepositorySnapshot>("inspect_repository", { path });
}

export async function gitSwitchBranch(repositoryRoot: string, workspaceRoot: string, branch: string): Promise<void> {
  requireDesktop();
  return invoke("git_switch_branch", { repositoryRoot, workspaceRoot, branch });
}

export async function gitDeleteLocalBranch(repositoryRoot: string, branch: string): Promise<void> {
  requireDesktop();
  return invoke("git_delete_local_branch", { repositoryRoot, branch });
}

/**
 * Destructive Git operations must be gated by a Tauri-native confirmation.
 * Never fall back to window.confirm(): macOS WKWebView can suppress its UI.
 * A cancelled or unavailable dialog must never invoke the Rust command.
 */
export async function deleteLocalBranchAfterConfirmation(
  repositoryRoot: string,
  branch: string,
): Promise<boolean> {
  requireDesktop();
  const confirmed = await confirm(
    `Delete the LOCAL branch "${branch}"?\n\n` +
      "This does not delete a branch on GitHub. Git will refuse to delete a branch with unmerged commits. " +
      "Stale origin branches are removed with Fetch + prune.",
    {
      title: "Delete local Git branch",
      kind: "warning",
      okLabel: "Delete local",
      cancelLabel: "Cancel",
    },
  );

  if (!confirmed) return false;
  await gitDeleteLocalBranch(repositoryRoot, branch);
  return true;
}

export async function gitDeleteOriginBranch(repositoryRoot: string, branch: string): Promise<void> {
  requireDesktop();
  return invoke("git_delete_origin_branch", { repositoryRoot, branch });
}

/**
 * Unlike local deletion, this pushes a deletion to origin. A native warning
 * must be accepted before the Rust command is ever invoked.
 */
export async function deleteOriginBranchAfterConfirmation(
  repositoryRoot: string,
  branch: string,
): Promise<boolean> {
  requireDesktop();
  const confirmed = await confirm(
    `Permanently delete the REMOTE branch "origin/${branch}"?\n\n` +
      "This deletes the branch from the shared origin repository and may affect other collaborators. " +
      "Your local branch and worktrees will be kept. Default branches are protected.",
    {
      title: "Delete origin Git branch",
      kind: "warning",
      okLabel: "Delete origin",
      cancelLabel: "Cancel",
    },
  );

  if (!confirmed) return false;
  await gitDeleteOriginBranch(repositoryRoot, branch);
  return true;
}

export async function gitFetchOrigin(repositoryRoot: string): Promise<void> {
  requireDesktop();
  return invoke("git_fetch_origin", { repositoryRoot });
}

export async function gitPullCurrent(repositoryRoot: string, workspaceRoot: string): Promise<void> {
  requireDesktop();
  return invoke("git_pull_current", { repositoryRoot, workspaceRoot });
}

export async function gitDiff(request: DiffRequest): Promise<DiffResponse> {
  requireDesktop();
  return invoke<DiffResponse>("git_diff", { request });
}

export async function createWorktree(
  repositoryRoot: string,
  branch: string,
  baseRef?: string,
  targetPath?: string,
): Promise<WorkspaceMutationResult> {
  requireDesktop();
  return invoke<WorkspaceMutationResult>("create_worktree", {
    repositoryRoot,
    branch,
    baseRef: baseRef || null,
    targetPath: targetPath || null,
  });
}

export async function removeWorktree(
  repositoryRoot: string,
  worktreePath: string,
): Promise<void> {
  requireDesktop();
  return invoke("remove_worktree", { repositoryRoot, worktreePath });
}

export async function terminalSpawn(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
): Promise<void> {
  requireDesktop();
  return invoke("terminal_spawn", { id, cwd, cols, rows });
}

export async function terminalWrite(id: string, data: Uint8Array): Promise<void> {
  requireDesktop();
  return invoke("terminal_write", { id, data: Array.from(data) });
}

export async function terminalResize(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  requireDesktop();
  return invoke("terminal_resize", { id, cols, rows });
}

export async function terminalStop(id: string): Promise<void> {
  requireDesktop();
  return invoke("terminal_stop", { id });
}

export async function processSpawn(spec: ProcessSpec): Promise<void> {
  requireDesktop();
  return invoke("process_spawn", { spec });
}

export async function buildWorkflowDiscover(workspaceRoot: string): Promise<BuildSuggestion[]> {
  requireDesktop();
  return invoke<BuildSuggestion[]>("build_workflow_discover", { workspaceRoot });
}

export async function buildWorkflowStart(spec: BuildWorkflowSpec): Promise<void> {
  requireDesktop();
  return invoke("build_workflow_start", { spec });
}

export async function buildWorkflowCancel(id: string): Promise<void> {
  requireDesktop();
  return invoke("build_workflow_cancel", { id });
}

/**
 * Publishing or flashing is never automatic. A deployment workflow is a
 * user-created recipe and must pass a native desktop confirmation on every run.
 * This is a UI safety gate, not an OS sandbox or device-level interlock.
 */
export async function confirmDeploymentWorkflow(name: string, steps: BuildWorkflowSpec["steps"]): Promise<boolean> {
  requireDesktop();
  return confirm(
    `Run deployment workflow "${name}"?\n\n` +
      steps.map((step) => `${step.program} ${step.args.join(" ")}`).join("\n") +
      "\n\nDeployment may write to external targets or publish artifacts. Verify the commands and destination first. VirtualLab does not enforce hardware safety.",
    {
      title: "Confirm deployment",
      kind: "warning",
      okLabel: "Run deployment",
      cancelLabel: "Cancel",
    },
  );
}

export async function processStop(id: string): Promise<void> {
  requireDesktop();
  return invoke("process_stop", { id });
}

export async function watchStart(id: string, path: string): Promise<void> {
  requireDesktop();
  return invoke("watch_start", { id, path });
}

export async function watchStop(id: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  return invoke("watch_stop", { id });
}

/** Fail closed if the native dialog is unavailable or denied. */
export async function confirmNativeAction(message: string): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    return await confirm(message, { title: "Confirm action", kind: "warning", okLabel: "Confirm", cancelLabel: "Cancel" });
  } catch { return false; }
}

export interface NativeRun {
  presentation?: { profileId: string; profileName: string; profileKind: import("@/types/workbench").ProcessProfileKind } | null;
  id: string;
  cwd: string;
  label: string;
  isWorkflow: boolean;
  status: "running" | "stopping" | "passed" | "failed" | "stopped";
  output: string;
  exitCode: number | null;
  stepName: string | null;
  revision: number;
}
export async function listRuns(cwd: string): Promise<NativeRun[]> {
  requireDesktop();
  return invoke<NativeRun[]>("list_runs", { cwd });
}
