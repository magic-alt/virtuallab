import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as backend from "@/lib/backend";
import { githubAdapter } from "@/lib/github";
import { reviewWorkspaceKey, useWorkbenchStore } from "@/stores/workbench";
import { GithubPanel } from "./GithubPanel";
import type { GithubPullRequest, RepositorySnapshot } from "@/types/workbench";

vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  githubAdapter: {
    capabilities: vi.fn(),
    loadContext: vi.fn(),
    listPullRequests: vi.fn(),
    mergePullRequest: vi.fn(),
    postReviewComment: vi.fn(),
  },
}));

const adapter = vi.mocked(githubAdapter);

const snapshot: RepositorySnapshot = {
  root: "D:/repo",
  name: "repo",
  currentBranch: "feat/review",
  headSha: "abcdef1234",
  remoteUrl: "https://github.com/example-org/sample-repo.git",
  dirtyCount: 0,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  changes: [],
  worktrees: [],
  branches: [{ name: "feat/review", local: true, remote: false, worktreePath: "D:/repo" }],
  recentCommits: [],
};

const connected = {
  installed: true,
  authenticated: true,
  repository: "example-org/sample-repo",
  mode: "connected" as const,
  detail: "connected",
};

describe("GithubPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkbenchStore.setState({ reviewStates: {} });
    adapter.capabilities.mockReset();
    adapter.loadContext.mockReset();
    adapter.listPullRequests.mockReset();
    adapter.mergePullRequest.mockReset();
    adapter.postReviewComment.mockReset();
    adapter.capabilities.mockResolvedValue(connected);
    adapter.listPullRequests.mockImplementation(async () => ({
      capabilities: await adapter.capabilities("D:/repo"),
      pullRequests: [],
    }));
  });

  it("keeps a graceful local-only mode when gh is unavailable", async () => {
    adapter.capabilities.mockResolvedValue({
      installed: false,
      authenticated: false,
      repository: "example-org/sample-repo",
      mode: "local_only",
      detail: "GitHub CLI is unavailable",
    });
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled />);
    expect(await screen.findByText("Local review mode")).toBeInTheDocument();
    expect(screen.getByText(/GitHub CLI is unavailable/)).toBeInTheDocument();
  });

  it("loads PR metadata, changed files and check summary", async () => {
    adapter.capabilities.mockResolvedValue(connected);
    adapter.loadContext.mockResolvedValue({
      capabilities: connected,
      reference: "pr:7",
      pullRequest: {
        number: 7,
        title: "Review lane",
        state: "OPEN",
        url: "https://github.com/example-org/sample-repo/pull/7",
        baseRef: "main",
        headRef: "feat/review",
        headSha: "abcdef1234567890",
        isDraft: false,
        author: "example-user",
        changedFiles: [{ path: "src/a.ts", additions: 4, deletions: 2 }],
        checks: {
          total: 1,
          success: 1,
          pending: 0,
          failure: 0,
          neutral: 0,
          checks: [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS", url: null }],
        },
      },
      issue: null,
    });

    const user = userEvent.setup();
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled />);
    await screen.findByText("connected");
    await user.type(screen.getByRole("textbox", { name: "GitHub reference" }), "pr:7");
    await user.click(screen.getByRole("button", { name: "Load" }));

    expect(await screen.findByText(/#7 Review lane/)).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("HEAD match")).toBeInTheDocument();
    expect(
      useWorkbenchStore.getState().reviewStates[reviewWorkspaceKey("D:/repo")]
        ?.githubReference,
    ).toContain("/pull/7");
  });

  it("posts a draft only after an explicit confirmation", async () => {
    adapter.capabilities.mockResolvedValue(connected);
    adapter.loadContext.mockResolvedValue({
      capabilities: connected,
      reference: "pr:7",
      pullRequest: {
        number: 7,
        title: "Review lane",
        state: "OPEN",
        url: "https://github.com/example-org/sample-repo/pull/7",
        baseRef: "main",
        headRef: "feat/review",
        headSha: "abcdef1234567890",
        isDraft: false,
        author: "example-user",
        changedFiles: [{ path: "src/a.ts", additions: 4, deletions: 2 }],
        checks: { total: 0, success: 0, pending: 0, failure: 0, neutral: 0, checks: [] },
      },
      issue: null,
    });
    adapter.postReviewComment.mockResolvedValue({
      id: 99,
      url: "https://github.com/example-org/sample-repo/pull/7#discussion_r99",
    });
    useWorkbenchStore.getState().addReviewDraft({
      id: "draft-1",
      workspaceRoot: "D:/repo",
      headSha: "abcdef1234",
      path: "src/a.ts",
      line: 12,
      side: "RIGHT",
      body: "Please verify this guard.",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    const confirmSpy = vi.spyOn(backend, "confirmNativeAction").mockResolvedValue(true);

    const user = userEvent.setup();
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled />);
    await screen.findByText("connected");
    await user.type(screen.getByRole("textbox", { name: "GitHub reference" }), "pr:7");
    await user.click(screen.getByRole("button", { name: "Load" }));
    await screen.findByText(/#7 Review lane/);
    await user.click(screen.getByRole("button", { name: "Post" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(adapter.postReviewComment).toHaveBeenCalledTimes(1));
    expect(
      useWorkbenchStore.getState().reviewStates[reviewWorkspaceKey("D:/repo")]
        ?.drafts[0].status,
    ).toBe("posted");
    confirmSpy.mockRestore();
  });
  it("offers an explicit issue-to-worktree action without a Git mutation", async () => {
    adapter.capabilities.mockResolvedValue(connected);
    adapter.loadContext.mockResolvedValue({
      capabilities: connected,
      reference: "issue:42",
      pullRequest: null,
      issue: { number:42, title:"Review issue", state:"OPEN",
        url:"https://github.com/example-org/sample-repo/issues/42",
        author:"example-user", labels:[] },
    });
    const onNewReviewWorkspace=vi.fn();
    const user=userEvent.setup();
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled
      onNewReviewWorkspace={onNewReviewWorkspace} />);
    await screen.findByText("connected");
    await user.type(screen.getByRole("textbox",{name:"GitHub reference"}),"issue:42");
    await user.click(screen.getByRole("button",{name:"Load"}));
    await user.click(await screen.findByRole("button",{name:"New issue worktree"}));
    expect(onNewReviewWorkspace).toHaveBeenCalledWith({
      kind:"issue",number:42,reference:"https://github.com/example-org/sample-repo/issues/42",
    });
  });

  it("differentiates PR base from head, and blocks posting at base",async()=>{
    adapter.capabilities.mockResolvedValue(connected);
    adapter.loadContext.mockResolvedValue({
      capabilities:connected,reference:"pr:7",issue:null,
      pullRequest:{ number:7,title:"Review",state:"OPEN",
        url:"https://github.com/example-org/sample-repo/pull/7",
        baseRef:"main",headRef:"feat/review",
        headSha:"fedcba9876543210",baseSha:"abcdef1234567890",
        isDraft:false,changedFiles:[{path:"src/a.ts",additions:2,deletions:1}],
        checks:{total:0,success:0,pending:0,failure:0,neutral:0,checks:[]}},
    });
    useWorkbenchStore.getState().addReviewDraft({
      id:"draft-base",workspaceRoot:"D:/repo",headSha:snapshot.headSha,path:"src/a.ts",
      line:1,side:"RIGHT",body:"Review",status:"active",createdAt:1,updatedAt:1,
    });
    const user=userEvent.setup();
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled />);
    await screen.findByText("connected");
    await user.type(screen.getByRole("textbox",{name:"GitHub reference"}),"pr:7");
    await user.click(screen.getByRole("button",{name:"Load"}));
    expect(await screen.findByText("At PR base")).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Post"})).toBeDisabled();
  });

  it("restores persisted issue metadata after switching back to a workspace",async()=>{
    const url="https://github.com/example-org/sample-repo/issues/9";
    useWorkbenchStore.getState().setGithubReference("D:/repo",url);
    adapter.capabilities.mockResolvedValue(connected);
    adapter.loadContext.mockResolvedValue({
      capabilities:connected,reference:url,pullRequest:null,
      issue:{number:9,title:"Restored",state:"OPEN",url,labels:[]},
    });
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled />);
    expect(await screen.findByText(/#9 Restored/)).toBeInTheDocument();
    expect(adapter.loadContext).toHaveBeenCalledWith("D:/repo",url);
  });


  const readyPr: GithubPullRequest = {
    number: 77,
    title: "Make PR dashboard",
    state: "OPEN",
    url: "https://github.com/example-org/sample-repo/pull/77",
    baseRef: "main",
    headRef: "feature/dashboard",
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    author: "example-user",
    changedFiles: [{ path: "src/feature.ts", additions: 8, deletions: 1 }],
    checks: {
      total: 2, success: 2, pending: 0, failure: 0, neutral: 0,
      checks: [
        { name: "build", status: "COMPLETED", conclusion: "SUCCESS", url: "https://github.com/example-org/sample-repo/actions/runs/1" },
        { name: "tests", status: "COMPLETED", conclusion: "SUCCESS", url: "https://github.com/example-org/sample-repo/actions/runs/2" },
      ],
    },
  };

  it("lists PRs independent of the local branch and displays every CI check", async () => {
    adapter.listPullRequests.mockResolvedValue({ capabilities: connected, pullRequests: [readyPr] });
    adapter.loadContext.mockResolvedValue({
      capabilities: connected, reference: "pr:77", pullRequest: readyPr, issue: null,
    });
    const user = userEvent.setup();
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled />);
    await user.click(await screen.findByRole("button", { name: "Open PR #77" }));
    expect(await screen.findByText(/#77 Make PR dashboard/)).toBeInTheDocument();
    expect(screen.getByText("build")).toHaveAttribute("href", "https://github.com/example-org/sample-repo/actions/runs/1");
    expect(screen.getByText("tests")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge PR" })).toBeEnabled();
  });

  it("blocks merge when CI fails or is pending, or GitHub status is unknown", async () => {
    const failingPr = {
      ...readyPr,
      checks: {
        ...readyPr.checks,
        success: 1,
        failure: 1,
        pending: 0,
        checks: [
          { name: "unit", status: "COMPLETED", conclusion: "SUCCESS", url: null },
          { name: "windows build", status: "COMPLETED", conclusion: "FAILURE", url: null },
        ],
      },
    };
    adapter.listPullRequests.mockResolvedValue({ capabilities: connected, pullRequests: [failingPr] });
    adapter.loadContext.mockResolvedValue({
      capabilities: connected, reference: "pr:77", pullRequest: failingPr, issue: null,
    });
    const user = userEvent.setup();
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled />);
    await user.click(await screen.findByRole("button", { name: "Open PR #77" }));
    expect(await screen.findByText("windows build")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge PR" })).toBeDisabled();
    expect(screen.getByText(/1 CI check\(s\) failed\./)).toBeInTheDocument();
    expect(adapter.mergePullRequest).not.toHaveBeenCalled();
  });

  it("merges only with explicit user approval, passing the exact inspected HEAD", async () => {
    adapter.listPullRequests.mockResolvedValueOnce({ capabilities: connected, pullRequests: [readyPr] })
      .mockResolvedValueOnce({ capabilities: connected, pullRequests: [] });
    adapter.loadContext.mockResolvedValueOnce({
      capabilities: connected, reference: "pr:77", pullRequest: readyPr, issue: null,
    }).mockResolvedValueOnce({
      capabilities: connected, reference: "pr:77", pullRequest: { ...readyPr, state: "MERGED" }, issue: null,
    });
    adapter.mergePullRequest.mockResolvedValue({ merged: true, sha: "c".repeat(40) });
    const confirmSpy = vi.spyOn(backend, "confirmNativeAction").mockResolvedValue(true);
    const user = userEvent.setup();
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled />);
    await user.click(await screen.findByRole("button", { name: "Open PR #77" }));
    await screen.findByText(/#77 Make PR dashboard/);
    await user.click(screen.getByRole("button", { name: "Merge PR" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(adapter.mergePullRequest).toHaveBeenCalledWith({
      workspaceRoot: "D:/repo",
      repository: "example-org/sample-repo",
      prNumber: 77,
      expectedHeadSha: readyPr.headSha,
      mergeMethod: "squash",
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("PR #77 merged");
    expect(screen.getByRole("button", { name: "Merge PR" })).toBeDisabled();
    confirmSpy.mockRestore();
  });

  it("does not merge after a cancelled confirmation", async () => {
    adapter.listPullRequests.mockResolvedValue({ capabilities: connected, pullRequests: [readyPr] });
    adapter.loadContext.mockResolvedValue({
      capabilities: connected, reference: "pr:77", pullRequest: readyPr, issue: null,
    });
    const confirmSpy = vi.spyOn(backend, "confirmNativeAction").mockResolvedValue(false);
    const user = userEvent.setup();
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled />);
    await user.click(await screen.findByRole("button", { name: "Open PR #77" }));
    await user.click(await screen.findByRole("button", { name: "Merge PR" }));
    expect(adapter.mergePullRequest).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does not post a draft invalidated while native confirmation is open", async () => {
    adapter.listPullRequests.mockResolvedValue({ capabilities: connected, pullRequests: [] });
    adapter.loadContext.mockResolvedValue({ capabilities: connected, reference: "pr:77", issue: null,
      pullRequest: { ...readyPr, headSha: snapshot.headSha + "567890", changedFiles: [{ path: "src/a.ts", additions: 1, deletions: 0 }] } });
    useWorkbenchStore.getState().addReviewDraft({ id: "stale-dialog", workspaceRoot: "D:/repo",
      headSha: snapshot.headSha, path: "src/a.ts", line: 1, side: "RIGHT", body: "Guard this", status: "active", createdAt: 1, updatedAt: 1 });
    let decide!: (approved: boolean) => void;
    vi.spyOn(backend, "confirmNativeAction").mockImplementation(() => new Promise<boolean>((resolve) => { decide = resolve; }));
    const user = userEvent.setup();
    render(<GithubPanel snapshot={snapshot} workspaceRoot="D:/repo" enabled />);
    await screen.findByText("connected");
    await user.type(screen.getByRole("textbox", { name: "GitHub reference" }), "pr:77");
    await user.click(screen.getByRole("button", { name: "Load" }));
    await user.click(await screen.findByRole("button", { name: "Post" }));
    act(() => useWorkbenchStore.getState().markReviewDraftsStale("D:/repo", "different-head"));
    await act(async () => decide(true));
    expect(adapter.postReviewComment).not.toHaveBeenCalled();
  });

});
