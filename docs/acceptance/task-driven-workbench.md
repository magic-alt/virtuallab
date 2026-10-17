# Task-driven Workbench acceptance record

## Candidate and host

- Baseline: `feat/task-driven-workbench@1afa6ef`; inspect the implementation commit
  and clean/dirty state before each desktop/provider qualification.
- Current work: Profile library, task guidance/navigation and task Run inventory.
- Local host: macOS 26.7.1 (25G241), Node 26.0.0, npm 12.0.2,
  cargo 1.98.1, rustc 1.98.1.
- This record distinguishes automated source checks from actual desktop/provider
  observations. A printed acceptance checklist is not evidence it was performed.

## Automated observations

- Locked `npm ci`: passed during setup; dependency install scripts blocked by
  the host's existing npm policy were reported, not manually enabled.
- Baseline frontend: 298 passed, 1 pre-existing skip.
- Profile library: 11 focused native tests passed; frozen accepted-task Profile
  regression passed separately.
- Host-permission native suite after Profile implementation: 324 passed, 0 failed.
  The sandbox-only run failed existing process-inspection and watcher tests;
  the host-permission rerun passed without weakening tests.
- Final candidate checks and independent-review result: pending; update below
  after running them on the implementation.

## Manual scenario: first task

All entries below are **unperformed** until a named host/version and actual
observations are recorded. Unit/UI tests do not close these entries.

- [ ] Launch the packaged application and record app commit/dirty state, host,
  actual provider executable/version, authentication result and toolchain.
- [ ] With no existing tasks, create/save/reopen a Profile. Preserve Unicode and
  spaced arguments. Confirm concurrent-editor revision conflict preserves draft.
- [ ] Simulate unavailable/corrupt Profile storage using a disposable app-data
  fixture. Confirm preserved data, actionable error and usable repository tools.
- [ ] Select a user-chosen repository, provision locked dependencies separately,
  accept a scoped plan with the copied Profile, explicitly prepare its worktree.
- [ ] Start an authenticated Codex task, inspect candidate changes and run native
  verification. Observe a failed check, explicit repair and a fresh Run.
- [ ] Change source without changing HEAD, restore bytes, change a selected tool
  and restart. Old evidence must not regain qualification automatically.
- [ ] Review and accept the exact new Run; export and inspect passport lineage.
- [ ] Across all new pages, confirm terminals remain mounted, small-window/CSP
  behavior works, and navigation never starts work. Test cancellation and native
  confirmation cancellation independently.

## Manual scenario: V0.7 integrated delivery

Prerequisite: user selects a disposable CMake C++ repository and a supported
provisioned host. No application-specific path or project connector is bundled.

- [ ] Record repository/base commit, CMake/Ninja/compiler and two actual Codex
  instance identities. Exploratory CMake configuration is separate from formal
  build/test qualification; unsupported launchers remain unqualified.
- [ ] Accept two independent implementation tasks and one integration task in
  the same repository. Explicitly create three isolated worktrees and inspect
  accepted scopes, including all integration source changes and conflict repairs.
- [ ] Run the two Codex tasks concurrently, freeze candidates and obtain fresh
  required prerequisite checks. Confirm a queued third task respects slot limits.
- [ ] Preview exact fixed sources and dedicated target HEAD, then explicitly
  confirm through the expiring single-use native dialog. Reject stale previews
  and failed/rejected/changed prerequisites.
- [ ] Demonstrate independently passing source branches with a failing integrated
  build/test. Confirm delivery remains blocked.
- [ ] Resolve/commit a repair explicitly and verify final integrated inputs. Test
  conflict/interruption recovery without implicit mutation replay.
- [ ] Confirm same-HEAD/source/tool/restart invalidation, fresh revision-and-Run
  review/acceptance, and passport dependency/Run/toolchain lineage.
- [ ] Treat any PR publication/CI/merge/release as a separately authorized action;
  local acceptance never grants remote authorization.

## Host qualification matrix

| Gate | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Final locked dependency install, frontend checks/build | Pending final run | Unperformed | Unperformed |
| Locked Rust check/tests | Earlier local run passed; final pending | Unperformed | Unperformed |
| `npm run acceptance:local` | Pending final run | Unperformed | Unperformed |
| Packaged GUI / CSP / native dialogs | Unperformed | Unperformed | Unperformed |
| Authenticated two-Codex / three-worktree CMake delivery | Unperformed; project selection requested | Unperformed | Unperformed |

Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`,
`cargo check --locked --manifest-path src-tauri/Cargo.toml`,
`cargo test --locked --manifest-path src-tauri/Cargo.toml`, and
`npm run acceptance:local` on the appropriate hosts. Existing CI has Linux locked
Rust check and the local acceptance runner on all three platforms. Remote CI
results have not been queried or asserted by this record. No V0.6/V0.7 release,
provider, packaged-GUI or cross-platform gate is closed merely by source presence.
