import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Command,
  Cpu,
  Layers3,
  Search,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { NewWorkspaceDialog } from "@/features/workspace/NewWorkspaceDialog";
import { ProjectSidebar } from "@/features/sidebar/ProjectSidebar";
import { WorkspaceContent } from "@/features/workspace/WorkspaceContent";
import { WorkspaceHeader } from "@/features/workspace/WorkspaceHeader";
import {
  chooseRepositoryDirectory,
  createWorktree,
  inspectRepository,
  isDesktopRuntime,
  removeWorktree,
  watchStart,
  watchStop,
} from "@/lib/backend";
import { useWorkbenchStore } from "@/stores/workbench";
import type {
  RepositorySnapshot,
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
  } = useWorkbenchStore();

  const activeRepository = useMemo(
    () => repositories.find((item) => item.id === activeRepositoryId) ?? null,
    [activeRepositoryId, repositories],
  );

  const [snapshot, setSnapshot] = useState<RepositorySnapshot>(PREVIEW_SNAPSHOT);
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const activePathRef = useRef<string | null>(null);
  const refreshTimer = useRef<number | undefined>(undefined);

  const loadSnapshot = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await inspectRepository(path);
      activePathRef.current = next.root;
      setSnapshot(next);
      return next;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeRepository) {
      activePathRef.current = null;
      setSnapshot(PREVIEW_SNAPSHOT);
      setError(null);
      return;
    }
    void loadSnapshot(activeRepository.path).catch(() => undefined);
  }, [activeRepository, loadSnapshot]);

  useEffect(() => {
    if (!isDesktopRuntime() || !activeRepository || !snapshot.root) return;

    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    void watchStart(WATCH_ID, snapshot.root).catch((err) => {
      if (!disposed) setError(err instanceof Error ? err.message : String(err));
    });

    void listen<WorkbenchEvent>("workbench://event", ({ payload }) => {
      if (payload.eventType !== "fs.changed" || payload.id !== WATCH_ID) return;
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        const path = activePathRef.current;
        if (path) void loadSnapshot(path).catch(() => undefined);
      }, 550);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer.current);
      unlisten?.();
      void watchStop(WATCH_ID).catch(() => undefined);
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
      setSnapshot(next);
      setTab("overview");
    } catch {
      // The visible error surface keeps the desktop action non-blocking.
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
    await loadSnapshot(created.path);
    setTab("overview");
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
      await loadSnapshot(activeRepository.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const isPreview = !activeRepository;
  const native = isDesktopRuntime();

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[#0b0805] text-slate-100">
      <div
        className="flex h-12 shrink-0 items-center border-b border-orange-400/[0.08] bg-[#0d0906]/95 px-4"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2.5">
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

        <div className="mx-auto flex h-8 w-[380px] items-center gap-2 rounded-lg border border-orange-400/[0.08] bg-white/[0.025] px-3 text-xs text-stone-600">
          <Search size={13} />
          <span className="flex-1">Search workspaces and commands</span>
          <span className="mono rounded border border-white/[0.08] bg-black/20 px-1.5 py-0.5 text-[9px]">
            ⌘ K
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Badge tone={native ? "green" : "amber"}>
            <Cpu size={11} />
            {native ? "Native" : "Web preview"}
          </Badge>
          <Badge tone="orange">
            <ShieldCheck size={11} />
            Workspace execution
          </Badge>
        </div>
      </div>

      {error && (
        <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-rose-400/15 bg-rose-400/[0.06] px-4 py-2 text-xs text-rose-200">
          <TriangleAlert size={14} />
          <span className="truncate">{error}</span>
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
          onSelect={(id) => {
            setActiveRepository(id);
            setTab("overview");
          }}
          onRemove={removeRepository}
          onNewWorkspace={() => setWorkspaceDialog(true)}
          onSelectWorkspace={(path) => void loadSnapshot(path).catch(() => undefined)}
          onRemoveWorkspace={(path) => void deleteWorkspace(path)}
          workspaceActionsEnabled={native && Boolean(activeRepository)}
        />

        <section className="flex min-w-0 flex-1 flex-col bg-[#0b0805]">
          <WorkspaceHeader
            snapshot={snapshot}
            isPreview={isPreview}
            loading={loading}
            onRefresh={() => {
              const path = activePathRef.current;
              if (path) void loadSnapshot(path).catch(() => undefined);
            }}
          />

          <WorkspaceContent
            snapshot={snapshot}
            tab={tab}
            isPreview={isPreview}
            onTabChange={setTab}
          />

          <footer className="flex h-7 shrink-0 items-center justify-between border-t border-orange-400/[0.06] bg-[#0d0906] px-3 text-[10px] text-stone-600">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <Command size={11} />
                local-first
              </span>
              <span>workspace owns execution context</span>
            </div>
            <span className="mono text-orange-300/70">v0.2 workspace execution</span>
          </footer>
        </section>
      </div>

      {workspaceDialog && activeRepository && (
        <NewWorkspaceDialog
          defaultBaseRef={snapshot.currentBranch || "HEAD"}
          onClose={() => setWorkspaceDialog(false)}
          onCreate={createWorkspace}
        />
      )}
    </div>
  );
}
