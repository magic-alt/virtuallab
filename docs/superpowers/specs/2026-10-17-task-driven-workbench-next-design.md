# Task-driven Workbench: next delivery increment

Status: written design approved by the user on 2026-10-17, with an instruction to implement. The concrete implementation plan is `docs/superpowers/plans/2026-10-17-task-driven-workbench-next.md`; the user approved inline execution with one final independent review. Source implementation and macOS automated verification are complete (`0961dac`); host/provider qualification is separate and remains open.

## Baseline and intent

Inspected local branch: `feat/task-driven-workbench`, HEAD `1afa6ef`.
Its product source is identical to `3ea67e0`; the subsequent commit only added
the superseded dogfooding design and plan. This is a local source audit, not a
claim about current remote branches, PR checks or authenticated desktop behavior.

Make existing task execution useful from a fresh installation, then qualify the
Roadmap's two-task integrated-delivery workflow. Preserve direct repository tools,
workspace-owned runtime state, explicit worktree preparation, native authorization
and independent execution/check/readiness/acceptance facts.

This design replaces both previous Task-first and Task-driven design/plan pairs.
Their already implemented behavior is documented in `docs/ARCHITECTURE.md` and
`docs/TASK_FIRST_CONTROL_CENTER.md`; Git history retains the old execution ledgers.
The release-gate/reliability plans and the offline prototype are unaffected.

## Source facts

| Current source | Observed behavior | Next change |
| --- | --- | --- |
| `src/features/tasks/TaskControlCenter.tsx` | Home, tasks and evidence share a task list; settings is a read-only summary | Separate actionable dashboard, task list, Run inventory and Profile settings |
| `src/features/tasks/TaskPlanWizard.tsx` | Profile JSON is manual; reuse comes from existing repository tasks | Add a first-install library and copy selected configuration into the draft |
| `src/features/tasks/TaskDetail.tsx` | Native action controls and historical evidence already exist; detail tab is component-local | Reuse controls/renderers and preserve task/tab navigation |
| `src/stores/tasks.ts` | Refresh revokes readiness and rejects obsolete reads | Extend selection carefully; retain existing freshness and action locks |
| `src-tauri/src/tasks/validation.rs` | Bounded Profile validation supports `root: Option<&str>` | Expose a narrow definition validator for a separate library |
| `src-tauri/src/workspace_lifecycle.rs` | Shared writer reservations exist and are consumed by task/runtime paths | Qualify existing lifecycle behavior; do not recreate the subsystem |
| `src-tauri/src/task_execution.rs` | Task coordinator selects Codex; other workspace harnesses do not imply task parity | Keep first delivery qualification Codex-only |
| `src-tauri/src/task_runtime.rs` and task evidence/input helpers | Native verification, integration, review and acceptance are implemented | Preserve authority and qualify the integrated workflow |

## Approach

Recommended: complete first-use configuration and task guidance, then qualify the
existing integration lane. This addresses observable usability gaps while retaining
the tested native execution boundary.

A dashboard-only change would leave first-use Profile setup unresolved. A new
orchestration framework or immediate AI Reviewer expansion would duplicate existing
boundaries and precede the V0.7 delivery qualification. Neither is in this increment.

## A. Reusable verification Profile library

Rust owns an app-data `task-profiles-v1.json` library independently of TaskManager.
Missing storage initializes an empty library; unreadable, oversized, corrupt or
unsupported existing data is preserved and reported unavailable. Either service can
fail without disabling direct repository/workspace tools.

The library contains at most 128 uniquely identified records. Each record contains
the full schema-v1 task verification Profile, an optimistic revision and update
time. A Profile is bounded to 64 KiB, the complete generation to 9 MiB, and reads
are bounded before allocation. Refuse symlinks and non-regular storage files.
Cloned managers share one serialized writer. Persist a validated next generation
through same-directory atomic replacement using existing platform patterns before
publishing in-memory state. Failed validation/persistence leaves the old state intact.
This is single-application-manager coordination, not a cross-process locking claim.

Native commands are only `task_profile_list` and `task_profile_save`.
Save takes a Profile plus `expectedRevision`: null creates only; updating an
existing ID requires its exact revision and increments it. ID changes create a
separate record; rename/delete and policy migration of accepted tasks are deferred.
Validate loaded records, positive revisions, duplicate IDs and Profile definitions.
Guard revisions against overflow and JavaScript integer precision loss.

Share `tasks::validate_profile_definition` with existing `validation::profile(value,
None)`. Task plan acceptance must still validate repository containment with its
actual root. Configuration validity never proves executable availability,
authentication or runnable verification capability. Preserve the current narrow
program allowlist and argument policy; no shell-string command or execution API.

React uses typed types/wrappers and a focused store. Settings supports structured
editing of Profile identity/name/description, gates, executable, ordered arguments,
working root, timeout, required/approval policy, source/output paths and toolchain
identities. Retain bounded advanced JSON for the existing supported schema without
silently dropping adapter fields. Unsupported execution remains explicitly blocked.
Import validates bounded UTF-8 JSON; export downloads configuration only. Neither
operation takes a native arbitrary file path or executes a program.

Save conflicts preserve the draft and offer explicit reload/copy choices. Old
refreshes cannot replace a newer saved record or active draft. Selecting a saved
Profile deep-copies it into a task draft; library updates never mutate accepted
tasks or overwrite an edited draft. Manual JSON remains available if the library
fails. No task is required to create the first Profile.

## B. Task guidance and evidence navigation

