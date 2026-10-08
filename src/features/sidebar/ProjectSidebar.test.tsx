import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectSidebar } from "./ProjectSidebar";
import { PREVIEW_SNAPSHOT } from "@/data/preview";

const repositories = [
  { id: "repo-1", name: "sample-alpha", path: "D:/Work/sample-alpha", lastOpenedAt: 1 },
  { id: "repo-2", name: "sample-beta", path: "D:/Work/sample-beta", lastOpenedAt: 2 },
];

function props() {
  return {
    repositories,
    activeRepositoryId: "repo-1",
    snapshot: PREVIEW_SNAPSHOT,
    isPreview: false,
    onAdd: vi.fn(),
    onSelect: vi.fn(),
    onRemove: vi.fn(),
    onNewWorkspace: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onRemoveWorkspace: vi.fn(),
    onSwitchBranch: vi.fn(),
    branchActionsEnabled: true,
    workspaceActionsEnabled: true,
    repositoryActionsEnabled: true,
    filterQuery: "",
  };
}

describe("ProjectSidebar controls", () => {
  it("wires repository and workspace controls", async () => {
    const user = userEvent.setup();
    const p = props();
    render(<ProjectSidebar {...p} />);

    await user.click(screen.getByRole("button", { name: /add repository/i }));
    expect(p.onAdd).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /^sample-beta D:\/Work\/sample-beta$/i }));
    expect(p.onSelect).toHaveBeenCalledWith("repo-2");

    await user.click(screen.getByRole("button", { name: /remove sample-beta/i }));
    expect(p.onRemove).toHaveBeenCalledWith("repo-2");

    await user.click(screen.getByRole("button", { name: /^new$/i }));
    expect(p.onNewWorkspace).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /feat\/sample-workspace/i }));
    expect(p.onSelectWorkspace).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /remove workspace/i }));
    expect(p.onRemoveWorkspace).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /switch to feat\/remote-only/i }));
    expect(p.onSwitchBranch).toHaveBeenCalledWith("feat/remote-only");

    await user.click(screen.getByRole("button", { name: /open worktree for main/i }));
    expect(p.onSwitchBranch).toHaveBeenCalledWith("main");
  });

  it("filters repositories and disables native-only controls in web preview", () => {
    const p = props();
    render(
      <ProjectSidebar
        {...p}
        filterQuery="sample-beta"
        repositoryActionsEnabled={false}
        workspaceActionsEnabled={false}
        branchActionsEnabled={false}
      />,
    );
    expect(screen.queryByText("sample-alpha")).not.toBeInTheDocument();
    expect(screen.getByText("sample-beta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add repository/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^new$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /switch to feat\/remote-only/i })).toBeDisabled();
  });
});
