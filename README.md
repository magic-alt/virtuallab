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

Optional agent harnesses can attach to this model, but the workbench remains useful without them.

**Project independence:** VirtualLab is a general-purpose local workbench. It never assumes a specific GitHub repository, firmware project, hardware board, device ID, or lab setup. All repositories are selected by the user, all build/test profiles are workspace-scoped, and any third-party hardware extension must be explicitly configured. Generic HIL/verification gate types are not connections to a particular project.

## Current implementation status

**V0.1/V0.2:** completed local workbench foundation and workspace execution.  
**V0.3 A/B:** completed local Git diff + read-only Monaco review, persisted line drafts, and optional `gh` GitHub PR/issue integration.  
**V0.3 C:** Review loop merged in PR #12: explicit Issue/PR → worktree creation, Review → Fix → Refresh → Re-review phase, HEAD/base correlation and stale-diff invalidation. Desktop manual acceptance remains a separate verification step.  
**V0.4:** versioned verification profile, native process runner, cancellation/timeout, per-run evidence directory, SHA-256 artifacts and restricted hardware lease/approval *contract*. Full evidence history/release UI and physical hardware integration are not implemented.  
**V0.5 (development branch):** Agent tab with bounded live event timeline, workspace-scoped custom roles and opt-in skills; Codex, DeepSeek-through-Codex, Claude Code and OpenCode adapters. Protected hardware operations remain DENY without an independently enforcing external provider. Cross-platform CI and manual desktop acceptance are required before release.

This repo ships independently of other application repositories or hardware labs. Local review works without GitHub authentication; the optional GitHub panel uses an existing `gh` login and never stores a token.

### V0.3 Review loop

1. Add/select a local repository and open the **GitHub** tab.
2. With authenticated `gh`, load a PR/issue URL belonging to that repository.
3. Click **New issue worktree** or **New PR worktree**, inspect/edit the suggested local branch and base ref, then explicitly **Create workspace**. The link to the source issue/PR persists per worktree. No automatic PR branch checkout, remote fetch or merge occurs.
4. Select **Changes**, inspect a read-only diff and create a line-scoped local draft.
5. Mark **fix in progress**; edit using the Terminal or an external editor.
6. Click **Refresh and re-review**. Any open diff is invalidated, so reload the selected file (or base file list), inspect again and click **Mark reviewed**.
7. In GitHub, only a draft tied to the current HEAD can be posted and only when local HEAD matches PR head; posting requires an explicit confirmation. Local HEAD equal to PR base is **not** sufficient.

Refresh/re-review is a local workflow, not a proof that the remote PR has been updated. PR metadata and checks require an explicit GitHub refresh/reload to reflect upstream changes.

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

Implemented adapters include xterm.js/PTy, Monaco read-only diff, optional `gh` GitHub context, native verification runner and four optional agent adapter identities. The Agent tab shows a bounded live event timeline; durable searchable agent history and independently enforced hardware controls remain future work.

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

Install locked dependencies:

```bash
npm ci
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
npm run test:controls
npm run build
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

## Product direction

V0.2 provides isolated worktrees, native PTY and process supervision.

V0.3 adds diff/review, optional GitHub PR/issue context and the explicit Review loop.

V0.4 adds a restricted native verification runner, evidence files and policy contracts; hardware gates remain blocked pending real enforcement.

V0.5 adds the Agent workspace UI, optional roles/skills and Codex, DeepSeek, Claude Code and OpenCode harness support. See [V0.5 harness guide](docs/V0.5_AGENT_HARNESSES.md) for setup, provider limitations and acceptance. The invariant remains:

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

Every new interactive control must have an automated UI/native test and/or an explicit desktop acceptance step. V0.3 Review loop controls and safety gates are mapped in the control acceptance document. The acceptance runner is Node-based and works on Windows, macOS and Linux. Run:

 ```bash
npm ci
npm run test:controls
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run acceptance:local
```

The control-to-test mapping is documented in [docs/CONTROL_ACCEPTANCE.md](docs/CONTROL_ACCEPTANCE.md).


## Local cross-platform build

Frontend-only preview:

```powershell
npm ci
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


## Implementation contracts

See [V0.5 agent harnesses](docs/V0.5_AGENT_HARNESSES.md), [V0.3 review and GitHub](docs/V0.3_REVIEW_GITHUB.md), [V0.4 verification and hardware policy](docs/V0.4_VERIFICATION_HARDWARE_POLICY.md), [V0.4/V0.5 agent foundation](docs/V0.4_V0.5_AGENT_FOUNDATION.md), and the [control acceptance matrix](docs/CONTROL_ACCEPTANCE.md). CI uses Windows/macOS/Linux desktop acceptance; actual third-party GitHub authentication and PR posting are manual desktop checks.


### Windows: terminal windows repeatedly flash open and closed

Background Git/GitHub/where/Codex/build probes are launched with the Windows
`CREATE_NO_WINDOW` flag. This prevents short-lived console windows from
appearing during workspace startup and watcher-driven refresh. The filesystem
watcher also ignores access-only events to prevent read→rescan loops, without
disabling the explicit embedded xterm.js terminal. The fix requires
**rebuilding the native executable**; running an older built `.exe` will
still exhibit the old behavior. Refer to
[Windows console flash regression acceptance](docs/CONTROL_ACCEPTANCE.md#windows--recurring-console-flash-regression).
