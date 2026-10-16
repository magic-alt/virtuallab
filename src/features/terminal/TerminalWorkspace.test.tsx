import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalWorkspace } from "./TerminalWorkspace";
import { WorkspaceContent } from "@/features/workspace/WorkspaceContent";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { setTerminalFontSize } from "./terminalAppearance";
import { useTaskNotifications } from "@/stores/taskNotifications";
import { MONITORED_CODEX_COMMAND } from "@/lib/terminalAlerts";

const backend = vi.hoisted(() => ({
  isDesktopRuntime: vi.fn(() => true),
  terminalSpawn: vi.fn().mockResolvedValue(undefined),
  terminalStop: vi.fn().mockResolvedValue(undefined),
  terminalWrite: vi.fn().mockResolvedValue(undefined),
  terminalResize: vi.fn().mockResolvedValue(undefined),
  desktopNotify: vi.fn().mockResolvedValue(undefined),
}));

const events = vi.hoisted(() => ({
  callbacks: {} as Record<string, (event: { payload: unknown }) => void>,
  listeners: {} as Record<string, Set<(event: { payload: unknown }) => void>>,
  holdOutputListener: false,
  resolveOutputListener: null as (() => void) | null,
}));

const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    options: { fontSize: number };
    write: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onInput?: (data: string) => void;
  }>,
  fits: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("@/lib/backend", () => backend);
vi.mock("@/features/execution/ProcessRunner", () => ({ ProcessRunner: () => null }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    if (name === "terminal://output" && events.holdOutputListener) {
      await new Promise<void>((resolve) => { events.resolveOutputListener = resolve; });
    }
    const listeners = events.listeners[name] ??= new Set();
    listeners.add(callback);
    events.callbacks[name] = (event) => { for (const listener of listeners) listener(event); };
    return () => { listeners.delete(callback); if (!listeners.size) delete events.callbacks[name]; };
  }),
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    constructor() { xterm.fits.push(this.fit); }
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: { fontSize: number };
    cols = 120;
    rows = 32;
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    onInput?: (data: string) => void;
    loadAddon() {}
    open() {}
    onData(callback: (data: string) => void) {
      this.onInput = callback;
      return { dispose: vi.fn() };
    }
    constructor(options: { fontSize: number }) {
      this.options = { fontSize: options.fontSize };
      xterm.instances.push(this);
    }
  },
}));

beforeEach(() => {
  events.callbacks = {};
  events.listeners = {};
  events.holdOutputListener = false;
  events.resolveOutputListener = null;
  xterm.instances.length = 0;
  xterm.fits.length = 0;
  for (const method of Object.values(backend)) method.mockReset().mockResolvedValue(undefined);
  backend.isDesktopRuntime.mockReset().mockReturnValue(true);
  useTaskNotifications.setState({ notices: [], desktopEnabled: true, desktopError: null, terminalTarget: null });
});

async function startTerminal(user: ReturnType<typeof userEvent.setup>) {
  const previousStarts = backend.terminalSpawn.mock.calls.length;
  await waitFor(() => expect(screen.getByRole("button", { name: /start terminal/i })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: /start terminal/i }));
  await waitFor(() => expect(backend.terminalSpawn).toHaveBeenCalledTimes(previousStarts + 1));
  return backend.terminalSpawn.mock.calls[previousStarts][0] as string;
}

