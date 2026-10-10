import {
  Cloud,
  CloudOff,
  GitBranch,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { compactPath } from "@/lib/utils";
import type { RepositorySnapshot } from "@/types/workbench";

interface Props {
  snapshot: RepositorySnapshot;
  isPreview: boolean;
  loading: boolean;
  gitBusy: boolean;
  onRefresh: () => void;
  onFetch: () => void;
  onPull: () => void;
}

export function WorkspaceHeader({
  snapshot,
  isPreview,
  loading,
  gitBusy,
  onRefresh,
  onFetch,
  onPull,
}: Props) {
  const clean = snapshot.dirtyCount === 0;

  return (
    <header className="vl-header min-w-0 shrink-0 border-b px-4 py-3 sm:px-6 sm:py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-[20px] font-semibold tracking-[-0.02em] text-slate-100">
              {snapshot.name}
            </h1>
            {isPreview && (
              <Badge tone="amber">
                <Sparkles size={11} />
                Preview
              </Badge>
            )}
            <Badge tone={clean ? "green" : "amber"}>
              {clean ? "Working tree clean" : `${snapshot.dirtyCount} local changes`}
            </Badge>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <GitBranch size={13} />
              <span className="mono text-slate-400">{snapshot.currentBranch}</span>
            </span>

            <span className="flex min-w-0 items-center gap-1.5">
              {snapshot.remoteUrl ? <Cloud size={13} /> : <CloudOff size={13} />}
              <span className="truncate" title={snapshot.remoteUrl ?? snapshot.root}>
                {snapshot.remoteUrl ?? compactPath(snapshot.root, 70)}
              </span>
            </span>

            <span className="mono text-[11px] text-slate-600">{snapshot.headSha}</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            disabled={isPreview || loading || gitBusy || !snapshot.remoteUrl}
            onClick={onFetch}
            variant="outline"
            size="sm"
            title="Fetch origin and prune deleted remote-tracking branches"
          >
            <Cloud size={13} />
            Fetch + prune
          </Button>
          <Button
            disabled={
              isPreview || loading || gitBusy || !snapshot.remoteUrl ||
              snapshot.dirtyCount > 0 || snapshot.currentBranch.startsWith("detached@")
            }
            onClick={onPull}
            variant="outline"
            size="sm"
            title={snapshot.dirtyCount > 0
              ? "Local changes prevent Pull. Open Changes to Save to stash or separately discard tracked / delete untracked entries."
              : "Fast-forward the current branch from origin (no merge or reset)"}
          >
            <GitBranch size={13} />
            Pull
          </Button>
          <Button
            disabled={isPreview || loading || gitBusy}
            onClick={onRefresh}
            variant="outline"
            size="sm"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>
      </div>
    </header>
  );
}
