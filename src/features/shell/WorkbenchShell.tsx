import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BuildIdentity } from "./BuildIdentity";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Command,
  Cpu,
  Layers3,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { HelpMenu } from "@/features/help/HelpMenu";
import { GuideDialog } from "@/features/help/GuideDialog";
import { WorkspaceSearch } from "@/features/search/WorkspaceSearch";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { NewWorkspaceDialog } from "@/features/workspace/NewWorkspaceDialog";
import { ProjectSidebar } from "@/features/sidebar/ProjectSidebar";
import { WorkspaceContent } from "@/features/workspace/WorkspaceContent";
import { WorkspaceHeader } from "@/features/workspace/WorkspaceHeader";
import {
  chooseRepositoryDirectory,
  createWorktree,
  deleteLocalBranchAfterConfirmation,
  deleteOriginBranchAfterConfirmation,
  gitFetchOrigin,
  gitPullCurrent,
  gitSwitchBranch,
  inspectRepository,
  inspectWorktreeStatus,
  isDesktopRuntime,
  openWorkspaceDirectory,
  removeWorktreeAfterConfirmation,
  resolveLocalChangesAfterConfirmation,
  watchStart,
  watchStop,
} from "@/lib/backend";
import { useWorkbenchStore } from "@/stores/workbench";
import { workspaceKey } from "@/lib/workspaceKey";
import { mergeWorktreeStatus } from "@/lib/worktreeStatus";
import { useAgentTimeline } from "@/stores/agentTimeline";
import type { AgentEvent } from "@/types/agent";
import { selectedReviewBase, suggestedReviewBranch } from "@/lib/reviewLoop";
import type {
  LocalChangesAction,
  RepositorySnapshot,
  ReviewWorkspaceRequest,
  WorkbenchEvent,
  WorkspaceTab,
} from "@/types/workbench";

const WATCH_ID = "active-workspace";
const WATCH_METADATA_QUIET_MS = 400;
const WATCH_REFRESH_QUIET_MS = 850;
const WATCH_REFRESH_MAX_WAIT_MS = 2600;

