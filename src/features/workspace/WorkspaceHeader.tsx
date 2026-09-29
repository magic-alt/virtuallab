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
  onRefresh: () => void;
}

export function WorkspaceHeader({
  snapshot,
  isPreview,
  loading,
  onRefresh,
}: Props) {
  const clean = snapshot.dirtyCount === 0;

  return (
    <header className="border-b border-white/[0.07] bg-[#120d09]/82 px-6 py-4 backdrop-blur-xl">
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
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

        <Button
          disabled={isPreview || loading}
          onClick={onRefresh}
          variant="outline"
          size="sm"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
          Refresh
        </Button>
      </div>
    </header>
  );
}
