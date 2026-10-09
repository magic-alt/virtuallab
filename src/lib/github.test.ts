import { describe, expect, it } from "vitest";
import { getPrCheckLabel, getPrMergeBlockers } from "./github";
import type { GithubPullRequest } from "@/types/workbench";

const ready: GithubPullRequest = {
  number: 3,
  title: "Integration",
  url: "https://github.com/example/repo/pull/3",
  state: "OPEN",
  baseRef: "main",
  headRef: "feature",
  headSha: "f".repeat(40),
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  changedFiles: [],
  checks: {
    total: 2,
    success: 1,
    pending: 0,
    failure: 0,
    neutral: 1,
    checks: [
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "optional", status: "COMPLETED", conclusion: "SKIPPED" },
    ],
  },
};

describe("GitHub merge readiness", () => {
  it("requires a clean GitHub merge status and at least one successful check", () => {
    expect(getPrMergeBlockers(ready)).toEqual([]);
    expect(getPrCheckLabel(ready)).toBe("1/2 passed");
    expect(getPrMergeBlockers({ ...ready, mergeable: null })).toContain(
      "GitHub has not confirmed a conflict-free merge.",
    );
    expect(getPrMergeBlockers({ ...ready, mergeStateStatus: "BLOCKED" })).toContain(
      "GitHub merge status is BLOCKED, not CLEAN.",
    );
    expect(getPrMergeBlockers({
      ...ready,
      checks: { total: 0, success: 0, failure: 0, pending: 0, neutral: 0, checks: [] },
    })).toContain("No successful CI checks have been reported.");
  });

  it("blocks failing, pending, draft and unapproved PRs", () => {
    expect(getPrMergeBlockers({ ...ready, checks: { ...ready.checks, failure: 1 } }))
      .toContain("1 CI check(s) failed.");
    expect(getPrMergeBlockers({ ...ready, checks: { ...ready.checks, pending: 1 } }))
      .toContain("1 CI check(s) are still pending.");
    expect(getPrMergeBlockers({ ...ready, isDraft: true }))
      .toContain("Draft PRs cannot be merged.");
    expect(getPrMergeBlockers({ ...ready, reviewDecision: "CHANGES_REQUESTED" }))
      .toContain("Review decision: CHANGES_REQUESTED.");
  });
});
