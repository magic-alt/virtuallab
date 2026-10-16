import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "./NotificationCenter";
import { useTaskNotifications } from "@/stores/taskNotifications";

vi.mock("@/lib/backend", () => ({ desktopNotify: vi.fn(), isDesktopRuntime: () => false }));
beforeEach(() => {
  useTaskNotifications.setState({ notices: [], desktopEnabled: true, desktopError: null });
});

describe("non-modal notification inbox", () => {
  it("counts unread entries, returns to the source, and allows silencing native toasts", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    useTaskNotifications.getState().add({
      id: "terminal:1", source: "terminal", terminalId: "one",
      workspaceRoot: "D:/repo/feature", title: "Codex task completed",
      detail: "Terminal 1 finished.", severity: "complete", createdAt: 1, read: false,
    });
    render(<NotificationCenter onNavigate={onNavigate} />);
    await user.click(screen.getByRole("button", { name: /Task notifications \(1 unread\)/ }));
    expect(screen.getByRole("dialog", { name: "Task notifications" })).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: /Desktop alerts: On/ }));
    expect(useTaskNotifications.getState().desktopEnabled).toBe(false);
    await user.click(screen.getByRole("button", { name: /Codex task completed/ }));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: "D:/repo/feature", terminalId: "one",
    }));
    expect(useTaskNotifications.getState().notices[0].read).toBe(true);
  });
});
