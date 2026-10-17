# Task-driven Workbench acceptance record

## Candidate and host

- Baseline: `feat/task-driven-workbench@1afa6ef`; inspect the implementation commit
  and clean/dirty state before each desktop/provider qualification.
- Product source checkpoint: `0961dac` (implementation `2c54e7a` plus review fixes).
  The final acceptance began on the matching working-tree changes before the fix
  commit; no subsequent product-source change was made.
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
- Independent review: `1afa6ef..2c54e7a`, four Important issues and one recovery
  guidance issue (promoted from Minor) fixed in `0961dac`, each with failing then
  passing regressions. No Critical issue was reported; no confirmed issue was
  left deferred. Fix validation used tests; no independent re-review is claimed.
- Final frontend suite: 327 passed / 1 pre-existing skipped; typecheck passed.
  The final acceptance runner's earlier frontend stage had 326 passed / 1 skipped;
  the additional export round-trip regression and full 327-test suite passed
  separately without a subsequent product-source change.
- Production build and macOS `cargo check --offline --locked --manifest-path
  src-tauri/Cargo.toml`: passed. Six existing unused-code warnings remain.
- `RUST_TEST_THREADS=4 npm run acceptance:local`: exited 0. Its locked native suite
  passed 325 tests, 0 failed (329.31 seconds). Every native test and original
  deadline remained enabled; test parallelism was limited to four on this host.
- Earlier runner attempts failed at unchanged watcher UI timing assertions and
  native integration-cancellation elapsed time under concurrent load. The affected
  tests passed unchanged in isolated reruns; the final limited-concurrency runner
  passed. These observations do not establish that timing sensitivity is absent.
- New native backing-file replacement/deletion regression passed; Profile suite
  12 passed. Disk-content changes are detected and preserved, not automatically
  repaired. This is still a single-application manager, not interprocess locking.
- `git diff --check` and local documentation links passed. No new native process,
  shell or Git operation was introduced by the Profile library.

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
| Locked dependency install, frontend checks/build | Passed | Unperformed | Unperformed |
| Locked Rust check/tests | Passed: 325 native tests | Unperformed | Unperformed |
| `npm run acceptance:local` | Passed with Rust test concurrency 4 | Unperformed | Unperformed |
| Packaged GUI / CSP / native dialogs | Unperformed | Unperformed | Unperformed |
| Authenticated two-Codex / three-worktree CMake delivery | Unperformed; project selection requested | Unperformed | Unperformed |

Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`,
`cargo check --locked --manifest-path src-tauri/Cargo.toml`,
`cargo test --locked --manifest-path src-tauri/Cargo.toml`, and
`npm run acceptance:local` on the appropriate hosts. Existing CI has Linux locked
Rust check and the local acceptance runner on all three platforms. Remote CI
results have not been queried or asserted by this record. No V0.6/V0.7 release,
provider, packaged-GUI or cross-platform gate is closed merely by source presence.
