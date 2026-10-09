import { confirmNativeAction } from "@/lib/backend";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CloudOff,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  GitBranchPlus,
  GitMerge,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { getPrCheckLabel, getPrMergeBlockers, githubAdapter } from "@/lib/github";
import { correlatePrHead } from "@/lib/reviewLoop";
import { reviewWorkspaceKey, useWorkbenchStore } from "@/stores/workbench";
import type {
  GithubCapabilities,
  GithubContext,
  GithubMergeMethod,
  GithubPullRequest,
  RepositorySnapshot,
  ReviewDraft,
  ReviewWorkspaceRequest,
} from "@/types/workbench";

export function GithubPanel({
  snapshot,
  workspaceRoot,
  enabled,
  onNewReviewWorkspace,
  onRefreshForRereview,
}: {
  onNewReviewWorkspace?: (request: ReviewWorkspaceRequest) => void;
  onRefreshForRereview?: (workspaceRoot: string) => Promise<void>;
  snapshot: RepositorySnapshot;
  workspaceRoot: string;
  enabled: boolean;
}) {
  const reviewState = useWorkbenchStore(
    (state) => state.reviewStates[reviewWorkspaceKey(workspaceRoot)],
  );
  const setGithubReference = useWorkbenchStore((state) => state.setGithubReference);
  const markReviewDraftPosted = useWorkbenchStore((state) => state.markReviewDraftPosted);
  const setReviewPhase = useWorkbenchStore((state) => state.setReviewPhase);

  const [capabilities, setCapabilities] = useState<GithubCapabilities | null>(null);
  const [context, setContext] = useState<GithubContext | null>(null);
  const [reference, setReference] = useState(reviewState?.githubReference ?? "");
  const [loading, setLoading] = useState(false);
  const [pullRequests, setPullRequests] = useState<GithubPullRequest[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<GithubMergeMethod>("squash");
  const [mergeResult, setMergeResult] = useState<string | null>(null);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const drafts = reviewState?.drafts ?? [];
  const liveContext = useRef("");
  const actionPending = useRef(false);
  useEffect(() => () => { liveContext.current = "disposed"; }, []);

  useEffect(() => {
    setReference(reviewState?.githubReference ?? "");
  }, [reviewState?.githubReference, workspaceRoot]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const savedReference = useWorkbenchStore.getState()
      .reviewStates[reviewWorkspaceKey(workspaceRoot)]?.githubReference;
    setContext(null);
    setCapabilities(null);
    setPullRequests([]);
    setError(null);
    setMergeResult(null);
    setLoading(true);
    void githubAdapter.listPullRequests(workspaceRoot)
      .then(async (list) => {
        if (disposed) return;
        setCapabilities(list.capabilities);
        setPullRequests(list.pullRequests);
        if (list.capabilities.mode === "connected" && savedReference) {
          const restored = await githubAdapter.loadContext(workspaceRoot, savedReference);
          if (!disposed) {
            setCapabilities(restored.capabilities);
            setContext(restored);
          }
        }
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, [enabled, workspaceRoot]);

  const loadContext = async (selectedReference = reference) => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    setContext(null); // Never enable actions against a stale selection.
    setMergeResult(null);
    try {
      const next = await githubAdapter.loadContext(workspaceRoot, selectedReference);
      setCapabilities(next.capabilities);
      setContext(next);
      const resolved =
        next.pullRequest?.url ??
        next.issue?.url ??
        (selectedReference.trim() ? selectedReference.trim() : null);
      setGithubReference(workspaceRoot, resolved);
      setReference(resolved ?? "");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(!selectedReference.trim() && /no pull requests|no pull request|argument required|not found/i.test(detail)
        ? "No PR is associated with this branch. Select an open PR from the list below."
        : detail);
    } finally {
      setLoading(false);
    }
  };

  const refreshPrList = async () => {
    if (!enabled || listLoading) return;
    setListLoading(true);
    setError(null);
    try {
      const list = await githubAdapter.listPullRequests(workspaceRoot);
      setCapabilities(list.capabilities);
      setPullRequests(list.pullRequests);
      if (list.capabilities.mode !== "connected") setContext(null);
      else if (context?.pullRequest) {
        const latest = await githubAdapter.loadContext(workspaceRoot, `pr:${context.pullRequest.number}`);
        setContext(latest);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setListLoading(false);
    }
  };

  const pr = context?.pullRequest ?? null;
  const mergeBlockers = pr ? getPrMergeBlockers(pr) : [];
  const sortedChecks = [...(pr?.checks.checks ?? [])].sort(
    (a, b) => checkPriority(a.conclusion ?? a.status) - checkPriority(b.conclusion ?? b.status),
  );
  const headRelation = pr ? correlatePrHead(snapshot.headSha, pr) : "unknown";
  const headMatches = headRelation === "head";
  liveContext.current = JSON.stringify([workspaceRoot, snapshot.headSha, pr?.number, pr?.headSha, capabilities?.repository]);

  const postableDrafts = useMemo(
    () =>
      drafts.filter(
        (draft) =>
          draft.status === "active" &&
          draft.headSha === snapshot.headSha &&
          pr?.changedFiles.some((file) => file.path === draft.path),
      ),
    [drafts, pr],
  );

  const postDraft = async (draft: ReviewDraft) => {
    if (!pr || !capabilities?.repository || !headMatches) return;
    if (actionPending.current) return;
    actionPending.current = true;
    const expectedContext = liveContext.current;
    const confirmed = await confirmNativeAction(
      `Post this review comment to GitHub PR #${pr.number}?\n\n${draft.path}:${draft.line} ${draft.side}\n\n${draft.body}`,
    );
    actionPending.current = false;
    const currentDraft = useWorkbenchStore.getState().reviewStates[reviewWorkspaceKey(workspaceRoot)]?.drafts.find((item) => item.id === draft.id);
    if (!confirmed || liveContext.current !== expectedContext || currentDraft?.status !== "active"
      || currentDraft.headSha !== snapshot.headSha || currentDraft.body !== draft.body) return;

    setPostingId(draft.id);
    setError(null);
    try {
      const posted = await githubAdapter.postReviewComment({
        workspaceRoot,
        repository: capabilities.repository,
        prNumber: pr.number,
        commitId: pr.headSha,
        path: draft.path,
        line: draft.line,
        side: draft.side,
        body: draft.body,
      });
      markReviewDraftPosted(workspaceRoot, draft.id, posted.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPostingId(null);
    }
  };

  const refreshReview = async () => {
    if (!onRefreshForRereview || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await onRefreshForRereview(workspaceRoot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const mergePr = async () => {
    if (!pr || !capabilities?.repository || merging || loading || mergeBlockers.length) return;
    if (actionPending.current) return;
    actionPending.current = true;
    const expectedContext = liveContext.current;
    const approved = await confirmNativeAction(
      `Merge GitHub PR #${pr.number} into ${pr.baseRef} using ${mergeMethod}?\n\n` +
      `${pr.title}\nHead: ${pr.headSha}\n` +
      `Checks: ${pr.checks.success} passed, ${pr.checks.failure} failed, ${pr.checks.pending} pending.\n\n` +
      "This updates the remote base branch. Review the PR and confirm before proceeding.",
    );
    actionPending.current = false;
    if (!approved || liveContext.current !== expectedContext) return;

    setMerging(true);
    setError(null);
    setMergeResult(null);
    try {
      const result = await githubAdapter.mergePullRequest({
        workspaceRoot,
        repository: capabilities.repository,
        prNumber: pr.number,
        expectedHeadSha: pr.headSha,
        mergeMethod,
      });
      if (!result.merged) throw new Error("GitHub did not confirm the merge");
      setMergeResult(`PR #${pr.number} merged into ${pr.baseRef} (${mergeMethod}).`);
      setContext((previous) => previous?.pullRequest?.number === pr.number
        ? { ...previous, pullRequest: { ...previous.pullRequest, state: "MERGED" } }
        : previous);
      setPullRequests((previous) => previous.filter((item) => item.number !== pr.number));
      try {
        const [list, latest] = await Promise.all([
          githubAdapter.listPullRequests(workspaceRoot),
          githubAdapter.loadContext(workspaceRoot, `pr:${pr.number}`),
        ]);
        setPullRequests(list.pullRequests);
        setContext(latest);
      } catch (refreshError) {
        setError(`Merge completed, but refresh failed: ${String(refreshError)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  };

  if (!enabled) {
    return (
      <PanelMessage
        icon={<CloudOff size={18} />}
        title="GitHub integration unavailable in preview"
        detail="Local diff and review remain available in the native desktop runtime."
      />
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] space-y-4">
      <section className="border border-white/[0.07] bg-[#15100c]/92">
        <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-3">
          <GitPullRequest size={16} className="text-orange-300" />
          <div>
            <div className="text-sm font-medium text-slate-200">GitHub workspace context</div>
            <div className="mt-1 text-[11px] text-slate-600">
              Typed gh adapter; no token is stored by VirtualLab.
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {capabilities && (
              <Badge tone={capabilities.mode === "connected" ? "green" : "amber"}>
                {capabilities.mode === "connected" ? "connected" : "local only"}
              </Badge>
            )}
            <Button disabled={loading || listLoading} onClick={() => void refreshPrList()} size="sm" variant="ghost">
              <RefreshCw size={12} className={loading || listLoading ? "animate-spin" : undefined} />
              Refresh
            </Button>
          </div>
        </div>

        <div className="p-4">
          {loading && !capabilities ? (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <LoaderCircle className="animate-spin" size={14} />
              Detecting local gh capability…
            </div>
          ) : capabilities?.mode !== "connected" ? (
            <div className="border border-amber-400/15 bg-amber-400/[0.04] p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-amber-200">
                <CloudOff size={14} />
                Local review mode
              </div>
              <div className="mt-2 text-[11px] leading-5 text-slate-500">
                {capabilities?.detail ??
                  "GitHub capability has not been detected yet. Local diff/review remains fully available."}
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-[1_1_320px]">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-600">
                    PR / issue reference
                  </span>
                  <input
                    aria-label="GitHub reference"
                    className="field mt-1 w-full"
                    placeholder="PR URL, issue URL, pr:7, issue:4, #7; blank = current branch"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                  />
                </label>
                <Button disabled={loading} onClick={() => void loadContext()} size="sm">
                  {loading ? <LoaderCircle className="animate-spin" size={13} /> : <GitPullRequest size={13} />}
                  Load
                </Button>
              </div>
              <div className="mt-2 text-[10px] text-slate-600">
                Repository: <span className="mono text-slate-400">{capabilities.repository}</span>.
                You can also select any open PR below, including PRs not on the current local branch.
              </div>
            </>
          )}

          {error && (
            <div className="mt-3 flex gap-2 border border-rose-400/20 bg-rose-400/[0.05] p-3 text-[11px] text-rose-200">
              <TriangleAlert size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </section>

      {capabilities?.mode === "connected" && (
        <section className="border border-white/[0.07] bg-[#15100c]/92">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
            <div className="flex items-center gap-2">
              <GitPullRequest size={15} className="text-orange-300" />
              <span className="text-sm font-medium text-slate-200">Open pull requests</span>
              <Badge tone="neutral">{pullRequests.length}</Badge>
            </div>
            <span className="text-[10px] text-slate-500">Select a PR to inspect all CI checks and merge eligibility</span>
          </div>
          {pullRequests.length === 0 ? (
            <div className="px-4 py-4 text-xs text-slate-500">
              {loading || listLoading ? "Loading pull requests…" : "No open PRs found. You can still load a closed PR or issue by reference."}
            </div>
          ) : (
            <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto p-3 lg:grid-cols-2">
              {pullRequests.map((item) => (
                <button
                  type="button"
                  key={item.number}
                  aria-label={`Open PR #${item.number}`}
                  disabled={loading || merging}
                  onClick={() => void loadContext(`pr:${item.number}`)}
                  className={`min-w-0 border p-3 text-left transition-colors hover:border-orange-400/40 hover:bg-white/[0.03] disabled:opacity-50 ${
                    pr?.number === item.number ? "border-orange-400/50 bg-orange-400/[0.07]" : "border-white/[0.07]"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="mono text-xs text-orange-300">#{item.number}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{item.title}</span>
                    {item.isDraft && <Badge tone="amber">draft</Badge>}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                    <span className="mono max-w-[60%] truncate">{item.baseRef} ← {item.headRef}</span>
                    <Badge tone={item.checks.failure ? "red" : item.checks.pending || !item.checks.total ? "amber" : "green"}>
                      {getPrCheckLabel(item)}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {mergeResult && (
        <div role="status" className="border border-emerald-400/20 bg-emerald-400/[0.05] px-4 py-3 text-xs text-emerald-200">
          {mergeResult}
        </div>
      )}

      {(pr || context?.issue) && (
        <div className="flex flex-wrap items-center gap-2 border border-white/[0.07] bg-[#15100c]/92 px-4 py-3 text-[11px]">
          <span className="font-medium text-slate-300">Review loop</span>
          <Badge tone="neutral">{reviewState?.phase ?? "review"}</Badge>
          <span className="text-slate-500">
            Inspect → Review → Fix → Refresh → Re-review
          </span>
          <Button size="sm" variant="outline"
            onClick={() => setReviewPhase(workspaceRoot,"fix")}>
            Mark fix in progress
          </Button>
        </div>
      )}

      {pr && (
        <section className="border border-white/[0.07] bg-[#15100c]/92">
          <div className="flex items-start gap-3 border-b border-white/[0.06] px-4 py-3">
            <GitPullRequest size={16} className="mt-0.5 text-orange-300" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-200">
                #{pr.number} {pr.title}
              </div>
              <div className="mono mt-1 truncate text-[10px] text-slate-600" title={pr.url}>
                {pr.baseRef} ← {pr.headRef} · {pr.headSha.slice(0, 10)}
              </div>
            </div>
            <Badge tone={headMatches ? "green" : "amber"}>
              {headRelation === "head" ? "HEAD match" : headRelation === "base" ? "At PR base" :
                headRelation === "unknown" ? "HEAD unknown" : "HEAD mismatch"}
            </Badge>
            <Badge tone="neutral">{pr.state}</Badge>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] p-4">
            <div className="mono text-[10px] text-slate-500">
              Local: {snapshot.headSha} · PR head: {pr.headSha.slice(0, 12)} ·
              PR base: {pr.baseSha?.slice(0, 12) ?? "not available"}
            </div>
            <div className="ml-auto flex gap-2">
              {onNewReviewWorkspace && (
                <Button onClick={() => onNewReviewWorkspace({
                  kind:"pr", number:pr.number, reference:pr.url,
                })} size="sm" variant="outline">
                  <GitBranchPlus size={12} /> New PR worktree
                </Button>
              )}
              {onRefreshForRereview && (
                <Button onClick={() => void refreshReview()} disabled={refreshing} size="sm" variant="outline">
                  <RefreshCw size={12} /> Refresh and re-review
                </Button>
              )}
            </div>
          </div>
          {headRelation !== "head" && (
            <div className="border-b border-amber-400/15 px-4 py-2 text-[11px] text-amber-200">
              {headRelation === "base"
                ? "This workspace is at PR base, not PR head. A new worktree does not fetch PR commits automatically."
                : "Local HEAD does not match the loaded PR head. Review-comment posting stays disabled."}
            </div>
          )}
          <div className="grid min-w-0 grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
            <div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Metric label="Files" value={String(pr.changedFiles.length)} />
                <Metric label="Checks" value={String(pr.checks.total)} />
                <Metric label="Pass" value={String(pr.checks.success)} tone="green" />
                <Metric label="Fail" value={String(pr.checks.failure)} tone={pr.checks.failure ? "red" : "neutral"} />
                <Metric label="Pending" value={String(pr.checks.pending)} tone={pr.checks.pending ? "red" : "neutral"} />
              </div>
              <div className="mt-3 max-h-64 space-y-1 overflow-y-auto" aria-label="PR CI checks">
                {sortedChecks.length === 0 && (
                  <div className="text-[11px] text-amber-300">No CI checks reported for this PR HEAD.</div>
                )}
                {sortedChecks.map((check, index) => {
                  const status = check.conclusion ?? check.status;
                  const failed = checkPriority(status) === 0;
                  const passed = status === "SUCCESS";
                  const safeUrl = check.url && /^https?:\/\//i.test(check.url) ? check.url : null;
                  return (
                    <div key={`${check.name}-${index}`} className="flex items-center gap-2 py-1 text-[11px]">
                      <CheckCircle2 size={13} className={failed ? "text-rose-300" : passed ? "text-emerald-300" : "text-amber-300"} />
                      {safeUrl ? (
                        <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-slate-300 underline-offset-2 hover:underline">
                          {check.name}
                        </a>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-slate-400">{check.name}</span>
                      )}
                      <span className={`mono ${failed ? "text-rose-300" : passed ? "text-emerald-300" : "text-amber-300"}`}>
                        {status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-600">
                Changed files
              </div>
              <div className="mt-2 max-h-52 overflow-y-auto border border-white/[0.05]">
                {pr.changedFiles.map((file) => (
                  <div key={file.path} className="flex items-center gap-3 border-b border-white/[0.04] px-3 py-2 last:border-b-0">
                    <span className="mono min-w-0 flex-1 truncate text-[10px] text-slate-400">{file.path}</span>
                    <span className="mono text-[10px] text-emerald-400">+{file.additions}</span>
                    <span className="mono text-[10px] text-rose-400">-{file.deletions}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="border-t border-white/[0.06] p-4">
            <div className="flex flex-wrap items-center gap-3">
              <GitMerge size={15} className="text-orange-300" />
              <div className="text-xs font-medium text-slate-200">Merge eligibility</div>
              <Badge tone={mergeBlockers.length === 0 ? "green" : "amber"}>
                {mergeBlockers.length === 0 ? "Ready to merge" : "Merge blocked"}
              </Badge>
              <span className="mono text-[10px] text-slate-500">
                GitHub: {pr.mergeStateStatus ?? "unknown"} · Review: {pr.reviewDecision ?? "not required"}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <select
                  aria-label="Merge method"
                  className="field min-w-[110px] py-1 text-xs"
                  disabled={merging}
                  value={mergeMethod}
                  onChange={(event) => setMergeMethod(event.target.value as GithubMergeMethod)}
                >
                  <option value="squash">Squash</option>
                  <option value="merge">Merge commit</option>
                  <option value="rebase">Rebase</option>
                </select>
                <Button disabled={mergeBlockers.length > 0 || merging || loading} onClick={() => void mergePr()} size="sm">
                  {merging ? <LoaderCircle size={13} className="animate-spin" /> : <GitMerge size={13} />}
                  Merge PR
                </Button>
              </div>
            </div>
            {mergeBlockers.length > 0 ? (
              <ul className="mt-3 space-y-1 text-[11px] text-amber-200">
                {mergeBlockers.map((reason) => <li key={reason}>• {reason}</li>)}
              </ul>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500">
                All reported CI checks passed or were skipped. GitHub reports CLEAN; merge requires explicit confirmation and a fresh server-side verification.
              </p>
            )}
          </div>

          <div className="border-t border-white/[0.06] p-4">
            <div className="flex items-center gap-2">
              <MessageSquare size={14} className="text-orange-300" />
              <div className="text-xs font-medium text-slate-200">Local review drafts</div>
              <Badge tone="neutral">{drafts.length}</Badge>
              {!headMatches && (
                <span className="text-[10px] text-amber-300">
                  Posting is disabled until local HEAD matches the PR head.
                </span>
              )}
            </div>
            <div className="mt-3 space-y-2">
              {drafts.length === 0 ? (
                <div className="text-[11px] text-slate-600">
                  Create line-scoped drafts in Changes. Nothing is posted automatically.
                </div>
              ) : (
                drafts.map((draft) => {
                  const fileInPr = pr.changedFiles.some((file) => file.path === draft.path);
                  const canPost =
                    draft.status === "active" && draft.headSha === snapshot.headSha &&
                    headMatches && fileInPr && postingId !== draft.id;
                  return (
                    <div key={draft.id} className="border border-white/[0.06] bg-white/[0.02] p-3">
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
                        <Button
                          disabled={!canPost}
                          onClick={() => void postDraft(draft)}
                          size="sm"
                          variant="outline"
                        >
                          {postingId === draft.id ? (
                            <LoaderCircle className="animate-spin" size={12} />
                          ) : (
                            <MessageSquare size={12} />
                          )}
                          Post
                        </Button>
                      </div>
                      <div className="mt-2 text-[11px] leading-5 text-slate-500">{draft.body}</div>
                      {!fileInPr && draft.status === "active" && (
                        <div className="mt-1 text-[10px] text-amber-300">
                          This draft path is not present in the loaded PR.
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      )}

      {context?.issue && (
        <section className="border border-white/[0.07] bg-[#15100c]/92 p-4">
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{context.issue.state}</Badge>
            <div className="text-sm font-medium text-slate-200">
              #{context.issue.number} {context.issue.title}
            </div>
          </div>
          <div className="mono mt-2 text-[10px] text-slate-600">{context.issue.url}</div>
          {onNewReviewWorkspace && (
            <div className="mt-3 flex items-center gap-2">
              <Button onClick={() => onNewReviewWorkspace({
                kind: "issue", number: context.issue!.number, reference: context.issue!.url,
              })} size="sm" variant="outline">
                <GitBranchPlus size={12} /> New issue worktree
              </Button>
              {onRefreshForRereview && (
                <Button onClick={() => void refreshReview()} disabled={refreshing} size="sm" variant="outline">
                  <RefreshCw size={12} /> Refresh and re-review
                </Button>
              )}
            </div>
          )}
          {context.issue.labels.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {context.issue.labels.map((label) => (
                <Badge key={label} tone="neutral">{label}</Badge>
              ))}
            </div>
          )}
        </section>
      )}

      {context && !context.pullRequest && !context.issue && capabilities?.mode === "connected" && (
        <PanelMessage
          icon={<GitPullRequest size={18} />}
          title="No GitHub context loaded"
          detail="Enter a PR/issue reference or leave the field blank to resolve the current branch PR."
        />
      )}

      {postableDrafts.length > 0 && pr && headMatches && (
        <div className="text-[10px] text-slate-600">
          {postableDrafts.length} active draft(s) are eligible for explicit GitHub posting.
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "green" | "red";
}) {
  return (
    <div className="border border-white/[0.06] bg-white/[0.02] p-2">
      <div className="text-[9px] uppercase tracking-[0.08em] text-slate-600">{label}</div>
      <div
        className={
          tone === "green"
            ? "mono mt-1 text-sm text-emerald-300"
            : tone === "red"
              ? "mono mt-1 text-sm text-rose-300"
              : "mono mt-1 text-sm text-slate-300"
        }
      >
        {value}
      </div>
    </div>
  );
}

function PanelMessage({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="mx-auto flex min-h-64 max-w-[900px] items-center justify-center border border-white/[0.07] bg-[#15100c]/92 p-8 text-center">
      <div>
        <div className="mx-auto flex size-10 items-center justify-center border border-white/[0.07] text-slate-500">
          {icon}
        </div>
        <div className="mt-3 text-sm text-slate-200">{title}</div>
        <div className="mt-2 max-w-xl text-[11px] leading-5 text-slate-600">{detail}</div>
      </div>
    </div>
  );
}

function checkPriority(status: string): number {
  if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(status)) return 0;
  if (status === "SUCCESS") return 2;
  if (status === "SKIPPED" || status === "NEUTRAL") return 3;
  return 1;
}
