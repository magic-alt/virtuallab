import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ProjectSidebar } from "@/features/sidebar/ProjectSidebar";
import { WorkspaceContent } from "@/features/workspace/WorkspaceContent";
import { WorkspaceHeader } from "@/features/workspace/WorkspaceHeader";
import {
  chooseRepositoryDirectory,
  inspectRepository,
  isDesktopRuntime,
} from "@/lib/backend";
import { useWorkbenchStore } from "@/stores/workbench";
import type { RepositorySnapshot, WorkspaceTab } from "@/types/workbench";

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

  const [snapshot, setSnapshot] =
    useState<RepositorySnapshot>(PREVIEW_SNAPSHOT);
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await inspectRepository(path);
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
      setSnapshot(PREVIEW_SNAPSHOT);
      setError(null);
      return;
    }

    void loadSnapshot(activeRepository.path).catch(() => undefined);
  }, [activeRepository, loadSnapshot]);

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
      // The error surface below keeps the desktop action non-blocking.
    }
  };

  const isPreview = !activeRepository;
  const native = isDesktopRuntime();

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[#070b12] text-slate-100">
      <div
        className="flex h-12 shrink-0 items-center border-b border-white/[0.07] bg-[#080d15]/95 px-4"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-lg border border-blue-400/20 bg-blue-400/10 text-blue-300">
            <Layers3 size={15} />
          </div>
          <div>
            <div className="text-[12px] font-semibold leading-none tracking-[-0.01em] text-slate-100">
              VirtualLab
            </div>
            <div className="mt-1 text-[9px] uppercase tracking-[0.16em] text-slate-650">
              Engineering Workbench
            </div>
          </div>
        </div>

        <div className="mx-auto flex h-8 w-[380px] items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 text-xs text-slate-650">
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
          <Badge tone="neutral">
            <ShieldCheck size={11} />
            Read-only Git
          </Badge>
        </div>
      </div>

      {error && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-rose-400/15 bg-rose-400/[0.06] px-4 text-xs text-rose-200">
          <TriangleAlert size={14} />
          <span className="truncate">{error}</span>
          <span className="ml-auto text-[10px] text-rose-300/60">
            Verify this is a Git repository and that git is on PATH.
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ProjectSidebar
          repositories={repositories}
          activeRepositoryId={activeRepositoryId}
          snapshot={snapshot}
          isPreview={isPreview}
          onAdd={addLocalRepository}
          onSelect={setActiveRepository}
          onRemove={removeRepository}
        />

        <section className="flex min-w-0 flex-1 flex-col bg-[#080d15]">
          <WorkspaceHeader
            snapshot={snapshot}
            isPreview={isPreview}
            loading={loading}
            onRefresh={() => {
              if (activeRepository) {
                void loadSnapshot(activeRepository.path).catch(() => undefined);
              }
            }}
          />

          <WorkspaceContent
            snapshot={snapshot}
            tab={tab}
            isPreview={isPreview}
            onTabChange={setTab}
          />

          <footer className="flex h-7 shrink-0 items-center justify-between border-t border-white/[0.06] bg-[#080d15] px-3 text-[10px] text-slate-650">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <Command size={11} />
                local-first
              </span>
              <span>workspace owns execution context</span>
            </div>
            <span className="mono">v0.1 foundation</span>
          </footer>
        </section>
      </div>
    </div>
  );
}
