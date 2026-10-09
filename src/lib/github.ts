import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "@/lib/backend";
import type {
  GithubCapabilities,
  GithubContext,
  GithubPostReviewCommentRequest,
  GithubPostReviewCommentResponse,
  GithubPullRequest,
  GithubPullRequestList,
  GithubMergeRequest,
  GithubMergeResponse,
} from "@/types/workbench";

export interface GithubAdapter {
  capabilities(workspaceRoot: string): Promise<GithubCapabilities>;
  loadContext(workspaceRoot: string, reference?: string | null): Promise<GithubContext>;
  listPullRequests(workspaceRoot: string): Promise<GithubPullRequestList>;
  mergePullRequest(request: GithubMergeRequest): Promise<GithubMergeResponse>;
  postReviewComment(
    request: GithubPostReviewCommentRequest,
  ): Promise<GithubPostReviewCommentResponse>;
}

function requireDesktop() {
  if (!isDesktopRuntime()) {
    throw new Error("GitHub integration requires the Tauri desktop runtime.");
  }
}

export const githubAdapter: GithubAdapter = {
  async capabilities(workspaceRoot) {
    requireDesktop();
    return invoke<GithubCapabilities>("github_capabilities", { workspaceRoot });
  },

  async loadContext(workspaceRoot, reference) {
    requireDesktop();
    return invoke<GithubContext>("github_context", {
      request: {
        workspaceRoot,
        reference: reference?.trim() || null,
      },
    });
  },

  async listPullRequests(workspaceRoot) {
    requireDesktop();
    return invoke<GithubPullRequestList>("github_list_pull_requests", { workspaceRoot });
  },

  async mergePullRequest(request) {
    requireDesktop();
    return invoke<GithubMergeResponse>("github_merge_pull_request", { request });
  },

  async postReviewComment(request) {
    requireDesktop();
    return invoke<GithubPostReviewCommentResponse>("github_post_review_comment", {
      request,
    });
  },
};

/**
 * Fail closed: a missing/unknown check result is not proof of a green CI.
 * The native backend repeats all guards against the live PR before merging.
 */
export function getPrMergeBlockers(pr: GithubPullRequest): string[] {
  const reasons: string[] = [];
  if (pr.state !== "OPEN") reasons.push("PR is not open.");
  if (pr.isDraft) reasons.push("Draft PRs cannot be merged.");
  if (pr.checks.total === 0 || pr.checks.success === 0) {
    reasons.push("No successful CI checks have been reported.");
  }
  if (pr.checks.failure > 0) reasons.push(`${pr.checks.failure} CI check(s) failed.`);
  if (pr.checks.pending > 0) reasons.push(`${pr.checks.pending} CI check(s) are still pending.`);
  if (pr.mergeable !== "MERGEABLE") reasons.push("GitHub has not confirmed a conflict-free merge.");
  if (pr.mergeStateStatus !== "CLEAN") {
    reasons.push(`GitHub merge status is ${pr.mergeStateStatus ?? "unknown"}, not CLEAN.`);
  }
  if (pr.reviewDecision && pr.reviewDecision !== "APPROVED") {
    reasons.push(`Review decision: ${pr.reviewDecision}.`);
  }
  return reasons;
}

export function getPrCheckLabel(pr: GithubPullRequest): string {
  const { total, failure, pending, success } = pr.checks;
  if (!total) return "CI unknown";
  if (failure) return `${failure} failed`;
  if (pending) return `${pending} pending`;
  if (!success) return "CI unknown";
  return `${success}/${total} passed`;
}
