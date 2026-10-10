import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { WorkspaceHeader } from "./WorkspaceHeader";

describe("WorkspaceHeader", () => {
  it("runs refresh in native mode and disables it in preview", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const onFetch = vi.fn();
    const onPull = vi.fn();
    const { rerender } = render(
      <WorkspaceHeader snapshot={{ ...PREVIEW_SNAPSHOT, dirtyCount: 0, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, changes: [] }} isPreview={false} loading={false} gitBusy={false} onRefresh={onRefresh} onFetch={onFetch} onPull={onPull} />,
    );

    expect(document.querySelector("header > div")).toHaveClass("flex-wrap");
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /^fetch \+ prune$/i }));
    expect(onFetch).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /^pull$/i }));
    expect(onPull).toHaveBeenCalledTimes(1);

    rerender(
      <WorkspaceHeader snapshot={PREVIEW_SNAPSHOT} isPreview loading={false} gitBusy={false} onRefresh={onRefresh} onFetch={onFetch} onPull={onPull} />,
    );
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^fetch \+ prune$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^pull$/i })).toBeDisabled();
  });
  it("allows a safe Pull when only untracked files remain", async () => {
    const user = userEvent.setup();
    const onPull = vi.fn();
    const onlyUntracked = {
      ...PREVIEW_SNAPSHOT, dirtyCount: 1, stagedCount: 0, unstagedCount: 0, untrackedCount: 1,
      changes: [{ path: "hardware/.history/", indexStatus: "?", worktreeStatus: "?", kind: "untracked" as const }],
    };
    const view = render(<WorkspaceHeader snapshot={onlyUntracked} isPreview={false}
      loading={false} gitBusy={false} onRefresh={vi.fn()} onFetch={vi.fn()} onPull={onPull} />);
    expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Pull" }));
    expect(onPull).toHaveBeenCalledTimes(1);
    view.rerender(<WorkspaceHeader snapshot={{ ...onlyUntracked, stagedCount: 1 }} isPreview={false}
      loading={false} gitBusy={false} onRefresh={vi.fn()} onFetch={vi.fn()} onPull={onPull} />);
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
  });

});
