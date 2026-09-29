import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";

describe("NewWorkspaceDialog", () => {
  it("validates and submits branch/base/target", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewWorkspaceDialog defaultBaseRef="main" onClose={onClose} onCreate={onCreate} />);

    const create = screen.getByRole("button", { name: /create workspace/i });
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText("Branch"), "feat/pixel-ui");
    await user.clear(screen.getByLabelText("Base ref"));
    await user.type(screen.getByLabelText("Base ref"), "origin/main");
    await user.type(screen.getByLabelText(/Target path/i), "D:/ws/pixel-ui");
    await user.click(create);

    expect(onCreate).toHaveBeenCalledWith("feat/pixel-ui", "origin/main", "D:/ws/pixel-ui");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("supports cancel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NewWorkspaceDialog defaultBaseRef="main" onClose={onClose} onCreate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