export function WorkbenchShell() {
  const {
    repositories,
    activeRepositoryId,
    addRepository,
    removeRepository,
    setActiveRepository,
    saveWorkspaceState,
    setGithubReference,
    setReviewPhase,
  } = useWorkbenchStore();

  const activeRepository = useMemo(
    () => repositories.find((item) => item.id === activeRepositoryId) ?? null,
    [activeRepositoryId, repositories],
  );

  const appendAgentEvent = useAgentTimeline((s) => s.append);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void listen<AgentEvent>("agent://event", (event) => appendAgentEvent(event.payload))
      .then((stop) => { if (cancelled) stop(); else unlisten = stop; })
      .catch(() => undefined);
    return () => { cancelled = true; unlisten?.(); };
  }, [appendAgentEvent]);

  const [snapshot, setSnapshot] = useState<RepositorySnapshot>(PREVIEW_SNAPSHOT);
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [guideOpen, setGuideOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  // A synchronous guard prevents rapid double-clicks before React re-renders.
  const gitMutationInFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [reviewIntent, setReviewIntent] = useState<ReviewWorkspaceRequest | null>(null);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const helpMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const activePathRef = useRef<string | null>(null);
  const refreshTimer = useRef<number | undefined>(undefined);
  const metadataRefreshTimer = useRef<number | undefined>(undefined);
  const firstWatchChangeAtRef = useRef<number | null>(null);
  const fullInspectionEpochRef = useRef(0);
  const statusLoadsRef = useRef(new Map<string, Promise<void>>());
  const queuedStatusRef = useRef(new Set<string>());
  const watchSequence = useRef(0);
  const snapshotLoadsRef = useRef(new Map<string, Promise<RepositorySnapshot>>());
  const snapshotCacheRef = useRef(new Map<string, RepositorySnapshot>());
  const latestSnapshotRequestRef = useRef<string | null>(null);
  const [retiredTerminal, setRetiredTerminal] = useState<{ path: string; sequence: number } | null>(null);
  const retiredTerminalSequence = useRef(0);

  const loadSnapshot = useCallback((
    path: string, requireFresh = false,
    ownerId: string | null = useWorkbenchStore.getState().activeRepositoryId,
    background = false,
  ): Promise<RepositorySnapshot> => {
    // Fresh retries inherit the *original* owner. A previous repository's
    // delayed watch/inspection must not select a path inside the new one.
    if (ownerId !== useWorkbenchStore.getState().activeRepositoryId) {
      return Promise.reject(new Error("Workspace selection changed during inspection"));
    }
    const key = normalizePath(path);
    latestSnapshotRequestRef.current = key;
    const ownsSelection = () =>
      latestSnapshotRequestRef.current === key &&
      useWorkbenchStore.getState().activeRepositoryId === ownerId;

    const existing = snapshotLoadsRef.current.get(key);
    if (existing) {
      if (requireFresh) {
        // A filesystem watch refresh may have started before git switch ended.
        // Wait for it, then *reinspect* the new HEAD instead of displaying
        // the snapshot that captured the previous branch.
        return existing.catch(() => undefined).then(() => loadSnapshot(path, true, ownerId, background));
      }
      // An older request may have lost ownership of the UI when the user
      // switched worktrees. Re-selecting its path must commit its snapshot.
      return existing.then((next) => {
        if (ownsSelection()) {
          activePathRef.current = next.root;
          setSnapshot(next);
          setSnapshotRevision((revision) => revision + 1);
          if (!background) setLoading(false);
        }
        return next;
      }).catch((cause) => {
        if (ownsSelection() && !background) {
          setLoading(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        throw cause;
      });
    }

    const cached = snapshotCacheRef.current.get(key);
    if (
      cached && ownsSelection() &&
      normalizePath(activePathRef.current ?? "") !== key
    ) {
      // Switching back to a known repository/worktree should be visually
      // immediate; a native refresh still runs in the background.
      activePathRef.current = cached.root;
      setSnapshot(cached);
    }

    if (!background) setLoading(true);
    // A filesystem watcher refresh must not erase a meaningful Git error
    // (e.g. an untracked file collision) before the user can read it.

    // Invalidates any older lightweight status request before a full inspection.
    fullInspectionEpochRef.current += 1;
    const request = inspectRepository(path)
      .then((next) => {
        snapshotCacheRef.current.set(key, next);
        if (ownsSelection()) {
          activePathRef.current = next.root;
          setSnapshot(next);
          setSnapshotRevision((revision) => revision + 1);
        }
        return next;
      })
      .catch((err) => {
        if (ownsSelection() && !background) {
          const message =
            err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
          setError(message);
        }
        throw err;
      })
      .finally(() => {
        snapshotLoadsRef.current.delete(key);
        // A slow inspection of another repository must never keep the
        // currently selected workspace in a permanent loading state.
        if (ownsSelection() && !background) setLoading(false);
      });

    snapshotLoadsRef.current.set(key, request);
    return request;
  }, []);

  useEffect(() => {
    if (!activeRepository) {
      latestSnapshotRequestRef.current = null;
      activePathRef.current = null;
      setSnapshot(PREVIEW_SNAPSHOT);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const repositoryId = activeRepository.id;
    const saved = useWorkbenchStore.getState().workspaceStates[repositoryId];
    const preferredPath = saved?.activeWorktreePath || activeRepository.path;
    const preferredTab = saved?.activeTab ?? "overview";
    const stillSelected = (path: string) =>
      !cancelled &&
      useWorkbenchStore.getState().activeRepositoryId === repositoryId &&
      latestSnapshotRequestRef.current === normalizePath(path);

    setTab(preferredTab);
    void loadSnapshot(preferredPath)
      .then((next) => {
        // A delayed response must not undo a worktree/repository/tab change.
        if (!stillSelected(preferredPath)) return;
        saveWorkspaceState({
          repositoryId,
          activeWorktreePath: next.root,
          activeTab: useWorkbenchStore.getState().workspaceStates[repositoryId]?.activeTab ?? preferredTab,
          updatedAt: Date.now(),
        });
      })
      .catch(() => {
        if (cancelled || useWorkbenchStore.getState().activeRepositoryId !== repositoryId ||
            preferredPath === activeRepository.path ||
            latestSnapshotRequestRef.current !== normalizePath(preferredPath)) return;
        void loadSnapshot(activeRepository.path)
          .then((next) => {
            if (!stillSelected(activeRepository.path)) return;
            saveWorkspaceState({
              repositoryId,
              activeWorktreePath: next.root,
              activeTab: "overview",
              updatedAt: Date.now(),
            });
            setTab("overview");
          })
          .catch(() => undefined);
      });
    return () => { cancelled = true; };
  }, [activeRepository, loadSnapshot, saveWorkspaceState]);

  const refreshWorkingTree: (path: string, ownerId: string) => Promise<void> = useCallback(
    (path, ownerId) => {
      const key = normalizePath(path);
      const ownsSelection = () =>
        latestSnapshotRequestRef.current === key &&
        normalizePath(activePathRef.current ?? "") === key &&
        useWorkbenchStore.getState().activeRepositoryId === ownerId;

      if (!ownsSelection() || gitMutationInFlightRef.current ||
          snapshotLoadsRef.current.has(key)) return Promise.resolve();

      const inFlight = statusLoadsRef.current.get(key);
      if (inFlight) {
        // An edit arriving during a Git status scan needs one trailing scan;
        // otherwise a quiet final write could be missed.
        queuedStatusRef.current.add(key);
        return inFlight;
      }

      const epoch = fullInspectionEpochRef.current;
      const request = inspectWorktreeStatus(path)
        .then(async (status) => {
          if (!ownsSelection() || gitMutationInFlightRef.current ||
              snapshotLoadsRef.current.has(key) ||
              fullInspectionEpochRef.current !== epoch) return;

          const previous = snapshotCacheRef.current.get(key);
          if (!previous) return;
          const next = mergeWorktreeStatus(previous, status);
          if (!next) {
            // Terminal-side commit/checkout changed HEAD: reload branch and
            // worktree metadata once, without blocking or flashing the sidebar.
            await loadSnapshot(path, true, ownerId, true);
          } else if (next !== previous) {
            snapshotCacheRef.current.set(key, next);
            setSnapshot(next);
            setSnapshotRevision((revision) => revision + 1);
          }
        })
        .catch(() => {
          // A watcher read may race an external Git operation. Keep the last
          // valid snapshot and leave diagnostic errors to explicit Refresh.
        })
        .finally(() => {
          statusLoadsRef.current.delete(key);
          if (queuedStatusRef.current.delete(key) && ownsSelection() &&
              !gitMutationInFlightRef.current) {
            void refreshWorkingTree(path, ownerId);
          }
        });
      statusLoadsRef.current.set(key, request);
      return request;
    },
    [loadSnapshot],
  );

  useEffect(() => {
    if (
      !isDesktopRuntime() ||
      !activeRepository ||
      !snapshot.root ||
      !activePathRef.current ||
      normalizePath(activePathRef.current) !== normalizePath(snapshot.root) ||
      !snapshot.worktrees.some((tree) => normalizePath(tree.path) === normalizePath(activeRepository.path))
    ) {
      return;
    }

    // Each subscription owns a unique native ID: an old asynchronous stop
    // must not tear down a freshly reselected watcher of the same path.
    const watchId = `${WATCH_ID}:${++watchSequence.current}:${snapshot.root}`;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    void watchStart(watchId, snapshot.root)
      .then(() => { if (disposed) void watchStop(watchId).catch(() => undefined); })
      .catch((err) => { if (!disposed) setError(err instanceof Error ? err.message : String(err)); });

    void Promise.resolve(listen<WorkbenchEvent>("workbench://event", ({ payload }) => {
      if (disposed || payload.id !== watchId) return;
      if (payload.eventType === "git.changed") {
        // HEAD, branch refs and worktree inventories are inexpensive to
        // refresh only when Git metadata actually changes.
        window.clearTimeout(metadataRefreshTimer.current);
        metadataRefreshTimer.current = window.setTimeout(() => {
          if (!gitMutationInFlightRef.current) {
            void loadSnapshot(snapshot.root, true, activeRepository.id, true).catch(() => undefined);
          }
        }, WATCH_METADATA_QUIET_MS);
        return;
      }
      if (payload.eventType !== "fs.changed" &&
          payload.eventType !== "git.status_changed") return;
      const now = Date.now();
      if (firstWatchChangeAtRef.current === null) firstWatchChangeAtRef.current = now;
      // Coalesce write bursts; the max wait prevents continuous Agent output
      // from indefinitely postponing the final Git status refresh.
      const remaining = WATCH_REFRESH_MAX_WAIT_MS - (now - firstWatchChangeAtRef.current);
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        firstWatchChangeAtRef.current = null;
        void refreshWorkingTree(snapshot.root, activeRepository.id);
      }, Math.max(0, Math.min(WATCH_REFRESH_QUIET_MS, remaining)));
    })).then((fn) => {
      if (typeof fn !== "function") return;
      if (disposed) fn();
      else unlisten = fn;
    }).catch((cause) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer.current);
      window.clearTimeout(metadataRefreshTimer.current);
      firstWatchChangeAtRef.current = null;
      unlisten?.();
      void watchStop(watchId).catch(() => undefined);
    };
  }, [activeRepository, loadSnapshot, refreshWorkingTree, snapshot.root]);

  const addLocalRepository = async () => {
    try {
      const path = await chooseRepositoryDirectory();
      if (!path) return;

      // Inspect before registering a new repository: a failed dialog or an
      // invalid folder must not modify the current repository's selection.
      const next = await inspectRepository(path);
      snapshotCacheRef.current.set(normalizePath(next.root), next);
      const existing = useWorkbenchStore.getState().repositories.find(
        (item) => normalizePath(item.path) === normalizePath(next.root));
      const id = existing?.id ??
        (globalThis.crypto?.randomUUID?.() ??
          `repo-${Date.now()}-${Math.random().toString(16).slice(2)}`);

      addRepository({
        id,
        name: next.name,
        path: next.root,
        lastOpenedAt: Date.now(),
      });
      saveWorkspaceState({
        repositoryId: id,
        activeWorktreePath: next.root,
        activeTab: "overview",
        updatedAt: Date.now(),
      });
      latestSnapshotRequestRef.current = normalizePath(next.root);
      activePathRef.current = next.root;
      setLoading(false);
      setError(null);
      setSnapshot(next);
      setTab("overview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const createWorkspace = async (
    branch: string,
    baseRef: string,
    targetPath?: string,
  ) => {
    if (!activeRepository) return;
    const created = await createWorktree(
      activeRepository.path,
      branch,
      baseRef,
      targetPath,
    );
    if (useWorkbenchStore.getState().activeRepositoryId !== activeRepository.id) return;
    const next = await loadSnapshot(created.path);
    if (useWorkbenchStore.getState().activeRepositoryId !== activeRepository.id ||
        latestSnapshotRequestRef.current !== normalizePath(created.path)) return;
    if (reviewIntent) {
      // A source PR/issue is only a reference: never silently check out remote code.
      setGithubReference(next.root, reviewIntent.reference);
      setReviewPhase(next.root, "review");
    }
    const nextTab = reviewIntent ? "github" : "overview";
    saveWorkspaceState({
      repositoryId: activeRepository.id,
      activeWorktreePath: next.root,
      activeTab: nextTab,
      updatedAt: Date.now(),
    });
    setTab(nextTab);
    setReviewIntent(null);
  };

  const refreshForRereview = async (workspaceRoot: string) => {
    if (!activeRepository || normalizePath(workspaceRoot) !== normalizePath(snapshot.root)) return;
    const repositoryId = activeRepository.id;
    await loadSnapshot(workspaceRoot);
    if (useWorkbenchStore.getState().activeRepositoryId !== repositoryId ||
        latestSnapshotRequestRef.current !== normalizePath(workspaceRoot)) return;
    setReviewPhase(workspaceRoot, "needs_rereview");
    setTab("changes");
    saveWorkspaceState({
      repositoryId: activeRepository.id,
      activeWorktreePath: workspaceRoot,
      activeTab: "changes",
      updatedAt: Date.now(),
    });
  };

  const deleteWorkspace = async (path: string) => {
    if (!activeRepository || loading || gitMutationInFlightRef.current ||
        !snapshot.worktrees.some((item) => normalizePath(item.path) === normalizePath(path))) return;

    // Keep the mutation lock through BOTH native dialogs and the Git command.
    // A cancelled force confirmation leaves the selected worktree unchanged.
    gitMutationInFlightRef.current = true;
    setGitBusy(true);
    setError(null);
    try {
      const removed = await removeWorktreeAfterConfirmation(activeRepository.path, path);
      if (!removed) return;

      snapshotCacheRef.current.delete(normalizePath(path));
      setRetiredTerminal({ path, sequence: ++retiredTerminalSequence.current });
      if (useWorkbenchStore.getState().activeRepositoryId !== activeRepository.id) return;
      const wasActive = normalizePath(activePathRef.current ?? snapshot.root) === normalizePath(path);
      const remainingPath = wasActive
        ? activeRepository.path
        : (activePathRef.current ?? activeRepository.path);
      const next = await loadSnapshot(remainingPath, true);
      saveWorkspaceState({
        repositoryId: activeRepository.id,
        activeWorktreePath: next.root,
        activeTab: wasActive ? "overview" : tab,
        updatedAt: Date.now(),
      });
      if (wasActive) setTab("overview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      gitMutationInFlightRef.current = false;
      setGitBusy(false);
    }
  };

  const runGitMutation = async (action: () => Promise<void | boolean>): Promise<boolean> => {
    if (!activeRepository || gitMutationInFlightRef.current || loading ||
        useWorkbenchStore.getState().activeRepositoryId !== activeRepository.id) return false;
    const repositoryId = activeRepository.id;
    const selectedPath = activePathRef.current ?? activeRepository.path;
    const stillSelected = () =>
      useWorkbenchStore.getState().activeRepositoryId === repositoryId &&
      normalizePath(activePathRef.current ?? "") === normalizePath(selectedPath);
    gitMutationInFlightRef.current = true;
    setGitBusy(true);
    setError(null);
    let succeeded = false;
    try {
      succeeded = await action() !== false;
    } catch (err) {
      if (stillSelected()) setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Even a failed operation can have changed the worktree (e.g. a stash
      // succeeded but checkout encountered a collision). Refresh its owner,
      // not whatever repository the user navigated to in the meantime.
      snapshotCacheRef.current.delete(normalizePath(selectedPath));
      if (stillSelected()) {
        try { await loadSnapshot(selectedPath, true); }
        catch { /* loadSnapshot already reports the error for this selection. */ }
      }
      gitMutationInFlightRef.current = false;
      setGitBusy(false);
    }
    return succeeded;
  };

  const resolveLocalChanges = async (action: LocalChangesAction, path?: string): Promise<boolean> => {
    if (!activeRepository || !isDesktopRuntime() ||
        normalizePath(activePathRef.current ?? "") !== normalizePath(snapshot.root)) return false;
    return runGitMutation(() => resolveLocalChangesAfterConfirmation({
      repositoryRoot: activeRepository.path,
      workspaceRoot: snapshot.root,
      expectedBranch: snapshot.currentBranch,
      expectedHeadSha: snapshot.headSha,
      expectedChanges: snapshot.changes,
      action,
      path: path ?? null,
    }));
  };

  const selectBranch = async (name: string) => {
    if (!activeRepository || gitBusy || loading || gitMutationInFlightRef.current) return;
    const repositoryId = activeRepository.id;
    const selected = snapshot;
    if (name === selected.currentBranch) return;
    const occupied = selected.branches.find((branch) => branch.name === name)?.worktreePath;
    if (occupied && normalizePath(occupied) !== normalizePath(selected.root)) {
      // Navigation to an existing worktree never stashes or transfers edits.
      try {
        setError(null);
        const next = await loadSnapshot(occupied, true);
        if (useWorkbenchStore.getState().activeRepositoryId !== repositoryId ||
            latestSnapshotRequestRef.current !== normalizePath(occupied)) return;
        saveWorkspaceState({
          repositoryId,
          activeWorktreePath: next.root,
          activeTab: tab,
          updatedAt: Date.now(),
        });
      } catch (err) {
        if (useWorkbenchStore.getState().activeRepositoryId === repositoryId) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      return;
    }
    await runGitMutation(async () => {
      let stashed = false;
      if (selected.stagedCount > 0 || selected.unstagedCount > 0) {
        // The existing native confirmation and Rust HEAD/branch/status guards
        // form a safe, one-click Stash & Switch workflow. Stashes are never
        // popped onto a different branch automatically.
        stashed = await resolveLocalChangesAfterConfirmation({
          repositoryRoot: activeRepository.path,
          workspaceRoot: selected.root,
          expectedBranch: selected.currentBranch,
          expectedHeadSha: selected.headSha,
          expectedChanges: selected.changes,
          action: "stashAll",
          path: null,
        });
        if (!stashed) return false;
      }
      try {
        await gitSwitchBranch(activeRepository.path, selected.root, name);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(stashed
          ? `Switch to "${name}" failed: ${detail}. Your local edits are preserved in Git stash (git stash list); they were NOT restored automatically.`
          : detail);
      }
    });
  };

  const deleteLocalBranch = async (name: string) => {
    if (!activeRepository || gitBusy || loading) return;
    const branch = snapshot.branches.find((item) => item.name === name);
    if (!branch?.local || branch.worktreePath || name === "main" || name === "master") return;
    // This keeps the branch action disabled while the native confirmation
    // dialog is open. Cancel/close/permission errors never delete a branch.
    await runGitMutation(() => deleteLocalBranchAfterConfirmation(activeRepository.path, name));
  };

  const deleteOriginBranch = async (name: string) => {
    if (!activeRepository || gitBusy || loading) return;
    const branch = snapshot.branches.find((item) => item.name === name);
    if (!branch?.remote || name === "main" || name === "master" || name === snapshot.originDefaultBranch) return;
    await runGitMutation(() => deleteOriginBranchAfterConfirmation(activeRepository.path, name));
  };

  // The store switches immediately, but a native inspection can finish later.
  // Never render actionable controls against the previous repository's HEAD.
  const workspaceReady = Boolean(activeRepository && activePathRef.current &&
    normalizePath(activePathRef.current) === normalizePath(snapshot.root) &&
    snapshot.worktrees.some((tree) => normalizePath(tree.path) === normalizePath(activeRepository.path)));
  const isPreview = !workspaceReady;
  const visibleSnapshot = workspaceReady ? snapshot : PREVIEW_SNAPSHOT;
  const native = isDesktopRuntime();

  const openFolder = async (path: string, repositoryPath: string) => {
    try {
      await openWorkspaceDirectory(repositoryPath, path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectRepository = (id: string) => {
    if (id === activeRepositoryId) return;
    latestSnapshotRequestRef.current = null;
    activePathRef.current = null;
    setLoading(true);
    setError(null);
    setActiveRepository(id);
  };

  const switchTab = (nextTab: WorkspaceTab) => {
    if (activeRepository && !workspaceReady) return;
    setTab(nextTab);
    if (!activeRepository) return;
    saveWorkspaceState({
      repositoryId: activeRepository.id,
      activeWorktreePath: activePathRef.current ?? snapshot.root ?? activeRepository.path,
      activeTab: nextTab,
      updatedAt: Date.now(),
    });
  };

  return (
    <div className="pixel-ui vl-workbench flex h-screen min-h-0 min-w-0 flex-col overflow-hidden text-slate-100">
      <div
        className="vl-topbar flex h-12 min-w-0 shrink-0 items-center gap-3 border-b px-3 sm:px-4"
        data-tauri-drag-region
      >
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-lg border border-orange-400/20 bg-orange-400/10 text-orange-300">
            <Layers3 size={15} />
          </div>
          <div>
            <div className="text-[12px] font-semibold leading-none tracking-[-0.01em] text-slate-100">
              VirtualLab
            </div>
            <div className="mt-1 text-[9px] uppercase tracking-[0.16em] text-stone-600">
              Engineering Workbench
            </div>
          </div>
        </div>

        <nav aria-label="Application menu" className="shrink-0">
          <HelpMenu
            triggerRef={helpMenuTriggerRef}
            onOpenGuide={() => setGuideOpen(true)}
          />
        </nav>

        <div className="mx-auto min-w-0 w-full max-w-[420px] flex-1">
          <WorkspaceSearch value={searchQuery} onChange={setSearchQuery} />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={native ? "green" : "amber"}>
            <Cpu size={11} />
            {native ? "Native" : "Web preview"}
          </Badge>
          <span title="Workspace execution">
            <Badge tone="orange">
              <ShieldCheck size={11} />
              <span className="hidden min-[1150px]:inline">Workspace execution</span>
            </Badge>
          </span>
        </div>
      </div>

      {error && (
        <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-rose-400/15 bg-rose-400/[0.06] px-4 py-2 text-xs text-rose-200">
          <TriangleAlert size={14} />
          <span className="truncate" title={error}>{error}</span>
          <button className="ml-auto text-[10px] text-rose-300/60 hover:text-rose-200" onClick={() => setError(null)} type="button">
            dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ProjectSidebar
          repositories={repositories}
          activeRepositoryId={activeRepositoryId}
          snapshot={visibleSnapshot}
          isPreview={isPreview}
          onAdd={addLocalRepository}
          filterQuery={searchQuery}
          repositoryActionsEnabled={native}
          onSelect={selectRepository}
          onRemove={removeRepository}
          onOpenRepositoryFolder={(path) => void openFolder(path, path)}
          onOpenWorkspaceFolder={(path) => {
            if (activeRepository && workspaceReady) void openFolder(path, activeRepository.path);
          }}
          onNewWorkspace={() => { setReviewIntent(null); setWorkspaceDialog(true); }}
          onSelectWorkspace={(path) => {
            if (!activeRepository || !workspaceReady || gitMutationInFlightRef.current || loading) return;
            const repositoryId = activeRepository.id;
            void loadSnapshot(path)
              .then((next) => {
                if (useWorkbenchStore.getState().activeRepositoryId !== repositoryId ||
                    latestSnapshotRequestRef.current !== normalizePath(path)) return;
                saveWorkspaceState({
                  repositoryId,
                  activeWorktreePath: next.root,
                  activeTab: tab,
                  updatedAt: Date.now(),
                });
              })
              .catch(() => undefined);
          }}
          onRemoveWorkspace={(path) => void deleteWorkspace(path)}
          workspaceActionsEnabled={native && workspaceReady && !loading && !gitBusy}
          branchActionsEnabled={native && workspaceReady && !loading && !gitBusy}
          onSwitchBranch={(branch) => { void selectBranch(branch); }}
          onDeleteBranch={(branch) => { void deleteLocalBranch(branch); }}
          onDeleteOriginBranch={(branch) => { void deleteOriginBranch(branch); }}
        />

        <section className="vl-stage flex min-h-0 min-w-0 flex-1 flex-col">
          <WorkspaceHeader
            snapshot={visibleSnapshot}
            isPreview={isPreview}
            loading={loading}
            gitBusy={gitBusy}
            onFetch={() => {
              if (activeRepository) void runGitMutation(() => gitFetchOrigin(activeRepository.path));
            }}
            onPull={() => {
              if (activeRepository) void runGitMutation(() => gitPullCurrent(activeRepository.path, snapshot.root));
            }}
            onOpenFolder={() => {
              if (activeRepository && workspaceReady) void openFolder(snapshot.root, activeRepository.path);
            }}
            onRefresh={() => {
              setError(null);
              const path = activePathRef.current;
              if (path) void loadSnapshot(path).catch(() => undefined);
            }}
          />

          <WorkspaceContent
            snapshot={visibleSnapshot}
            profileRepositoryRoot={activeRepository?.path ?? visibleSnapshot.root}
            terminalRepositoryId={workspaceReady ? activeRepository?.id ?? null : null}
            registeredRepositoryIds={repositories.map((item) => item.id)}
            retiredTerminal={retiredTerminal}
            tab={tab}
            isPreview={isPreview}
            snapshotRevision={snapshotRevision}
            onRefreshForRereview={refreshForRereview}
            onResolveLocalChanges={resolveLocalChanges}
            gitMutationPending={gitBusy || loading || !workspaceReady}
            onNewReviewWorkspace={(intent) => {
              if (!activeRepository || !native || !workspaceReady) return;
              setReviewIntent(intent);
              setWorkspaceDialog(true);
            }}
            onTabChange={switchTab}
          />

          <footer className="vl-footer flex h-7 min-w-0 shrink-0 items-center justify-between gap-2 border-t px-3 text-[10px] text-stone-600">
            <div className="flex min-w-0 items-center gap-4">
              <span className="flex shrink-0 items-center gap-1.5">
                <Command size={11} />
                local-first
              </span>
              <span className="min-w-0 truncate" title="workspace owns execution context">workspace owns execution context</span>
            </div>
            <BuildIdentity />
          </footer>
        </section>
      </div>

      {guideOpen && (
        <GuideDialog
          onClose={() => {
            setGuideOpen(false);
            helpMenuTriggerRef.current?.focus();
          }}
        />
      )}

      {workspaceDialog && activeRepository && workspaceReady && (
        <NewWorkspaceDialog
          defaultBaseRef={reviewIntent ? selectedReviewBase(snapshot.headSha) : snapshot.currentBranch || "HEAD"}
          defaultBranch={reviewIntent ? suggestedReviewBranch(reviewIntent) : ""}
          reviewLabel={reviewIntent ? `${reviewIntent.kind.toUpperCase()} #${reviewIntent.number}` : undefined}
          onClose={() => { setWorkspaceDialog(false); setReviewIntent(null); }}
          onCreate={createWorkspace}
        />
      )}
    </div>
  );
}


function normalizePath(path: string) {
  return workspaceKey(path);
}
