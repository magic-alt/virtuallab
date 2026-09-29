import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectSidebar } from "./ProjectSidebar";
import { PREVIEW_SNAPSHOT } from "@/data/preview";

const repositories = [
  { id: "repo-1", name: "servo_host", path: "D:/Project/servo_host", lastOpenedAt: 1 },
  { id: "repo-2", name: "servoHIL", path: "D:/Project/servoHIL", lastOpenedAt: 2 },
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

    await user.click(screen.getByRole("button", { name: /servohil/i }));
    expect(p.onSelect).toHaveBeenCalledWith("repo-2");

    await user.click(screen.getByRole("button", { name: /remove servohil/i }));
    expect(p.onRemove).toHaveBeenCalledWith("repo-2");

    await user.click(screen.getByRole("button", { name: /^new$/i }));
    expect(p.onNewWorkspace).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /feat\/engineering-workbench-foundation/i }));
    expect(p.onSelectWorkspace).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /remove workspace/i }));
    expect(p.onRemoveWorkspace).toHaveBeenCalled();
  });

  it("filters repositories and disables native-only controls in web preview", () => {
    const p = props();
    render(
      <ProjectSidebar
        {...p}
        filterQuery="servoHIL"
        repositoryActionsEnabled={false}
        workspaceActionsEnabled={false}
      />,
    );
    expect(screen.queryByText("servo_host")).not.toBeInTheDocument();
    expect(screen.getByText("servoHIL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add repository/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^new$/i })).toBeDisabled();
  });
});
