# VirtualLab

**VirtualLab** is a local-first **Engineering Workbench / Engineering Control Plane** for managing repositories, isolated workspaces, execution, verification and—later—coding agents.

The product is intentionally **workspace-first** rather than chat-first:

```text
Repository
  └─ Workspace
      ├─ Git worktree / branch
      ├─ Terminal + processes
      ├─ Changes / review
      ├─ Build / test / HIL checks
      ├─ PR state
      └─ Agent sessions (later)
```

Claude Code, Codex or other agents will attach to this model later; the workbench remains useful without them.

## Current status — V0.2 workspace execution

The first slice is already designed for daily local use:

- orange-accented Tauri desktop shell
- persisted list of local repositories
- native folder picker
- native, read-only Git inspection
- current branch and HEAD
- dirty/staged/unstaged/untracked counts
- changed-file inventory
- Git worktree inventory
- recent commit history
- preview mode when running as a normal web page
- native PowerShell/bash PTY with multi-terminal tabs
- Git worktree create/select/remove workflow
- structured build/test profiles with Run/Stop and streamed output
- filesystem-driven repository refresh
- architecture and safety boundary ready for review, verification and agents

V0.2 turns the shell into an execution workbench: PTY terminals, isolated worktrees, structured build/test processes and filesystem-driven refresh live behind typed native commands.

## Technology stack

### Desktop / native

- **Tauri 2**
- **Rust**
- native system WebView
- structured Tauri commands
- Git CLI adapter

### Frontend

- **React 19**
- **TypeScript**
- **Vite**
- **Tailwind CSS v4**
- shadcn/ui-compatible component structure
- **Zustand**
- **Lucide**

Planned:

- xterm.js + PTY process supervisor
- Monaco diff/review
- SQLite event/history store
- GitHub integration
- verification profiles
- Claude Code / Codex harness adapters

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Run locally

Prerequisites:

- Node.js 22+
- Rust stable
- Git
- platform prerequisites for Tauri 2
  - Windows: WebView2 and MSVC C++ Build Tools
  - macOS: Xcode Command Line Tools
  - Linux: WebKitGTK development packages

Install dependencies:

```bash
npm install
```

Run the desktop workbench:

```bash
npm run tauri:dev
```

Frontend-only preview:

```bash
npm run dev
```

The web preview shows representative data; native repository picking and Git inspection require the Tauri desktop runtime.

## Development checks

```bash
npm run typecheck
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Product direction

V0.2 adds isolated workspace execution with Git worktree lifecycle, xterm.js and a native PTY/process supervisor.

V0.3 adds diff/review and GitHub PR state.

V0.4 adds engineering verification gates for build, unit, HIL, hardware, soak and evidence.

V0.5 adds agent harnesses. The invariant remains:

> **Agent belongs to Workspace. Workspace does not belong to Agent.**

## Safety posture

Read-only inspection is the default. Destructive Git operations, firmware flashing, motor/power-stage enable and release/merge actions will require explicit human approval gates.

### Windows: `cargo metadata ... program not found`

VirtualLab's desktop runtime requires the Rust toolchain because Tauri compiles a native Rust host. The repository now wraps `tauri:dev` with a preflight that also discovers `%USERPROFILE%\\.cargo\\bin\\cargo.exe` when Cargo is installed but missing from the current Conda/PowerShell PATH.

Run:

```powershell
npm run doctor
npm run tauri:dev
```

If Rust is not installed, install rustup first (for example `winget install Rustlang.Rustup`), restart PowerShell, then run `rustup default stable` and retry.


## Control acceptance

Every interactive control introduced in V0.2 must have either an automated UI/native test or an explicit local acceptance step. The acceptance runner is Node-based and works on Windows, macOS and Linux. Run:

 ```bash
npm install
npm run test:controls
cargo test --manifest-path src-tauri/Cargo.toml
npm run acceptance:local
```

The control-to-test mapping is documented in [docs/CONTROL_ACCEPTANCE.md](docs/CONTROL_ACCEPTANCE.md).


## Local cross-platform build

Frontend-only preview:

```powershell
npm install
npm run dev
```

Production frontend build:

```powershell
npm run typecheck
npm run test:controls
npm run build
```

The frontend output is written to `dist/`.

Native Tauri development:

```powershell
npm run doctor
npm run tauri:dev
```

Native release build:

```powershell
npm run acceptance:local
npm run tauri:build
```

Build outputs are under `src-tauri/target/{debug|release}/`; platform bundles are under the corresponding `bundle/` directory.

Windows native builds require the Visual Studio Build Tools **Desktop development with C++** workload and WebView2. macOS native builds require Xcode Command Line Tools.


### Build/test profile scope

Run profiles are repository-scoped. A command configured for one repository is not shown or executed when another repository is active. The process working directory remains the selected workspace/worktree, so the same repository profile can be reused across its worktrees.

V0.2 intentionally ships with no universal build/test defaults because commands such as `npm run build` or `cargo check --manifest-path src-tauri/Cargo.toml` are project-specific.


### Standalone debug executable

`npm run tauri:dev` is a development session. The executable created under `src-tauri/target/debug/virtuallab.exe` during that session expects the Vite dev server configured by `build.devUrl`, so launching that dev-session executable after the Vite server has stopped can show a blank window.

For a directly launchable debug executable with frontend assets embedded, build with:

```powershell
npm run tauri:build:debug
```

Then run the generated standalone debug application for your platform:

```powershell
# Windows
.\src-tauri\target\debug\virtuallab.exe
```

```bash
# macOS / Linux binary path
./src-tauri/target/debug/virtuallab
```

On macOS, the bundled app is also available under `src-tauri/target/debug/bundle/macos/` when generated.

Debug bundles/installers are generated under `src-tauri/target/debug/bundle/`.

For the normal standalone release build use:

```powershell
npm run tauri:build
```


## V0.3 preparation

V0.1/V0.2 closeout locks Node/Rust dependencies, restores repository/worktree/tab context, normalizes check results and runs the shared acceptance gate on Windows, macOS and Linux. The next implementation contract is [V0.3 Review and GitHub](docs/V0.3_REVIEW_GITHUB.md).
