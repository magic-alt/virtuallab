import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessRunner } from "./ProcessRunner";
import { useWorkbenchStore } from "@/stores/workbench";

const backend = vi.hoisted(() => ({
  processSpawn: vi.fn().mockResolvedValue(undefined),
  processStop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/backend", () => ({
  processSpawn: backend.processSpawn,
  processStop: backend.processStop,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

describe("ProcessRunner controls", () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      profiles: [
        {
          id: "build-1",
          name: "Fixture build",
          kind: "build",
          repositoryRoot: "D:/repo",
          program: "echo",
          args: ["ok"],
        },
      ],
    });
  });

  it("runs and stops a structured profile", async () => {
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);

    await user.click(screen.getByRole("button", { name: /^run$/i }));
    expect(backend.processSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "D:/workspace",
        program: "echo",
        args: ["ok"],
      }),
    );

    await user.click(screen.getByRole("button", { name: /^stop$/i }));
    expect(backend.processStop).toHaveBeenCalledTimes(1);
  });

  it("creates, closes and removes profiles", async () => {
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);

    await user.click(screen.getByRole("button", { name: /profile/i }));
    expect(screen.getByText("New run profile")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /close profile editor/i }));
    expect(screen.queryByText("New run profile")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /profile/i }));
    await user.type(screen.getByLabelText("Name"), "Unit tests");
    await user.selectOptions(screen.getByLabelText("Kind"), "test");
    await user.type(screen.getByLabelText("Program"), "npm");
    await user.type(screen.getByLabelText(/Arguments/i), "test");
    await user.click(screen.getByRole("button", { name: /save profile/i }));
    expect(screen.getByText("Unit tests")).toBeInTheDocument();
    expect(useWorkbenchStore.getState().profiles.at(-1)?.repositoryRoot).toBe("D:/repo");

    await user.click(screen.getByRole("button", { name: /remove unit tests/i }));
    expect(screen.queryByText("Unit tests")).not.toBeInTheDocument();
  });

  it("does not expose profiles from another repository", () => {
    useWorkbenchStore.setState({
      profiles: [
        {
          id: "other",
          name: "VirtualLab Rust check",
          kind: "test",
          repositoryRoot: "D:/Project/virtuallab",
          program: "cargo",
          args: ["check", "--manifest-path", "src-tauri/Cargo.toml"],
        },
      ],
    });

    render(<ProcessRunner cwd="D:/Project/servo_host" repositoryRoot="D:/Project/servo_host" enabled />);
    expect(screen.queryByText("VirtualLab Rust check")).not.toBeInTheDocument();
    expect(screen.getByText(/No run profiles for this repository/i)).toBeInTheDocument();
  });

  it("disables run in web preview", () => {
    useWorkbenchStore.setState({
      profiles: [
        {
          id: "preview-build",
          name: "Preview build",
          kind: "build",
          repositoryRoot: "preview",
          program: "echo",
          args: ["preview"],
        },
      ],
    });

    render(<ProcessRunner cwd="preview" repositoryRoot="preview" enabled={false} />);
    expect(screen.getByRole("button", { name: /^run$/i })).toBeDisabled();
  });
});
