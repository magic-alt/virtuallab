import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { WorkspaceHeader } from "./WorkspaceHeader";

describe("WorkspaceHeader", () => {
  it("shows the configured upstream and supports repositories without origin", () => {
    render(<WorkspaceHeader snapshot={{ ...PREVIEW_SNAPSHOT, remoteUrl: null, upstream: "team/trunk", dirtyCount: 0, stagedCount: 0, unstagedCount: 0 }} isPreview={false} loading={false} gitBusy={false} onFetch={vi.fn()} onPull={vi.fn()} onOpenFolder={vi.fn()} editor="auto" onEditorChange={vi.fn()} onOpenEditor={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pull" })).toHaveAttribute("title", expect.stringContaining("team/trunk"));
  });
  it("runs Fetch and hides manual Refresh", async () => {
    const user = userEvent.setup();
    const onFetch = vi.fn();
    const onPull = vi.fn();
    const onOpenFolder = vi.fn();
    const { rerender } = render(
      <WorkspaceHeader snapshot={{ ...PREVIEW_SNAPSHOT, dirtyCount: 0, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, changes: [] }} isPreview={false} loading={false} gitBusy={false} onFetch={onFetch} onPull={onPull} onOpenFolder={onOpenFolder} editor="auto" onEditorChange={vi.fn()} onOpenEditor={vi.fn()} />,
    );

    expect(document.querySelector("header > div")).toHaveClass("flex-wrap");
    expect(screen.queryByRole("button", { name: /^refresh$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^fetch$/i }))
      .toHaveAttribute("title", "Fetch origin and prune deleted remote-tracking branches");
    await user.click(screen.getByRole("button", { name: /^fetch$/i }));
    expect(onFetch).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /^pull$/i }));
    expect(onPull).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /open folder/i }));
    expect(onOpenFolder).toHaveBeenCalledTimes(1);

    rerender(
      <WorkspaceHeader snapshot={PREVIEW_SNAPSHOT} isPreview loading={false} gitBusy={false} onFetch={onFetch} onPull={onPull} onOpenFolder={onOpenFolder} editor="auto" onEditorChange={vi.fn()} onOpenEditor={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /open folder/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^refresh$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^fetch$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^pull$/i })).toBeDisabled();
  });
  it("opens the exact selected workspace in the preferred IDE and updates the choice", async () => {
    const user = userEvent.setup();
    const onOpenEditor = vi.fn();
    const onEditorChange = vi.fn();
    const props = {
      snapshot: PREVIEW_SNAPSHOT, isPreview: false, loading: false, gitBusy: false,
      onFetch: vi.fn(), onPull: vi.fn(), onOpenFolder: vi.fn(),
      onOpenEditor, onEditorChange,
    };
    const { rerender } = render(<WorkspaceHeader {...props} editor="auto" />);
    await user.click(screen.getByRole("button", { name: "Open in IDE" }));
    expect(onOpenEditor).toHaveBeenCalledOnce();
    await user.selectOptions(screen.getByRole("combobox", { name: "Preferred editor" }), "zed");
    expect(onEditorChange).toHaveBeenCalledWith("zed");
    rerender(<WorkspaceHeader {...props} editor="zed" />);
    expect(screen.getByRole("button", { name: "Open in Zed" })).toBeEnabled();
    rerender(<WorkspaceHeader {...props} editor="zed" isPreview />);
    expect(screen.getByRole("button", { name: "Open in Zed" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Preferred editor" })).toBeDisabled();
  });

  it("allows a safe Pull when only untracked files remain", async () => {
    const user = userEvent.setup();
    const onPull = vi.fn();
    const onOpenFolder = vi.fn();
    const onlyUntracked = {
      ...PREVIEW_SNAPSHOT, dirtyCount: 1, stagedCount: 0, unstagedCount: 0, untrackedCount: 1,
      changes: [{ path: "hardware/.history/", indexStatus: "?", worktreeStatus: "?", kind: "untracked" as const }],
    };
    const view = render(<WorkspaceHeader snapshot={onlyUntracked} isPreview={false}
      loading={false} gitBusy={false} onFetch={vi.fn()} onPull={onPull} onOpenFolder={onOpenFolder} editor="auto" onEditorChange={vi.fn()} onOpenEditor={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Pull" }));
    expect(onPull).toHaveBeenCalledTimes(1);
    view.rerender(<WorkspaceHeader snapshot={{ ...onlyUntracked, stagedCount: 1 }} isPreview={false}
      loading={false} gitBusy={false} onFetch={vi.fn()} onPull={onPull} onOpenFolder={onOpenFolder} editor="auto" onEditorChange={vi.fn()} onOpenEditor={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
  });

});
