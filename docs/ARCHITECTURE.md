# VirtualLab architecture

VirtualLab is a **local-first Engineering Workbench / Engineering Control Plane**. The durable abstraction is the workspace, not an AI chat session.

## Architecture principles

1. **Workspace owns execution context.** Repository, branch/worktree, terminal, checks, diff and future agent sessions all hang from one workspace.
2. **AI is an adapter, not the product core.** Claude Code, Codex, OpenCode or other agents can be added later without changing the workspace model.
3. **Native operations stay behind a narrow Rust boundary.** The frontend requests typed commands; Rust performs filesystem/process/Git operations.
4. **No arbitrary shell from UI commands.** V0.1 uses fixed Git subcommands and structured arguments to avoid command injection.
5. **Hardware-changing actions require explicit human approval.** Flashing, drive enable, power-stage enable, destructive Git operations and merge actions will be gated.
6. **Local-first and offline-capable.** Git inspection and workspace inventory must work without cloud services.

## Layers

```text
React / TypeScript UI
  ├─ features/sidebar
  ├─ features/workspace
  ├─ stores
  └─ typed backend client
          │ Tauri invoke/events
          ▼
Rust native core
  ├─ git service
  ├─ workspace service        (next)
  ├─ PTY/process supervisor   (next)
  ├─ filesystem watcher       (next)
  └─ persistence              (next)
          │
          ├─ git
          ├─ PowerShell/bash
          ├─ build/test tools
          └─ agent harnesses  (later)
```

## Frontend stack

- React 19 + TypeScript
- Vite
- Tailwind CSS v4
- shadcn/ui-compatible component layout
- Zustand for local application state
- Lucide icons

Planned adapters:

- xterm.js for embedded PTY terminal
- Monaco diff/editor for review
- event stream for build/test/agent activity

## Native stack

- Tauri 2
- Rust 2021
- Tauri dialog plugin
- Git CLI through `std::process::Command` in V0.1

Git is intentionally CLI-backed at first. It matches developer machines, supports worktree semantics well and avoids prematurely coupling the product to libgit2 behavior.

## Domain model

```text
Repository
  └─ Workspace
      ├─ Git worktree / branch
      ├─ Terminal session(s)
      ├─ Build / test run(s)
      ├─ Change set / review
      ├─ Verification checks
      ├─ PR metadata
      └─ Agent session(s)
```

The workspace survives even when there is no agent attached.

## Event model direction

Long-running operations should converge on an append-only event envelope:

```ts
type WorkbenchEvent =
  | { type: "process.started"; ... }
  | { type: "process.output"; ... }
  | { type: "process.finished"; ... }
  | { type: "git.changed"; ... }
  | { type: "check.updated"; ... }
  | { type: "agent.started"; ... }
  | { type: "agent.tool"; ... }
  | { type: "agent.finished"; ... }
```

This gives the UI one streaming model for terminals, builds, HIL runs and future agents.

## Security boundary

The native layer must distinguish:

- **read-only:** inspect repository, diff, log, status
- **reversible write:** create branch/worktree, stage files
- **destructive:** reset, clean, force push, delete worktree
- **hardware / release:** flash, enable motor/power stage, merge/release

Destructive and hardware/release operations must never execute from an implicit agent decision.
