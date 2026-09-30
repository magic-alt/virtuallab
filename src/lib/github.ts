import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "@/lib/backend";
import type {
  GithubCapabilities,
  GithubContext,
  GithubPostReviewCommentRequest,
  GithubPostReviewCommentResponse,
} from "@/types/workbench";

export interface GithubAdapter {
  capabilities(workspaceRoot: string): Promise<GithubCapabilities>;
  loadContext(workspaceRoot: string, reference?: string | null): Promise<GithubContext>;
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

  async postReviewComment(request) {
    requireDesktop();
    return invoke<GithubPostReviewCommentResponse>("github_post_review_comment", {
      request,
    });
  },
};
