import { describe, expect, it } from "vitest";
import { latestCodexAnswer } from "./agentActivity";
import type { AgentEvent } from "@/types/agent";

function event(turnId: string, method: string, payload: unknown): AgentEvent {
  return { workspaceRoot: "/repo", eventType: "agent.notification", turnId,
    method, payload, timestampMs: 1 };
}
describe("latestCodexAnswer", () => {
  it("joins Codex deltas only for the most recent turn", () => {
    const events = [
      event("old", "item/agentMessage/delta", { delta: "old answer" }),
      event("new", "item/agentMessage/delta", { delta: "new " }),
      event("new", "item/agentMessage/delta", { delta: { text: "answer" } }),
    ];
    expect(latestCodexAnswer(events)).toBe("new answer");
  });
  it("prefers complete text when Codex also streams deltas", () => {
    expect(latestCodexAnswer([
      event("a", "item/agentMessage/delta", { delta: "Hello" }),
      event("a", "item/completed", { item: { type: "agentMessage", text: "Hello world!" } }),
    ])).toBe("Hello world!");
  });
  it("does not synthesize text from unrelated diagnostics", () => {
    expect(latestCodexAnswer([event("a", "turn/completed", { status: "ok" })])).toBe("");
    expect(latestCodexAnswer([event("a", "item/agentMessage/delta", { delta: "abcdefgh" })], 4)).toBe("efgh");
  });
});
