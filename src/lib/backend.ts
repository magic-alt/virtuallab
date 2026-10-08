import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import type {
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
  const confirmed = await ask(
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
