import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentWorkspace } from "./AgentWorkspace";
import { useAgentConfiguration } from "@/stores/agentConfiguration";
import { useAgentSessionStore } from "@/stores/agentSessions";
import { useAgentTimeline } from "@/stores/agentTimeline";
import { useAgentPreferences } from "@/stores/agentPreferences";

describe("AgentWorkspace desktop control surface", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAgentConfiguration.setState({ roles: [], skills: [], selections: {} });
    useAgentSessionStore.setState({ bindings: {} });
    useAgentTimeline.setState(useAgentTimeline.getInitialState(), true);
    useAgentPreferences.setState({ codexExecutablePath: "" });
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
  it("pauses journal reads while a retained session panel is hidden", async () => {
    const invoke = vi.fn(async (command: string) => command === "agent_journal_recover"
      ? { workspaceId: "test", nativeSessionRegistered: false, retainedEvents: 0, turns: [] }
      : []);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    const page = render(<AgentWorkspace workspaceRoot="/hidden-session" enabled visible={false} />);
    await act(async () => undefined);
    expect(invoke).not.toHaveBeenCalled();
    page.rerender(<AgentWorkspace workspaceRoot="/hidden-session" enabled visible />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_journal_recent", { workspaceRoot: "/hidden-session", limit: 100 }, undefined));
    page.rerender(<AgentWorkspace workspaceRoot="/hidden-session" enabled visible={false} />);
    expect(invoke.mock.calls.some(([command]) => command === "agent_session_stop")).toBe(false);
  });
  it("does not attach after an availability response returns to a hidden panel", async () => {
    let resolve!: (value: unknown) => void;
    const availability = new Promise(result => { resolve = result; });
    const invoke = vi.fn(async (command: string) => {
      if (command === "agent_journal_recover") return { workspaceId: "test", nativeSessionRegistered: false, retainedEvents: 0, turns: [] };
      if (command === "agent_journal_recent") return [];
      if (command === "agent_harness_capabilities") return availability;
      if (command === "agent_session_start") return { workspaceRoot: "/pending-session", harness: "codex", threadId: "thread", createdAtMs: 1, updatedAtMs: 1 };
      if (command === "agent_turn_start") return { threadId: "thread", turnId: "turn" };
      throw new Error("Unexpected native command: " + command);
    });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    const page = render(<AgentWorkspace workspaceRoot="/pending-session" enabled visible />);
    await userEvent.type(screen.getByRole("textbox", { name: "Agent message" }), "Keep this draft");
    await userEvent.click(screen.getByRole("button", { name: "Connect & send" }));
    await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "agent_harness_capabilities")).toBe(true));
    page.rerender(<AgentWorkspace workspaceRoot="/pending-session" enabled visible={false} />);
    await act(async () => resolve({ harness: "codex", available: true, detail: "Available", executablePath: "/bin/codex", features: {} }));
    expect(invoke.mock.calls.some(([command]) => command === "agent_session_start")).toBe(false);
    expect(screen.getByRole("textbox", { name: "Agent message" })).toHaveValue("Keep this draft");
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
    useAgentPreferences.getState().setCodexExecutablePath(selected);
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
    await user.click(screen.getByRole("button", { name: /Connect & send/i }));
    await waitFor(() => expect(invoke.mock.calls.some((call) => call[0] === "agent_turn_start")).toBe(true));
    expect(invoke).toHaveBeenCalledWith("agent_harness_capabilities", {
      harness: "codex", executablePath: selected,
    }, undefined);
    expect(invoke).toHaveBeenCalledWith("agent_session_start", {
      request: expect.objectContaining({ executablePath: selected, threadId: null }),
    }, undefined);
    expect(screen.getByText(/Turn running; activity appears below/)).toBeInTheDocument();
  });

  it('shows effective references and requires stopping before applying a changed selection', async () => {
    const first = [{ repositoryRoot: '/alias/firmware', workspaceRoot: '/alias/firmware-review' }];
    const second = [{ repositoryRoot: '/firmware', workspaceRoot: '/firmware-main' }];
    const invoke = vi.fn(async (command: string, args?: Record<string, any>) => {
      if (command === 'agent_journal_recover') return { workspaceId: 'test', nativeSessionRegistered: false, retainedEvents: 0, turns: [] };
      if (command === 'agent_journal_recent') return [];
      if (command === 'agent_harness_capabilities') return { harness: 'codex', available: true, executablePath: '/bin/codex', detail: 'Available', features: {} };
      if (command === 'agent_session_start') return { workspaceRoot: '/host', harness: 'codex', threadId: 'thread', createdAtMs: 1, updatedAtMs: 1,
        contextRepositories: args?.request.contextRepositories?.[0]?.workspaceRoot === first[0].workspaceRoot
          ? [{ repositoryRoot: '/firmware', workspaceRoot: '/firmware-review' }] : args?.request.contextRepositories };
      if (command === 'agent_session_stop') return;
      throw new Error('Unexpected command: ' + command);
    });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    const view = render(<AgentWorkspace workspaceRoot="/host" enabled contextRepositories={first}/>);
    await userEvent.click(screen.getByRole('button', { name: 'Attach / resume' }));
    await waitFor(() => expect(screen.getByText(/Ready for another message/)).toBeInTheDocument());
    expect(screen.queryByText(/先停止当前会话/)).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('agent_session_start', { request: expect.objectContaining({ contextRepositories: first }) }, undefined);
    view.rerender(<AgentWorkspace workspaceRoot="/host" enabled contextRepositories={second}/>);
    expect(screen.getByText(/先停止当前会话/)).toBeInTheDocument();
    expect(screen.getByText('/firmware-review')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Agent message' }), 'Continue with the new reference');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Stop runtime' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach / resume' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Attach / resume' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agent_session_start', { request: expect.objectContaining({ contextRepositories: second }) }, undefined));
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

  it("makes resume available when a retained panel observes its native runtime stop", async () => {
    const root = "/retained-stop";
    const invoke = vi.fn(async (command: string) => {
      if (command === "agent_journal_recover") return { workspaceId: "test", nativeSessionRegistered: false, retainedEvents: 0, turns: [] };
      if (command === "agent_journal_recent") return [];
      if (command === "agent_harness_capabilities") return { harness: "codex", available: true, executablePath: "/tools/codex", detail: "Available", features: {} };
      if (command === "agent_session_start") return { workspaceRoot: root, harness: "codex", threadId: "thread", createdAtMs: 1, updatedAtMs: 1 };
      throw new Error("Unexpected native command: " + command);
    });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    render(<AgentWorkspace workspaceRoot={root} enabled/>);
    await userEvent.click(screen.getByRole("button", { name: "Attach / resume" }));
    await screen.findByText("Ready for another message in this workspace.");
    act(() => useAgentTimeline.getState().append({ workspaceRoot: root, threadId: "thread", eventType: "agent.session_stopped", timestampMs: 1 }));
    expect(screen.getByRole("button", { name: "Attach / resume" })).toBeEnabled();
  });

  it("does not stop or forget a replacement binding after a delayed confirmation", async () => {
    const root = "/replacement-session";
    useAgentSessionStore.getState().setBinding({ workspaceRoot: root, harness: "codex", threadId: "original", createdAtMs: 1, updatedAtMs: 1 });
    let approve!: (value: string) => void;
    const confirmation = new Promise<string>(resolve => { approve = resolve; });
    const invoke = vi.fn(async (command: string) => {
      if (command === "agent_journal_recover") return { workspaceId: "test", nativeSessionRegistered: true, retainedEvents: 0, turns: [] };
      if (command === "agent_journal_recent") return [];
      if (command === "plugin:dialog|message") return confirmation;
      if (command === "agent_session_stop") return;
      throw new Error("Unexpected native command: " + command);
    });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    render(<AgentWorkspace workspaceRoot={root} enabled/>);
    await userEvent.click(screen.getByRole("button", { name: "Forget saved thread" }));
    await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "plugin:dialog|message")).toBe(true));
    act(() => useAgentSessionStore.getState().setBinding({ workspaceRoot: root, harness: "codex", threadId: "replacement", createdAtMs: 2, updatedAtMs: 2 }));
    await act(async () => approve("Confirm"));
    expect(invoke.mock.calls.some(([command]) => command === "agent_session_stop")).toBe(false);
    expect(useAgentSessionStore.getState().bindings[root]?.threadId).toBe("replacement");
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
    await user.click(screen.getByRole("button", { name: /Connect & send/i }));
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
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });


});
