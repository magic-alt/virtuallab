# VirtualLab architecture

VirtualLab is a **local-first Engineering Workbench / Engineering Control Plane**. The durable abstraction is the workspace, not an AI chat session.

## Architecture principles

1. **Workspace owns execution context.** Repository, branch/worktree, terminal, checks, diff and future agent sessions all hang from one workspace.
2. **AI is an adapter, not the product core.** Codex is integrated as an initial optional harness bridge; other agents can be added later without changing the workspace model.
3. **Native operations stay behind a narrow Rust boundary.** The frontend requests typed commands; Rust performs filesystem/process/Git operations.
4. **Typed native operations.** Interactive PTYs are human-controlled; Git/GitHub/verification services use narrowly defined Tauri commands, not arbitrary agent-supplied shell strings.
5. **Hardware-changing actions require explicit human approval.** Flashing, drive enable, power-stage enable, destructive Git operations and merge actions will be gated.
6. **Local-first and offline-capable.** Git inspection and workspace inventory must work without cloud services.

## Layers

```text
React / TypeScript UI
  ├─ features/sidebar
  ├─ features/workspace
  ├─ Monaco review + GitHub panel
  ├─ stores / typed adapters
  └─ typed backend client
          │ Tauri invoke/events
          ▼
Rust native core
  ├─ git service
  ├─ workspace service
  ├─ PTY/process supervisor
  ├─ filesystem watcher
  ├─ restricted verification runner + hashed evidence files
  ├─ Codex app-server transport + private hardware policy contract
  └─ persisted workspace context
          │
          ├─ git
          ├─ PowerShell/bash
          ├─ build/test tools
          └─ Codex app-server (foundation only; UI later)
```

## Frontend stack

- React 19 + TypeScript
- Vite
- Tailwind CSS v4
- shadcn/ui-compatible component layout
- Zustand for local application state
- Lucide icons

Implemented: xterm.js/PTy, structured `workbench://event`, Monaco read-only diff, optional `gh` PR/issue context, and initial Codex app-server transport. Full agent workspace UI and durable cross-run event history are still planned.

## Native stack

- Tauri 2
- Rust 2021
- Tauri dialog plugin
- Git CLI through `std::process::Command`
- portable-pty for PowerShell/bash sessions
- notify for workspace change observation

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

## V0.2 execution boundary

Interactive terminals and build/test processes are separate execution paths:

- **Terminal:** true PTY, interactive input, resize and Ctrl+C. Intended for human-driven shells and future agent harnesses.
- **Process profile:** structured executable + argument vector + working directory. Intended for repeatable build/test/check commands; it does not accept a shell command string.
- **Worktree mutation:** branch validation plus clean-only worktree removal. Primary worktree removal is refused.
- **Filesystem watcher:** emits debounced UI refresh signals while ignoring generated-heavy directories such as `.git`, `node_modules`, `target` and `dist`.

On Windows, `.cmd`/`.bat` process profiles are routed through `cmd.exe /d /s /c` only after the program and its arguments have already been separated by the profile model. Arbitrary command strings are not exposed as an agent API.


## V0.2 persisted workspace context

The local Zustand store persists one workspace context per repository: active worktree path, active tab and update timestamp. Repository switching restores that context. If a remembered worktree no longer exists, VirtualLab falls back to the primary repository and Overview. Runtime PTY/process objects are deliberately not persisted.

## V0.2 normalized checks

Repository readiness and process outcomes share a typed `CheckResult` contract with stable ID, source, status, detail, observation time and optional exit code. V0.2 uses this for local readiness semantics; V0.4 now persists per-run manifests, hashes, and logs; history search and enforceable release gates are future work.

## V0.3 review boundary

V0.3 starts read-oriented: Git diff retrieval and GitHub PR/check metadata are read-only adapters. Inline review drafts may be edited locally before network mutation. Posting comments, changing PR state and merge/release remain explicit user actions.


## V0.4 → V0.5 agent and verification bridge

The first V0.4/V0.5 bridge keeps the workspace as the durable owner while adding a thin agent-harness runtime and versioned verification contracts.

- Frontend harness code depends on the `HarnessAdapter` interface; the first implementation is `CodexAppServerAdapter`.
- Rust `AgentManager` owns only the local Codex app-server process and JSON-RPC transport. Repository/workspace state is not owned by Codex.
- Each workspace has at most one persisted Codex thread binding. The binding survives application restart; the app-server process does not. A later attach resumes the saved thread id.
- VirtualLab talks to `codex app-server` over stdio JSON-RPC and emits structured `agent://event` notifications. UI code must not scrape the Codex TUI or terminal text.
- Until VirtualLab owns approval routing, Codex sessions use `workspace-write` with `approvalPolicy = "never"`. This permits workspace-local edits while failing closed for operations that need elevation.
- `VerificationProfile` defines versioned build/unit/HIL/hardware/soak/evidence gates using structured executable + argument vectors or future typed adapters.
- `EvidenceManifest` binds a verification run to the workspace, repository HEAD, individual gate results, artifacts, and optional firmware/bitstream/DUT/hardware-revision metadata.

This slice defines the contracts but does not yet make an agent authoritative for verification. The restricted native verification runner writes evidence into `.virtuallab/evidence/<run-id>/`. A private hardware lease policy contract exists but cannot authorize real hardware: there is no public grant-minting method, physical interlock, or approved hardware execution provider. Release readiness UI, searchable history and complete authorization are not implemented.

See [V0.4 → V0.5 agent foundation](./V0.4_V0.5_AGENT_FOUNDATION.md).


## V0.3 review loop (current)

```text
Authenticated same-origin issue / PR reference
  → user confirms new local Git worktree
  → workspace-local source reference + review state
  → Changes diff / optional local line draft
  → fix in Terminal or external editor
  → refresh native Git snapshot; invalidate cached Monaco diff
  → reload changed file / base file list → mark reviewed
  → optional explicit, confirmed GitHub comment (PR head match only)
```

Source references are workspace-local and restored when that worktree is revisited. `baseRefOid` and `headRefOid` from `gh pr view --json` are compared with the local (abbreviated) Git HEAD; a local HEAD at PR base does not authorize posting to PR head. A new worktree starts at a user-selected **local** base ref, not at a remote PR branch. Changes/Monaco always remain read-only. A post-refresh diff is considered invalid until explicitly reloaded.

The native boundary continues to reject nonmatching GitHub repository URLs; no automatic fetch/checkout/merge/reset/force-push behavior was added. Workspace and review state remain meaningful offline.
