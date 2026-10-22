import { invoke } from "@tauri-apps/api/core";
import type { AppBuildInfo } from "@/types/appBuild";
import type { ExternalEditor } from "@/lib/externalEditor";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type {
  BuildSuggestion,
  BuildWorkflowSpec,
  CodexTerminalSpawnRequest,
  DiffRequest,
  DiffResponse,
  LocalChangesRequest,
  ProcessSpec,
  RepositorySnapshot,
  WorktreeStatus,
  WorkspaceMutationResult,
} from "@/types/workbench";

export function isDesktopRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

/** Native OS toast; failures are reflected in the in-app notification inbox. */
export async function desktopNotify(title: string, body: string): Promise<void> {
  requireDesktop();
  return invoke("desktop_notify", { title, body });
}

/** Read compile-time application identity, independent of the selected repository. */
export async function getAppBuildInfo(): Promise<AppBuildInfo> {
  requireDesktop();
  return invoke<AppBuildInfo>("app_build_info");
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

export async function inspectRepository(
  path: string,
  options: { confirmOwnership?: boolean } = {},
): Promise<RepositorySnapshot> {
  requireDesktop();
  try {
    return await invoke<RepositorySnapshot>("inspect_repository", { path });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.confirmOwnership || !message.includes("detected dubious ownership")) throw error;
    const approved = await confirm(
      `Trust Git repository "${path}"?\n\n` +
        "This directory belongs to another OS user. Only continue if you trust its files and Git configuration. " +
        "This adds this exact directory to your global Git safe.directory exceptions, including for Git outside VirtualLab.",
      { title: "Trust Git repository", kind: "warning", okLabel: "Trust directory", cancelLabel: "Cancel" },
    );
    if (!approved) throw error;
    await invoke<void>("trust_repository_directory", { path });
    return invoke<RepositorySnapshot>("inspect_repository", { path });
  }
}

