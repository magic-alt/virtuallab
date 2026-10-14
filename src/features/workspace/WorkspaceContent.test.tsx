import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const terminalLifecycle = vi.hoisted(() => ({ mounts: vi.fn(), unmounts: vi.fn() }));
const githubLifecycle = vi.hoisted(() => ({ mounts: vi.fn(), unmounts: vi.fn() }));
vi.mock("@/features/terminal/TerminalWorkspace", () => ({
  TerminalWorkspace: ({ cwd, visible }: { cwd: string; visible: boolean }) => {
    useEffect(() => {
      terminalLifecycle.mounts();
      return () => terminalLifecycle.unmounts();
    }, []);
    return <div data-testid="terminal-mock" data-cwd={cwd} data-visible={String(visible)} />;
  },
}));
vi.mock("@/features/execution/ProcessRunner", () => ({
  ProcessRunner: () => <div data-testid="runner-mock" />,
}));
vi.mock("@/features/github/GithubPanel", () => ({
  GithubPanel: ({ workspaceRoot }: { workspaceRoot: string }) => {
    useEffect(() => {
      githubLifecycle.mounts(workspaceRoot);
      return () => githubLifecycle.unmounts(workspaceRoot);
    }, []);
    return <div data-testid="github-mock" data-root={workspaceRoot} />;
  },
}));
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { WorkspaceContent } from "./WorkspaceContent";