describe("TerminalWorkspace native PTY lifecycle", () => {
  it("launches monitored Codex with scoped CLI flags and alerts on completed turns in a hidden terminal", async () => {
    const user = userEvent.setup();
    render(<TerminalWorkspace cwd="D:/workspace" enabled visible={false} repositoryId="repo-owner" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start Codex with alerts" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start Codex with alerts" }));
    await waitFor(() => expect(backend.terminalSpawn).toHaveBeenCalledTimes(1));
    const id = backend.terminalSpawn.mock.calls[0][0];
    await waitFor(() => expect(backend.terminalWrite).toHaveBeenCalledWith(
      id, new TextEncoder().encode(MONITORED_CODEX_COMMAND),
    ));
    act(() => {
      events.callbacks["terminal://output"]({ payload: {
        id, data: Array.from(new TextEncoder().encode("\x1b]9;Changes implemented\x07")),
      } });
    });
    expect(useTaskNotifications.getState().notices[0].title).toBe("Codex task completed");
    expect(useTaskNotifications.getState().notices[0].repositoryId).toBe("repo-owner");
    await waitFor(() => expect(backend.desktopNotify).toHaveBeenCalledTimes(1));
    expect(backend.desktopNotify.mock.calls[0].join(" ")).not.toContain("Changes implemented");
  });

  it("treats a regular BEL as attention, never proof of a completed task", async () => {
    const user = userEvent.setup();
    render(<TerminalWorkspace cwd="D:/workspace" enabled visible={false} />);
    const id = await startTerminal(user);
    act(() => {
      events.callbacks["terminal://output"]({ payload: { id, data: [7] } });
    });
    expect(useTaskNotifications.getState().notices[0].severity).toBe("attention");
    expect(useTaskNotifications.getState().notices[0].title).toBe("Terminal needs attention");
  });

  it("starts with legible text and zooms existing xterm buffers without respawning PTYs", async () => {
    const user = userEvent.setup();
    render(<TerminalWorkspace cwd="D:/workspace" enabled />);
    const id = await startTerminal(user);
    const first = xterm.instances[0];
    expect(first.options.fontSize).toBe(15);
    expect(screen.getByRole("button", { name: "Reset terminal font size" })).toHaveTextContent("15px");

    const priorFits = xterm.fits[0].mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Increase terminal font size" }));
    await waitFor(() => expect(first.options.fontSize).toBe(16));
    await waitFor(() => expect(xterm.fits[0].mock.calls.length).toBeGreaterThan(priorFits));
    expect(localStorage.getItem("virtuallab.terminal.fontSize")).toBe("16");
    expect(backend.terminalSpawn).toHaveBeenCalledTimes(1);
    expect(first.dispose).not.toHaveBeenCalled();

    // Codex slash commands still reach the same native process after zoom.
    act(() => { first.onInput?.("/model"); });
    await waitFor(() =>
      expect(backend.terminalWrite).toHaveBeenCalledWith(id, new TextEncoder().encode("/model")),
    );

    await user.click(screen.getByRole("button", { name: /new terminal/i }));
    await waitFor(() => expect(xterm.instances[1]?.options.fontSize).toBe(16));
    expect(first.dispose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reset terminal font size" }));
    await waitFor(() => {
      expect(first.options.fontSize).toBe(15);
      expect(xterm.instances[1].options.fontSize).toBe(15);
    });
    expect(localStorage.getItem("virtuallab.terminal.fontSize")).toBe("15");
    expect(backend.terminalSpawn).toHaveBeenCalledTimes(2);
  });

  it("remembers zoom on a new visit and does not resize hidden ConPTY sessions", async () => {
    const user = userEvent.setup();
    const view = render(<TerminalWorkspace cwd="D:/workspace" enabled visible />);
    await startTerminal(user);
    await waitFor(() => expect(xterm.instances[0]?.focus).toHaveBeenCalled());
    view.rerender(<TerminalWorkspace cwd="D:/workspace" enabled visible={false} />);
    const previousResizes = backend.terminalResize.mock.calls.length;

    act(() => { setTerminalFontSize(19); });
    await waitFor(() => expect(xterm.instances[0].options.fontSize).toBe(19));
    expect(backend.terminalResize).toHaveBeenCalledTimes(previousResizes);
    expect(xterm.instances[0].dispose).not.toHaveBeenCalled();

    view.rerender(<TerminalWorkspace cwd="D:/workspace" enabled visible />);
    await waitFor(() => expect(backend.terminalResize.mock.calls.length).toBeGreaterThan(previousResizes));
    view.unmount();

    render(<TerminalWorkspace cwd="D:/another" enabled />);
    await startTerminal(user);
    expect(xterm.instances.at(-1)?.options.fontSize).toBe(19);
    expect(screen.getByRole("button", { name: "Reset terminal font size" })).toHaveTextContent("19px");
  });

  it("waits for both subscriptions before it permits spawning a fast shell", async () => {
    events.holdOutputListener = true;
    const user = userEvent.setup();
    render(<TerminalWorkspace cwd="D:/workspace" enabled />);

    const start = screen.getByRole("button", { name: /start terminal/i });
    expect(start).toBeDisabled();
    await user.click(start);
    expect(backend.terminalSpawn).not.toHaveBeenCalled();

    await act(async () => { events.resolveOutputListener?.(); });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    await waitFor(() => expect(backend.terminalSpawn).toHaveBeenCalledTimes(1));
    expect(Object.keys(events.callbacks)).toEqual(["terminal://output", "workbench://event"]);
  });

  it("starts multiple terminals, selects a tab and stops the active session", async () => {
    const user = userEvent.setup();
    render(<TerminalWorkspace cwd="D:/workspace" enabled />);

    await startTerminal(user);
    expect(screen.getByRole("button", { name: /terminal 1/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /new terminal/i }));
    await waitFor(() => expect(backend.terminalSpawn).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /terminal 2/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /terminal 1/i }));
    await user.click(screen.getByRole("button", { name: /^stop$/i }));
    expect(backend.terminalStop).toHaveBeenCalledWith(backend.terminalSpawn.mock.calls[0][0]);
  });

  it("preserves xterm, native session, output and keyboard input while hidden", async () => {
    const user = userEvent.setup();
    const view = render(<TerminalWorkspace cwd="D:/workspace" enabled visible />);
    const id = await startTerminal(user);
    await waitFor(() => expect(xterm.instances[0]?.focus).toHaveBeenCalled());

    // Invoke success is sufficient to leave 'starting' even without a
    // terminal.started event. The input path must then be enabled.
    expect(screen.getByRole("button", { name: /terminal 1/i }).querySelector("span"))
      .toHaveClass("bg-emerald-400");
    const handle = xterm.instances[0];
    const focusCount = handle.focus.mock.calls.length;

    await act(async () => {
      events.callbacks["terminal://output"]({ payload: { id, data: [80, 83, 62, 32] } });
    });
    expect(handle.write).toHaveBeenCalledWith(new Uint8Array([80, 83, 62, 32]));

    view.rerender(<TerminalWorkspace cwd="D:/workspace" enabled visible={false} />);
    expect(backend.terminalStop).not.toHaveBeenCalled();
    expect(handle.dispose).not.toHaveBeenCalled();

    view.rerender(<TerminalWorkspace cwd="D:/workspace" enabled visible />);
    await waitFor(() => expect(handle.focus.mock.calls.length).toBeGreaterThan(focusCount));
    expect(xterm.instances).toHaveLength(1);
    expect(backend.terminalStop).not.toHaveBeenCalled();

    act(() => { handle.onInput?.("whoami\r"); });
    await waitFor(() =>
      expect(backend.terminalWrite).toHaveBeenCalledWith(id, new TextEncoder().encode("whoami\r")),
    );
  });

  it("sends ConPTY cursor-position replies while the shell is starting", async () => {
    let acknowledge: (() => void) | undefined;
    backend.terminalSpawn.mockImplementationOnce(() => new Promise<void>((resolve) => {
      acknowledge = resolve;
    }));
    const user = userEvent.setup();
    render(<TerminalWorkspace cwd="D:/workspace" enabled />);
    const id = await startTerminal(user);

    expect(screen.getByRole("button", { name: /terminal 1/i }).querySelector("span"))
      .toHaveClass("bg-amber-400");
    // ConPTY asks CSI 6n before rendering the first PowerShell prompt.
    act(() => {
      events.callbacks["terminal://output"]({ payload: { id, data: [27, 91, 54, 110] } });
      // xterm's parser emits this response via onData. The real parser is not
      // emulated by this UI test, so drive the onData callback explicitly.
      xterm.instances[0].onInput?.("\x1b[1;1R");
    });
    await waitFor(() =>
      expect(backend.terminalWrite).toHaveBeenCalledWith(
        id, new TextEncoder().encode("\x1b[1;1R"),
      ),
    );
    await act(async () => { acknowledge?.(); });
  });

  it("does not revive a process that exited before the spawn acknowledgement", async () => {
    let completeSpawn: (() => void) | undefined;
    backend.terminalSpawn.mockImplementationOnce(() => new Promise<void>((resolve) => {
      completeSpawn = resolve;
    }));
    const user = userEvent.setup();
    render(<TerminalWorkspace cwd="D:/workspace" enabled />);
    const id = await startTerminal(user);

    act(() => {
      events.callbacks["workbench://event"]({
        payload: { eventType: "terminal.exited", id },
      });
    });
    await act(async () => { completeSpawn?.(); });
    await waitFor(() => expect(screen.getByRole("button", { name: /terminal 1/i }).querySelector("span"))
      .toHaveClass("bg-slate-700"));
    expect(backend.terminalWrite).not.toHaveBeenCalled();
  });

  it("reports startup and input failures rather than silently showing a blank terminal", async () => {
    backend.terminalSpawn.mockRejectedValueOnce(new Error("ConPTY shell unavailable"));
    const user = userEvent.setup();
    const view = render(<TerminalWorkspace cwd="D:/workspace" enabled />);
    await startTerminal(user);
    await waitFor(() => expect(screen.getByText("ConPTY shell unavailable")).toBeInTheDocument());

    view.unmount();
    backend.terminalWrite.mockRejectedValueOnce(new Error("PTY write failed"));
    render(<TerminalWorkspace cwd="D:/workspace" enabled />);
    await startTerminal(user);
    await waitFor(() => expect(xterm.instances.at(-1)?.focus).toHaveBeenCalled());
    act(() => { xterm.instances.at(-1)?.onInput?.("echo test\r"); });
    await waitFor(() => expect(screen.getByText("PTY write failed")).toBeInTheDocument());
  });

  it("keeps web previews inert", () => {
    render(<TerminalWorkspace cwd="preview" enabled={false} />);
    expect(screen.getByRole("button", { name: /new terminal/i })).toBeDisabled();
    expect(events.callbacks["terminal://output"]).toBeUndefined();
  });

  it("only terminates sessions on actual teardown, not a visibility change", async () => {
    const user = userEvent.setup();
    const view = render(<TerminalWorkspace cwd="D:/workspace" enabled visible />);
    const id = await startTerminal(user);
    view.rerender(<TerminalWorkspace cwd="D:/workspace" enabled visible={false} />);
    expect(backend.terminalStop).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(backend.terminalStop).toHaveBeenCalledWith(id));
  });

  it("closes an individual terminal and releases its tab", async () => {
    const user = userEvent.setup();
    render(<TerminalWorkspace cwd="D:/workspace" enabled />);
    await startTerminal(user);
    expect(screen.getByRole("button", { name: /terminal 1/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /close terminal/i }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /terminal 1/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /start terminal/i })).toBeInTheDocument();
  });
});


