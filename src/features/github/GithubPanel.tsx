import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CloudOff,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { githubAdapter } from "@/lib/github";
import { reviewWorkspaceKey, useWorkbenchStore } from "@/stores/workbench";
import type {
  GithubCapabilities,
  GithubContext,
  RepositorySnapshot,
  ReviewDraft,
} from "@/types/workbench";

export function GithubPanel({
  snapshot,
  workspaceRoot,
  enabled,
}: {
  snapshot: RepositorySnapshot;
  workspaceRoot: string;
  enabled: boolean;
}) {
  const reviewState = useWorkbenchStore(
    (state) => state.reviewStates[reviewWorkspaceKey(workspaceRoot)],
  );
  const setGithubReference = useWorkbenchStore((state) => state.setGithubReference);
  const markReviewDraftPosted = useWorkbenchStore((state) => state.markReviewDraftPosted);

  const [capabilities, setCapabilities] = useState<GithubCapabilities | null>(null);
  const [context, setContext] = useState<GithubContext | null>(null);
  const [reference, setReference] = useState(reviewState?.githubReference ?? "");
  const [loading, setLoading] = useState(false);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const drafts = reviewState?.drafts ?? [];

  useEffect(() => {
    setReference(reviewState?.githubReference ?? "");
  }, [reviewState?.githubReference, workspaceRoot]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setLoading(true);
    void githubAdapter
      .capabilities(workspaceRoot)
      .then((next) => {
        if (!disposed) setCapabilities(next);
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [enabled, workspaceRoot]);

  const loadContext = async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const next = await githubAdapter.loadContext(workspaceRoot, reference);
      setCapabilities(next.capabilities);
      setContext(next);
      const resolved =
        next.pullRequest?.url ??
        next.issue?.url ??
        (reference.trim() ? reference.trim() : null);
      setGithubReference(workspaceRoot, resolved);
      if (resolved) setReference(resolved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const refreshCapabilities = async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const next = await githubAdapter.capabilities(workspaceRoot);
      setCapabilities(next);
      if (next.mode !== "connected") setContext(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const pr = context?.pullRequest ?? null;
  const headMatches = Boolean(
    pr &&
      (pr.headSha.startsWith(snapshot.headSha) ||
        snapshot.headSha.startsWith(pr.headSha)),
  );

  const postableDrafts = useMemo(
    () =>
      drafts.filter(
        (draft) =>
          draft.status === "active" &&
          pr?.changedFiles.some((file) => file.path === draft.path),
      ),
    [drafts, pr],
  );

  const postDraft = async (draft: ReviewDraft) => {
    if (!pr || !capabilities?.repository || !headMatches) return;
    const confirmed = window.confirm(
      `Post this review comment to GitHub PR #${pr.number}?\n\n${draft.path}:${draft.line} ${draft.side}\n\n${draft.body}`,
    );
    if (!confirmed) return;

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
            <Button disabled={loading} onClick={() => void refreshCapabilities()} size="sm" variant="ghost">
              <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
              Detect
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
                <label className="min-w-[420px] flex-1">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-600">
                    PR / issue reference
                  </span>
                  <input
                    aria-label="GitHub reference"
                    className="field mt-1 w-full"
                    placeholder="PR URL, issue URL, pr:7, issue:4, #7, or blank = current PR"
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
                Repository: <span className="mono text-slate-400">{capabilities.repository}</span>
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
              {headMatches ? "HEAD match" : "HEAD mismatch"}
            </Badge>
            <Badge tone="neutral">{pr.state}</Badge>
          </div>

          <div className="grid grid-cols-[0.75fr_1.25fr] gap-4 p-4">
            <div>
              <div className="grid grid-cols-4 gap-2">
                <Metric label="Files" value={String(pr.changedFiles.length)} />
                <Metric label="Checks" value={String(pr.checks.total)} />
                <Metric label="Pass" value={String(pr.checks.success)} tone="green" />
                <Metric label="Fail" value={String(pr.checks.failure)} tone={pr.checks.failure ? "red" : "neutral"} />
              </div>
              <div className="mt-3 space-y-1">
                {pr.checks.checks.slice(0, 8).map((check, index) => (
                  <div key={`${check.name}-${index}`} className="flex items-center gap-2 text-[10px]">
                    <CheckCircle2
                      size={11}
                      className={
                        check.conclusion === "SUCCESS" || check.status === "SUCCESS"
                          ? "text-emerald-300"
                          : check.conclusion === "FAILURE" || check.status === "FAILURE"
                            ? "text-rose-300"
                            : "text-amber-300"
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-slate-500">{check.name}</span>
                    <span className="mono text-slate-600">
                      {check.conclusion ?? check.status}
                    </span>
                  </div>
                ))}
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
                    draft.status === "active" && headMatches && fileInPr && postingId !== draft.id;
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
