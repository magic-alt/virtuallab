import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessRunner } from "./ProcessRunner";
import { useWorkbenchStore } from "@/stores/workbench";

const backend = vi.hoisted(() => ({
  buildWorkflowDiscover: vi.fn().mockResolvedValue([]),
  buildWorkflowStart: vi.fn().mockResolvedValue(undefined),
  buildWorkflowCancel: vi.fn().mockResolvedValue(undefined),
  confirmDeploymentWorkflow: vi.fn().mockResolvedValue(true),
  processSpawn: vi.fn().mockResolvedValue(undefined),
  processStop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/backend", () => ({
  buildWorkflowDiscover: backend.buildWorkflowDiscover,
  buildWorkflowStart: backend.buildWorkflowStart,
  buildWorkflowCancel: backend.buildWorkflowCancel,
  confirmDeploymentWorkflow: backend.confirmDeploymentWorkflow,
  processSpawn: backend.processSpawn,
  processStop: backend.processStop,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

describe("ProcessRunner controls", () => {
  beforeEach(() => {
    backend.buildWorkflowDiscover.mockReset().mockResolvedValue([]);
    backend.buildWorkflowStart.mockReset().mockResolvedValue(undefined);
    backend.buildWorkflowCancel.mockReset().mockResolvedValue(undefined);
    backend.confirmDeploymentWorkflow.mockReset().mockResolvedValue(true);
    backend.processSpawn.mockReset().mockResolvedValue(undefined);
    backend.processStop.mockReset().mockResolvedValue(undefined);
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
    expect(screen.getByText("New run profile").closest(".vl-dialog")).toHaveClass("overflow-y-auto", "w-full");
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
          name: "Repository A Rust check",
          kind: "test",
          repositoryRoot: "D:/Work/sample-alpha",
          program: "cargo",
          args: ["check", "--manifest-path", "src-tauri/Cargo.toml"],
        },
      ],
    });

    render(<ProcessRunner cwd="D:/Work/sample-beta" repositoryRoot="D:/Work/sample-beta" enabled />);
    expect(screen.queryByText("Repository A Rust check")).not.toBeInTheDocument();
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

  it("discovers Qt CMake steps and triggers a single native sequential run", async () => {
    backend.buildWorkflowDiscover.mockResolvedValueOnce([{
      id: "cmake-configure-build", name: "Qt / CMake · Build", kind: "build",
      tool: "Qt / CMake", supported: true, description: "Configure and build",
      steps: [
        { name: "Configure", program: "cmake", args: ["-S", ".", "-B", "build/virtuallab"] },
        { name: "Compile", program: "cmake", args: ["--build", "build/virtuallab", "--config", "Release"] },
      ],
    }]);
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/repo/.worktrees/review" repositoryRoot="D:/repo" enabled />);
    await user.click(await screen.findByRole("button", { name: "Build now" }));
    expect(backend.buildWorkflowStart).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "D:/repo/.worktrees/review",
      steps: [
        expect.objectContaining({ name: "Configure", program: "cmake" }),
        expect.objectContaining({ name: "Compile", program: "cmake" }),
      ],
    }));
    expect(backend.processSpawn).not.toHaveBeenCalled();
  });

  it("saves and executes a configurable two-step workflow", async () => {
    useWorkbenchStore.setState({ profiles: [] });
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: /profile/i }));
    await user.type(screen.getByLabelText("Name"), "My CMake workflow");
    await user.type(screen.getByLabelText("Program"), "cmake");
    await user.type(screen.getByLabelText(/Arguments · one/i), "-S\n.\n-B\nbuild");
    await user.click(screen.getByRole("button", { name: /Add step/i }));
    await user.type(screen.getByLabelText("Program · step 2"), "cmake");
    await user.type(screen.getByLabelText("Arguments · step 2"), "--build\nbuild");
    await user.click(screen.getByRole("button", { name: /save profile/i }));
    expect(useWorkbenchStore.getState().profiles[0].steps).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /^run$/i }));
    expect(backend.buildWorkflowStart).toHaveBeenCalledWith(expect.objectContaining({
      steps: [
        expect.objectContaining({ program: "cmake", args: ["-S", ".", "-B", "build"] }),
        expect.objectContaining({ program: "cmake", args: ["--build", "build"] }),
      ],
    }));
    await user.click(screen.getByRole("button", { name: /^stop$/i }));
    expect(backend.buildWorkflowCancel).toHaveBeenCalledTimes(1);
  });

  it("never executes deployment if its native confirmation is cancelled", async () => {
    useWorkbenchStore.setState({
      profiles: [{
        id: "deploy-1", name: "Publish firmware", kind: "deploy",
        repositoryRoot: "D:/repo", program: "deploy-tool", args: ["--target", "test"],
      }],
    });
    backend.confirmDeploymentWorkflow.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);
    await user.click(screen.getByRole("button", { name: /^run$/i }));
    expect(backend.confirmDeploymentWorkflow).toHaveBeenCalledWith("Publish firmware",
      [expect.objectContaining({ program: "deploy-tool" })]);
    expect(backend.processSpawn).not.toHaveBeenCalled();
    expect(backend.buildWorkflowStart).not.toHaveBeenCalled();
  });

  it("does not run unsupported Windows-only Keil presets on other hosts", async () => {
    useWorkbenchStore.setState({ profiles: [] });
    backend.buildWorkflowDiscover.mockResolvedValueOnce([{
      id: "keil-foo", name: "Keil · firmware.uvprojx", kind: "build",
      tool: "Keil MDK / µVision", description: "Windows only",
      supported: false, steps: [{ name: "Compile", program: "UV4.exe", args: ["-b", "firmware.uvprojx"] }],
    }]);
    render(<ProcessRunner cwd="/repo" repositoryRoot="/repo" enabled />);
    expect(await screen.findByRole("button", { name: "Build now" })).toBeDisabled();
  });

});
