# Task-driven Workbench Slice A Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans (recommended) or superpowers:subagent-driven-development task by task. Preserve this ledger across handoffs.

**Goal:** Make the existing Task-first UI usable for a real single-task delivery loop without losing engineering repository functionality.

**Architecture:** Workspace remains the repository/runtime owner. Rust persists a reusable Profile library and validates configuration through the existing task Profile validator. React separates dashboard, tasks, evidence and settings, consuming existing native task/readiness operations and new typed Profile wrappers.

**Tech Stack:** Existing React, TypeScript, Zustand, Tauri, Rust and serde_json; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-task-driven-dogfooding-design.md`, slice A only. Slices B/C are deferred.

## Global Constraints

- Preserve engineering repository navigation, all Workspace tools and the mounted terminal host.
- Structured executable and argument arrays only; no arbitrary shell API.
- Opening a page never creates a worktree or starts execution; retain Native confirmation gates.
- Four separate facts: execution, observed checks, current readiness, human acceptance.
- Library edits affect future task plans only; accepted task Profiles remain frozen.
- No embedded VirtualLab path, project connector, credential/environment dump or provider transcript.
- Keep AI planning/review unavailable until qualified read-only provider support exists.
- Locked installation, frontend typecheck/tests/build, Rust locked checks/tests and three-host acceptance remain required.

## Review Focus

- Missing or corrupt Profile storage must not overwrite user data or disable repository tools.
- Two editors saving the same revision must not silently lose a configuration update.
- A historical successful Run or unchanged SHA must not grant current readiness.
- Delayed Profile/task reads after repository changes must not restore stale selection or apply writes to another task.
- A task blocked by missing dependencies/Profile/workspace must explain the blocker; navigation must not execute the suggested operation.

## Task 1: Durable reusable Profile library

**Files:** Create `src-tauri/src/task_profiles.rs` and `src-tauri/src/task_profiles/tests.rs`; modify `src-tauri/src/tasks.rs`, `src-tauri/src/lib.rs`.

**Interfaces:**
- `ProfileRecord { id: String, revision: u64, profile: serde_json::Value, updated_at_ms: u64 }`, serialized camelCase.
- `SaveProfileRequest { profile: Value, expected_revision: Option<u64> }`; null means create only, an existing ID requires an exact revision.
- `TaskProfileLibrary::open(path: PathBuf) -> Result<Self,String>`, `unavailable(error:String) -> Self`, `list() -> Result<Vec<ProfileRecord>,String>`, `save(request:SaveProfileRequest) -> Result<ProfileRecord,String>`.
- `task_profile_list()` and `task_profile_save({request})`, backed by one shared Native manager. Library file: app-data `task-profiles-v1.json`.
- Expose a narrow `tasks::validate_profile_definition(&Value) -> Result<(),String>` delegating to existing `validation::profile(value,None)`; acceptance still revalidates repository containment.

- [ ] Write failing tests: reopen preserves Unicode/argv; create/update revisions; stale revision rollback; malformed/oversized/secret/traversal/shell-program rejection; corrupt store preserved; failed persistence leaves memory unchanged; accepted Task profile unaffected by library update.
- [ ] Run `cargo test --locked --manifest-path src-tauri/Cargo.toml task_profiles::` and confirm expected failures.
- [ ] Implement bounded schema-v1 storage: at most 128 records, 64 KiB per Profile, 9 MiB generation, bounded file reads, regular-file checks, serialized clone-shared writer, same-directory atomic replacement using established platform persistence patterns. Validate loaded IDs, revisions, duplicate IDs and Profiles. Never repair corrupt data automatically.
- [ ] Register manager independently of TaskManager so either service can fail without disabling Workspace tools. Native save validates and durably persists before publishing state; no new Git/process command.
- [ ] Re-run Native tests and existing task profile validation tests; commit this deliverable.

## Task 2: Profile editing and task-wizard integration

**Files:** Create `src/types/taskProfiles.ts`, `src/lib/taskProfiles.ts`, `src/stores/taskProfiles.ts`, `src/features/task-profiles/ProfileSettings.tsx`, `ProfileEditor.tsx` and tests; modify `TaskPlanWizard.tsx`, `TaskControlCenter.tsx`, `tasks.css`.

**Interfaces:**
- TypeScript `TaskProfileRecord {id:string;revision:number;profile:TaskVerificationProfile;updatedAtMs:number}` and `SaveTaskProfileRequest {profile:TaskVerificationProfile;expectedRevision:number|null}` mirror Task 1.
- Typed wrappers `listTaskProfiles():Promise<TaskProfileRecord[]>`, `saveTaskProfile(request):Promise<TaskProfileRecord>` enforce desktop runtime.
- Store exposes records/loading/error and explicit refresh/save operations, rejects outdated refresh responses and preserves a draft after a save conflict.
- `ProfileSettings` owns list/editor/import/export. `ProfileEditor` consumes a draft and emits `TaskVerificationProfile`; it never invokes Native itself.

- [ ] Write failing UI tests: fresh-install create/save/reload; edit structured gate argument rows; JSON import validation failure preserves draft; stale revision surfaced; export round trip; delayed responses do not reset active draft; browser unavailable state.
- [ ] Run targeted Vitest files and confirm expected failures.
- [ ] Implement form fields for Profile name/ID, gates, executable, ordered argument strings, working root, timeout, required flag, source/output paths and toolchain identities. Show approval/kind and blocked unsupported executor capability honestly; advanced JSON retains existing supported schema without silent loss.
- [ ] Bound pasted/imported JSON to 64 KiB before parsing. Export configuration via local browser download. No filename-supplied filesystem read or arbitrary executable invocation.
- [ ] Replace settings summary with editable Profile library plus existing Provider/Run links and truthful capability information. No save mutates an accepted Task.
- [ ] Add saved Profile selection to wizard. Copy the full selected Profile into the draft; library changes do not silently overwrite it. Retain advanced JSON/manual mode when library unavailable and show actionable errors. Do not require pre-existing tasks to create a first Profile.
- [ ] Verify `npm test -- <targeted files>` and `npm run typecheck`; commit.

## Task 3: Actionable control center and task guidance

**Files:** Create `src/features/tasks/workflow.ts`, `TaskDashboard.tsx`, `TaskList.tsx`, corresponding tests; modify `TaskControlCenter.tsx`, `TaskDetail.tsx`, `src/stores/tasks.ts`, `tasks.css`.

**Interfaces:**
- Export `TaskDetailTab = '概览'|'执行'|'变更与审查'|'证据'|'交付'`.
- Store adds `activeTaskTab:TaskDetailTab` and a selection action `selectTask(taskId:string,tab?:TaskDetailTab):void`; selection/tab survives application navigation but clears on repository removal.
- `nextTaskStep(task:TaskRecord,readiness?:TaskReadiness):{label:string;detail:string;tab:TaskDetailTab}` is guidance only; Native still authorizes every operation.
- Dashboard receives tasks/readiness/errors/loading and `onOpenTask(id,tab)`. Independent queue memberships are allowed and labeled; dashboard counts use these same selectors.

- [ ] Write failing tests for running/stopping tasks, absent workspace/Profile, failed verification, stale/unknown readiness, integration prerequisites and revision-bound review/acceptance. No successful Agent status grants delivery PASS.
- [ ] Run selectors and dashboard tests, confirming expected failures.
- [ ] Implement actionable queues (needs input, failed checks, stale evidence, ready for review, active, recently accepted), with unavailable state distinct from zero. Route cards to the relevant TaskDetail tab.
- [ ] Add the next-step guidance panel and applicable blocking explanations to TaskDetail, linking to existing explicit controls. It never auto-submits an action or bypasses pending/cancellation locks.
- [ ] Split task-list rendering from the dashboard while preserving search/repository/attention filters and four-fact status summary. Keep selected task/tab across Workspace round trips.
- [ ] Verify targeted UI tests and existing TaskControlCenter/WorkbenchShell navigation tests; commit.

## Task 4: Immutable evidence inventory

**Files:** Create `src/features/tasks/evidenceModel.ts`, `TaskEvidenceInventory.tsx`, associated tests; extract `TaskEvidenceContext.tsx` from TaskDetail; modify TaskControlCenter.

**Interfaces:**
- `EvidenceRow {taskId:string;taskTitle:string;repositoryRoot:string;attemptId:string;evidence:TaskEvidence}`.
- `taskEvidenceRows(tasks:TaskRecord[]):EvidenceRow[]` includes every Attempt containing evidence, sorted by observedAtMs descending with stable task/attempt tie breakers.
- Inventory consumes existing native records/readiness; it does not synthesize manifests, retain raw logs, or claim complete archive discovery.

- [ ] Write failing tests for multiple old/current Runs, failed historical checks, unknown current readiness, matching SHA with stale inputs, repository/task/status filters and delayed repository removal.
- [ ] Run targeted Vitest tests and confirm expected failures.
- [ ] Implement Run list/details with task/Attempt/SHA/check/time fields, filters, existing bound digest and artifact metadata renderer, and explicit task navigation. Historical outcome remains visible independently of current task readiness.
- [ ] Clearly label superseded evidence. Only existing Native currentness/readiness establishes current delivery status; no client digest comparison or raw-artifact file-opening API.
- [ ] Update existing tests that assumed the evidence page was a duplicate task list; preserve the task selection and Workspace-tool accessibility behavior they protected.
- [ ] Verify evidence and TaskDetail regressions; commit.

## Task 5: Integration, documentation and acceptance

**Files:** Modify `src/features/shell/WorkbenchShell.tasks.test.tsx`, relevant new feature tests, `docs/ARCHITECTURE.md`, `docs/TASK_FIRST_CONTROL_CENTER.md`; add `docs/acceptance/task-driven-workbench.md`.

- [ ] Add regression coverage that repository/worktree tools remain reachable, navigation retains the mounted terminal host, no view change invokes start/create, Profile failure leaves repository tools available, and stale asynchronous results cannot cross repository selection.
- [ ] Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, `cargo test --locked --manifest-path src-tauri/Cargo.toml` and `npm run acceptance:local`; fix discovered failures without weakening gates.
- [ ] Document Profile library schema, optimistic revisions, immutable task snapshots and failure isolation in ARCHITECTURE. Update the operator guide to match actual screens and capability limits.
- [ ] Write a host acceptance checklist using user-selected VirtualLab: locked dependency provisioning, structured npm/Rust gates, explicit task worktree, authenticated Agent execution, failure then repair, same-HEAD invalidation, fresh review/acceptance, passport and explicit PR. Record each real observation separately; mark unavailable host/provider checks unperformed instead of inventing success.
- [ ] Obtain a final independent branch review if an agent is available. Address blocking findings and rerun affected checks.
- [ ] Commit/push feature branch and create reviewable PR under the existing session authorization. Confirm Windows/macOS/Linux CI; do not merge or promote local acceptance into authenticated GUI qualification.

## Execution handoff

Recommended: native execution in this session, with one final independent review,
because the five deliverables share Profile/task selection contracts and the
existing Native execution layer stays intact. User review and method selection
are pending. No product code has been changed by this plan.
