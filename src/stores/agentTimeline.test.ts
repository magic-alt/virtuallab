import { beforeEach, describe, expect, it } from "vitest";
import { useAgentTimeline } from "./agentTimeline";
import { useAgentSessionStore } from "./agentSessions";
import type { AgentEvent } from "@/types/agent";
const event = (n: number): AgentEvent => ({
  eventType: "agent.notification", workspaceRoot: "D:\\Workspace\\A",
  timestampMs: n, turnId: "t1", payload: { delta: String(n) },
});
describe("agent timeline", () => {
  beforeEach(() => {
    useAgentTimeline.setState(useAgentTimeline.getInitialState(), true);
    useAgentSessionStore.setState({ bindings: {} });
  });
  it("caps live events per workspace without persisting transcript", () => {
    for (let n = 0; n < 350; n++) useAgentTimeline.getState().append(event(n));
    const state = useAgentTimeline.getState();
    expect(state.entries["d:/workspace/a"]).toHaveLength(300);
    expect(state.entries["d:/workspace/a"]?.[0]?.timestampMs).toBe(50);
  });
  it("retains in-progress turn and session identity across tab switches", () => {
    useAgentSessionStore.getState().setBinding({
      workspaceRoot: "D:/Workspace/A", harness: "claude", threadId: "pending-session",
      createdAtMs: 1, updatedAtMs: 1,
    });
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.turn_started", threadId: "pending-session" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBe("t1");
    useAgentTimeline.getState().append({
      ...event(2), eventType: "agent.session_binding", threadId: "provider-session", payload: { binding: {
        workspaceRoot: "D:\\Workspace\\A", harness: "claude", threadId: "provider-session",
        createdAtMs: 1, updatedAtMs: 2,
      } },
    });
    expect(useAgentSessionStore.getState().bindings["d:/workspace/a"]?.threadId).toBe("provider-session");
    useAgentTimeline.getState().append({ ...event(3), eventType: "agent.turn_completed", threadId: "provider-session" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
  });

  it.each([false, true])("follows an explicit provider thread promotion when start delivery is delayed: %s", (delayedStart) => {
    const binding = {
      workspaceRoot: "D:/Workspace/A", harness: "claude" as const, threadId: "pending-session",
      createdAtMs: 1, updatedAtMs: 1,
    };
    useAgentSessionStore.getState().setBinding(binding);
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.session_started", threadId: binding.threadId, turnId: null });
    const start = { ...event(2), eventType: "agent.turn_started", threadId: binding.threadId };
    if (!delayedStart) useAgentTimeline.getState().append(start);
    useAgentTimeline.getState().append({
      ...event(3), eventType: "agent.session_binding", threadId: "provider-session",
      payload: { binding: { ...binding, threadId: "provider-session", updatedAtMs: 3 } },
    });
    if (delayedStart) useAgentTimeline.getState().append(start);
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBe("t1");
    expect(useAgentTimeline.getState().activeTurnThreads["d:/workspace/a"]).toBe("provider-session");
    useAgentTimeline.getState().append({ ...event(4), eventType: "agent.turn_completed", threadId: "provider-session" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
    useAgentTimeline.getState().setActiveTurn(binding.workspaceRoot, "t1", binding.threadId);
    useAgentTimeline.getState().append(start);
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
  });

  it("keeps a stopped CLI session stopped when its provider binding arrives late", () => {
    const binding = {
      workspaceRoot: "D:/Workspace/A", harness: "opencode" as const, threadId: "pending-session",
      createdAtMs: 1, updatedAtMs: 1,
    };
    useAgentSessionStore.getState().setBinding(binding);
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.session_stopped", threadId: binding.threadId, turnId: null });
    useAgentTimeline.getState().append({
      ...event(2), eventType: "agent.session_binding", threadId: "provider-session",
      payload: { binding: { ...binding, threadId: "provider-session", updatedAtMs: 2 } },
    });
    useAgentTimeline.getState().append({ ...event(3), eventType: "agent.turn_started", threadId: "provider-session" });
    useAgentTimeline.getState().setActiveTurn(binding.workspaceRoot, "t1", binding.threadId);
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
  });

  it.each(["agent.session_stopped", "agent.turn_completed"])("clears the provisional turn when provider %s arrives before its binding promotion", (eventType) => {
    const binding = {
      workspaceRoot: "D:/Workspace/A", harness: "claude" as const, threadId: "pending-session",
      createdAtMs: 1, updatedAtMs: 1,
    };
    useAgentSessionStore.getState().setBinding(binding);
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.session_started", threadId: binding.threadId, turnId: null });
    useAgentTimeline.getState().append({ ...event(2), eventType: "agent.turn_started", threadId: binding.threadId });
    useAgentTimeline.getState().append({
      ...event(3), eventType, threadId: "provider-session", turnId: eventType === "agent.session_stopped" ? null : "t1",
    });
    useAgentTimeline.getState().append({
      ...event(4), eventType: "agent.session_binding", threadId: "provider-session",
      payload: { binding: { ...binding, threadId: "provider-session", updatedAtMs: 4 } },
    });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
    useAgentTimeline.getState().setActiveTurn(binding.workspaceRoot, "t1", binding.threadId);
    useAgentTimeline.getState().append({ ...event(5), eventType: "agent.turn_started", threadId: "provider-session" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
  });

  it("does not apply an old provider binding to a replacement session", () => {
    const binding = {
      workspaceRoot: "D:/Workspace/A", harness: "claude" as const, threadId: "new-session",
      createdAtMs: 3, updatedAtMs: 3,
    };
    useAgentSessionStore.getState().setBinding(binding);
    useAgentTimeline.getState().append({ ...event(3), eventType: "agent.turn_started", threadId: binding.threadId });
    useAgentTimeline.getState().append({
      ...event(2), eventType: "agent.session_binding", threadId: "old-provider-session",
      payload: { binding: { ...binding, threadId: "old-provider-session", createdAtMs: 1, updatedAtMs: 2 } },
    });
    expect(useAgentSessionStore.getState().bindings["d:/workspace/a"]).toEqual(binding);
    expect(useAgentTimeline.getState().activeTurnThreads["d:/workspace/a"]).toBe(binding.threadId);
  });

  it("does not recreate a forgotten binding from buffered provider output", () => {
    const root = "D:/Workspace/A";
    const binding = { workspaceRoot: root, harness: "claude" as const, threadId: "pending-session", createdAtMs: 1, updatedAtMs: 1 };
    useAgentSessionStore.getState().setBinding(binding);
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.turn_started", threadId: binding.threadId });
    useAgentTimeline.getState().append({ ...event(2), eventType: "agent.session_stopped", threadId: binding.threadId, turnId: null });
    useAgentSessionStore.getState().clearBinding(root);
    useAgentTimeline.getState().setActiveTurn(root, null);
    useAgentTimeline.getState().append({
      ...event(3), eventType: "agent.session_binding", threadId: "provider-session",
      payload: { binding: { ...binding, threadId: "provider-session", updatedAtMs: 3 } },
    });
    expect(useAgentSessionStore.getState().bindings["d:/workspace/a"]).toBeUndefined();
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
  });

  it.each([
    { eventType: "agent.turn_completed", method: null },
    { eventType: "agent.notification", method: "turn/completed" },
  ])("keeps a completed turn inactive after delayed acknowledgements: $eventType $method", (completion) => {
    useAgentTimeline.getState().append({ ...event(1), ...completion, threadId: "thread-a" });
    useAgentTimeline.getState().append({ ...event(2), eventType: "agent.turn_started", threadId: "thread-a" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
    useAgentTimeline.getState().setActiveTurn("D:/Workspace/A", "t1", "thread-a");
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
  });

  it("does not clear a newer active turn when an earlier turn completes", () => {
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.turn_started", threadId: "thread-a", turnId: "old" });
    useAgentTimeline.getState().append({ ...event(2), eventType: "agent.turn_started", threadId: "thread-a", turnId: "new" });
    useAgentTimeline.getState().append({ ...event(3), workspaceRoot: "D:/Workspace/B", eventType: "agent.turn_started", threadId: "thread-b", turnId: "other" });
    useAgentTimeline.getState().append({ ...event(4), eventType: "agent.turn_completed", threadId: "thread-a", turnId: "old" });
    expect(useAgentTimeline.getState().activeTurns).toEqual({ "d:/workspace/a": "new", "d:/workspace/b": "other" });
  });

  it.each([
    { firstType: "agent.turn_started", firstMethod: null, delayedType: "agent.notification", delayedMethod: "turn/started" },
    { firstType: "agent.notification", firstMethod: "turn/started", delayedType: "agent.turn_started", delayedMethod: null },
  ])("preserves a newer turn when the old $delayedType start counterpart arrives late", (delivery) => {
    useAgentTimeline.getState().append({ ...event(1), eventType: delivery.firstType, method: delivery.firstMethod, threadId: "thread-a", turnId: "old" });
    useAgentTimeline.getState().append({ ...event(2), eventType: "agent.turn_started", threadId: "thread-a", turnId: "new" });
    useAgentTimeline.getState().append({ ...event(3), eventType: delivery.delayedType, method: delivery.delayedMethod, threadId: "thread-a", turnId: "old" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBe("new");
    useAgentTimeline.getState().append({ ...event(4), eventType: "agent.turn_completed", threadId: "thread-a", turnId: "old" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBe("new");
  });

  it("distinguishes identical turn IDs from different threads", () => {
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.turn_completed", threadId: "old-thread" });
    useAgentTimeline.getState().append({ ...event(2), eventType: "agent.turn_started", threadId: "new-thread" });
    useAgentTimeline.getState().append({ ...event(3), eventType: "agent.turn_completed", threadId: "old-thread" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBe("t1");
  });

  it("preserves a newer active turn when an earlier invoke acknowledgement arrives", () => {
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.turn_started", threadId: "thread-a", turnId: "new" });
    useAgentTimeline.getState().setActiveTurn("D:/Workspace/A", "old", "thread-a");
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBe("new");
  });

  it("bounds remembered terminal identities while retaining completion after transcript clearing", () => {
    for (let n = 0; n < 400; n++) {
      useAgentTimeline.getState().append({ ...event(n), eventType: "agent.turn_completed", threadId: "thread-a", turnId: `done-${n}` });
    }
    useAgentTimeline.getState().clear("D:/Workspace/A");
    useAgentTimeline.getState().setActiveTurn("D:/Workspace/A", "done-399", "thread-a");
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
    expect(useAgentTimeline.getState().terminalTurns["d:/workspace/a"].length).toBeLessThanOrEqual(300);
  });

  it.each(["agent.session_stopped", "agent.process_exited"])("blocks late starts when %s arrived before the turn was known", (eventType) => {
    useAgentTimeline.getState().append({ ...event(1), eventType, threadId: "thread-a", turnId: null });
    useAgentTimeline.getState().append({ ...event(2), eventType: "agent.turn_started", threadId: "thread-a" });
    useAgentTimeline.getState().setActiveTurn("D:/Workspace/A", "t1", "thread-a");
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
  });

  it("allows an explicit session resume while rejecting the previous session's pending acknowledgement", () => {
    const revision = useAgentTimeline.getState().sessionStates?.["d:/workspace/a"]?.revision ?? 0;
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.session_stopped", threadId: "thread-a", turnId: null });
    useAgentTimeline.getState().append({ ...event(2), eventType: "agent.session_started", threadId: "thread-a", turnId: null });
    useAgentTimeline.getState().setActiveTurn("D:/Workspace/A", "old", "thread-a", revision);
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
    const resumedRevision = useAgentTimeline.getState().sessionStates["d:/workspace/a"].revision;
    useAgentTimeline.getState().setActiveTurn("D:/Workspace/A", "new", "thread-a", resumedRevision);
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBe("new");
  });

  it.each(["agent.turn_completed", "agent.process_exited", "agent.session_stopped"])("does not let an identity-less %s clear a known thread", (eventType) => {
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.turn_started", threadId: "new-thread" });
    useAgentTimeline.getState().append({ ...event(2), eventType, threadId: null });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBe("t1");
  });

  it("clears the current crashed thread while preserving another workspace and a replacement thread", () => {
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.turn_started", threadId: "new-thread" });
    useAgentTimeline.getState().append({ ...event(2), eventType: "agent.turn_started", workspaceRoot: "D:/Workspace/B", threadId: "other-thread" });
    useAgentTimeline.getState().append({ ...event(3), eventType: "agent.process_exited", threadId: "old-thread", turnId: null });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBe("t1");
    useAgentTimeline.getState().append({ ...event(4), eventType: "agent.process_exited", threadId: "new-thread", turnId: null });
    expect(useAgentTimeline.getState().activeTurns).toEqual({ "d:/workspace/b": "t1" });
  });

  it("bounds stopped-thread memory independently of cleared transcript history", () => {
    for (let n = 0; n < 400; n++) {
      useAgentTimeline.getState().append({ ...event(n), eventType: "agent.session_stopped", threadId: `stopped-${n}`, turnId: null });
    }
    useAgentTimeline.getState().clear("D:/Workspace/A");
    useAgentTimeline.getState().append({ ...event(401), eventType: "agent.turn_started", threadId: "stopped-399" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
    expect(useAgentTimeline.getState().stoppedThreads["d:/workspace/a"].length).toBeLessThanOrEqual(300);
  });
});

it("bounds oversized event payloads without losing completion identity", () => {
  useAgentTimeline.setState(useAgentTimeline.getInitialState(), true);
  useAgentTimeline.getState().append({ ...event(1), eventType: "agent.turn_started" });
  useAgentTimeline.getState().append({ ...event(2), eventType: "agent.turn_completed", payload: { delta: "中".repeat(40000) } });
  const state = useAgentTimeline.getState();
  expect(new TextEncoder().encode(JSON.stringify(state.entries["d:/workspace/a"]?.at(-1)?.payload)).byteLength).toBeLessThanOrEqual(16_384);
  expect(state.activeTurns["d:/workspace/a"]).toBeUndefined();
});
