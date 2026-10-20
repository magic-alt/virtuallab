# Task Git Conversion Implementation Plan

> **For agentic workers:** Use Superpowers execution, regression-first development
> and independent review for the tasks below. Checkboxes record actual completion.

**Goal:** Allow Control Center tasks to run in normal Windows Git worktrees while
preserving exact input observation, candidate safety and truthful reports.

**Architecture:** Separate raw file identity from qualified Git EOL identity.
Carry the raw preflight snapshot into provider completion and seal only immutable,
validated candidate objects. Keep frontend changes within existing typed task APIs.

**Tech stack:** Rust, Git CLI, Tauri, React, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-task-git-conversion-design.md`

## Global constraints

- Preserve `AGENTS.md` workspace ownership, typed commands and cross-platform rules.
- No Git configuration changes, new dependency, arbitrary shell API, implicit
  integration or release action.
- Actual raw bytes continue to determine evidence freshness.
- External filters, identity and encoding transformations stay unsupported.
- Failed work and the task's bound worktree remain available for explicit retry.

## Review focus

- Binary, lone-CR and legacy CRLF index content must not be normalized accidentally.
- Cached, nested and repository-external attribute policy can differ or change.
- An out-of-scope edit that only changes line endings must still be detected.
- A source/configuration race must not publish an unapproved candidate tree.
- A failed retry with no execution identity must not display a previous result.

## Task 1: Qualified native EOL identities and candidate construction

**Files:** `src-tauri/src/task_inputs.rs` and focused tests/submodules as needed.

**Interfaces:** Keep `SourceIdentity` and `source_identity` stable. Add
`SourceSnapshot { identity, raw_files }` and `source_snapshot`. Accept the snapshot
as the expected input to `retained_candidate`.

- [x] Reproduce the reported configuration with a real linked worktree; run the
  original input tests (33 passed).
- [x] Add failing EOL, attribute, binary, scope and candidate-preservation regressions.
- [x] Implement bounded built-in conversion qualification and raw snapshot identity.
- [x] Construct isolated candidate entries from approved immutable objects and retain
  all existing index/ref/hook/signing guards.
- [x] Run the complete input module and record its result; commit native repair.

## Task 2: Provider preflight, completion and report recovery

**Files:** `src-tauri/src/task_execution.rs`, `src/features/tasks/workflow.ts`,
`src/features/tasks/TaskDetail.tsx` and corresponding tests.

**Interfaces:** Consume Task 1's `SourceSnapshot` across provider execution; formal
verification continues to consume `SourceIdentity`.

- [x] Add and observe failing actual provider preflight/completion regressions for
  Windows-style inputs and out-of-scope EOL changes.
- [x] Extract preflight so its rejection explicitly precedes Codex startup; retain
  the raw snapshot for both automatic-commit and retained-edit completion.
- [x] Add failing frontend tests for failure-priority and stale-summary reuse.
- [x] Fix failure-priority and restrict prior-summary fallback to verification.
- [x] Verify the provider regressions, frontend suite, typecheck and build; commit.

## Task 3: Final validation, documentation and PR

**Files:** `docs/ARCHITECTURE.md`, `docs/CONTROL_ACCEPTANCE.md`, this plan.

- [x] Independently review conversion, scope and publication behavior; fix material
  findings with regressions.
- [x] Run locked native Linux checks and full acceptance; record any exact failure
  and unchanged rerun separately.
- [x] Update architecture, acceptance scenarios and recovery guidance.
- [x] Submit the isolated branch as a reviewable PR against current main.
- [ ] Check Windows/macOS/Linux CI on the submitted commit and report the result.

## Execution notes

The native qualification extension was chosen instead of a provider-only bypass:
the latter would leave ordinary Windows automatic commits and formal verification
blocked. The implementation must therefore prove both raw freshness and Git object
equivalence; no task is granted verification merely because Codex completed.

Independent review identified five defects in the first implementation: a fresh
HEAD-only seal baseline could miss a later raw scope edit; safe-CRLF simulation
misclassified adjacent CR bytes; scoped attribute edits exempted external policy
drift; deleting attributes could change index fallback only after publication; and
staged CRLF classification was mistaken for attribute-policy drift. Six regression
tests reproduced these failures (including ignored nested attributes) before the
production fixes. The reviewer rechecked all five corrections and found no further
concrete correctness issue in the supported regular-file/path cases.

### Local validation record

| Check | Observed result |
| --- | --- |
| Original native input module on the starting implementation | 33 passed |
| Initial built-in EOL input module | 43 passed, 1 existing cancellation timing assertion failed; all 11 added EOL tests passed |
| Review regressions before their fixes | 0 passed, 6 expected failures |
| Review regressions after the fixes, approved subprocess access | 6 passed |
| Original cancellation regression after the fixes, isolated with approved subprocess access | 1 passed; original less-than-15-second assertion unchanged |
| Provider CRLF regression before the input fix | Failed with the user's original conversion error |
| Targeted report/workflow regressions | 19 passed after observing 3 expected failures before the UI fix |
| Typecheck, production build, version consistency, icon parity | Passed |
| Full frontend, default local subprocess restrictions | 516 passed, 7 failed, 1 skipped; process-permission and UI failures |
| Those six failing frontend files, unchanged, approved subprocess access | 35 passed |
| Full frontend, approved subprocess access, one worker | 521 passed, 2 timed out, 1 skipped |
| The affected AgentWorkspace file, unchanged, alone | 6 passed |
| Final full frontend, approved subprocess access, two workers | 503 passed, 20 failed, 1 skipped; 16 timeouts and 4 assertion/DOM-wait failures |

The local complete frontend suite is not recorded as green. No production change
or test-timeout relaxation was made to explain away those full-run failures. The
submitted PR's complete CI and the final native results remain the completion gate.
The PR records subsequent verification on its submitted commit separately from
this pre-publication local record. Final provider review also corrected a test's
workspace comparison to use canonical paths on Windows and symlinked temp roots.

### First published CI and runtime follow-up

PR #89 initially published commit `f2249e80dafc8a340bd8aebc9d67eb7383bc96f4`.
[CI run 39365119941](https://github.com/magic-alt/virtuallab/actions/runs/39365119941)
recorded the following results on its merge with the unchanged base:

| Check | Observed result |
| --- | --- |
| Targeted local provider review suite | 21 passed |
| Frontend Node 22 and Node 26 | Each: 523 passed, 1 skipped; typecheck and production build passed |
| Linux locked cargo check and desktop acceptance | Passed; native 442 passed, 1 ignored, 0 failed in 1007.10 seconds; all 50 task-input and 21 provider review tests passed |
| Windows desktop acceptance and standalone release host | Passed; native 408 passed, 3 ignored, 0 failed in 246.49 seconds; all 44 applicable task-input and 21 provider review tests passed; qualification and release ACL checks passed |
| macOS desktop acceptance | Timed out at the existing 20-minute step deadline; native compilation took 1 minute 25 seconds; 276 distinct native tests logged as passed, 1 ignored and no assertion failure before termination |
| Required quality gate | Failed because macOS timed out |

The superseded local complete native run was interrupted after the complete Linux
CI result and macOS timing failure became available. It is not counted as a pass;
the sequential local cargo-check step was not reached. Linux CI supplied both
complete native-suite and locked cargo-check evidence for that first commit.

The runtime follow-up keeps every Git command, argument, default, native boolean
check and policy fingerprint. It splits the longest configuration chain into two
workers of at most three queries each, while retaining parallel working/cached
attribute probes. Exactly six workers are joined before error propagation. The
independent reviewer confirmed unchanged successful results and error precedence.
No test deadline or managed-process cleanup behavior was changed. The six review
regressions, native boolean-alias compatibility and original cancellation test
all passed together: 8 passed, 0 failed in 148.88 seconds, with the existing
less-than-15-second cancellation assertion unchanged. The new commit's complete
CI remains required before completion; its final results are recorded in the PR.
