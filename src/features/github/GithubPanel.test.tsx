import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubAdapter } from "@/lib/github";
import { reviewWorkspaceKey, useWorkbenchStore } from "@/stores/workbench";
import { GithubPanel } from "./GithubPanel";
import type { RepositorySnapshot } from "@/types/workbench";

vi.mock("@/lib/github", () => ({
  githubAdapter: {
    capabilities: vi.fn(),
    loadContext: vi.fn(),
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
    adapter.postReviewComment.mockReset();
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
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

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

});
