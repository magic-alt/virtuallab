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
      repositoryRoot: "D:/Project/virtuallab",
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
      name: "virtuallab",
      path: "D:/Project/virtuallab",
      lastOpenedAt: 1,
    });

    expect(useWorkbenchStore.getState().activeRepositoryId).toBe("repo-1");
    const raw = window.localStorage.getItem("virtuallab-workbench-v2");
    expect(raw).toContain("repo-1");
  });

  it("persists the active worktree and tab per repository", () => {
    useWorkbenchStore.getState().saveWorkspaceState({
      repositoryId: "repo-1",
      activeWorktreePath: "D:/Project/.virtuallab-workspaces/virtuallab/review",
      activeTab: "changes",
      updatedAt: 123,
    });

    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]).toEqual(
      expect.objectContaining({
        activeWorktreePath: "D:/Project/.virtuallab-workspaces/virtuallab/review",
        activeTab: "changes",
      }),
    );

    const raw = window.localStorage.getItem("virtuallab-workbench-v2");
    expect(raw).toContain("activeWorktreePath");
    expect(raw).toContain("changes");
  });

  it("persists review drafts per workspace and marks old HEAD drafts stale", () => {
    const workspaceRoot = "D:/Project/.virtuallab-workspaces/virtuallab/review";
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

  it("persists the GitHub reference with the workspace review state", () => {
    const workspaceRoot = "D:/Project/virtuallab";
    useWorkbenchStore
      .getState()
      .setGithubReference(workspaceRoot, "https://github.com/magic-alt/virtuallab/pull/7");
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
          name: "virtuallab",
          path: "D:/Project/virtuallab",
          lastOpenedAt: 1,
        },
      ],
      activeRepositoryId: "repo-1",
      workspaceStates: {
        "repo-1": {
          repositoryId: "repo-1",
          activeWorktreePath: "D:/Project/virtuallab",
          activeTab: "overview",
          updatedAt: 1,
        },
      },
      reviewStates: {
        [reviewWorkspaceKey("D:/Project/virtuallab")]: {
          workspaceRoot: "D:/Project/virtuallab",
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
});
