import { useMemo, useState } from "react";
import { FileCode2, LoaderCircle, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { gitDiff } from "@/lib/backend";
import { cn } from "@/lib/utils";
import type {
  ChangeEntry,
  DiffMode,
  DiffResponse,
  RepositorySnapshot,
} from "@/types/workbench";

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
  const [result, setResult] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => snapshot.changes.find((change) => change.path === selectedPath) ?? null,
    [selectedPath, snapshot.changes],
  );

  const load = async (path: string, nextMode = mode) => {
    if (!enabled) return;
    setSelectedPath(path);
    setMode(nextMode);
    setLoading(true);
    setError(null);
    try {
      const next = await gitDiff({
        repositoryRoot,
        workspaceRoot,
        path,
        mode: nextMode,
        baseRef: nextMode === "base" ? baseRef.trim() || null : null,
      });
      setResult(next);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const changeMode = (nextMode: DiffMode) => {
    setMode(nextMode);
    if (selectedPath && nextMode !== "base") {
      void load(selectedPath, nextMode);
    }
  };

  if (snapshot.changes.length === 0) {
    return (
      <div className="mx-auto max-w-[1120px] border border-white/[0.07] bg-[#15100c]/92 p-8 text-center">
        <FileCode2 className="mx-auto text-emerald-300" size={22} />
        <div className="mt-3 text-sm text-slate-200">Working tree is clean</div>
        <div className="mt-1 text-xs text-slate-600">There are no local modifications to review.</div>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-[1320px] grid-cols-[320px_1fr] gap-4">
      <section className="overflow-hidden border border-white/[0.07] bg-[#15100c]/92">
        <div className="border-b border-white/[0.06] px-4 py-3">
          <div className="text-sm font-medium text-slate-200">Changed files</div>
          <div className="mt-1 text-[11px] text-slate-600">Select a file to load a bounded read-only Git diff.</div>
        </div>
        <div className="scrollbar-thin max-h-[620px] overflow-y-auto">
          {snapshot.changes.map((change) => (
            <ChangeRow
              key={change.path}
              change={change}
              active={change.path === selectedPath}
              disabled={!enabled}
              onSelect={() => void load(change.path)}
            />
          ))}
        </div>
      </section>

      <section className="vl-editor-surface flex min-h-[560px] min-w-0 flex-col overflow-hidden border border-white/[0.07]">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
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
                disabled={!selectedPath || !baseRef.trim() || loading}
                onClick={() => selectedPath && void load(selectedPath, "base")}
                size="sm"
                variant="outline"
              >
                Load base diff
              </Button>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {result?.binary && <Badge tone="orange">binary</Badge>}
            {result?.truncated && <Badge tone="orange">truncated</Badge>}
            {result && <Badge tone="neutral">{result.returnedBytes} B</Badge>}
          </div>
        </div>

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
                <div className="mt-1 text-xs text-slate-600">Text rendering is intentionally disabled for binary content.</div>
              </div>
            </div>
          ) : result ? (
            <pre className="mono scrollbar-thin h-full max-h-[620px] overflow-auto whitespace-pre p-4 text-[11px] leading-5 text-slate-300">
              {result.patch || "No textual diff for this file in the selected mode."}
            </pre>
          ) : (
            <div className="flex h-full min-h-72 items-center justify-center text-center">
              <div>
                <div className="text-sm text-slate-300">Select a changed file</div>
                <div className="mt-1 text-xs text-slate-600">
                  V0.3 Phase A uses the typed native Git diff adapter; Monaco rendering follows next.
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mono border-t border-white/[0.06] px-3 py-2 text-[10px] text-slate-600">
          {selected ? selected.path : workspaceRoot}
        </div>
      </section>
    </div>
  );
}

function ChangeRow({
  change,
  active,
  disabled,
  onSelect,
}: {
  change: ChangeEntry;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-3 border-b border-white/[0.05] px-3 py-3 text-left transition",
        active ? "bg-orange-400/[0.10]" : "hover:bg-white/[0.025]",
      )}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <span className="mono flex size-7 shrink-0 items-center justify-center border border-white/[0.08] text-[11px] text-orange-300">
        {change.kind === "untracked" ? "?" : change.indexStatus.trim() || change.worktreeStatus.trim() || "·"}
      </span>
      <span className="mono min-w-0 flex-1 truncate text-xs text-slate-300" title={change.path}>
        {change.path}
      </span>
    </button>
  );
}
