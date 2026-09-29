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

## Current status — V0.1 foundation

The first slice is already designed for daily local use:

- polished Tauri desktop shell
- persisted list of local repositories
- native folder picker
- native, read-only Git inspection
- current branch and HEAD
- dirty/staged/unstaged/untracked counts
- changed-file inventory
- Git worktree inventory
- recent commit history
- preview mode when running as a normal web page
- architecture and safety boundary ready for PTY, review, verification and agents

The embedded terminal surface is deliberately non-executing in V0.1. PTY/process execution lands in V0.2 behind a reviewed native boundary.

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
