import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { LoaderCircle, MessageSquarePlus, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { gitDiff } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { reviewWorkspaceKey, useWorkbenchStore } from "@/stores/workbench";
import type {
  ChangeEntry,
  DiffFileSummary,
  DiffMode,
  DiffResponse,
  RepositorySnapshot,
  ReviewDraft,
  ReviewLineSelection,
} from "@/types/workbench";

const MonacoReviewSurface = lazy(() =>
  import("./MonacoReviewSurface").then((module) => ({
    default: module.MonacoReviewSurface,
  })),
);

type ReviewLayout = "unified" | "side-by-side";

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
  const reviewState = useWorkbenchStore(
    (state) => state.reviewStates[reviewWorkspaceKey(workspaceRoot)],
  );
  const addReviewDraft = useWorkbenchStore((state) => state.addReviewDraft);
  const removeReviewDraft = useWorkbenchStore((state) => state.removeReviewDraft);
  const markReviewDraftsStale = useWorkbenchStore((state) => state.markReviewDraftsStale);

  const drafts = reviewState?.drafts ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedReviewLine, setSelectedReviewLine] = useState<ReviewLineSelection | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [mode, setMode] = useState<DiffMode>("worktree");
  const [layout, setLayout] = useState<ReviewLayout>("side-by-side");
  const [baseRef, setBaseRef] = useState("main");
  const [baseFiles, setBaseFiles] = useState<DiffFileSummary[]>([]);
  const [result, setResult] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    markReviewDraftsStale(workspaceRoot, snapshot.headSha);
  }, [markReviewDraftsStale, snapshot.headSha, workspaceRoot]);

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
      .map((change) => localReviewFile(change, mode));
  }, [baseFiles, mode, snapshot.changes]);

  const loadFile = async (file: ReviewFile) => {
    if (!enabled) return;
    setSelectedPath(file.path);
    setSelectedReviewLine(null);
    setDraftBody("");
    setLoading(true);
    setError(null);
    try {
      const next = await gitDiff({
        repositoryRoot,
        workspaceRoot,
        path: file.path,
        oldPath: file.oldPath ?? null,
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
    setSelectedReviewLine(null);
    setResult(null);
    try {
      const next = await gitDiff({
        repositoryRoot,
        workspaceRoot,
        path: null,
        oldPath: null,
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
    setSelectedReviewLine(null);
    setDraftBody("");
    setResult(null);
    setError(null);
  };

  const saveDraft = () => {
    const body = draftBody.trim();
    const path = result?.path ?? selectedPath;
    if (!body || !path || !selectedReviewLine) return;

    const now = Date.now();
    const draft: ReviewDraft = {
      id:
        globalThis.crypto?.randomUUID?.() ??
        `review-${now}-${Math.random().toString(16).slice(2)}`,
      workspaceRoot,
      headSha: snapshot.headSha,
      path,
      line: selectedReviewLine.line,
      side: selectedReviewLine.side,
      body,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    addReviewDraft(draft);
    setDraftBody("");
  };

  const textualResult =
    result &&
    !result.binary &&
    result.originalText != null &&
    result.modifiedText != null;

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col gap-3" data-testid="changes-review-root">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border border-white/[0.07] bg-[#15100c]/92 px-3 py-2.5">
        <div className="flex items-center gap-1">
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
        </div>

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

        <div className="ml-auto flex items-center gap-1 border-l border-white/[0.08] pl-2">
          <Badge tone={drafts.some((draft) => draft.status === "stale") ? "amber" : "neutral"}>
            {drafts.length} drafts
          </Badge>
          <Button
            aria-pressed={layout === "unified"}
            size="sm"
            variant={layout === "unified" ? "primary" : "ghost"}
            onClick={() => setLayout("unified")}
          >
            Unified
          </Button>
          <Button
            aria-pressed={layout === "side-by-side"}
            size="sm"
            variant={layout === "side-by-side" ? "primary" : "ghost"}
            onClick={() => setLayout("side-by-side")}
          >
            Side by side
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,340px)_minmax(0,1fr)] gap-4" data-testid="changes-review-grid">
        <section className="flex min-h-0 flex-col overflow-hidden border border-white/[0.07] bg-[#15100c]/92">
          <div className="shrink-0 border-b border-white/[0.06] px-4 py-3">
            <div className="text-sm font-medium text-slate-200">
              {mode === "base"
                ? "Base changed files"
                : mode === "index"
                  ? "Staged files"
                  : "Worktree files"}
            </div>
            <div className="mt-1 text-[11px] text-slate-600">
              {mode === "base"
                ? "Load a base ref, then select a committed change."
                : "Select a tracked file for read-only Monaco review."}
            </div>
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="changes-file-list">
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
                  onSelect={() => void loadFile(file)}
                />
              ))
            )}
          </div>

          <div className="max-h-48 shrink-0 overflow-y-auto border-t border-white/[0.06]">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                Local review drafts
              </span>
              <span className="mono text-[10px] text-slate-600">{drafts.length}</span>
            </div>
            {drafts.length === 0 ? (
              <div className="px-3 pb-3 text-[10px] leading-4 text-slate-600">
                Select a Monaco line to create a workspace-local draft.
              </div>
            ) : (
              drafts.map((draft) => (
                <div key={draft.id} className="border-t border-white/[0.04] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="mono min-w-0 flex-1 truncate text-[10px] text-slate-400">
                      {draft.path}:{draft.line} {draft.side}
                    </span>
                    <Badge
                      tone={
                        draft.status === "posted"
                          ? "green"
                          : draft.status === "stale"
                            ? "amber"
                            : "neutral"
                      }
                    >
                      {draft.status}
                    </Badge>
                    <button
                      aria-label={`Remove draft ${draft.path} line ${draft.line}`}
                      className="text-slate-600 hover:text-rose-300"
                      onClick={() => removeReviewDraft(workspaceRoot, draft.id)}
                      type="button"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-slate-500">
                    {draft.body}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="vl-editor-surface flex min-h-0 min-w-0 flex-col overflow-hidden border border-white/[0.07]" data-testid="changes-review-editor">
          <div className="flex min-h-10 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
            <div className="mono min-w-0 flex-1 truncate text-[11px] text-slate-400">
              {result?.oldPath ? `${result.oldPath} → ${result.path}` : result?.path ?? "No file selected"}
            </div>
            {selectedReviewLine && (
              <Badge tone="orange">
                {selectedReviewLine.side} L{selectedReviewLine.line}
              </Badge>
            )}
            {result?.binary && <Badge tone="orange">binary</Badge>}
            {(result?.truncated || result?.contentTruncated) && (
              <Badge tone="orange">truncated</Badge>
            )}
            {result && <Badge tone="neutral">{result.returnedBytes} B patch</Badge>}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden" data-testid="changes-review-editor-body">
            {loading ? (
              <ReviewMessage icon="spinner" title="Loading Git diff…" />
            ) : error ? (
              <ReviewMessage icon="error" title="Diff load failed" detail={error} />
            ) : result?.binary ? (
              <ReviewMessage
                title="Binary diff"
                detail="Text rendering is intentionally disabled for binary content."
              />
            ) : textualResult ? (
              <Suspense fallback={<ReviewMessage icon="spinner" title="Loading Monaco…" />}>
                <MonacoReviewSurface
                  original={result.originalText ?? ""}
                  modified={result.modifiedText ?? ""}
                  path={result.path ?? selectedPath ?? "diff.txt"}
                  layout={layout}
                  onReviewLineSelect={setSelectedReviewLine}
                />
              </Suspense>
            ) : result ? (
              <ReviewMessage
                title="No textual diff"
                detail="The selected file has no textual change in this diff mode."
              />
            ) : (
              <ReviewMessage
                title={mode === "base" && files.length === 0 ? "Load base files" : "Select a changed file"}
                detail="Monaco review is read-only. Choose unified or side-by-side layout above."
              />
            )}
          </div>

          {selectedReviewLine && textualResult && (
            <div className="shrink-0 border-t border-orange-400/15 bg-orange-400/[0.035] px-3 py-2">
              <div className="flex items-center gap-2">
                <MessageSquarePlus size={13} className="text-orange-300" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-orange-200">
                  Local draft · {selectedReviewLine.side} line {selectedReviewLine.line}
                </span>
                <span className="ml-auto text-[10px] text-slate-600">HEAD {snapshot.headSha}</span>
              </div>
              <div className="mt-2 flex items-end gap-2">
                <textarea
                  aria-label="Review draft body"
                  className="field min-h-16 flex-1 resize-y py-2 text-xs"
                  placeholder="Write a local review comment. Nothing is posted until you explicitly confirm it in GitHub."
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                />
                <Button disabled={!draftBody.trim()} onClick={saveDraft} size="sm">
                  Save draft
                </Button>
              </div>
            </div>
          )}

          {(result?.truncated || result?.contentTruncated) && (
            <div className="border-t border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-200">
              Large diff content was bounded before rendering. Review the complete file in an external editor if needed.
            </div>
          )}
          <div className="mono border-t border-white/[0.06] px-3 py-2 text-[10px] text-slate-600">
            {selectedPath ?? workspaceRoot}
          </div>
        </section>
      </div>
    </div>
  );
}

function localReviewFile(change: ChangeEntry, mode: DiffMode): ReviewFile {
  const status = mode === "index" ? change.indexStatus.trim() : change.worktreeStatus.trim();
  return {
    path: change.path,
    oldPath: change.oldPath,
    status: status || (change.kind === "untracked" ? "?" : "·"),
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

function ReviewMessage({
  icon,
  title,
  detail,
}: {
  icon?: "spinner" | "error";
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6 text-center">
      <div className="max-w-lg">
        {icon === "spinner" && (
          <LoaderCircle className="mx-auto mb-3 animate-spin text-orange-300" size={18} />
        )}
        {icon === "error" && (
          <TriangleAlert className="mx-auto mb-3 text-rose-300" size={18} />
        )}
        <div className="text-sm text-slate-200">{title}</div>
        {detail && <div className="mt-2 text-xs leading-5 text-slate-600">{detail}</div>}
      </div>
    </div>
  );
}
