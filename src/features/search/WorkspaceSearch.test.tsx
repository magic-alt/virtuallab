import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSearch } from "./WorkspaceSearch";

describe("WorkspaceSearch", () => {
  it("emits search text and clear action", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<WorkspaceSearch value="" onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: /search repositories/i });

    await user.type(input, "servo");
    expect(onChange).toHaveBeenCalled();

    rerender(<WorkspaceSearch value="servo" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /clear search/i }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("focuses on Ctrl+K", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSearch value="" onChange={() => undefined} />);
    const input = screen.getByRole("textbox", { name: /search repositories/i });
    await user.keyboard("{Control>}k{/Control}");
    expect(input).toHaveFocus();
  });
});
