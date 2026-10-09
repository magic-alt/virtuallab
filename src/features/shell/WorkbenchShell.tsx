import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import appManifest from "../../../package.json";
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
  isDesktopRuntime,
  removeWorktree,
  watchStart,
  watchStop,
} from "@/lib/backend";
import { useWorkbenchStore } from "@/stores/workbench";
import { useAgentTimeline } from "@/stores/agentTimeline";
import type { AgentEvent } from "@/types/agent";
import { selectedReviewBase, suggestedReviewBranch } from "@/lib/reviewLoop";
import type {
  RepositorySnapshot,
  ReviewWorkspaceRequest,
  WorkbenchEvent,
  WorkspaceTab,
} from "@/types/workbench";

const WATCH_ID = "active-workspace";

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
  const snapshotLoadsRef = useRef(new Map<string, Promise<RepositorySnapshot>>());
  const snapshotCacheRef = useRef(new Map<string, RepositorySnapshot>());
  const latestSnapshotRequestRef = useRef<string | null>(null);

  const loadSnapshot = useCallback((path: string, requireFresh = false): Promise<RepositorySnapshot> => {
    const key = normalizePath(path);
    latestSnapshotRequestRef.current = key;

    const existing = snapshotLoadsRef.current.get(key);
    if (existing) {
      if (requireFresh) {
        // A filesystem watch refresh may have started before git switch ended.
        // Wait for it, then *reinspect* the new HEAD instead of displaying
        // the snapshot that captured the previous branch.
        return existing.catch(() => undefined).then(() => loadSnapshot(path, true));
      }
      // An older request may have lost ownership of the UI when the user
      // switched worktrees. Re-selecting its path must commit its snapshot.
      return existing.then((next) => {
        if (latestSnapshotRequestRef.current === key) {
          activePathRef.current = next.root;
          setSnapshot(next);
          setSnapshotRevision((revision) => revision + 1);
        }
        return next;
      });
    }

    const cached = snapshotCacheRef.current.get(key);
    if (
      cached &&
      normalizePath(activePathRef.current ?? "") !== key
    ) {
      // Switching back to a known repository/worktree should be visually
      // immediate; a native refresh still runs in the background.
      activePathRef.current = cached.root;
      setSnapshot(cached);
    }

    setLoading(true);
    // A filesystem watcher refresh must not erase a meaningful Git error
    // (e.g. an untracked file collision) before the user can read it.

    const request = inspectRepository(path)
      .then((next) => {
        snapshotCacheRef.current.set(key, next);
        if (latestSnapshotRequestRef.current === key) {
          activePathRef.current = next.root;
          setSnapshot(next);
          setSnapshotRevision((revision) => revision + 1);
        }
        return next;
      })
      .catch((err) => {
        if (latestSnapshotRequestRef.current === key) {
          const message =
            err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
          setError(message);
        }
        throw err;
      })
      .finally(() => {
        snapshotLoadsRef.current.delete(key);
        if (snapshotLoadsRef.current.size === 0) {
          setLoading(false);
        }
      });

    snapshotLoadsRef.current.set(key, request);
    return request;
  }, []);

  useEffect(() => {
    if (!activeRepository) {
      latestSnapshotRequestRef.current = null;
      activePathRef.current = null;
      setSnapshot(PREVIEW_SNAPSHOT);
      setError(null);
      return;
    }
    const saved = useWorkbenchStore.getState().workspaceStates[activeRepository.id];
    const preferredPath = saved?.activeWorktreePath || activeRepository.path;
    const preferredTab = saved?.activeTab ?? "overview";

    setTab(preferredTab);
    void loadSnapshot(preferredPath)
      .then((next) => {
        saveWorkspaceState({
          repositoryId: activeRepository.id,
          activeWorktreePath: next.root,
          activeTab: preferredTab,
          updatedAt: Date.now(),
        });
      })
      .catch(() => {
        if (preferredPath === activeRepository.path) return;
        void loadSnapshot(activeRepository.path)
          .then((next) => {
            saveWorkspaceState({
              repositoryId: activeRepository.id,
              activeWorktreePath: next.root,
              activeTab: "overview",
              updatedAt: Date.now(),
            });
            setTab("overview");
          })
          .catch(() => undefined);
      });
  }, [activeRepository, loadSnapshot, saveWorkspaceState]);

  useEffect(() => {
    if (
      !isDesktopRuntime() ||
      !activeRepository ||
      !snapshot.root ||
      !activePathRef.current ||
      normalizePath(activePathRef.current) !== normalizePath(snapshot.root)
    ) {
      return;
    }

    const watchId = `${WATCH_ID}:${snapshot.root}`;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    void watchStart(watchId, snapshot.root).catch((err) => {
      if (!disposed) setError(err instanceof Error ? err.message : String(err));
    });

    void Promise.resolve(listen<WorkbenchEvent>("workbench://event", ({ payload }) => {
      if (payload.eventType !== "fs.changed" || payload.id !== watchId) return;
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        const path = activePathRef.current;
        if (path) void loadSnapshot(path).catch(() => undefined);
      }, 550);
    })).then((fn) => {
      if (typeof fn !== "function") return;
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer.current);
      unlisten?.();
      void watchStop(watchId).catch(() => undefined);
    };
  }, [activeRepository, loadSnapshot, snapshot.root]);

  const addLocalRepository = async () => {
    try {
      const path = await chooseRepositoryDirectory();
      if (!path) return;

      const next = await loadSnapshot(path);
      const id =
        globalThis.crypto?.randomUUID?.() ??
        `repo-${Date.now()}-${Math.random().toString(16).slice(2)}`;

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
    const next = await loadSnapshot(created.path);
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
    await loadSnapshot(workspaceRoot);
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
    if (!activeRepository) return;
    const confirmed = window.confirm(
      `Remove this clean Git worktree?\n\n${path}\n\nDirty worktrees are refused by Git and are never force-removed.`,
    );
    if (!confirmed) return;

    try {
      if (snapshot.root === path) {
        await loadSnapshot(activeRepository.path);
      }
      await removeWorktree(activeRepository.path, path);
      const next = await loadSnapshot(activeRepository.path);
      saveWorkspaceState({
        repositoryId: activeRepository.id,
        activeWorktreePath: next.root,
        activeTab: "overview",
        updatedAt: Date.now(),
      });
      setTab("overview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runGitMutation = async (action: () => Promise<void | boolean>) => {
    if (!activeRepository || gitMutationInFlightRef.current || loading) return;
    gitMutationInFlightRef.current = true;
    setGitBusy(true);
    setError(null);
    try {
      // A cancelled confirmation returns false: do not execute further
      // mutations or refresh the repository as though deletion succeeded.
      if (await action() !== false) {
        await loadSnapshot(activePathRef.current ?? activeRepository.path, true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      gitMutationInFlightRef.current = false;
      setGitBusy(false);
    }
  };

  const selectBranch = async (name: string) => {
    if (!activeRepository || gitBusy || loading) return;
    const occupied = snapshot.branches.find((branch) => branch.name === name)?.worktreePath;
    if (occupied && normalizePath(occupied) !== normalizePath(snapshot.root)) {
      // Git will not check out the same branch into two worktrees. Navigate
      // to the existing owner instead of forcing the checkout.
      try {
        setError(null);
        const next = await loadSnapshot(occupied, true);
        saveWorkspaceState({
          repositoryId: activeRepository.id,
          activeWorktreePath: next.root,
          activeTab: tab,
          updatedAt: Date.now(),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    await runGitMutation(() => gitSwitchBranch(activeRepository.path, snapshot.root, name));
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

  const isPreview = !activeRepository;
  const native = isDesktopRuntime();

  const switchTab = (nextTab: WorkspaceTab) => {
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
          snapshot={snapshot}
          isPreview={isPreview}
          onAdd={addLocalRepository}
          filterQuery={searchQuery}
          repositoryActionsEnabled={native}
          onSelect={(id) => {
            setActiveRepository(id);
          }}
          onRemove={removeRepository}
          onNewWorkspace={() => { setReviewIntent(null); setWorkspaceDialog(true); }}
          onSelectWorkspace={(path) => {
            if (!activeRepository) return;
            void loadSnapshot(path)
              .then((next) => {
                saveWorkspaceState({
                  repositoryId: activeRepository.id,
                  activeWorktreePath: next.root,
                  activeTab: tab,
                  updatedAt: Date.now(),
                });
              })
              .catch(() => undefined);
          }}
          onRemoveWorkspace={(path) => void deleteWorkspace(path)}
          workspaceActionsEnabled={native && Boolean(activeRepository)}
          branchActionsEnabled={native && Boolean(activeRepository) && !loading && !gitBusy}
          onSwitchBranch={(branch) => { void selectBranch(branch); }}
          onDeleteBranch={(branch) => { void deleteLocalBranch(branch); }}
          onDeleteOriginBranch={(branch) => { void deleteOriginBranch(branch); }}
        />

        <section className="vl-stage flex min-w-0 flex-1 flex-col">
          <WorkspaceHeader
            snapshot={snapshot}
            isPreview={isPreview}
            loading={loading}
            gitBusy={gitBusy}
            onFetch={() => {
              if (activeRepository) void runGitMutation(() => gitFetchOrigin(activeRepository.path));
            }}
            onPull={() => {
              if (activeRepository) void runGitMutation(() => gitPullCurrent(activeRepository.path, snapshot.root));
            }}
            onRefresh={() => {
              setError(null);
              const path = activePathRef.current;
              if (path) void loadSnapshot(path).catch(() => undefined);
            }}
          />

          <WorkspaceContent
            snapshot={snapshot}
            profileRepositoryRoot={activeRepository?.path ?? snapshot.root}
            tab={tab}
            isPreview={isPreview}
            snapshotRevision={snapshotRevision}
            onRefreshForRereview={refreshForRereview}
            onNewReviewWorkspace={(intent) => {
              if (!activeRepository || !native) return;
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
            <span className="mono shrink-0 text-orange-300/70">VirtualLab v{appManifest.version}</span>
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

      {workspaceDialog && activeRepository && (
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
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}
