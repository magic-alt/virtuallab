import { beforeEach, describe, expect, it } from "vitest";
import { reviewWorkspaceKey, useWorkbenchStore } from "./workbench";

describe("workbench persisted store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkbenchStore.setState({
      repositories: [],
      activeRepositoryId: null,
      profiles: [],
      workspaceStates: {},
      reviewStates: {},
    });
  });

  it("persists profile mutations to jsdom window.localStorage", () => {
    useWorkbenchStore.getState().addProfile({
      id: "profile-1",
      name: "Fixture",
      kind: "build",
      repositoryRoot: "D:/Work/sample-alpha",
      program: "echo",
      args: ["ok"],
    });

    const raw = window.localStorage.getItem("virtuallab-workbench-v2");
    expect(raw).toContain("profile-1");
    expect(raw).toContain("Fixture");
  });

  it("persists repository selection", () => {
    useWorkbenchStore.getState().addRepository({
      id: "repo-1",
      name: "sample-alpha",
      path: "D:/Work/sample-alpha",
      lastOpenedAt: 1,
    });

    expect(useWorkbenchStore.getState().activeRepositoryId).toBe("repo-1");
    const raw = window.localStorage.getItem("virtuallab-workbench-v2");
    expect(raw).toContain("repo-1");
  });

  it("keeps POSIX case-distinct repositories but deduplicates Windows spelling variants", () => {
    const store = useWorkbenchStore.getState();
    store.addRepository({ id: "unix-A", name: "A", path: "/tmp/Servo", lastOpenedAt: 1 });
    store.addRepository({ id: "unix-b", name: "b", path: "/tmp/servo", lastOpenedAt: 2 });
    store.addRepository({ id: "windows-A", name: "Windows", path: "D:\\Projects\\Servo", lastOpenedAt: 3 });
    store.addRepository({ id: "windows-reopened", name: "Windows copy", path: "d:/projects/servo/", lastOpenedAt: 4 });
    expect(useWorkbenchStore.getState().repositories).toHaveLength(3);
    expect(useWorkbenchStore.getState().activeRepositoryId).toBe("windows-A");
  });

  it("persists the active worktree and tab per repository", () => {
    useWorkbenchStore.getState().saveWorkspaceState({
      repositoryId: "repo-1",
      activeWorktreePath: "D:/Work/.virtuallab-workspaces/sample-alpha/review",
      activeTab: "changes",
      updatedAt: 123,
    });

    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]).toEqual(
      expect.objectContaining({
        activeWorktreePath: "D:/Work/.virtuallab-workspaces/sample-alpha/review",
        activeTab: "changes",
      }),
    );

    const raw = window.localStorage.getItem("virtuallab-workbench-v2");
    expect(raw).toContain("activeWorktreePath");
    expect(raw).toContain("changes");
  });

  it.each(["guide", "checks", "history"])("migrates the retired %s workspace tab without losing its worktree", async (activeTab) => {
    window.localStorage.setItem("virtuallab-workbench-v2", JSON.stringify({
      state: {
        repositories: [{ id: "repo-1", name: "example", path: "D:/Work/example", lastOpenedAt: 1 }],
        activeRepositoryId: "repo-1",
        profiles: [],
        workspaceStates: {
          "repo-1": {
            repositoryId: "repo-1",
            activeWorktreePath: "D:/Work/example/.worktrees/feature",
            activeTab,
            updatedAt: 123,
          },
        },
        reviewStates: {},
      },
      version: 6,
    }));

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]).toEqual({
      repositoryId: "repo-1",
      activeWorktreePath: "D:/Work/example/.worktrees/feature",
      activeTab: "overview",
      updatedAt: 123,
    });
    const saved = JSON.parse(window.localStorage.getItem("virtuallab-workbench-v2")!);
    expect(saved.state.workspaceStates["repo-1"].activeTab).toBe("overview");
  });

  it("does not merge case-distinct Unix review draft workspaces", () => {
    const store = useWorkbenchStore.getState();
    for (const root of ["/tmp/Servo", "/tmp/servo"]) {
      store.addReviewDraft({
        id: root, workspaceRoot: root, headSha: "abc123", path: "source.cpp",
        line: 1, side: "RIGHT", body: root, status: "active",
        createdAt: 1, updatedAt: 1,
      });
    }
    expect(Object.keys(useWorkbenchStore.getState().reviewStates)).toHaveLength(2);
  });

  it("persists review drafts per workspace and marks old HEAD drafts stale", () => {
    const workspaceRoot = "D:/Work/.virtuallab-workspaces/sample-alpha/review";
    useWorkbenchStore.getState().addReviewDraft({
      id: "draft-1",
      workspaceRoot,
      headSha: "abc123",
      path: "src/a.ts",
      line: 12,
      side: "RIGHT",
      body: "Check this guard.",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });

    const key = reviewWorkspaceKey(workspaceRoot);
    expect(useWorkbenchStore.getState().reviewStates[key]?.drafts[0]).toEqual(
      expect.objectContaining({ id: "draft-1", status: "active" }),
    );
    expect(window.localStorage.getItem("virtuallab-workbench-v2")).toContain("Check this guard.");

    useWorkbenchStore.getState().markReviewDraftsStale(workspaceRoot, "def456");
    expect(useWorkbenchStore.getState().reviewStates[key]?.drafts[0].status).toBe("stale");
  });

  it("leaves review state unchanged when a post result arrives after its draft was removed", () => {
    const root = "D:/Work/sample-alpha";
    useWorkbenchStore.getState().addReviewDraft({
      id: "removed-draft", workspaceRoot: root, headSha: "abc123", path: "src/a.ts",
      line: 1, side: "RIGHT", body: "Review this guard.", status: "active", createdAt: 1, updatedAt: 1,
    });
    useWorkbenchStore.getState().removeReviewDraft(root, "removed-draft");
    const reviews = useWorkbenchStore.getState().reviewStates;
    useWorkbenchStore.getState().markReviewDraftPosted(root, "removed-draft", "https://github.com/example-org/sample-repo/pull/7#discussion_r99");
    expect(useWorkbenchStore.getState().reviewStates).toBe(reviews);
  });

  it("persists the GitHub reference with the workspace review state", () => {
    const workspaceRoot = "D:/Work/sample-alpha";
    useWorkbenchStore
      .getState()
      .setGithubReference(workspaceRoot, "https://github.com/example-org/sample-repo/pull/7");
    expect(
      useWorkbenchStore.getState().reviewStates[reviewWorkspaceKey(workspaceRoot)]
        ?.githubReference,
    ).toContain("/pull/7");
  });

  it("removes persisted workspace state with its repository", () => {
    useWorkbenchStore.setState({
      repositories: [
        {
          id: "repo-1",
          name: "sample-alpha",
          path: "D:/Work/sample-alpha",
          lastOpenedAt: 1,
        },
      ],
      activeRepositoryId: "repo-1",
      workspaceStates: {
        "repo-1": {
          repositoryId: "repo-1",
          activeWorktreePath: "D:/Work/sample-alpha",
          activeTab: "overview",
          updatedAt: 1,
        },
      },
      reviewStates: {
        [reviewWorkspaceKey("D:/Work/sample-alpha")]: {
          workspaceRoot: "D:/Work/sample-alpha",
          drafts: [],
          githubReference: "pr:7",
          updatedAt: 1,
        },
      },
    });

    useWorkbenchStore.getState().removeRepository("repo-1");
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]).toBeUndefined();
    expect(Object.keys(useWorkbenchStore.getState().reviewStates)).toHaveLength(0);
  });
  it("persists review phase and invalidates a reviewed HEAD on commit change", () => {
    const path="D:/Work/sample-alpha";
    const key=reviewWorkspaceKey(path);
    useWorkbenchStore.getState().setReviewPhase(path,"fix");
    expect(useWorkbenchStore.getState().reviewStates[key]?.phase).toBe("fix");
    useWorkbenchStore.getState().setReviewPhase(path,"needs_rereview");
    expect(useWorkbenchStore.getState().reviewStates[key]?.lastRefreshAt).toEqual(expect.any(Number));
    useWorkbenchStore.getState().setReviewPhase(path,"reviewed","abcdef1");
    expect(useWorkbenchStore.getState().reviewStates[key]?.lastReviewedHead).toBe("abcdef1");
    useWorkbenchStore.getState().markReviewDraftsStale(path,"abcdef2");
    expect(useWorkbenchStore.getState().reviewStates[key]?.phase).toBe("needs_rereview");
    expect(window.localStorage.getItem("virtuallab-workbench-v2")).toContain("needs_rereview");
  });

});
