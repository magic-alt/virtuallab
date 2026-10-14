import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentWorkspace } from "./AgentWorkspace";
import { useAgentConfiguration } from "@/stores/agentConfiguration";
import { useAgentSessionStore } from "@/stores/agentSessions";
import { useAgentTimeline } from "@/stores/agentTimeline";

describe("AgentWorkspace desktop control surface", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAgentConfiguration.setState({ roles: [], skills: [], selections: {} });
    useAgentSessionStore.setState({ bindings: {} });
    useAgentTimeline.setState({ entries: {}, activeTurns: {} });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("offers four harnesses and does not launch native commands in preview", () => {
    render(<AgentWorkspace workspaceRoot="/worktree" enabled={false} />);
    const select = screen.getByRole("combobox", { name: "Harness" }) as HTMLSelectElement;
    expect(select.options).toHaveLength(4);
    expect(screen.getByRole("button", { name: /Attach \/ resume/i })).toBeDisabled();
    expect(screen.getByRole("log", { name: /Agent event timeline/i })).toHaveClass("max-h-80", "overflow-y-auto");
    expect(screen.getByText(/Default decision: DENY/)).toBeInTheDocument();
  });
  it("saves a generic custom role and opt-in skill", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace workspaceRoot="C:/Temp/generic-repo" enabled={false} />);
    await user.click(screen.getByText(/Role & optional skills · advanced/));
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
  it("connects, pins the inspected Codex launcher, and runs on one click", async () => {
    const user = userEvent.setup();
    const selected = "C:/Users/test/AppData/Roaming/npm/codex.cmd";
    window.localStorage.setItem("virtuallab-codex-executable-v1", selected);
    const invoke = vi.fn(async (command: string, args?: Record<string, any>) => {
      if (command === "agent_journal_recover") return {
        workspaceId: "test", nativeSessionRegistered: false, retainedEvents: 0, turns: [],
      };
      if (command === "agent_journal_recent") return [];
      if (command === "agent_harness_capabilities") return {
        harness: "codex", available: true, version: "codex-cli 0.162.0",
        executablePath: selected, detail: "Codex CLI available",
        features: { persistentThreads: true, turns: true, steering: true, interrupt: true, structuredEvents: true },
      };
      if (command === "agent_session_start") return {
        workspaceRoot: args?.request?.workspaceRoot, harness: "codex", threadId: "thr-1",
        createdAtMs: 1, updatedAtMs: 1,
      };
      if (command === "agent_turn_start") return { threadId: "thr-1", turnId: "turn-1" };
      throw new Error("Unexpected test invoke: " + command);
    });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    render(<AgentWorkspace workspaceRoot="C:/work/demo" enabled />);
    await user.type(screen.getByRole("textbox", { name: "Agent message" }), "Review the current branch");
    await user.click(screen.getByRole("button", { name: /Connect & run task/i }));
    await waitFor(() => expect(invoke.mock.calls.some((call) => call[0] === "agent_turn_start")).toBe(true));
    expect(invoke).toHaveBeenCalledWith("agent_harness_capabilities", {
      harness: "codex", executablePath: selected,
    }, undefined);
    expect(invoke).toHaveBeenCalledWith("agent_session_start", {
      request: expect.objectContaining({ executablePath: selected, threadId: null }),
    }, undefined);
    expect(screen.getByText(/Task running; activity appears below/)).toBeInTheDocument();
  });

});
