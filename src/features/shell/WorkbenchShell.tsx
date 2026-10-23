import { cleanupMergedAfterConfirmation, type CleanupOutcome } from "@/lib/gitCleanup";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BuildIdentity } from "./BuildIdentity";
import { AgentsHub } from "@/features/agents/AgentsHub";
import { useTaskObserver } from "@/features/tasks/useTaskObserver";
import { useRepositoryContextStore } from '@/stores/repositoryContext';
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
import type { TerminalOpenRequest } from "@/features/terminal/TerminalWorkspace";
import { WorkspaceHeader } from "@/features/workspace/WorkspaceHeader";
import {
  chooseRepositoryDirectory,
  createWorktree,
  detachRepositoryAfterConfirmation,
  restoreRepositoryRegistration,
  deleteLocalBranchAfterConfirmation,
  deleteOriginBranchAfterConfirmation,
  gitFetchOrigin,
  gitPullCurrent,
  gitSwitchBranch,
  inspectRepository,
  inspectWorktreeStatus,
  isDesktopRuntime,
  openWorkspaceDirectory,
  openWorkspaceInEditor,
  removeWorktreeAfterConfirmation,
  resolveLocalChangesAfterConfirmation,
  watchStart,
  watchStop,
} from "@/lib/backend";
import { useWorkbenchStore } from "@/stores/workbench";
import { useAgentsHubStore } from "@/stores/agentsHub";
import { selectTask, useTaskStore } from "@/stores/tasks";
import { workspaceKey } from "@/lib/workspaceKey";
import { usePreferredEditor, savePreferredEditor, type ExternalEditor } from "@/lib/externalEditor";
import { mergeWorktreeStatus } from "@/lib/worktreeStatus";
import { useAgentTimeline } from "@/stores/agentTimeline";
import { NotificationCenter } from "@/features/notifications/NotificationCenter";
import { noticeForAgentEvent, publishTaskNotice, useTaskNotifications, type TaskNotice } from "@/stores/taskNotifications";
import type { AgentEvent } from "@/types/agent";
import { selectedReviewBase, suggestedReviewBranch } from "@/lib/reviewLoop";
import type {
  LocalChangesAction,
  RepositoryRecord,
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

  type AppView = "home" | "repositories" | "settings";
  // Preserve existing operators' workspace; fresh installs begin at Agents Hub.
  const [appView, setAppViewState] = useState<AppView>(() => activeRepositoryId ? "repositories" : "home");
  const navigationEpoch = useRef(0);
  const setAppView = useCallback((view: AppView) => {
    navigationEpoch.current += 1;
    setAppViewState(view);
  }, []);
  const lastTaskView = useRef<Exclude<AppView, "repositories">>("home");
  if (appView !== "repositories") lastTaskView.current = appView;
  useTaskObserver(repositories);
  useEffect(() => { useRepositoryContextStore.getState().retainRepositories(repositories.map(repository => repository.path)); }, [repositories]);

  useEffect(() => {
    // Inventory lookups only complete the navigation that requested them.
    // Hub/task selections can change independently of shell route buttons.
    const stopHub = useAgentsHubStore.subscribe((next, previous) => {
      if (next.section !== previous.section || next.sessionTarget !== previous.sessionTarget) navigationEpoch.current += 1;
    });
    const stopTasks = useTaskStore.subscribe((next, previous) => {
      if (next.navigationRevision !== previous.navigationRevision) navigationEpoch.current += 1;
    });
    const stopWorkbench = useWorkbenchStore.subscribe((next, previous) => {
      const selected = next.workspaceStates[next.activeRepositoryId ?? ""];
      const prior = previous.workspaceStates[previous.activeRepositoryId ?? ""];
      if (next.activeRepositoryId !== previous.activeRepositoryId ||
          workspaceKey(selected?.activeWorktreePath ?? "") !== workspaceKey(prior?.activeWorktreePath ?? "") || selected?.activeTab !== prior?.activeTab) {
        navigationEpoch.current += 1;
      }
    });
    return () => {
      navigationEpoch.current += 1;
      stopHub(); stopTasks(); stopWorkbench();
    };
  }, []);

  const appendAgentEvent = useAgentTimeline((s) => s.append);
  const [snapshot, setSnapshot] = useState<RepositorySnapshot>(PREVIEW_SNAPSHOT);
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [guideOpen, setGuideOpen] = useState(false);
  const viewed = useRef({ appView, guideOpen });
  viewed.current = { appView, guideOpen };
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void listen<AgentEvent>("agent://event", ({ payload }) => {
      appendAgentEvent(payload);
      const notice = noticeForAgentEvent(payload);
      if (notice) {
        const hub = useAgentsHubStore.getState();
        const owner = knownWorkspaceOwner(notice.workspaceRoot);
        publishTaskNotice({ ...notice, repositoryId: owner?.id ?? null },
          document.hasFocus() && !viewed.current.guideOpen && viewed.current.appView === "home" &&
          hub.section === "sessions" && hub.visibleSessionRoot !== null &&
          workspaceKey(hub.visibleSessionRoot) === workspaceKey(notice.workspaceRoot));
      }
    }).then((stop) => { if (cancelled) stop(); else unlisten = stop; })
      .catch(() => undefined);
    return () => { cancelled = true; unlisten?.(); };
  }, [appendAgentEvent]);
  const [loading, setLoading] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const [cleanupReport, setCleanupReport] = useState<(CleanupOutcome & { repositoryId: string }) | null>(null);
  const [cleanupProgress, setCleanupProgress] = useState("");
  // A synchronous guard prevents rapid double-clicks before React re-renders.
  const gitMutationInFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [ownershipErrorPath, setOwnershipErrorPath] = useState<string | null>(null);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [reviewIntent, setReviewIntent] = useState<ReviewWorkspaceRequest | null>(null);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const preferredEditor = usePreferredEditor();
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
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<TerminalOpenRequest | null>(null);
  const terminalOpenSequence = useRef(0);

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
    let selectionKey = key;
    const ownsSelection = () =>
      latestSnapshotRequestRef.current === selectionKey &&
      useWorkbenchStore.getState().activeRepositoryId === ownerId;

    const existing = snapshotLoadsRef.current.get(key);
    if (existing) {
      if (requireFresh) {
        // A filesystem watch refresh may have started before git switch ended.
        // Wait for it, then *reinspect* the new HEAD instead of displaying
        // the snapshot that captured the previous branch.
        return existing.then(
          (next) => ownsSelection() ? loadSnapshot(path, true, ownerId, background) : next,
          (cause) => {
            if (!ownsSelection()) throw cause;
            return loadSnapshot(path, true, ownerId, background);
          },
        );
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
    let recovered = false;
    const request = inspectRepository(path)
      .catch(async (cause) => {
        const repository = useWorkbenchStore.getState().repositories.find((item) => item.id === ownerId);
        if (!ownsSelection() || !repository || normalizePath(repository.path) === key) throw cause;

        // A CLI may have removed the selected worktree. Read its registered
        // repository before changing selection; a transient Git error must not
        // move the user away from a worktree that is still registered.
        let primary: RepositorySnapshot;
        try { primary = await inspectRepository(repository.path); }
        catch { throw cause; }
        if (!ownsSelection() ||
            primary.worktrees.some((tree) => normalizePath(tree.path) === key && !tree.missing) ||
            !primary.worktrees.some((tree) => normalizePath(tree.path) === normalizePath(primary.root))) throw cause;
        recovered = true;
        return primary;
      })
      .then((next) => {
        if (recovered && !ownsSelection()) return next;
        snapshotCacheRef.current.set(normalizePath(next.root), next);
        if (ownsSelection()) {
          if (recovered) {
            snapshotCacheRef.current.delete(key);
            selectionKey = normalizePath(next.root);
            latestSnapshotRequestRef.current = selectionKey;
            saveWorkspaceState({
              repositoryId: ownerId!, activeWorktreePath: next.root,
              activeTab: "overview", updatedAt: Date.now(),
            });
            setTab("overview");
            setError(null);
            // A foreground re-selection may have joined this background read.
            // It is satisfied by recovery even though its old path lost ownership.
            setLoading(false);
          }
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
          setOwnershipErrorPath(message.includes("detected dubious ownership") ? path : null);
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
  }, [saveWorkspaceState]);

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
      .catch(() => undefined); // loadSnapshot owns recovery and error reporting.
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
        .catch(async () => {
          if (!ownsSelection() || gitMutationInFlightRef.current ||
              snapshotLoadsRef.current.has(key) || fullInspectionEpochRef.current !== epoch) return;
          // A source event can be the last event before a directory disappears.
          // Full inspection can confirm removal and recover through its owner.
          try { await loadSnapshot(path, true, ownerId, true); }
          catch { /* A transient failure keeps the last valid snapshot. */ }
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
    if (gitMutationInFlightRef.current || !isDesktopRuntime()) return;
    gitMutationInFlightRef.current = true;
    setGitBusy(true);
    try {
      const path = await chooseRepositoryDirectory();
      if (!path) return;

      // Inspect before registering a new repository: a failed dialog or an
      // invalid folder must not modify the current repository's selection.
      const next = await inspectRepository(path, { confirmOwnership: true });
      await restoreRepositoryRegistration(next.root);
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
    } finally {
      gitMutationInFlightRef.current = false;
      setGitBusy(false);
    }
  };

  const retryRepositoryOwnership = async () => {
    if (!ownershipErrorPath || gitMutationInFlightRef.current || loading) return;
    const path = ownershipErrorPath;
    const ownerId = useWorkbenchStore.getState().activeRepositoryId;
    gitMutationInFlightRef.current = true;
    setGitBusy(true);
    try {
      await inspectRepository(path, { confirmOwnership: true });
      if (useWorkbenchStore.getState().activeRepositoryId !== ownerId ||
          latestSnapshotRequestRef.current !== normalizePath(path)) return;
      await loadSnapshot(path, true, ownerId);
      setError(null);
      setOwnershipErrorPath(null);
    } catch (reason) {
      if (useWorkbenchStore.getState().activeRepositoryId === ownerId) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      gitMutationInFlightRef.current = false;
      setGitBusy(false);
    }
  };

  const detachLocalRepository = async (id: string) => {
    const record = useWorkbenchStore.getState().repositories.find((repo) => repo.id === id);
    if (!record || gitMutationInFlightRef.current || !isDesktopRuntime()) return;
    gitMutationInFlightRef.current = true;
    setGitBusy(true);
    setError(null);
    try {
      if (!await detachRepositoryAfterConfirmation(record.path)) return;
      useTaskNotifications.getState().discardRepository(record.path, id);
      snapshotCacheRef.current.delete(normalizePath(record.path));
      removeRepository(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      gitMutationInFlightRef.current = false;
      setGitBusy(false);
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
      useTaskNotifications.getState().discardWorkspace(path);
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

  const cleanMerged = async () => {
    if (!activeRepository || gitBusy || loading || gitMutationInFlightRef.current) return;
    const repositoryId = activeRepository.id;
    setCleanupReport(null);
    // Use the normal branch switch/navigation flow, including its native
    // Stash & Switch confirmation. Cancellation/failure stops cleanup.
    if (snapshot.currentBranch !== "main") await selectBranch("main");
    if (useWorkbenchStore.getState().activeRepositoryId !== repositoryId) return;
    const selectedPath = activePathRef.current;
    const selected = selectedPath && snapshotCacheRef.current.get(normalizePath(selectedPath));
    if (!selected || selected.currentBranch !== "main") return;
    await runGitMutation(async () => {
      try {
        const result = await cleanupMergedAfterConfirmation(activeRepository.path, selected.root, setCleanupProgress);
        if (!result) return false;
        snapshotCacheRef.current.clear();
        setCleanupReport({ ...result, repositoryId });
      } finally { setCleanupProgress(""); }
    });
  };

  const selectBranch = async (name: string) => {
    if (!activeRepository || gitBusy || loading || gitMutationInFlightRef.current) return;
    const repositoryId = activeRepository.id;
    const selected = snapshot;
    if (name === selected.currentBranch) return;
    const occupied = selected.branches.find((branch) => branch.name === name)?.worktreePath;
    if (occupied && selected.worktrees.some(tree => normalizePath(tree.path) === normalizePath(occupied) && tree.missing)) {
      setError("This worktree directory is missing. Remove its stale worktree registration, then switch branches again.");
      return;
    }
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

  const chooseEditor = (editor: ExternalEditor) => {
    savePreferredEditor(editor);
  };

  const openEditor = async (path: string, repositoryPath: string) => {
    const repositoryId = useWorkbenchStore.getState().activeRepositoryId;
    try {
      await openWorkspaceInEditor(repositoryPath, path, preferredEditor);
    } catch (err) {
      // A slow/native failure from an earlier selection must not overwrite the
      // new repository's errors or status.
      if (useWorkbenchStore.getState().activeRepositoryId === repositoryId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const selectRepository = (id: string) => {
    navigationEpoch.current += 1;
    if (id === activeRepositoryId) return;
    latestSnapshotRequestRef.current = null;
    activePathRef.current = null;
    setLoading(true);
    setError(null);
    setActiveRepository(id);
  };

  const switchTab = (nextTab: WorkspaceTab) => {
    if (activeRepository && !workspaceReady) return;
    navigationEpoch.current += 1;
    setTab(nextTab);
    if (!activeRepository) return;
    saveWorkspaceState({
      repositoryId: activeRepository.id,
      activeWorktreePath: activePathRef.current ?? snapshot.root ?? activeRepository.path,
      activeTab: nextTab,
      updatedAt: Date.now(),
    });
  };

  function knownWorkspaceOwner(root: string, repositoryId?: string | null): RepositoryRecord | null {
    const state = useWorkbenchStore.getState();
    const key = workspaceKey(root);
    const tasks = useTaskStore.getState().tasks;
    const repositories = state.repositories.filter((repository) => !repositoryId || repository.id === repositoryId);
    // A linked worktree can itself be imported as another repository row.
    // Keep its managed Task's original owner ahead of that navigation alias.
    const taskOwner = repositories.find((repository) => tasks.some((task) =>
      workspaceKey(task.repositoryRoot) === workspaceKey(repository.path) &&
      task.workspaceRoot && workspaceKey(task.workspaceRoot) === key));
    if (taskOwner) return taskOwner;
    return repositories.find((repository) => {
      const ownerKey = workspaceKey(repository.path);
      if (key === ownerKey) return true;
      // Every inspected linked worktree contains its repository's inventory.
      // The primary root need not have been visited or cached separately.
      return [...snapshotCacheRef.current.values()].some((known) =>
        known.worktrees.some((tree) => workspaceKey(tree.path) === ownerKey && !tree.missing) &&
        known.worktrees.some((tree) => workspaceKey(tree.path) === key && !tree.missing));
    }) ?? null;
  }

  function openHubWorkspace(root: string, repositoryRoot: string, identity?: Pick<TaskNotice, "threadId" | "turnId">) {
    const owner = useWorkbenchStore.getState().repositories.find((repository) =>
      workspaceKey(repository.path) === workspaceKey(repositoryRoot));
    if (!owner) return;
    const state = useTaskStore.getState();
    const registeredRoots = new Set(useWorkbenchStore.getState().repositories.map((repository) => workspaceKey(repository.path)));
    const task = state.tasks.filter((candidate) =>
      candidate.workspaceRoot && workspaceKey(candidate.workspaceRoot) === workspaceKey(root) &&
      registeredRoots.has(workspaceKey(candidate.repositoryRoot)) &&
      state.roots.some((path) => workspaceKey(path) === workspaceKey(candidate.repositoryRoot)) &&
      ((!identity?.threadId && !identity?.turnId) || candidate.attempts.some((attempt) =>
        attempt.execution && (!identity.threadId || attempt.execution.threadId === identity.threadId) &&
        (!identity.turnId || attempt.execution.turnId === identity.turnId))))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    if (task) {
      useAgentsHubStore.getState().showTasks();
      selectTask(task.id, "执行");
    } else {
      useAgentsHubStore.getState().showSession({ repositoryRoot: owner.path, workspaceRoot: root });
    }
    setAppView("home");
  }

  const navigateToAgentNotice = async (notice: TaskNotice) => {
    const request = ++navigationEpoch.current;
    const known = knownWorkspaceOwner(notice.workspaceRoot, notice.repositoryId);
    if (known) {
      openHubWorkspace(notice.workspaceRoot, known.path, notice);
      return;
    }
    if (!isDesktopRuntime()) return;
    const state = useWorkbenchStore.getState();
    const key = workspaceKey(notice.workspaceRoot);
    const candidates = state.repositories.filter((repository) => !notice.repositoryId || repository.id === notice.repositoryId)
      .sort((a, b) => Number(workspaceKey(state.workspaceStates[b.id]?.activeWorktreePath ?? "") === key)
        - Number(workspaceKey(state.workspaceStates[a.id]?.activeWorktreePath ?? "") === key));
    // Persisted selections are ownership hints, never authorization for an
    // arbitrary directory. Unknown targets require current registered inventory.
    const inventories = await Promise.allSettled(candidates.map((repository) => inspectRepository(repository.path)));
    if (navigationEpoch.current !== request) return;
    for (let index = 0; index < inventories.length; index += 1) {
      const result = inventories[index];
      if (result.status !== "fulfilled") continue;
      const candidate = candidates[index];
      const owner = useWorkbenchStore.getState().repositories.find((repository) =>
        repository.id === candidate.id && workspaceKey(repository.path) === workspaceKey(candidate.path));
      if (!owner) continue;
      const known = result.value;
      if (!known.worktrees.some((tree) => workspaceKey(tree.path) === workspaceKey(owner.path) && !tree.missing)) continue;
      snapshotCacheRef.current.set(workspaceKey(known.root), known);
      if (known.worktrees.some((tree) => workspaceKey(tree.path) === key && !tree.missing)) {
        openHubWorkspace(notice.workspaceRoot, owner.path, notice);
        return;
      }
    }
  };

  const navigateToNotice = (notice: TaskNotice) => {
    if (notice.source === "agent") {
      void navigateToAgentNotice(notice);
      return;
    }
    const pathKey = workspaceKey(notice.workspaceRoot);
    const state = useWorkbenchStore.getState();
    const repository = (notice.repositoryId
      ? state.repositories.find((item) => item.id === notice.repositoryId)
      : null) ?? [...state.repositories]
      .filter((item) =>
        pathKey === workspaceKey(item.path) ||
        pathKey.startsWith(workspaceKey(item.path) + "/") ||
        (state.workspaceStates[item.id] &&
          workspaceKey(state.workspaceStates[item.id].activeWorktreePath) === pathKey) ||
        snapshotCacheRef.current.get(workspaceKey(item.path))?.worktrees.some(
          (tree) => workspaceKey(tree.path) === pathKey))
      .sort((a, b) => workspaceKey(b.path).length - workspaceKey(a.path).length)[0];
    if (!repository) return; // Workspace was removed; never reopen an unrelated path.
    setAppView("repositories");
    const destination: WorkspaceTab = "terminal";
    saveWorkspaceState({
      repositoryId: repository.id,
      activeWorktreePath: notice.workspaceRoot,
      activeTab: destination,
      updatedAt: Date.now(),
    });
    if (notice.terminalId) useTaskNotifications.getState().focusTerminal(notice.workspaceRoot, notice.terminalId);
    if (repository.id !== useWorkbenchStore.getState().activeRepositoryId) {
      selectRepository(repository.id); // Existing restore path loads the target worktree.
    } else {
      setTab(destination);
      void loadSnapshot(notice.workspaceRoot).catch(() => undefined);
    }
  };

  const openTaskWorkspace = (root: string, destination: WorkspaceTab, repositoryRoot?: string) => {
    if (!root.trim()) return;
    const state = useWorkbenchStore.getState();
    // An explicit task owner must still be registered. Do not silently attach
    // a removed repository's task to a separately registered worktree alias.
    const owner = repositoryRoot
      ? state.repositories.find((item) => workspaceKey(item.path) === workspaceKey(repositoryRoot))
      : state.repositories.find((item) => workspaceKey(item.path) === workspaceKey(root)
        || snapshotCacheRef.current.get(workspaceKey(item.path))?.worktrees.some((tree) => !tree.missing && workspaceKey(tree.path) === workspaceKey(root)));
    if (!owner) return;
    saveWorkspaceState({repositoryId:owner.id,activeWorktreePath:root,activeTab:destination,updatedAt:Date.now()});
    setAppView("repositories");
    if (state.activeRepositoryId !== owner.id) selectRepository(owner.id);
    else setTab(destination);
    const request = navigationEpoch.current;
    void loadSnapshot(root, false, owner.id).then(next => {
      if (destination !== "terminal" || !isDesktopRuntime() || navigationEpoch.current !== request) return;
      const isCurrent = () => {
        const current = useWorkbenchStore.getState();
        const selected = current.workspaceStates[owner.id];
        return navigationEpoch.current === request && current.activeRepositoryId === owner.id &&
          current.repositories.some(item => item.id === owner.id && workspaceKey(item.path) === workspaceKey(owner.path)) &&
          selected?.activeTab === "terminal" && workspaceKey(selected.activeWorktreePath) === workspaceKey(root);
      };
      // Recovery may have returned the primary worktree after removal. Opening
      // the task terminal must never create a shell in that fallback directory.
      if (!isCurrent() || workspaceKey(next.root) !== workspaceKey(root) ||
          !next.worktrees.some(tree => !tree.missing && workspaceKey(tree.path) === workspaceKey(root)) ||
          !next.worktrees.some(tree => !tree.missing && workspaceKey(tree.path) === workspaceKey(owner.path))) return;
      setTerminalOpenRequest({ sequence: ++terminalOpenSequence.current, repositoryId: owner.id, workspaceRoot: root, isCurrent });
    }).catch(() => undefined);
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
          <NotificationCenter onNavigate={navigateToNotice} />
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
          {ownershipErrorPath && error.includes("detected dubious ownership") && (
            <button type="button" className="shrink-0 underline" disabled={loading || gitBusy}
              onClick={() => void retryRepositoryOwnership()}>Trust repository…</button>
          )}
          <button className="ml-auto text-[10px] text-rose-300/60 hover:text-rose-200" onClick={() => setError(null)} type="button">
            dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="vl-app-navigation flex min-h-0 shrink-0 flex-col border-r" data-view={appView}>
          <nav aria-label="工程导航" className="flex shrink-0 flex-col gap-1 border-b p-2">
            {([ ["home", "Agents Hub"], ["repositories", "工程仓库"], ["settings", "设置"] ] as const).map(([view,label]) => (
              <button key={view} type="button" aria-current={appView === view ? "page" : undefined}
                className="vl-app-route rounded-md px-3 py-2 text-left text-sm" onClick={() => setAppView(view)}>{label}</button>
            ))}
          </nav>
          <div hidden={appView !== "repositories"} className="min-h-0 flex-1 overflow-hidden">
        <ProjectSidebar
          repositories={repositories}
          activeRepositoryId={activeRepositoryId}
          snapshot={visibleSnapshot}
          isPreview={isPreview}
          onAdd={addLocalRepository}
          filterQuery={searchQuery}
          repositoryActionsEnabled={native && !gitBusy}
          onSelect={selectRepository}
          onRemove={(id) => { void detachLocalRepository(id); }}
          onOpenRepositoryFolder={(path) => void openFolder(path, path)}
          editor={preferredEditor}
          onOpenRepositoryEditor={(path) => void openEditor(path, path)}
          onOpenWorkspaceEditor={(path) => {
            if (activeRepository && workspaceReady) void openEditor(path, activeRepository.path);
          }}
          onOpenWorkspaceFolder={(path) => {
            if (activeRepository && workspaceReady) void openFolder(path, activeRepository.path);
          }}
          onNewWorkspace={() => { setReviewIntent(null); setWorkspaceDialog(true); }}
          onSelectWorkspace={(path) => {
            if (!activeRepository || !workspaceReady || gitMutationInFlightRef.current || loading) return;
            navigationEpoch.current += 1;
            const repositoryId = activeRepository.id;
            setError(null);
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
          onCleanupMerged={() => { void cleanMerged(); }}
          cleanupProgress={cleanupProgress}
        />
          </div>
        </aside>

        <section className="vl-stage flex min-h-0 min-w-0 flex-1 flex-col">
          <div hidden={appView !== "repositories"} className="vl-workspace-host min-h-0 min-w-0 flex-1 flex-col">
          {cleanupReport?.repositoryId === activeRepository?.id && cleanupReport && (
            <div role="status" className="shrink-0 border-b border-white/10 bg-slate-900 px-4 py-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span>Cleanup: {cleanupReport.removed.length} removed; {cleanupReport.failed.length} failed or skipped.</span>
                <button type="button" onClick={() => setCleanupReport(null)} aria-label="Dismiss cleanup result">Close</button>
              </div>
              <ul className="mt-2 max-h-36 overflow-y-auto break-all text-slate-400">
                {cleanupReport.removed.map(item => <li key={`ok:${item}`}>Removed: {item}</li>)}
                {cleanupReport.failed.map(item => <li key={`failed:${item}`} className="text-amber-300">Kept/failed: {item}</li>)}
              </ul>
            </div>
          )}
          <WorkspaceHeader
            snapshot={visibleSnapshot}
            isPreview={isPreview}
            loading={loading}
            gitBusy={gitBusy}
            editor={preferredEditor}
            onEditorChange={chooseEditor}
            onOpenEditor={() => {
              if (activeRepository && workspaceReady) void openEditor(snapshot.root, activeRepository.path);
            }}
            onFetch={() => {
              if (activeRepository) void runGitMutation(() => gitFetchOrigin(activeRepository.path));
            }}
            onPull={() => {
              if (activeRepository) void runGitMutation(() => gitPullCurrent(activeRepository.path, snapshot.root));
            }}
            onOpenFolder={() => {
              if (activeRepository && workspaceReady) void openFolder(snapshot.root, activeRepository.path);
            }}
          />

          <div className="flex shrink-0 justify-end border-b px-4 py-2 sm:px-6">
            <button type="button" disabled={!workspaceReady || loading}
              className="rounded-md px-3 py-1.5 text-xs text-orange-200 hover:bg-orange-400/10 disabled:opacity-40"
              onClick={() => { if (activeRepository && workspaceReady) openHubWorkspace(snapshot.root, activeRepository.path); }}>
              在 Agents Hub 中管理
            </button>
          </div>

          <WorkspaceContent
            snapshot={visibleSnapshot}
            visible={appView === "repositories"}
            profileRepositoryRoot={activeRepository?.path ?? visibleSnapshot.root}
            terminalRepositoryId={workspaceReady ? activeRepository?.id ?? null : null}
            registeredRepositoryIds={repositories.map((item) => item.id)}
            retiredTerminal={retiredTerminal}
            terminalOpenRequest={terminalOpenRequest}
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
          </div>
          <div hidden={appView === "repositories"} className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <AgentsHub view={lastTaskView.current} repositories={repositories} activeRepository={activeRepository}
              visible={appView !== "repositories"} searchQuery={searchQuery} onSearchQueryChange={setSearchQuery} onOpenWorkspace={openTaskWorkspace} onOpenHub={() => setAppView("home")}/>
          </div>

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
