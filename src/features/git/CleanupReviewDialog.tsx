import { useEffect, useRef, useState } from "react";
import { analyzeCleanup, cancelCleanupAnalysis, previewCleanup, type CleanupAnalysis, type CleanupPlan, type CleanupSelection } from "@/lib/gitCleanup";
import { useAgentPreferences } from "@/stores/agentPreferences";

interface Props {
  repositoryRoot: string;
  workspaceRoot: string;
  revision: number;
  busy?: boolean;
  onClose: () => void;
  onExecute: (plan: CleanupPlan, selection: CleanupSelection[]) => Promise<boolean>;
}
const stages: Record<string, string> = { collecting: "正在收集分支、合并关系及工作区状态…", analyzing: "后台 Codex 正在分析元数据…", completed: "分析完成，等待选择与确认。", failed: "Codex 排查失败。", cancelled: "排查已取消。" };

export function CleanupReviewDialog({ repositoryRoot, workspaceRoot, revision, busy = false, onClose, onExecute }: Props) {
  const executable = useAgentPreferences(state => state.codexExecutablePath);
  const [result, setResult] = useState<CleanupAnalysis | null>(null);
  const [selection, setSelection] = useState<CleanupSelection[]>([]);
  const [running, setRunning] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [fallback, setFallback] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [stale, setStale] = useState(false);
  const initialRevision = useRef(revision);
  const epoch = useRef(0);
  const operation = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    const token = ++epoch.current;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    operation.current = id;
    let disposed = false;
    setRunning(true); setResult(null); setSelection([]); setError(""); setLog([]); setFallback(false); setStale(false);
    initialRevision.current = revision;
    void analyzeCleanup(repositoryRoot, workspaceRoot, id, executable.trim() || null, stage => {
      if (!disposed && token === epoch.current) setLog(lines => [...lines.slice(-19), stages[stage] ?? "正在排查…"]);
    }, controller.signal).then(value => {
      if (!disposed && token === epoch.current) { setResult(value); setLog(lines => [...lines, stages.completed]); }
    }).catch(cause => {
      if (!disposed && token === epoch.current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!disposed && token === epoch.current) setRunning(false); });
    return () => { disposed = true; ++epoch.current; controller.abort(); void cancelCleanupAnalysis(id).catch(() => {}); };
    // Refresh invalidates below; it must not automatically launch another agent.
    // A changed executable is used only for the next explicit analysis.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryRoot, workspaceRoot, generation]);

  useEffect(() => {
    if (initialRevision.current === revision || executing) return;
    ++epoch.current; setStale(true); setResult(null); setSelection([]); setRunning(false); setError("仓库已刷新，请重新排查。");
    if (operation.current) void cancelCleanupAnalysis(operation.current).catch(() => {});
  }, [revision, executing]);

  const close = () => { ++epoch.current; if (operation.current) void cancelCleanupAnalysis(operation.current).catch(() => {}); onClose(); };
  const useRules = async () => {
    const token = ++epoch.current; setRunning(true); setError("");
    try {
      const plan = await previewCleanup(repositoryRoot, workspaceRoot);
      if (!alive.current || token !== epoch.current) return;
      initialRevision.current = revision; setStale(false); setFallback(true); setSelection([]);
      setResult({ plan, report: { summary: "规则预览（未经 Codex 分析）", recommendations: plan.targets.map(target => ({ branch: target.branch, recommendation: "keep", reason: "祖先关系校验通过；请自行确认分支用途。", risk: "尚未由 Codex 评估；远端删除可能影响协作者。" })) } });
    } catch (cause) { if (alive.current && token === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current && token === epoch.current) setRunning(false); }
  };
  const toggle = (branch: string, key: "local" | "remote" | "worktree") => {
    setSelection(previous => {
      const item = previous.find(item => item.branch === branch) ?? { branch, local: false, remote: false, worktree: false };
      const next = { ...item, [key]: !item[key] };
      if (key === "worktree" && !next.worktree) next.local = false;
      return [...previous.filter(item => item.branch !== branch), ...(next.local || next.remote || next.worktree ? [next] : [])];
    });
  };
  const execute = async () => {
    if (!result || stale || running || executing || busy || !selection.length) return;
    setExecuting(true); setError("");
    try { if (await onExecute(result.plan, selection)) onClose(); }
    catch (cause) {
      if (alive.current) { setError(cause instanceof Error ? cause.message : String(cause)); setStale(true); setResult(null); setSelection([]); }
    } finally { if (alive.current) setExecuting(false); }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5">
    <section role="dialog" aria-modal="true" aria-labelledby="cleanup-title" className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-5 text-sm text-slate-200">
      <h2 id="cleanup-title" className="text-lg font-semibold">Codex 智能分支排查</h2>
      <p className="mt-1 break-all text-xs text-slate-400">{repositoryRoot}</p>
      <p className="mt-2 text-xs text-slate-400">只读排查，不自动切换、暂存或拉取。仅向 Codex 提供分支元数据。所有删除均需勾选和最终确认。</p>
      <div role="log" aria-label="排查终端" className="my-3 min-h-16 rounded border border-slate-800 bg-black p-3 font-mono text-xs text-emerald-300">
        {log.map((line, index) => <div key={index}>&gt; {line}</div>)}
        {running && <div role="status">正在排查…</div>}
      </div>
      {error && <p role="alert" className="my-3 break-words text-amber-300">{error}</p>}
      {result && !stale && <>
        <p className="whitespace-pre-wrap">{result.report.summary}</p>
        <p className="my-2 break-all text-xs text-slate-400">比较基线：{result.plan.baseRef} @ {result.plan.baseSha.slice(0, 12)}</p>
        {result.plan.targets.length === 0 && <p className="my-3">没有通过安全校验的清理目标。</p>}
        {result.plan.targets.map(target => {
          const advice = result.report.recommendations.find(item => item.branch === target.branch);
          const selected = selection.find(item => item.branch === target.branch);
          return <div key={target.branch} className="my-3 rounded border border-slate-700 p-3">
            <p className="break-all font-semibold">{target.branch} <span className="text-xs text-slate-400">{advice?.recommendation === "delete" ? "建议可清理" : "建议保留 / 需人工判断"}</span></p>
            <p className="mt-1 whitespace-pre-wrap text-xs">依据：{advice?.reason}</p>
            <p className="mt-1 whitespace-pre-wrap text-xs text-amber-300">风险：{advice?.risk}</p>
            <div className="mt-3 flex flex-wrap gap-4">
              {target.worktreePath && <label className="break-all"><input type="checkbox" aria-label={`${target.branch} 工作区`} disabled={busy || executing} checked={selected?.worktree ?? false} onChange={() => toggle(target.branch, "worktree")} /> 工作区：{target.worktreePath}</label>}
              {target.localSha && <label><input type="checkbox" aria-label={`${target.branch} 本地分支`} disabled={busy || executing || Boolean(target.worktreePath && !selected?.worktree)} checked={selected?.local ?? false} onChange={() => toggle(target.branch, "local")} /> 本地 @{target.localSha.slice(0, 10)}</label>}
              {target.remoteSha && <label><input type="checkbox" aria-label={`${target.branch} 远端分支`} disabled={busy || executing} checked={selected?.remote ?? false} onChange={() => toggle(target.branch, "remote")} /> 远端 @{target.remoteSha.slice(0, 10)}</label>}
            </div>
          </div>;
        })}
        {result.plan.skipped.length > 0 && <details className="my-3 text-xs text-slate-400"><summary>保留 / 无法证明安全的项目（{result.plan.skipped.length}）</summary><ul>{result.plan.skipped.map((reason, i) => <li key={i} className="mt-1 break-all">{reason}</li>)}</ul></details>}
        {fallback && <p className="text-xs text-amber-300">规则预览不会将“已推送”视为“已合并”，也不会强制删除无法证明已合并的分支。</p>}
      </>}
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        {!running && !executing && <button type="button" onClick={() => setGeneration(n => n + 1)} className="rounded border border-slate-700 px-3 py-2">重新排查</button>}
        {!running && !executing && error && <button type="button" onClick={() => void useRules()} className="rounded border border-slate-700 px-3 py-2">使用规则预览</button>}
        <button type="button" disabled={executing || busy} onClick={close} className="rounded border border-slate-700 px-3 py-2">{running ? "取消排查" : "关闭"}</button>
        <button type="button" disabled={!result || stale || running || executing || busy || !selection.length} onClick={() => void execute()} className="rounded bg-orange-600 px-3 py-2 disabled:opacity-40">确认所选清理…</button>
      </div>
    </section>
  </div>;
}