describe("WorkspaceContent navigation", () => {
  it("keeps the GitHub tab mounted across navigation but isolates different workspaces", () => {
    githubLifecycle.mounts.mockClear();
    githubLifecycle.unmounts.mockClear();
    const props = { profileRepositoryRoot: "D:/repo", isPreview: true, onTabChange: vi.fn() };
    const first = { ...PREVIEW_SNAPSHOT, root: "D:/repo" };
    const second = { ...PREVIEW_SNAPSHOT, root: "D:/other" };
    const view = render(<WorkspaceContent {...props} snapshot={first} tab="overview" />);
    expect(githubLifecycle.mounts).not.toHaveBeenCalled();

    view.rerender(<WorkspaceContent {...props} snapshot={first} tab="github" />);
    expect(githubLifecycle.mounts).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("github-mock")).toHaveAttribute("data-root", "D:/repo");
    for (const tab of ["changes", "overview", "history"] as const) {
      view.rerender(<WorkspaceContent {...props} snapshot={first} tab={tab} />);
      expect(screen.getByTestId("github-mock").parentElement).toHaveAttribute("hidden");
    }
    view.rerender(<WorkspaceContent {...props} snapshot={first} tab="github" />);
    expect(githubLifecycle.mounts).toHaveBeenCalledTimes(1);
    expect(githubLifecycle.unmounts).not.toHaveBeenCalled();
    expect(screen.getByTestId("github-mock").parentElement).not.toHaveAttribute("hidden");

    view.rerender(<WorkspaceContent {...props} snapshot={second} tab="overview" />);
    expect(githubLifecycle.unmounts).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("github-mock")).not.toBeInTheDocument();
    view.rerender(<WorkspaceContent {...props} snapshot={second} tab="github" />);
    expect(githubLifecycle.mounts).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("github-mock")).toHaveAttribute("data-root", "D:/other");
  });
  it("keeps overview panels responsive and tab navigation independently scrollable", () => {
    const { container } = render(
      <WorkspaceContent
        snapshot={PREVIEW_SNAPSHOT}
        profileRepositoryRoot="D:/Project/virtuallab"
        tab="overview"
        isPreview
        onTabChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("navigation")).toHaveClass("overflow-x-auto");
    expect(container.querySelector("main")).toHaveClass("min-w-0", "overflow-y-auto");
    expect(screen.getByText("Working tree").closest(".grid")).toHaveClass("grid-cols-2", "xl:grid-cols-4");
    expect(screen.getByText("Workspace topology").closest(".grid")).toHaveClass("grid-cols-1");
    expect(screen.getByText("Workspace topology").closest(".grid")).toHaveClass("xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]");
  });

  it("gives the Run view a bounded desktop scroll region without trapping other tabs", () => {
    const props = {
      snapshot: PREVIEW_SNAPSHOT,
      profileRepositoryRoot: "D:/Project/virtuallab",
      isPreview: true,
      onTabChange: vi.fn(),
    };
    const view = render(<WorkspaceContent {...props} tab="run" />);
    const main = screen.getByTestId("workspace-main");
    expect(main).toHaveClass("min-h-0", "overflow-x-hidden", "overflow-y-auto", "xl:overflow-hidden");
    expect(screen.getByTestId("runner-mock")).toBeInTheDocument();

    // Overview, GitHub and other document-like pages still scroll normally.
    view.rerender(<WorkspaceContent {...props} tab="github" />);
    expect(main).toHaveClass("overflow-x-auto", "overflow-y-auto");
    expect(main).not.toHaveClass("xl:overflow-hidden");

    // Xterm uses its own scrollback, but on a short viewport the workspace
    // still needs to be scrollable rather than clipping the toolbar.
    view.rerender(<WorkspaceContent {...props} tab="terminal" />);
    expect(main).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("terminal-mock")).toBeInTheDocument();
  });

  it("wires every workspace tab", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(
      <WorkspaceContent
        snapshot={PREVIEW_SNAPSHOT}
        profileRepositoryRoot="D:/Project/virtuallab"
        tab="overview"
        isPreview
        onTabChange={onTabChange}
      />,
    );

    for (const tab of ["Overview", "Changes", "GitHub", "Agents", "Terminal", "Run", "Checks", "History"]) {
      await user.click(screen.getByRole("button", { name: new RegExp(tab, "i") }));
    }

    expect(onTabChange.mock.calls.map(([tab]) => tab)).toEqual([
      "overview",
      "changes",
      "github",
      "agents",
      "terminal",
      "run",
      "checks",
      "history",
    ]);
  });
  it("retains terminal mounts across tabs, worktrees and repositories", () => {
    const props = {
      snapshot: PREVIEW_SNAPSHOT,
      profileRepositoryRoot: "D:/Project/virtuallab",
      isPreview: true,
      onTabChange: vi.fn(),
    };
    const view = render(<WorkspaceContent {...props} tab="terminal" />);
    expect(screen.getByTestId("terminal-mock")).toHaveAttribute("data-visible", "true");
    expect(terminalLifecycle.mounts).toHaveBeenCalledTimes(1);

    for (const tab of ["overview", "github", "run", "terminal"] as const) {
      view.rerender(<WorkspaceContent {...props} tab={tab} />);
      expect(screen.getByTestId("terminal-mock")).toHaveAttribute(
        "data-visible", String(tab === "terminal"),
      );
    }
    expect(terminalLifecycle.mounts).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounts).not.toHaveBeenCalled();

    // Equivalent Windows spellings are one identity; other workspaces
    // keep their own mounted terminal panes when selection changes.
    const slash = { ...PREVIEW_SNAPSHOT, root: "D:/Project/repo" };
    view.rerender(<WorkspaceContent {...props} tab="terminal" snapshot={slash} />);
    expect(terminalLifecycle.mounts).toHaveBeenCalledTimes(2);
    view.rerender(<WorkspaceContent {...props} tab="terminal" snapshot={{ ...slash, root: "d:\\Project\\repo\\" }} />);
    expect(terminalLifecycle.mounts).toHaveBeenCalledTimes(2);
    view.rerender(<WorkspaceContent {...props} tab="terminal" snapshot={{ ...slash, root: "D:/Project/another" }} />);
    expect(terminalLifecycle.unmounts).not.toHaveBeenCalled();
    expect(terminalLifecycle.mounts).toHaveBeenCalledTimes(3);
  });

  it("lazily creates panes and disposes only the removed repository/worktree", () => {
    terminalLifecycle.mounts.mockClear();
    terminalLifecycle.unmounts.mockClear();
    const first = { ...PREVIEW_SNAPSHOT, root: "D:/repo" };
    const second = { ...PREVIEW_SNAPSHOT, root: "D:/other" };
    const base = { isPreview: true, onTabChange: vi.fn() };
    const view = render(<WorkspaceContent {...base} snapshot={first} profileRepositoryRoot="D:/repo"
      terminalRepositoryId="repo-a" registeredRepositoryIds={["repo-a", "repo-b"]} tab="overview" />);
    expect(screen.queryByTestId("terminal-mock")).not.toBeInTheDocument();
    view.rerender(<WorkspaceContent {...base} snapshot={first} profileRepositoryRoot="D:/repo"
      terminalRepositoryId="repo-a" registeredRepositoryIds={["repo-a", "repo-b"]} tab="terminal" />);
    expect(terminalLifecycle.mounts).toHaveBeenCalledTimes(1);
    view.rerender(<WorkspaceContent {...base} snapshot={second} profileRepositoryRoot="D:/other"
      terminalRepositoryId="repo-b" registeredRepositoryIds={["repo-a", "repo-b"]} tab="terminal" />);
    expect(terminalLifecycle.mounts).toHaveBeenCalledTimes(2);
    expect(terminalLifecycle.unmounts).not.toHaveBeenCalled();

    view.rerender(<WorkspaceContent {...base} snapshot={second} profileRepositoryRoot="D:/other"
      terminalRepositoryId="repo-b" registeredRepositoryIds={["repo-b"]} tab="terminal" />);
    expect(terminalLifecycle.unmounts).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("terminal-mock")).toHaveAttribute("data-cwd", "D:/other");

    view.rerender(<WorkspaceContent {...base} snapshot={second} profileRepositoryRoot="D:/other"
      terminalRepositoryId="repo-b" registeredRepositoryIds={["repo-b"]} tab="terminal"
      retiredTerminal={{ path: "d:\\other\\", sequence: 1 }} />);
    expect(terminalLifecycle.unmounts).toHaveBeenCalledTimes(2);
  });

});