Split features into `TaskDashboard`, `TaskList`, `TaskEvidenceInventory` and Profile
settings. Reuse existing `TaskDetail`, workspace tools and native action wrappers.
Keep the mounted workspace/terminal host intact. Page changes never create
worktrees, start execution or submit review/acceptance.

Pure selectors derive dashboard queues and counts from task snapshots and native
readiness: needs input, failed checks, stale/unknown evidence, ready for human
review, active/queued and currently accepted. Memberships may overlap and are
labeled. Missing/error/loading observations remain unavailable rather than zero.
Selectors distinguish prerequisite completion from current verification and never
promote a provider success message or historical PASS into readiness.

Persist the selected task ID and detail tab in the existing task store across
application navigation. Validate selection against registered repository roots
and clear it on removal. Preserve current filters across Workspace round trips.
Repository-scoped queries and mutations reject obsolete asynchronous responses.

A next-step panel explains the blocker and links to the relevant existing control.
Native remains the authorizer. Cover running/stopping, missing Profile/workspace,
failed verification, unknown readiness, stale review/acceptance and integration
prerequisites. Do not bypass pending/cancellation locks or hide existing explicit
reconciliation controls.

The evidence inventory enumerates every Attempt with a `TaskEvidence`, including
superseded Runs, sorted by observation time and stable task/Attempt tie breakers.
Show repository/task/Attempt/Run/SHA, outcome, checks, time and existing digest and
artifact metadata, with filters and explicit task navigation. Extract the existing
evidence renderer rather than duplicating qualification logic. Native readiness
alone establishes current applicability; matching SHA is insufficient. This is an
inventory of persisted task evidence, not complete archive discovery or retention
hardening. No arbitrary artifact-open or raw-log export API is added.

## C. Integrated-delivery qualification before AI expansion

First smoke-test a single scoped task from a fresh Profile through explicit
preparation, authenticated execution, verification, review and acceptance.
Then exercise the actual V0.7 milestone using a user-selected CMake C++ project:

1. Provision dependencies separately. Configure supported observable CMake/Ninja
   compiler selection through exploratory Run; formal verification uses the
   existing supported build/test Profile. Do not disguise setup as qualification.
2. Accept two independent implementation tasks and an integration task from the
   same selected repository/base. Explicitly prepare three worktrees. The accepted
   integration scope includes both source changes and any conflict repairs.
3. Observe two independent Codex instances concurrently; preserve the existing
   bounded queue, isolated writers, frozen candidates and verified prerequisites.
4. Preview fixed source commits and dedicated target HEAD; confirm through the
   existing expiring, single-use native gate. Reject stale/rejected prerequisites.
5. Demonstrate individually passing branches whose integrated build/test fails.
   Failed integrated checks must block delivery regardless of branch PASS results.
6. Repair explicitly and verify the final integration revision. Same-HEAD input
   edits, restored bytes after invalidation, tool changes and application restart
   must not resurrect old readiness. New Runs require fresh review/acceptance.
7. Exercise conflict/interruption recovery without replaying Git mutations. Export
   the accepted revision's passport and inspect dependency/Run/toolchain lineage.
8. Treat PR publication, CI, merge, release and deployment as separate operations.
   This design grants no remote mutation or destructive-operation authorization.

Record per-host/tool/provider versions, tested application commit and each actual
observation. An unavailable host/provider is an unperformed qualification, never a
pass. Single-task/npm dogfooding is useful regression coverage but cannot close
this CMake/two-Codex integration gate.

Qualified AI planning and independent read-only Reviewer remain later V0.8 work.
Do not enable either based on prompts, CLI version detection or this UI increment.
V0.6 interruption/lifecycle qualification still blocks parallel release.

## Verification and handoff

Implementation proceeds through Profile persistence, Profile UI/wizard, dashboard
and selection, evidence inventory, then end-to-end integration and qualification.
The linked formal implementation plan records the approved inline execution
method, task progress and verification evidence. These source changes do not
close external host/provider qualification gates.

Meaningful regression coverage must demonstrate:

- Profile reopen, Unicode/argv preservation, bounded corrupt-store handling,
  stale revision rejection, concurrent saves, persistence rollback, and frozen
  accepted-task Profiles after library edits.
- First-install creation without existing tasks, structured editing, bounded
  import/export, browser/unavailable states, save-conflict draft preservation and
  stale asynchronous response rejection.
- Queue/action semantics, native-only readiness, repository removal, selection
  and terminal retention, navigation without native mutations, and Profile-store
  failure isolation.
- Multiple historical/current Runs, failed old checks, unknown readiness and
  same-SHA stale inputs without fabricated current status.
- Existing scheduler/lifecycle, candidate, integration, recovery and evidence
  lineage regressions retained, including the integrated-failure negative case.

Required checks on the implementation candidate: `npm ci`, `npm run typecheck`,
`npm test`, `npm run build`, locked Rust check/tests and `npm run acceptance:local`.
Linux must run `cargo check --locked --manifest-path src-tauri/Cargo.toml`;
Windows/macOS/Linux must run the local acceptance runner on their actual hosts/CI.
The runner's printed manual checklist is not a completed desktop acceptance record.
Packaged GUI/production CSP, authenticated providers and real integrated delivery
need separate observations. Update architecture and operator documentation when
the new interfaces are implemented, labeling source presence and qualification
separately. No release gate is closed by this design update.

For baseline context only, the preceding local audit ran frontend typecheck,
44 task/shell tests, and macOS offline locked Rust check successfully. These are
not validation of the proposed implementation or a full acceptance run.
