import {
  Boxes,
  FolderGit2,
  GitBranch,
  Plus,
  GitBranchPlus,
  Trash2,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn, compactPath } from "@/lib/utils";
import type { RepositoryRecord, RepositorySnapshot } from "@/types/workbench";

interface Props {
  repositories: RepositoryRecord[];
  activeRepositoryId: string | null;
  snapshot: RepositorySnapshot;
  isPreview: boolean;
  onAdd: () => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onNewWorkspace: () => void;
  onSelectWorkspace: (path: string) => void;
  onRemoveWorkspace: (path: string) => void;
  workspaceActionsEnabled: boolean;
  repositoryActionsEnabled: boolean;
  filterQuery: string;
}

export function ProjectSidebar({
  repositories,
  activeRepositoryId,
  snapshot,
  isPreview,
  onAdd,
  onSelect,
  onRemove,
  onNewWorkspace,
  onSelectWorkspace,
  onRemoveWorkspace,
  workspaceActionsEnabled,
  repositoryActionsEnabled,
  filterQuery,
}: Props) {
  const query = filterQuery.trim().toLowerCase();
  const visibleRepositories = query
    ? repositories.filter((repository) =>
        `${repository.name} ${repository.path}`.toLowerCase().includes(query),
      )
    : repositories;
  const visibleWorktrees = (query
    ? snapshot.worktrees.filter((worktree) =>
        `${worktree.branch ?? ""} ${worktree.path}`.toLowerCase().includes(query),
      )
    : snapshot.worktrees
  ).slice(0, 6);

  return (
    <aside className="vl-sidebar flex min-h-0 w-[286px] shrink-0 flex-col border-r">
      <div className="border-b border-white/[0.07] px-4 pb-4 pt-4">
        <Button className="w-full" disabled={!repositoryActionsEnabled} onClick={onAdd} title={repositoryActionsEnabled ? "Add local Git repository" : "Desktop runtime required"}>
          <Plus size={15} />
          Add repository
        </Button>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <SectionLabel icon={<FolderGit2 size={13} />} label="Local repositories" />

        {repositories.length === 0 ? (
          <div className="mt-2 w-full rounded-xl border border-orange-300/30 bg-orange-950/20 p-3 text-left">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
              <div className="flex size-7 items-center justify-center rounded-lg bg-orange-500/15 text-orange-300">
                <Boxes size={14} />
              </div>
              Workbench preview
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Add a local Git repository to replace preview data with live repository state.
            </p>
          </div>
        ) : (
          <div className="mt-2 space-y-1">
            {visibleRepositories.map((repository) => {
              const active = repository.id === activeRepositoryId;
              return (
                <div
                  key={repository.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-xl border px-2 py-2 transition",
                    active
                      ? "border-orange-400/20 bg-orange-400/[0.08]"
                      : "border-transparent hover:bg-white/[0.035]",
                  )}
                >
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelect(repository.id)}
                    type="button"
                  >
                    <div className="truncate text-[13px] font-medium text-slate-200">
                      {repository.name}
                    </div>
                    <div
                      className="mt-1 truncate text-[10px] text-slate-600"
                      title={repository.path}
                    >
                      {compactPath(repository.path, 34)}
                    </div>
                  </button>
                  <button
                    aria-label={`Remove ${repository.name}`}
                    className="rounded-md p-1.5 text-slate-700 opacity-0 transition hover:bg-white/[0.06] hover:text-rose-300 group-hover:opacity-100"
                    onClick={() => onRemove(repository.id)}
                    type="button"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-7">
          <div className="flex items-center justify-between">
            <SectionLabel icon={<Workflow size={13} />} label="Workspace lanes" />
            <button
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-orange-300 transition hover:bg-orange-400/10 disabled:opacity-30"
              disabled={!workspaceActionsEnabled}
              onClick={onNewWorkspace}
              type="button"
            >
              <GitBranchPlus size={11} />
              New
            </button>
          </div>
          <div className="mt-2 space-y-1.5">
            {visibleWorktrees.map((worktree, index) => (
              <div
                key={`${worktree.path}-${index}`}
                className="group flex items-center gap-1 rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2"
              >
                <button className="min-w-0 flex-1 text-left" onClick={() => onSelectWorkspace(worktree.path)} type="button">
                  <div className="flex items-center gap-2 text-xs text-slate-300">
                    <GitBranch size={12} className="text-slate-600" />
                    <span className="truncate">
                      {worktree.branch ?? (worktree.detached ? "detached" : "workspace")}
                    </span>
                  </div>
                  <div className="mt-1 truncate pl-5 text-[10px] text-slate-600">
                    {compactPath(worktree.path, 30)}
                  </div>
                </button>
                {index > 0 && (
                  <button
                    aria-label="Remove workspace"
                    className="rounded-md p-1 text-slate-700 opacity-0 transition hover:bg-rose-400/10 hover:text-rose-300 group-hover:opacity-100"
                    onClick={() => onRemoveWorkspace(worktree.path)}
                    type="button"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-white/[0.07] px-4 py-3">
        <div className="flex items-center justify-between text-[11px] text-slate-600">
          <span>Local control plane</span>
          <span className={cn("size-1.5 rounded-full", isPreview ? "bg-amber-400" : "bg-emerald-400")} />
        </div>
      </div>
    </aside>
  );
}

function SectionLabel({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600">
      {icon}
      {label}
    </div>
  );
}
