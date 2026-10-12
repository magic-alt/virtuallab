import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalWorkspace } from "./TerminalWorkspace";

const backend = vi.hoisted(() => ({
  terminalSpawn: vi.fn().mockResolvedValue(undefined),
  terminalStop: vi.fn().mockResolvedValue(undefined),
  terminalWrite: vi.fn().mockResolvedValue(undefined),
  terminalResize: vi.fn().mockResolvedValue(undefined),
}));

const events = vi.hoisted(() => ({
  callbacks: {} as Record<string, (event: { payload: unknown }) => void>,
  holdOutputListener: false,
  resolveOutputListener: null as (() => void) | null,
}));

const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    write: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onInput?: (data: string) => void;
  }>,
}));

vi.mock("@/lib/backend", () => backend);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    if (name === "terminal://output" && events.holdOutputListener) {
      await new Promise<void>((resolve) => { events.resolveOutputListener = resolve; });
    }
    events.callbacks[name] = callback;
    return () => { delete events.callbacks[name]; };
  }),
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
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
    constructor() {
      xterm.instances.push(this);
    }
  },
}));

beforeEach(() => {
  events.callbacks = {};
  events.holdOutputListener = false;
  events.resolveOutputListener = null;
  xterm.instances.length = 0;
  for (const method of Object.values(backend)) method.mockReset().mockResolvedValue(undefined);
});

async function startTerminal(user: ReturnType<typeof userEvent.setup>) {
  const previousStarts = backend.terminalSpawn.mock.calls.length;
  await waitFor(() => expect(screen.getByRole("button", { name: /start terminal/i })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: /start terminal/i }));
  await waitFor(() => expect(backend.terminalSpawn).toHaveBeenCalledTimes(previousStarts + 1));
  return backend.terminalSpawn.mock.calls[previousStarts][0] as string;
}

describe("TerminalWorkspace native PTY lifecycle", () => {
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
