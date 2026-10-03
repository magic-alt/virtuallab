import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "./agentHarness";
import { WorkspaceAgentService } from "./workspaceAgent";
import { agentWorkspaceKey, useAgentSessionStore } from "@/stores/agentSessions";

function adapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    kind: "codex",
    capabilities: vi.fn(),
    startOrResumeSession: vi.fn(),
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    interruptTurn: vi.fn(),
    stopSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("WorkspaceAgentService", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAgentSessionStore.setState({ bindings: {} });
  });

  it("persists a new thread returned by the harness", async () => {
    const root = "D:/Project/virtuallab";
    const harness = adapter({
      startOrResumeSession: vi.fn().mockResolvedValue({
        workspaceRoot: root,
        harness: "codex",
        threadId: "thr-new",
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    });
    const service = new WorkspaceAgentService(harness);

    await expect(service.attach(root)).resolves.toEqual(
      expect.objectContaining({ threadId: "thr-new" }),
    );
    expect(harness.startOrResumeSession).toHaveBeenCalledWith({
      workspaceRoot: root,
      harness: "codex",
      threadId: null,
    });
    expect(
      useAgentSessionStore.getState().bindings[agentWorkspaceKey(root)]?.threadId,
    ).toBe("thr-new");
  });

  it("resumes the persisted thread instead of creating a second workspace thread", async () => {
    const root = "D:/Project/virtuallab";
    useAgentSessionStore.getState().setBinding({
      workspaceRoot: root,
      harness: "codex",
      threadId: "thr-saved",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const harness = adapter({
      startOrResumeSession: vi.fn().mockResolvedValue({
        workspaceRoot: root,
        harness: "codex",
        threadId: "thr-saved",
        createdAtMs: 1,
        updatedAtMs: 2,
      }),
    });

    await new WorkspaceAgentService(harness).attach(root);
    expect(harness.startOrResumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thr-saved" }),
    );
  });

  it("fails closed when the harness returns a different thread for a saved workspace", async () => {
    const root = "D:/Project/virtuallab";
    useAgentSessionStore.getState().setBinding({
      workspaceRoot: root,
      harness: "codex",
      threadId: "thr-saved",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const stopSession = vi.fn().mockResolvedValue(undefined);
    const harness = adapter({
      stopSession,
      startOrResumeSession: vi.fn().mockResolvedValue({
        workspaceRoot: root,
        harness: "codex",
        threadId: "thr-other",
        createdAtMs: 2,
        updatedAtMs: 2,
      }),
    });

    await expect(new WorkspaceAgentService(harness).attach(root)).rejects.toThrow(
      "different thread",
    );
    expect(stopSession).toHaveBeenCalledWith(root);
    expect(
      useAgentSessionStore.getState().bindings[agentWorkspaceKey(root)]?.threadId,
    ).toBe("thr-saved");
  });

  it("stops runtime without forgetting the durable binding", async () => {
    const root = "D:/Project/virtuallab";
    useAgentSessionStore.getState().setBinding({
      workspaceRoot: root,
      harness: "codex",
      threadId: "thr-saved",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const stopSession = vi.fn().mockResolvedValue(undefined);
    const service = new WorkspaceAgentService(adapter({ stopSession }));

    await service.stop(root);
    expect(stopSession).toHaveBeenCalledWith(root);
    expect(
      useAgentSessionStore.getState().bindings[agentWorkspaceKey(root)]?.threadId,
    ).toBe("thr-saved");

    service.forget(root);
    expect(useAgentSessionStore.getState().bindings[agentWorkspaceKey(root)]).toBeUndefined();
  });
});
