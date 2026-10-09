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
    useAgentTimeline.setState({ entries: {}, activeTurns: {} });
    useAgentSessionStore.setState({ bindings: {} });
  });
  it("caps live events per workspace without persisting transcript", () => {
    for (let n = 0; n < 350; n++) useAgentTimeline.getState().append(event(n));
    const state = useAgentTimeline.getState();
    expect(state.entries["d:/workspace/a"]).toHaveLength(300);
    expect(state.entries["d:/workspace/a"]?.[0]?.timestampMs).toBe(50);
  });
  it("retains in-progress turn and session identity across tab switches", () => {
    useAgentTimeline.getState().append({ ...event(1), eventType: "agent.turn_started" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBe("t1");
    useAgentTimeline.getState().append({
      ...event(2), eventType: "agent.session_binding", payload: { binding: {
        workspaceRoot: "D:\\Workspace\\A", harness: "claude", threadId: "provider-session",
        createdAtMs: 1, updatedAtMs: 2,
      } },
    });
    expect(useAgentSessionStore.getState().bindings["d:/workspace/a"]?.threadId).toBe("provider-session");
    useAgentTimeline.getState().append({ ...event(3), eventType: "agent.turn_completed" });
    expect(useAgentTimeline.getState().activeTurns["d:/workspace/a"]).toBeUndefined();
  });
});

it("bounds oversized event payloads without losing completion identity", () => {
  useAgentTimeline.setState({ entries: {}, activeTurns: {} });
  useAgentTimeline.getState().append({ ...event(1), eventType: "agent.turn_started" });
  useAgentTimeline.getState().append({ ...event(2), eventType: "agent.turn_completed", payload: { delta: "中".repeat(40000) } });
  const state = useAgentTimeline.getState();
  expect(new TextEncoder().encode(JSON.stringify(state.entries["d:/workspace/a"]?.at(-1)?.payload)).byteLength).toBeLessThanOrEqual(16_384);
  expect(state.activeTurns["d:/workspace/a"]).toBeUndefined();
});
