import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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
    useAgentTimeline.setState(useAgentTimeline.getInitialState(), true);
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

  it("stops a saved workspace runtime after the Agents pane is remounted", async () => {
    const user = userEvent.setup();
    const root = "C:/work/demo";
    useAgentSessionStore.getState().setBinding({
      workspaceRoot: root, harness: "codex", threadId: "persisted-thread",
      createdAtMs: 1, updatedAtMs: 1,
    });
    const invoke = vi.fn(async (command: string) => {
      if (command === "agent_journal_recover") return {
        workspaceId: "test", nativeSessionRegistered: true, retainedEvents: 0, turns: [],
      };
      if (command === "agent_journal_recent") return [];
      if (command === "agent_session_stop") return;
      throw new Error("Unexpected native command: " + command);
    });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    render(<AgentWorkspace workspaceRoot={root} enabled />);
    const stop = screen.getByRole("button", { name: "Stop runtime" });
    expect(stop).toBeEnabled();
    await user.click(stop);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "agent_session_stop", { workspaceRoot: root }, undefined,
    ));
  });

  it.each(["completed", "stopped and resumed"])("does not revive a turn %s before its start acknowledgement arrives", async (outcome) => {
    const root = "C:/work/demo";
    let acknowledge!: (value: { threadId: string; turnId: string }) => void;
    const started = new Promise<{ threadId: string; turnId: string }>((resolve) => { acknowledge = resolve; });
    const invoke = vi.fn(async (command: string) => {
      if (command === "agent_journal_recover") return {
        workspaceId: "test", nativeSessionRegistered: false, retainedEvents: 0, turns: [],
      };
      if (command === "agent_journal_recent") return [];
      if (command === "agent_harness_capabilities") return {
        harness: "codex", available: true, executablePath: "codex", detail: "Available",
        features: { persistentThreads: true, turns: true, steering: true, interrupt: true, structuredEvents: true },
      };
      if (command === "agent_session_start") return {
        workspaceRoot: root, harness: "codex", threadId: "thread-a", createdAtMs: 1, updatedAtMs: 1,
      };
      if (command === "agent_turn_start") return started;
      throw new Error("Unexpected native command: " + command);
    });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    const user = userEvent.setup();
    render(<AgentWorkspace workspaceRoot={root} enabled />);
    await user.type(screen.getByRole("textbox", { name: "Agent message" }), "Review this worktree");
    await user.click(screen.getByRole("button", { name: /Connect & run task/i }));
    await waitFor(() => expect(invoke.mock.calls.some((call) => call[0] === "agent_turn_start")).toBe(true));
    act(() => {
      if (outcome === "completed") {
        useAgentTimeline.getState().append({
          workspaceRoot: root, threadId: "thread-a", turnId: "finished-turn",
          eventType: "agent.notification", method: "turn/completed", timestampMs: 2,
          payload: { turn: { id: "finished-turn", status: "completed" } },
        });
      } else {
        useAgentTimeline.getState().append({ workspaceRoot: root, threadId: "thread-a", eventType: "agent.session_stopped", timestampMs: 2 });
        useAgentTimeline.getState().append({ workspaceRoot: root, threadId: "thread-a", eventType: "agent.session_started", timestampMs: 3 });
      }
    });
    await act(async () => acknowledge({ threadId: "thread-a", turnId: "finished-turn" }));

    expect(useAgentTimeline.getState().activeTurns["c:/work/demo"]).toBeUndefined();
    await user.type(screen.getByRole("textbox", { name: "Agent message" }), "Review another change");
    expect(screen.getByRole("button", { name: "Send next task" })).toBeEnabled();
  });


});
