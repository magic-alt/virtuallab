import { useMemo, useState } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { gitDiff } from "@/lib/backend";
import { cn } from "@/lib/utils";
import type {
  ChangeEntry,
  DiffFileSummary,
  DiffMode,
  DiffResponse,
  RepositorySnapshot,
} from "@/types/workbench";

interface ReviewFile {
  path: string;
  oldPath?: string | null;
  status: string;
}

export function ChangesReview({
  snapshot,
  repositoryRoot,
  workspaceRoot,
  enabled,
}: {
  snapshot: RepositorySnapshot;
  repositoryRoot: string;
  workspaceRoot: string;
  enabled: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("worktree");
  const [baseRef, setBaseRef] = useState("main");
  const [baseFiles, setBaseFiles] = useState<DiffFileSummary[]>([]);
  const [result, setResult] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const files = useMemo<ReviewFile[]>(() => {
    if (mode === "base") {
      return baseFiles.map((file) => ({
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
      }));
    }

    return snapshot.changes
      .filter((change) =>
        mode === "index"
          ? change.indexStatus !== " " && change.indexStatus !== "?"
          : change.worktreeStatus !== " " && change.kind !== "untracked",
      )
      .map(localReviewFile);
  }, [baseFiles, mode, snapshot.changes]);

  const loadFile = async (path: string) => {
    if (!enabled) return;
    setSelectedPath(path);
    setLoading(true);
    setError(null);
    try {
      const next = await gitDiff({
        repositoryRoot,
        workspaceRoot,
        path,
        mode,
        baseRef: mode === "base" ? baseRef.trim() || null : null,
      });
      setResult(next);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadBaseFiles = async () => {
    if (!enabled || !baseRef.trim()) return;
    setLoading(true);
    setError(null);
    setSelectedPath(null);
    setResult(null);
    try {
      const next = await gitDiff({
        repositoryRoot,
        workspaceRoot,
        path: null,
        mode: "base",
        baseRef: baseRef.trim(),
      });
      setBaseFiles(next.files);
    } catch (err) {
      setBaseFiles([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const changeMode = (nextMode: DiffMode) => {
    setMode(nextMode);
    setSelectedPath(null);
    setResult(null);
    setError(null);
  };

  return (
    <div className="mx-auto max-w-[1320px] space-y-3">
      <div className="flex flex-wrap items-center gap-2 border border-white/[0.07] bg-[#15100c]/92 px-3 py-2.5">
        {(["worktree", "index", "base"] as DiffMode[]).map((item) => (
          <Button
            key={item}
            size="sm"
            variant={mode === item ? "primary" : "ghost"}
            onClick={() => changeMode(item)}
          >
            {item === "index" ? "Staged" : item === "base" ? "Base" : "Worktree"}
          </Button>
        ))}
        {mode === "base" && (
          <>
            <input
              aria-label="Base ref"
              className="field ml-1 h-8 min-h-8 w-44"
              value={baseRef}
              onChange={(event) => setBaseRef(event.target.value)}
              placeholder="main"
            />
            <Button
              disabled={!enabled || !baseRef.trim() || loading}
              onClick={() => void loadBaseFiles()}
              size="sm"
              variant="outline"
            >
              Load base files
            </Button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {result?.binary && <Badge tone="orange">binary</Badge>}
          {result?.truncated && <Badge tone="orange">truncated</Badge>}
          {result && <Badge tone="neutral">{result.returnedBytes} B</Badge>}
        </div>
      </div>

      <div className="grid grid-cols-[320px_1fr] gap-4">
        <section className="overflow-hidden border border-white/[0.07] bg-[#15100c]/92">
          <div className="border-b border-white/[0.06] px-4 py-3">
            <div className="text-sm font-medium text-slate-200">
              {mode === "base" ? "Base changed files" : mode === "index" ? "Staged files" : "Worktree files"}
            </div>
            <div className="mt-1 text-[11px] text-slate-600">
              {mode === "base"
                ? "Load a base ref, then select a committed change."
                : "Select a tracked file to load a bounded read-only Git diff."}
            </div>
          </div>
          <div className="scrollbar-thin max-h-[620px] overflow-y-auto">
            {files.length === 0 ? (
              <div className="p-5 text-xs leading-5 text-slate-600">
                {mode === "base"
                  ? "No base-ref file list loaded yet, or there are no committed changes."
                  : mode === "worktree" && snapshot.untrackedCount > 0
                    ? "No tracked files in this mode. Untracked files have no Git diff until they are staged."
                    : "No files in this diff mode."}
              </div>
            ) : (
              files.map((file) => (
                <FileRow
                  key={`${file.oldPath ?? ""}->${file.path}`}
                  file={file}
                  active={file.path === selectedPath}
                  disabled={!enabled}
                  onSelect={() => void loadFile(file.path)}
                />
              ))
            )}
          </div>
        </section>

        <section className="vl-editor-surface flex min-h-[560px] min-w-0 flex-col overflow-hidden border border-white/[0.07]">
          <div className="min-h-0 flex-1">
            {loading ? (
              <div className="flex h-full min-h-72 items-center justify-center gap-2 text-xs text-slate-500">
                <LoaderCircle className="animate-spin" size={15} />
                Loading Git diff…
              </div>
            ) : error ? (
              <div className="m-4 flex gap-2 border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-200">
                <TriangleAlert size={14} />
                {error}
              </div>
            ) : result?.binary ? (
              <div className="flex h-full min-h-72 items-center justify-center text-center">
                <div>
                  <div className="text-sm text-slate-200">Binary diff</div>
                  <div className="mt-1 text-xs text-slate-600">
                    Text rendering is intentionally disabled for binary content.
                  </div>
                </div>
              </div>
            ) : result ? (
              <pre className="mono scrollbar-thin h-full max-h-[620px] overflow-auto whitespace-pre p-4 text-[11px] leading-5 text-slate-300">
                {result.patch || "No textual diff for this file in the selected mode."}
              </pre>
            ) : (
              <div className="flex h-full min-h-72 items-center justify-center text-center">
                <div>
                  <div className="text-sm text-slate-300">
                    {mode === "base" && files.length === 0 ? "Load base files" : "Select a changed file"}
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    V0.3 Phase A uses the typed native Git diff adapter; Monaco replaces this renderer next.
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="mono border-t border-white/[0.06] px-3 py-2 text-[10px] text-slate-600">
            {selectedPath ?? workspaceRoot}
          </div>
        </section>
      </div>
    </div>
  );
}

function localReviewFile(change: ChangeEntry): ReviewFile {
  return {
    path: change.path,
    oldPath: change.oldPath,
    status:
      change.indexStatus.trim() ||
      change.worktreeStatus.trim() ||
      (change.kind === "untracked" ? "?" : "·"),
  };
}

function FileRow({
  file,
  active,
  disabled,
  onSelect,
}: {
  file: ReviewFile;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const label = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

  return (
    <button
      aria-label={label}
      className={cn(
        "flex w-full items-center gap-3 border-b border-white/[0.05] px-3 py-3 text-left transition",
        active ? "bg-orange-400/[0.10]" : "hover:bg-white/[0.025]",
      )}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <span className="mono flex min-w-8 shrink-0 items-center justify-center border border-white/[0.08] px-1 py-1 text-[10px] text-orange-300">
        {file.status}
      </span>
      <span className="mono min-w-0 flex-1 truncate text-xs text-slate-300" title={label}>
        {label}
      </span>
    </button>
  );
}
