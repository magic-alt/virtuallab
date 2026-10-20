import { beforeEach, describe, expect, it, vi } from "vitest";
import { noticeForAgentEvent, publishTaskNotice, useTaskNotifications } from "./taskNotifications";

const notify = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/backend", () => ({ desktopNotify: notify, isDesktopRuntime: () => true }));

beforeEach(() => {
  notify.mockClear();
  useTaskNotifications.setState({ notices: [], desktopEnabled: true, desktopError: null });
});

describe("task notification inbox", () => {
  it("deduplicates a completed turn and never displays model output in OS notifications", async () => {
    const event = { eventType: "agent.notification", method: "turn/completed", workspaceRoot: "D:/repo",
      turnId: "turn-1", threadId: "thread-1", payload: { turn: { status: "completed" },
        lastAssistantMessage: "private secret" }, timestampMs: 4 };
    const notice = noticeForAgentEvent(event);
    expect(notice).toEqual(expect.objectContaining({ threadId: "thread-1", turnId: "turn-1" }));
    expect(publishTaskNotice(notice!, false)).toBe(true);
    expect(publishTaskNotice(notice!, false)).toBe(false);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(notify.mock.calls)).not.toContain("private secret");
    expect(useTaskNotifications.getState().notices).toHaveLength(1);
  });
  it("does not mistake process exits or output events for successful agent turns", () => {
    expect(noticeForAgentEvent({ eventType: "agent.process_exited", workspaceRoot: "p", timestampMs: 1 })).toBeNull();
    expect(noticeForAgentEvent({ eventType: "agent.notification", method: "item/completed",
      workspaceRoot: "p", timestampMs: 1 })).toBeNull();
  });
  it("keeps inbox notices visible without OS popup when target is in focus", () => {
    const n = noticeForAgentEvent({ eventType: "agent.turn_completed", workspaceRoot: "p",
      turnId: "a", payload: { status: "failed" }, timestampMs: 2 })!;
    publishTaskNotice(n, true);
    expect(notify).not.toHaveBeenCalled();
    expect(useTaskNotifications.getState().notices[0].severity).toBe("failed");
  });
});