/** Remove only workbench registration after native ownership checks. */
export async function detachRepositoryAfterConfirmation(repositoryRoot: string): Promise<boolean> {
  requireDesktop();
  const approved = await confirm(
    `Remove repository "${repositoryRoot}" from the workbench?\n\n` +
      "Repository files, Git branches and worktrees will be kept. Stop active terminals, agents and other native work in all linked worktrees first.",
    { title: "Remove repository", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" },
  );
  if (!approved) return false;
  await invoke<void>("repository_detach", { repositoryRoot });
  return true;
}

export async function restoreRepositoryRegistration(repositoryRoot: string): Promise<void> {
  requireDesktop();
  await invoke<void>("repository_restore", { repositoryRoot });
}

/** Source edits only require Git HEAD and porcelain status, not branch/Worktree inventory. */
export async function inspectWorktreeStatus(path: string): Promise<WorktreeStatus> {
  requireDesktop();
  return invoke<WorktreeStatus>("inspect_worktree_status", { path });
}

/** Opens a registered worktree in Explorer, Finder or the Linux file manager. */
export async function openWorkspaceDirectory(repositoryRoot: string, workspaceRoot: string): Promise<void> {
  requireDesktop();
  return invoke("open_workspace_directory", { repositoryRoot, workspaceRoot });
}

/** Open a registered worktree as its own external IDE project without switching Git branches. */
export async function openWorkspaceInEditor(
  repositoryRoot: string,
  workspaceRoot: string,
  editor: ExternalEditor,
): Promise<void> {
  requireDesktop();
  return invoke("open_workspace_in_editor", { repositoryRoot, workspaceRoot, editor });
}

export async function gitSwitchBranch(repositoryRoot: string, workspaceRoot: string, branch: string): Promise<void> {
  requireDesktop();
  return invoke("git_switch_branch", { repositoryRoot, workspaceRoot, branch });
}

interface LocalBranchDeletionState {
  repositoryRoot: string;
  branch: string;
  branchHeadSha: string;
  comparisonRef: string;
  comparisonHeadSha: string;
}

type LocalBranchDeletionResult =
  | { status: "deleted" }
  | { status: "needsForce"; state: LocalBranchDeletionState };

async function gitDeleteLocalBranch(
  repositoryRoot: string, branch: string,
  force: boolean, expectedState: LocalBranchDeletionState | null,
): Promise<LocalBranchDeletionResult> {
  requireDesktop();
  return invoke("git_delete_local_branch", { repositoryRoot, branch, force, expectedState });
}

/** Both destructive steps require native confirmation; cancellation never forces. */
export async function deleteLocalBranchAfterConfirmation(
  repositoryRoot: string,
  branch: string,
): Promise<boolean> {
  requireDesktop();
  const confirmed = await confirm(
    `Delete the LOCAL branch "${branch}"?\n\n` +
      "This does not delete a branch on GitHub. A branch with unmerged commits requires a separate force-delete confirmation. " +
      "Stale origin branches are removed with Fetch.",
    {
      title: "Delete local Git branch",
      kind: "warning",
      okLabel: "Delete local",
      cancelLabel: "Cancel",
    },
  );
  if (!confirmed) return false;
  const result = await gitDeleteLocalBranch(repositoryRoot, branch, false, null);
  if (result.status === "deleted") return true;
  if (result.status !== "needsForce") throw new Error("Unexpected branch deletion response.");

  const forceConfirmed = await confirm(
    `Local branch "${branch}" is not fully merged into ${result.state.comparisonRef}.\n\n` +
      `Repository: ${repositoryRoot}\nCommit: ${result.state.branchHeadSha}\n\n` +
      "Force delete this local branch? Commits unique to this branch may become unreachable and be lost. " +
      "Keep or back up any work you still need before continuing. This does not delete a branch on GitHub.",
    {
      title: "Force delete unmerged local branch",
      kind: "warning",
      okLabel: "Force delete",
      cancelLabel: "Cancel",
    },
  );
  if (!forceConfirmed) return false;
  const deleted = await gitDeleteLocalBranch(repositoryRoot, branch, true, result.state);
  if (deleted.status !== "deleted") throw new Error("Branch changed before force deletion. Retry and review the latest branch.");
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

/**
 * Native confirmation is mandatory. Rust repeats worktree/branch/HEAD/status
 * checks after the dialog, so a stale UI cannot silently discard another
 * checkout's changes. Stash preserves tracked and untracked data.
 */
export async function resolveLocalChangesAfterConfirmation(request: LocalChangesRequest): Promise<boolean> {
  requireDesktop();
  const tracked = request.expectedChanges.filter((change) => change.kind !== "untracked");
  const untracked = request.expectedChanges.filter((change) => change.kind === "untracked");
  if (request.expectedChanges.length === 0) return false;
  const selected = request.expectedChanges.find((change) => change.path === request.path);
  const paths = tracked.slice(0, 8).map((change) =>
    "  • " + (change.oldPath ? change.oldPath + " → " : "") + change.path).join("\n");
  const remaining = tracked.length > 8 ? "\n  … and " + (tracked.length - 8) + " more" : "";
  let title: string;
  let actionLabel: string;
  let warning: string;
  if (request.action === "stashAll" && request.path === null) {
    title = "Back up local changes to Git stash";
    actionLabel = "Stash all";
    warning = "Save " + tracked.length + " tracked and " + untracked.length + " untracked change(s) to a Git stash?\n\n" +
      "The workspace will be cleaned for switching branches and Pull. Recover with git stash list / git stash pop. Ignored files remain untouched.\n\n" +
      "Workspace: " + request.workspaceRoot;
  } else if (request.action === "discardTrackedAll" && tracked.length > 0 && request.path === null) {
    title = "Discard ALL tracked changes";
    actionLabel = "Discard tracked";
    warning = "Permanently restore " + tracked.length + " tracked change(s) to HEAD, including staged and unstaged files?\n\n" +
      paths + remaining + "\n\nNewly staged files may be deleted. Untracked files and directories will NOT be removed. " +
      "THIS CANNOT BE UNDONE. Use Stash all to keep a backup instead.\n\nWorkspace: " + request.workspaceRoot;
  } else if (request.action === "discardTrackedSelected" && selected?.kind !== "untracked" && selected && request.path) {
    title = "Discard selected tracked file";
    actionLabel = "Discard file";
    warning = "Permanently revert the tracked change to HEAD?\n\n" +
      (selected.oldPath ? selected.oldPath + " → " : "") + selected.path + "\n\n" +
      "Includes staged and unstaged edits. Newly staged files may be deleted. " +
      "Other files and untracked items remain. THIS CANNOT BE UNDONE.\n\nWorkspace: " + request.workspaceRoot;
  } else if (request.action === "deleteUntrackedSelected" && selected?.kind === "untracked" && request.path) {
    title = "Delete untracked local files";
    actionLabel = "Delete untracked";
    warning = "Permanently DELETE this UNTRACKED " + (selected.path.endsWith("/") ? "DIRECTORY and its unignored contents" : "FILE") + "?\n\n" +
      selected.path + "\n\nThis includes files not saved to Git. Other entries and ignored files remain. " +
      "THIS CANNOT BE UNDONE. Use Stash all to preserve them instead.\n\nWorkspace: " + request.workspaceRoot;
  } else {
    throw new Error("Invalid or stale local changes selection; refresh Changes first.");
  }
  const confirmed = await confirm(warning, {
    title, kind: "warning", okLabel: actionLabel, cancelLabel: "Cancel",
  });
  if (!confirmed) return false;
  await invoke("git_local_changes", { request });
  return true;
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

interface WorktreeRemovalState {
  headSha: string;
  branch: string;
  statusHash: string;
}

type WorktreeRemovalResult =
  | { status: "removed" }
  | { status: "needsForce"; state: WorktreeRemovalState; trackedCount: number; untrackedCount: number };

/**
 * Never expose a bare force-delete action in the UI: Rust first validates
 * the registered non-primary worktree and returns a snapshot of its dirty
 * status. Only an explicit second native confirmation passes that snapshot
 * back to Rust for a single --force. Any intervening status/HEAD change or
 * native-dialog failure leaves the directory alone.
 */
export async function removeWorktreeAfterConfirmation(
  repositoryRoot: string,
  worktreePath: string,
): Promise<boolean> {
  requireDesktop();
  const confirmed = await confirm(
    `Remove this Git worktree?\n\n${worktreePath}\n\n` +
      "Its local Git branch is kept. If the worktree contains uncommitted changes, " +
      "a separate force-removal confirmation will be required. " +
      "Ignored/build files may also be deleted even from an otherwise clean worktree.",
    {
      title: "Remove Git worktree",
      kind: "warning",
      okLabel: "Remove worktree",
      cancelLabel: "Cancel",
    },
  );
  if (!confirmed) return false;

  let terminalStopOffered = false;
  const remove = async (force: boolean, expectedState: WorktreeRemovalState | null): Promise<WorktreeRemovalResult | null> => {
    try {
      return await invoke<WorktreeRemovalResult>("remove_worktree", {
        repositoryRoot, worktreePath, force, expectedState,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.startsWith("Workspace is reserved by terminal;") && !terminalStopOffered) {
        terminalStopOffered = true;
        const stopConfirmed = await confirm(
          `Stop the terminals in this worktree, then retry removal?\n\n${worktreePath}\n\n` +
          "This ends their shells and running commands, including any agent CLI inside those terminals. " +
          "Save important work first. Other workspaces and separately managed Agents/Run tasks are kept. " +
          "Removal waits for terminal shutdown and still requires a separate confirmation for dirty files.",
          { title: "Stop worktree terminals", kind: "warning", okLabel: "Stop and retry", cancelLabel: "Cancel" },
        );
        if (!stopConfirmed) return null;
        await invoke<void>("stop_worktree_terminals", { repositoryRoot, worktreePath });
        return remove(force, expectedState);
      }
      if (message.startsWith("Workspace is reserved by terminal;")) {
        throw new Error(
          `Cannot remove worktree "${worktreePath}" while a terminal is running there. ` +
          "Select that workspace lane, open Terminal, and use Stop or Close for its sessions. " +
          "Wait for shutdown to finish, then retry removal.",
        );
      }
      throw cause;
    }
  };
  const initial = await remove(false, null);
  if (!initial) return false;
  if (initial.status === "removed") return true;
  if (initial.status !== "needsForce") throw new Error("Unexpected worktree removal response.");

  const forceConfirmed = await confirm(
    `This worktree contains ${initial.trackedCount} tracked change(s) and ${initial.untrackedCount} untracked file(s):\n\n` +
      `${worktreePath}\n\n` +
      "FORCE REMOVE will permanently delete this worktree directory, including uncommitted tracked changes, " +
      "untracked files and any ignored/generated files in it. This cannot be undone. " +
      "Commit, back up or stash important files first. The local Git branch is retained.",
    {
      title: "Force remove dirty worktree",
      kind: "warning",
      okLabel: "Force remove",
      cancelLabel: "Cancel",
    },
  );
  if (!forceConfirmed) return false;

  const removed = await remove(true, initial.state);
  if (!removed) return false;
  if (removed.status !== "removed") {
    throw new Error("Worktree changed before force removal. Retry and review its latest contents.");
  }
  return true;
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

/** Start Codex directly with a validated executable and structured context; no shell input. */
export async function terminalSpawnCodex(request: CodexTerminalSpawnRequest): Promise<void> {
  requireDesktop();
  return invoke('terminal_spawn_codex', { request });
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

/** Select a repository script without reading its contents or starting a process. */
export async function importBuildScript(workspaceRoot: string): Promise<BuildSuggestion | null> {
  requireDesktop();
  const scriptPath = await open({
    title: "Import build script", directory: false, multiple: false, defaultPath: workspaceRoot,
    filters: [{ name: "Build scripts", extensions: ["ps1", "cmd", "bat", "sh", "py", "js", "mjs", "cjs"] }],
  });
  if (typeof scriptPath !== "string") return null;
  return invoke<BuildSuggestion>("build_workflow_import_script", { workspaceRoot, scriptPath });
}

export async function chooseBuildProgram(): Promise<string | null> {
  requireDesktop();
  const selected = await open({ title: "Select build executable or interpreter", directory: false, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function buildWorkflowSelfUpdateAvailable(workspaceRoot: string): Promise<boolean> {
  requireDesktop();
  return invoke<boolean>("build_workflow_self_update_available", { workspaceRoot });
}

/** Explicit opt-in before closing the currently running desktop window. */
export async function confirmSelfBuildRestart(): Promise<boolean> {
  requireDesktop();
  try {
    return await confirm(
      "This project is the currently running desktop application. VirtualLab will build a standalone EXE in an isolated Cargo directory (--no-bundle; no MSI/NSIS installer), then close this window and launch the newly compiled version ONLY if the build succeeds.\n\n" +
        "For a running release EXE inside this worktree, the EXE is replaced after exit. Installed copies and development/debug EXEs are left intact; a separate new runtime copy opens instead.\n\n" +
        "Unsaved UI state may be lost. Continue?",
      {
        title: "Build and restart the current application",
        kind: "warning",
        okLabel: "Build and restart",
        cancelLabel: "Cancel",
      },
    );
  } catch {
    return false;
  }
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
