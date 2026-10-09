import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TerminalWorkspace } from "./TerminalWorkspace";

const backend = vi.hoisted(() => ({
  terminalSpawn: vi.fn().mockResolvedValue(undefined),
  terminalStop: vi.fn().mockResolvedValue(undefined),
  terminalWrite: vi.fn().mockResolvedValue(undefined),
  terminalResize: vi.fn().mockResolvedValue(undefined),
}));

const xterm = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/backend", () => backend);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
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
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    constructor() {
      xterm.instances.push(this as unknown as Record<string, unknown>);
    }
  },
}));

describe("TerminalWorkspace controls", () => {
  it("starts multiple terminals, selects a tab and stops the active session", async () => {
    const user = userEvent.setup();
    render(<TerminalWorkspace cwd="D:/workspace" enabled />);

    await user.click(screen.getByRole("button", { name: /start terminal/i }));
    await waitFor(() => expect(backend.terminalSpawn).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /terminal 1/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /new terminal/i }));
    await waitFor(() => expect(backend.terminalSpawn).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /terminal 2/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /terminal 1/i }));
    await user.click(screen.getByRole("button", { name: /^stop$/i }));
    expect(backend.terminalStop).toHaveBeenCalled();
  });

  it("disables terminal launch in web preview", () => {
    render(<TerminalWorkspace cwd="preview" enabled={false} />);
    expect(screen.getByRole("button", { name: /new terminal/i })).toBeDisabled();
  });
});

it("closes an individual terminal and releases its tab", async () => {
  const user = userEvent.setup();
  render(<TerminalWorkspace cwd="D:/workspace" enabled />);
  await user.click(screen.getByRole("button", { name: /start terminal/i }));
  expect(screen.getByRole("button", { name: /terminal 1/i })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /close terminal/i }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /terminal 1/i })).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: /start terminal/i })).toBeInTheDocument();
});
