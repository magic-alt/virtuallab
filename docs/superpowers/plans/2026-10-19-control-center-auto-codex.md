# Control center automatic Codex execution implementation plan

> **For agentic workers:** Use Superpowers test-driven development and verification before completion. Root coordinates distinct native and presentation changes and performs a final independent review.

**Goal:** Complete the single-action task-to-worktree-to-Codex-to-report workflow.

**Architecture:** Reuse the existing native task coordinator and supervised Codex
process. Add a typed idempotent launch boundary and separately persisted attempt
reports, then expose them through the existing task observer and control center.

**Tech Stack:** React/TypeScript/Zustand, Tauri/Rust, Git, Codex app-server.

**Spec:** `docs/superpowers/specs/2026-10-19-control-center-auto-codex-design.md`

## Global constraints

- Native owns processes and Git. No new arbitrary shell execution path.
- Preserve workspace identity and exact task/attempt/thread/turn correlation.
- Keep verification, review, and acceptance independent of execution success.
- Preserve Windows, spaces, Unicode paths, existing task data, and advanced flows.
- Changes stay on `feat/control-center-auto-codex-20261019`, initially based on
  main `31d29ce` and integrated with main `304ba43` before delivery.

## Review focus

- A lost launch response or rapid double click must not create a second worktree.
- A removed repository or changed HEAD must not launch or select a foreign task.
- Fast completion and foreign events must not drop or contaminate the report.
- A normal task without a profile or auto-commit must finish without false failure.
- Background completion must preserve explicit navigation and active terminals.
- Queued worktrees must survive merged cleanup, including creation-to-queue and
  provider-startup ownership handoffs.

## Task 1: Native launch and reporting

**Files:** `src-tauri/src/task_execution.rs`, task model/store, new report module,
`agent.rs`, `lib.rs`, relevant native tests.

**Interfaces:** Produce the launch and report contracts specified in the design;
consume existing validated worktree preparation, task queue, and Codex lifecycle.

- [x] Add failing regression tests for deduplication, partial failure, unprofiled
  completion, preserved uncommitted work, scoped reports, and bounded UTF-8 output.
- [x] Implement durable request lookup, sequential native setup, report observation,
  concrete failures, and execution/verification separation.
- [x] Run focused Rust tests and locked cargo check; inspect output.
- [x] Commit the native feature with the shared TypeScript boundary.

## Task 2: Prompt launch and persistent task observation

**Files:** `TaskQuickCreate.tsx`, `src/lib/tasks.ts`, `src/types/tasks.ts`,
`src/stores/tasks.ts`, their focused tests, prompt CSS.

**Interfaces:** Consume `launchTask`, `getTaskAttemptReport`, and report events.
Produce inline-compatible `TaskQuickCreate` with an `onLaunched(task)` callback;
store confirmed native tasks before selecting their execution tab.

- [x] Replace the plan-only expectation with a failing one-click launch test.
- [x] Cover request replay after a lost response, concurrent submission, changed
  repository/HEAD, partial launch errors, and explicit advanced plan editing.
- [x] Implement inline form, typed wrappers, immediate scoped task retention, and
  guarded execution-to-report navigation on observed completion.
- [x] Run focused frontend tests and typecheck; commit the launch workflow.

## Task 3: Unified control center and readable reports

**Files:** `WorkbenchShell.tsx`, `TaskControlCenter.tsx`, `TaskDetail.tsx`,
new report/console components, evidence presentation, focused tests and CSS.

**Interfaces:** Consume inline form and native report snapshots/invalidations;
keep internal evidence route keys while presenting 报告.

- [x] Add failing navigation, unprofiled-result, stale-response, and console tests.
- [x] Merge task list into control center, add bounded live execution console and
  result/problem summaries, keep prior implementation reports discoverable.
- [x] Run focused component tests; commit the presentation changes.

## Task 4: Integration and delivery

- [x] Update architecture and acceptance instructions for the actual workflow.
- [x] Run locked install, full frontend suite/typecheck/build, Rust check/tests,
  and local acceptance. Record any environment limits precisely.
- [x] Independently review the full branch and fix consequential findings with
  regression tests.
- Deliver the isolated feature branch and a reviewable PR. The PR and final
  handoff record its current CI status and remaining platform checks.

## Integration review

Independent review closed five concrete issues with regression coverage:

1. A composer mounted before repository setup must select the first added root;
   removing a selected root must leave an explicit selection control and the draft.
2. A late launch response must retain its task without replacing explicit task/tab
   navigation that happened while worktree preparation was pending.
3. Durable setup errors must expose reconciliation after restart without blocking
   corrected preparation after an absent or retired native preparation intent.
4. Report field budgets must leave room for JSON escaping within the file cap.
5. Definite acceptance rejection must durably close the request token before the
   UI refreshes its baseline; uncertain acceptance must retain the original token.

The final independent focused frontend review passed 61 tests across five files.
Version/icon consistency and the RC asset Node test passed.

## Local verification results

Verification ran on the feature tree based on main `31d29ce`:

| Gate | Result |
| --- | --- |
| Locked dependency install (`npm ci`) | Passed |
| TypeScript typecheck | Passed |
| Complete frontend suite | 511 passed, 1 skipped; 81 files passed, 1 skipped |
| Frontend production build | Passed |
| Locked native cargo check | Passed |
| Complete native suite | 399 passed, 0 failed, 1 existing selected-project probe ignored |
| Local acceptance runner | Passed; final process exit code 0 |
| Version, icon and RC asset consistency | Passed |
| Whitespace checks | Passed |

Native process tests used normal child-process permissions and an independent
temporary root. The first integrated run encountered one unchanged version-probe
fixture's `ExecutableFileBusy` error. That exact fixture passed 20 isolated runs;
a separate descriptor-inheritance diagnostic reproduced a plausible parallel-fork
mechanism. No production workaround was added. The complete acceptance runner
then passed with four Rust test threads.

An authenticated real Codex task and interactive desktop layout were not exercised
in this environment. Protocol, Git worktree, native ownership, persistence,
reporting, component navigation and process/toolchain regressions were exercised.
Windows/macOS/Linux PR jobs provide the combined target-platform gates.

## Compatibility with main `304ba43`

Main advanced during delivery and added **Clean merged**. Independent review
identified a real ownership gap: a clean sibling task worktree still at main could
be deleted while its attempt waited for one of the two execution slots. The
existing repository activity did not cover that sibling path.

The integration retains a target activity before guarded creation releases its
writer, passes ownership into the queue, and keeps it through dispatch, startup,
reporting and observed cleanup. Queued cancellation releases ownership only after
its state is persisted; running cancellation retains ownership until the worker
stops. Manual preparation without an attempt does not create a permanent lease.
Regression coverage uses native lifecycle/coordinator checks and real temporary
Git worktree cleanup. The final PR records verification of the combined tree.