describe("workspace terminal navigation", () => {
  it("retains each worktree and repository PTY, scrollback and input across round trips", async () => {
    const user = userEvent.setup();
    const props = { profileRepositoryRoot: "D:/repo", isPreview: false, onTabChange: vi.fn() };
    const first = { ...PREVIEW_SNAPSHOT, root: "D:/repo", currentBranch: "main" };
    const second = { ...first, root: "D:/repo-feature", currentBranch: "feature" };
    const other = { ...first, root: "D:/other" };
    const view = render(<WorkspaceContent {...props} snapshot={first} tab="terminal" />);
    const id = await startTerminal(user);
    const handle = xterm.instances[0];

    view.rerender(<WorkspaceContent {...props} snapshot={second} tab="terminal" />);
    const secondId = await startTerminal(user);
    const secondHandle = xterm.instances[1];
    view.rerender(<WorkspaceContent {...props} profileRepositoryRoot="D:/other" snapshot={other} tab="terminal" />);
    const otherId = await startTerminal(user);
    view.rerender(<WorkspaceContent {...props} profileRepositoryRoot="D:/other" snapshot={other} tab="run" />);
    expect(backend.terminalStop).not.toHaveBeenCalled();
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(secondHandle.dispose).not.toHaveBeenCalled();
    act(() => {
      events.callbacks["terminal://output"]({ payload: { id, data: [65] } });
      events.callbacks["terminal://output"]({ payload: { id: secondId, data: [66] } });
    });
    expect(handle.write).toHaveBeenCalledWith(new Uint8Array([65]));
    expect(secondHandle.write).toHaveBeenCalledWith(new Uint8Array([66]));

    view.rerender(<WorkspaceContent {...props} snapshot={{ ...first, root: "d:\\repo\\" }} tab="terminal" />);
    expect(screen.getByRole("button", { name: /terminal 1/i })).toBeInTheDocument();
    act(() => { handle.onInput?.("echo alive\r"); });
    await waitFor(() => expect(backend.terminalWrite).toHaveBeenCalledWith(id, new TextEncoder().encode("echo alive\r")));
    view.rerender(<WorkspaceContent {...props} snapshot={second} tab="terminal" />);
    expect(screen.getByRole("button", { name: /terminal 1/i })).toBeInTheDocument();
    expect(backend.terminalSpawn).toHaveBeenCalledTimes(3);
    expect(xterm.instances).toHaveLength(3);
    expect(backend.terminalStop).not.toHaveBeenCalled();
    view.rerender(<WorkspaceContent {...props} profileRepositoryRoot="D:/other" snapshot={other} tab="terminal" />);
    expect(screen.getByRole("button", { name: /terminal 1/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /close terminal/i }));
    expect(backend.terminalStop).toHaveBeenCalledWith(otherId);
    expect(screen.queryByRole("button", { name: /terminal 1/i })).not.toBeInTheDocument();
    view.unmount();
    await waitFor(() => {
      expect(backend.terminalStop).toHaveBeenCalledWith(id);
      expect(backend.terminalStop).toHaveBeenCalledWith(secondId);
    });
  });
});
