import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentWorkspace } from "./AgentWorkspace";
import { useAgentConfiguration } from "@/stores/agentConfiguration";
import { useAgentSessionStore } from "@/stores/agentSessions";

describe("AgentWorkspace desktop control surface", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAgentConfiguration.setState({ roles: [], skills: [], selections: {} });
    useAgentSessionStore.setState({ bindings: {} });
  });
  it("offers four harnesses and does not launch native commands in preview", () => {
    render(<AgentWorkspace workspaceRoot="/worktree" enabled={false} />);
    const select = screen.getByRole("combobox", { name: "Harness" }) as HTMLSelectElement;
    expect(select.options).toHaveLength(4);
    expect(screen.getByRole("button", { name: /Attach \/ resume/i })).toBeDisabled();
    expect(screen.getByRole("log", { name: /Agent event timeline/i })).toBeInTheDocument();
    expect(screen.getByText(/Default decision: DENY/)).toBeInTheDocument();
  });
  it("saves a generic custom role and opt-in skill", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace workspaceRoot="C:/Temp/generic-repo" enabled={false} />);
    await user.type(screen.getByRole("textbox", { name: "New role name" }), "Documentation");
    await user.type(screen.getByRole("textbox", { name: "New role instructions" }), "Write clear notes");
    await user.click(screen.getByRole("button", { name: "Add role" }));
    await user.type(screen.getByRole("textbox", { name: "New skill name" }), "Evidence");
    await user.type(screen.getByRole("textbox", { name: "New skill instructions" }), "Use check logs");
    await user.click(screen.getByRole("button", { name: "Add skill" }));
    expect(useAgentConfiguration.getState().roles).toHaveLength(1);
    expect(useAgentConfiguration.getState().skills).toHaveLength(1);
    expect(useAgentConfiguration.getState().selections["c:/temp/generic-repo"]?.skillIds).toHaveLength(1);
  });
});
