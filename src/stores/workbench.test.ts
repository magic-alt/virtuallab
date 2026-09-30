import { beforeEach, describe, expect, it } from "vitest";
import { useWorkbenchStore } from "./workbench";

describe("workbench persisted store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkbenchStore.setState({
      repositories: [],
      activeRepositoryId: null,
      profiles: [],
      workspaceStates: {},
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
    });

    useWorkbenchStore.getState().removeRepository("repo-1");
    expect(useWorkbenchStore.getState().workspaceStates["repo-1"]).toBeUndefined();
  });
});
