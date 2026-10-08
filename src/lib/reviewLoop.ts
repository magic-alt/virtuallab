import type { GithubPullRequest, ReviewWorkspaceRequest } from "@/types/workbench";

export type PrHeadRelation = "head" | "base" | "diverged" | "unknown";

/** Compare only proven hexadecimal Git OIDs; reject placeholders and short collisions. */
export function gitOidMatches(local: string, remote?: string | null): boolean {
  const a = local.trim().toLowerCase();
  const b = remote?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{7,40}$/.test(a) &&
    /^[a-f0-9]{7,40}$/.test(b) &&
    (a.startsWith(b) || b.startsWith(a));
}

export function correlatePrHead(localHead: string, pr: Pick<GithubPullRequest, "headSha" | "baseSha">): PrHeadRelation {
  if (gitOidMatches(localHead, pr.headSha)) return "head";
  if (gitOidMatches(localHead, pr.baseSha)) return "base";
  if (!/^[a-f0-9]{7,40}$/i.test(localHead) ||
      !/^[a-f0-9]{7,40}$/i.test(pr.headSha)) return "unknown";
  return "diverged";
}

export function suggestedReviewBranch(target: ReviewWorkspaceRequest): string {
  if (!Number.isSafeInteger(target.number) || target.number <= 0) throw new Error("Invalid review reference number.");
  return `review/${target.kind}-${target.number}`;
}

/** A review worktree starts from the selected *active* workspace, never a different primary worktree. */
export function selectedReviewBase(activeHead: string): string {
  const head=activeHead.trim();
  if (!/^[a-f0-9]{7,40}$/i.test(head)) throw new Error("A valid active-workspace HEAD is required.");
  return head;
}
