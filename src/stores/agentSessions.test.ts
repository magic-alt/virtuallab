import { beforeEach, describe, expect, it } from "vitest";
import { agentWorkspaceKey, useAgentSessionStore } from "./agentSessions";

describe("agent workspace bindings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAgentSessionStore.setState({ bindings: {} });
  });

  it("normalizes Windows workspace keys", () => {
    expect(agentWorkspaceKey("D:\\Project\\VirtualLab\\worktree\\")).toBe(
      "d:/project/virtuallab/worktree",
    );
  });

  it("persists exactly one Codex thread binding per workspace", () => {
    const workspaceRoot = "D:/Project/VirtualLab/worktree";
    useAgentSessionStore.getState().setBinding({
      workspaceRoot,
      harness: "codex",
      threadId: "thr-1",
      createdAtMs: 10,
      updatedAtMs: 10,
    });
    useAgentSessionStore.getState().setBinding({
      workspaceRoot,
      harness: "codex",
      threadId: "thr-2",
      createdAtMs: 20,
      updatedAtMs: 20,
    });

    const bindings = useAgentSessionStore.getState().bindings;
    expect(Object.keys(bindings)).toHaveLength(1);
    expect(bindings[agentWorkspaceKey(workspaceRoot)]?.threadId).toBe("thr-2");
    expect(window.localStorage.getItem("virtuallab-agent-sessions-v1")).toContain("thr-2");
  });

  it("clears bindings under a removed repository without touching other repositories", () => {
    const store = useAgentSessionStore.getState();
    store.setBinding({
      workspaceRoot: "D:/Project/VirtualLab",
      harness: "codex",
      threadId: "thr-root",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    store.setBinding({
      workspaceRoot: "D:/Project/VirtualLab/worktree-a",
      harness: "codex",
      threadId: "thr-a",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    store.setBinding({
      workspaceRoot: "D:/Project/other",
      harness: "codex",
      threadId: "thr-other",
      createdAtMs: 1,
      updatedAtMs: 1,
    });

    useAgentSessionStore.getState().clearRepositoryBindings("D:/Project/VirtualLab");
    const remaining = Object.values(useAgentSessionStore.getState().bindings);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.threadId).toBe("thr-other");
  });
});
