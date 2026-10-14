import type { AgentEvent } from "@/types/agent";

/**
 * Reconstruct the most recent Codex turn's user-facing answer from ephemeral
 * app-server message deltas. Never persist content or confuse different turns.
 * The caller's bounded event history means long answers may be partial.
 */
export function latestCodexAnswer(events: AgentEvent[], maxChars = 16000): string {
  let turnId: string | null = null;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].turnId) {
      turnId = events[index].turnId ?? null;
      break;
    }
  }
  if (!turnId) return "";

  let streamed = "";
  let completed = "";
  for (const event of events) {
    if (event.turnId !== turnId || event.eventType !== "agent.notification") continue;
    const payload = event.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object") continue;
    if (event.method === "item/agentMessage/delta") {
      const delta = payload.delta;
      const text = typeof delta === "string" ? delta
        : delta && typeof delta === "object" ? (delta as Record<string, unknown>).text : null;
      if (typeof text === "string") streamed += text;
    }
    if (event.method === "item/completed") {
      const item = payload.item as Record<string, unknown> | null | undefined;
      if (!item || item.type !== "agentMessage") continue;
      const content = item.content;
      const fullText = typeof item.text === "string" ? item.text :
        Array.isArray(content) ? content
          .filter((part) => part && typeof part.text === "string")
          .map((part) => part.text as string).join("") : "";
      if (fullText) completed = fullText;
    }
  }
  // Prefer a completed full-text event to streaming fragments when available.
  const answer = completed || streamed;
  return answer.length > maxChars ? answer.slice(-maxChars) : answer;
}
