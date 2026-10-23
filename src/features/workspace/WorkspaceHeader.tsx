import {
  Cloud,
  CloudOff,
  Code2,
  FolderOpen,
  GitBranch,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { compactPath } from "@/lib/utils";
import { EXTERNAL_EDITORS, editorLabel, type ExternalEditor } from "@/lib/externalEditor";
import type { RepositorySnapshot } from "@/types/workbench";

interface Props {
  snapshot: RepositorySnapshot;
  isPreview: boolean;
  loading: boolean;
  gitBusy: boolean;
  onOpenFolder: () => void;
  editor: ExternalEditor;
  onEditorChange: (editor: ExternalEditor) => void;
  onOpenEditor: () => void;
  onFetch: () => void;
  onPull: () => void;
}

export function WorkspaceHeader({
  snapshot,
  isPreview,
  loading,
  gitBusy,
  onOpenFolder,
  editor,
  onEditorChange,
  onOpenEditor,
  onFetch,
  onPull,
}: Props) {
  const clean = snapshot.dirtyCount === 0;
  const trackedDirty = snapshot.stagedCount > 0 || snapshot.unstagedCount > 0;

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

            <span className="mono text-[11px] text-slate-600" title={snapshot.headSha}>{snapshot.headSha.slice(0, 10)}</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            disabled={isPreview || loading}
            onClick={onOpenFolder}
            variant="outline"
            size="sm"
            title="Open this worktree in the system file manager"
          >
            <FolderOpen size={13} />
            Open folder
          </Button>
          <div className="flex min-w-0 items-center gap-1">
            <Button
              disabled={isPreview || loading}
              onClick={onOpenEditor}
              variant="outline"
              size="sm"
              title="Open the selected branch/worktree directory as a separate IDE project window"
            >
              <Code2 size={13} />
              Open in {editor === "auto" ? "IDE" : editorLabel(editor)}
            </Button>
            <select
              aria-label="Preferred editor"
              title="Choose an IDE for opening repository and worktree folders; this choice is remembered"
              className="h-8 min-w-0 max-w-[104px] rounded-md border border-white/15 bg-[#161b22] px-1 text-[11px] text-slate-300 outline-none focus:border-orange-400/60 disabled:opacity-40"
              value={editor}
              disabled={isPreview || loading}
              onChange={(event) => onEditorChange(event.target.value as ExternalEditor)}
            >
              {EXTERNAL_EDITORS.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </div>
          <Button
            disabled={isPreview || loading || gitBusy || !snapshot.remoteUrl}
            onClick={onFetch}
            variant="outline"
            size="sm"
            title="Fetch origin and prune deleted remote-tracking branches"
          >
            <Cloud size={13} />
            Fetch
          </Button>
          <Button
            disabled={
              isPreview || loading || gitBusy || (!snapshot.remoteUrl && !snapshot.upstream) || snapshot.upstream === null ||
              trackedDirty || snapshot.currentBranch.startsWith("detached@")
            }
            onClick={onPull}
            variant="outline"
            size="sm"
            title={snapshot.upstream === null ? "No configured upstream; configure one before Pull" : `Fast-forward from ${snapshot.upstream ?? "the configured upstream"}; untracked files remain unless they conflict with incoming files`}
          >
            <GitBranch size={13} />
            Pull
          </Button>
        </div>
      </div>
    </header>
  );
}
