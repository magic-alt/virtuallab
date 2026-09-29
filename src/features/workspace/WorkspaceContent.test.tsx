import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/terminal/TerminalWorkspace", () => ({
  TerminalWorkspace: () => <div data-testid="terminal-mock" />,
}));
vi.mock("@/features/execution/ProcessRunner", () => ({
  ProcessRunner: () => <div data-testid="runner-mock" />,
}));
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { WorkspaceContent } from "./WorkspaceContent";

describe("WorkspaceContent navigation", () => {
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

    for (const tab of ["Overview", "Changes", "Terminal", "Run", "Checks", "History"]) {
      await user.click(screen.getByRole("button", { name: new RegExp(tab, "i") }));
    }

    expect(onTabChange.mock.calls.map(([tab]) => tab)).toEqual([
      "overview",
      "changes",
      "terminal",
      "run",
      "checks",
      "history",
    ]);
  });
});
