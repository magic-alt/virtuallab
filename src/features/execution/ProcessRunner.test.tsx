import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessRunner } from "./ProcessRunner";
import { useWorkbenchStore } from "@/stores/workbench";

const backend = vi.hoisted(() => ({
  importBuildScript: vi.fn().mockResolvedValue(null),
  chooseBuildProgram: vi.fn().mockResolvedValue(null),
  buildWorkflowDiscover: vi.fn().mockResolvedValue([]),
  buildWorkflowSelfUpdateAvailable: vi.fn().mockResolvedValue(false),
  buildWorkflowStart: vi.fn().mockResolvedValue(undefined),
  confirmSelfBuildRestart: vi.fn().mockResolvedValue(true),
  buildWorkflowCancel: vi.fn().mockResolvedValue(undefined),
  confirmDeploymentWorkflow: vi.fn().mockResolvedValue(true),
  listRuns: vi.fn().mockResolvedValue([]),
  processSpawn: vi.fn().mockResolvedValue(undefined),
  processStop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/backend", () => ({
  importBuildScript: backend.importBuildScript,
  chooseBuildProgram: backend.chooseBuildProgram,
  buildWorkflowDiscover: backend.buildWorkflowDiscover,
  buildWorkflowSelfUpdateAvailable: backend.buildWorkflowSelfUpdateAvailable,
  buildWorkflowStart: backend.buildWorkflowStart,
  confirmSelfBuildRestart: backend.confirmSelfBuildRestart,
  buildWorkflowCancel: backend.buildWorkflowCancel,
  confirmDeploymentWorkflow: backend.confirmDeploymentWorkflow,
  listRuns: backend.listRuns,
  processSpawn: backend.processSpawn,
  processStop: backend.processStop,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

describe("ProcessRunner controls", () => {
  beforeEach(() => {
    backend.importBuildScript.mockReset().mockResolvedValue(null);
    backend.buildWorkflowDiscover.mockReset().mockResolvedValue([]);
    backend.buildWorkflowSelfUpdateAvailable.mockReset().mockResolvedValue(false);
    backend.buildWorkflowStart.mockReset().mockResolvedValue(undefined);
    backend.confirmSelfBuildRestart.mockReset().mockResolvedValue(true);
    backend.buildWorkflowCancel.mockReset().mockResolvedValue(undefined);
    backend.confirmDeploymentWorkflow.mockReset().mockResolvedValue(true);
    backend.listRuns.mockReset().mockResolvedValue([]);
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

  it("keeps long build logs within the pane and does not move the whole workspace", async () => {
    const outputText = Array.from({ length: 1200 }, (_, i) => `compiler diagnostic line ${i}`).join("\n");
    backend.listRuns.mockResolvedValueOnce([{
      id: "long-build", cwd: "D:/workspace", label: "Large build",
      isWorkflow: false, status: "running", output: outputText,
      exitCode: null, stepName: null, revision: 1,
    }]);
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);

    expect(screen.getByTestId("run-layout")).toHaveClass(
      "xl:h-full", "xl:min-h-0", "xl:grid-rows-[minmax(0,1fr)]",
    );
    expect(screen.getByTestId("run-workflows-scroll")).toHaveClass(
      "xl:overflow-y-auto", "xl:min-h-0",
    );
    expect(screen.getByTestId("run-output-panel")).toHaveClass(
      "overflow-hidden", "xl:h-full", "xl:min-h-0",
    );

    const log = screen.getByRole("log", { name: "Build / package output" }) as HTMLPreElement;
    expect(log).toHaveClass("min-h-0", "flex-1", "overflow-y-auto", "overscroll-contain");
    expect(log).toHaveAttribute("tabindex", "0");
    await waitFor(() => expect(log.textContent).toContain("compiler diagnostic line 1199"));

    // Scrolling up pauses follow-tail instead of snapping back to the bottom.
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 10_000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    expect(screen.getByRole("button", { name: "Latest output" })).toBeInTheDocument();
    expect(log.scrollTop).toBe(100);

    await user.click(screen.getByRole("button", { name: "Latest output" }));
    expect(log.scrollTop).toBe(10_000);
    expect(screen.queryByRole("button", { name: "Latest output" })).not.toBeInTheDocument();
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
    expect(screen.getByText("stopping")).toBeInTheDocument();
    expect(screen.queryByText("stopped")).not.toBeInTheDocument();
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

  it("makes the full desktop build distinct from frontend-only npm compilation", async () => {
    useWorkbenchStore.setState({ profiles: [] });
    backend.buildWorkflowDiscover.mockResolvedValueOnce([
      {
        id: "npm-tauri-package", name: "Tauri · Desktop build", kind: "package",
        tool: "Node.js / Tauri", supported: true,
        description: "Build the frontend, Rust backend and desktop bundle.",
        steps: [{ name: "Build desktop app", program: "npm", args: ["run", "tauri:build"] }],
      },
      {
        id: "npm-build", name: "npm · Frontend only", kind: "build",
        tool: "Node.js / npm", supported: true,
        description: "This does not compile Rust or generate an installer.",
        steps: [{ name: "Build frontend", program: "npm", args: ["run", "build"] }],
      },
    ]);
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/repo" repositoryRoot="D:/repo" enabled />);
    expect(await screen.findByRole("button", { name: "Build desktop app" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Build configuration' }), 'npm-build');
    expect(screen.getByRole("button", { name: "Build frontend" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Build configuration' }), 'npm-tauri-package');
    await user.click(screen.getByRole("button", { name: "Build desktop app" }));
    expect(backend.processSpawn).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "D:/repo", program: "npm", args: ["run", "tauri:build"],
    }));
  });

  it("builds the running desktop app in isolation and restarts only after confirmation", async () => {
    useWorkbenchStore.setState({ profiles: [] });
    backend.buildWorkflowDiscover.mockResolvedValueOnce([{
      id: "npm-tauri-package", name: "Tauri · Desktop build", kind: "package",
      tool: "Node.js / Tauri", supported: true, description: "Full package",
      steps: [{ name: "Build desktop app", program: "npm", args: ["run", "tauri:build"] }],
    }]);
    backend.buildWorkflowSelfUpdateAvailable.mockResolvedValueOnce(true);
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/repo" repositoryRoot="D:/repo" enabled />);
    await user.click(await screen.findByRole("button", { name: "Build desktop app" }));
    expect(backend.buildWorkflowSelfUpdateAvailable).toHaveBeenCalledWith("D:/repo");
    expect(backend.confirmSelfBuildRestart).toHaveBeenCalledTimes(1);
    expect(backend.buildWorkflowStart).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "D:/repo", restartAfterBuild: true,
      steps: [{ name: "Build desktop app", program: "npm", args: ["run", "tauri:build"] }],
    }));
    expect(backend.processSpawn).not.toHaveBeenCalled();
  });

  it("does not begin a self-restart build when the user declines", async () => {
    useWorkbenchStore.setState({ profiles: [] });
    backend.buildWorkflowDiscover.mockResolvedValueOnce([{
      id: "npm-tauri-package", name: "Tauri · Desktop build", kind: "package",
      tool: "Node.js / Tauri", supported: true, description: "Full package",
      steps: [{ name: "Build desktop app", program: "npm", args: ["run", "tauri:build"] }],
    }]);
    backend.buildWorkflowSelfUpdateAvailable.mockResolvedValueOnce(true);
    backend.confirmSelfBuildRestart.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/repo" repositoryRoot="D:/repo" enabled />);
    await user.click(await screen.findByRole("button", { name: "Build desktop app" }));
    expect(backend.buildWorkflowStart).not.toHaveBeenCalled();
    expect(backend.processSpawn).not.toHaveBeenCalled();
  });

  it("does not restart VirtualLab when packaging a different Tauri repository", async () => {
    useWorkbenchStore.setState({ profiles: [] });
    backend.buildWorkflowDiscover.mockResolvedValueOnce([{
      id: "npm-tauri-package", name: "Tauri · Desktop build", kind: "package",
      tool: "Node.js / Tauri", supported: true, description: "Full package",
      steps: [{ name: "Build desktop app", program: "npm", args: ["run", "tauri:build"] }],
    }]);
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/other" repositoryRoot="D:/other" enabled />);
    await user.click(await screen.findByRole("button", { name: "Build desktop app" }));
    expect(backend.buildWorkflowSelfUpdateAvailable).toHaveBeenCalledWith("D:/other");
    expect(backend.confirmSelfBuildRestart).not.toHaveBeenCalled();
    expect(backend.processSpawn).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "D:/other", program: "npm", args: ["run", "tauri:build"],
    }));
  });

  it("discovers Qt CMake steps and triggers a single native sequential run", async () => {
    backend.buildWorkflowDiscover.mockResolvedValueOnce([{
      id: "cmake-configure-build", name: "Qt / CMake · Build", kind: "build",
      tool: "Qt / CMake", supported: true, description: "Configure and build",
      steps: [
        { name: "Configure", program: "cmake", args: ["-S", ".", "-B", "build/auto"] },
        { name: "Compile", program: "cmake", args: ["--build", "build/auto", "--config", "Release"] },
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

  it("executes a project-owned CMake preset inside the selected worktree", async () => {
    useWorkbenchStore.setState({ profiles: [] });
    backend.buildWorkflowDiscover.mockResolvedValueOnce([{
      id: "cmake-preset-windows-mingw-release-qt6",
      name: "Qt / CMake · Windows MinGW Release / Qt6",
      kind: "build",
      tool: "Qt / CMake",
      supported: true,
      description: "Project-defined CMake build preset.",
      steps: [
        { name: "Configure", program: "cmake", args: ["--preset", "windows-mingw-release-qt6"] },
        { name: "Compile", program: "cmake", args: ["--build", "--preset", "windows-mingw-release-qt6"] },
      ],
    }]);
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/repo/.worktrees/feature" repositoryRoot="D:/repo" enabled />);
    expect(await screen.findByText("Qt / CMake · Windows MinGW Release / Qt6")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Build now" }));
    expect(backend.buildWorkflowStart).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "D:/repo/.worktrees/feature",
      steps: [
        { name: "Configure", program: "cmake", args: ["--preset", "windows-mingw-release-qt6"] },
        { name: "Compile", program: "cmake", args: ["--build", "--preset", "windows-mingw-release-qt6"] },
      ],
    }));
  });

  it("shows one build recipe at a time and runs the selected MSVC configuration", async () => {
    useWorkbenchStore.setState({ profiles: [] });
    backend.buildWorkflowDiscover.mockResolvedValueOnce(['MinGW', 'MSVC'].map(tool => ({
      id: tool, name: `${tool} Release`, kind: 'build', tool, supported: true,
      description: `${tool} project configuration`,
      steps: [{ name: 'Build', program: 'cmake', args: ['--build', '--preset', tool] }],
    })));
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);
    const selector = await screen.findByRole('combobox', { name: 'Build configuration' });
    expect(screen.getAllByRole('button', { name: 'Build now' })).toHaveLength(1);
    await user.selectOptions(selector, 'MSVC');
    expect(screen.queryByText('MinGW project configuration')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Build now' }));
    expect(backend.processSpawn).toHaveBeenCalledWith(expect.objectContaining({args: ['--build', '--preset', 'MSVC']}));
  });

  it("imports a script for review and saves its interpreter and literal arguments", async () => {
    useWorkbenchStore.setState({ profiles: [] });
    backend.importBuildScript.mockResolvedValueOnce({
      id: 'script-build', name: 'Build script · build.ps1', kind: 'build', tool: 'Script',
      description: 'Selected script', supported: true,
      steps: [{ name: 'Build script', program: 'pwsh', args: ['-NoProfile', '-File', 'script/build.ps1', '-Label', ' a b '] }],
    });
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);
    await user.click(screen.getByRole('button', { name: 'Import build script' }));
    expect(await screen.findByLabelText('Program')).toHaveValue('pwsh');
    expect(backend.processSpawn).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(useWorkbenchStore.getState().profiles[0].args).toEqual(['-NoProfile', '-File', 'script/build.ps1', '-Label', ' a b ']);
  });

  it('ignores an imported script when its workspace was changed during the picker', async () => {
    let resolveImport!: (value: unknown) => void;
    backend.importBuildScript.mockReturnValueOnce(new Promise(resolve => { resolveImport = resolve; }));
    const user = userEvent.setup();
    const view = render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);
    await user.click(screen.getByRole('button', { name: 'Import build script' }));
    view.rerender(<ProcessRunner cwd="D:/other" repositoryRoot="D:/other" enabled />);
    resolveImport({ id:'old', name:'Old script', kind:'build', supported:true, tool:'Script', description:'', steps:[{name:'Build',program:'node',args:['build.js']}] });
    await waitFor(() => expect(backend.buildWorkflowDiscover).toHaveBeenLastCalledWith('D:/other'));
    expect(screen.queryByText('Edit run profile')).not.toBeInTheDocument();
  });

  it("uses the native workflow adapter for single-step Keil builds", async () => {
    useWorkbenchStore.setState({ profiles: [{id:'keil', name:'Firmware app', kind:'build', repositoryRoot:'D:/repo', program:'C:/Keil/UV4/UV4.exe',args:['-b','Board.uvprojx','-t','app']}] });
    const user = userEvent.setup();
    render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);
    await user.click(screen.getByRole('button', {name: /^run$/i}));
    expect(backend.buildWorkflowStart).toHaveBeenCalledWith(expect.objectContaining({steps:[expect.objectContaining({args:['-b','Board.uvprojx','-t','app']})]}));
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

it("reattaches to a native run after the panel remounts", async () => {
  backend.listRuns.mockResolvedValue([{ id: "native-one", cwd: "D:/workspace", label: "Restored build",
    isWorkflow: false, status: "running", output: "compiler output", exitCode: null, stepName: null, revision: 1 }]);
  const user = userEvent.setup();
  const view = render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);
  expect(await screen.findByText("compiler output", { exact: false })).toBeInTheDocument();
  view.unmount();
  render(<ProcessRunner cwd="D:/workspace" repositoryRoot="D:/repo" enabled />);
  expect(await screen.findByText("compiler output", { exact: false })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /stop/i }));
  expect(backend.processStop).toHaveBeenCalledWith("native-one");
});
