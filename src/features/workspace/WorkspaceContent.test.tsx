import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/terminal/TerminalWorkspace", () => ({
  TerminalWorkspace: () => <div data-testid="terminal-mock" />,
}));
vi.mock("@/features/execution/ProcessRunner", () => ({
  ProcessRunner: () => <div data-testid="runner-mock" />,
}));
vi.mock("@/features/github/GithubPanel", () => ({
  GithubPanel: () => <div data-testid="github-mock" />,
}));
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { WorkspaceContent } from "./WorkspaceContent";

describe("WorkspaceContent navigation", () => {
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
});
