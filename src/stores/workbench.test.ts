import { beforeEach, describe, expect, it } from "vitest";
import { useWorkbenchStore } from "./workbench";

describe("workbench persisted store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkbenchStore.setState({
      repositories: [],
      activeRepositoryId: null,
      profiles: [],
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
});
