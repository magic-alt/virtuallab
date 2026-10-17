# Task-driven Workbench Next Increment Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution or superpowers:subagent-driven-development if explicitly selected. Implement task by task, using the checkboxes and execution ledger below.

**Goal:** Make first-install task configuration and evidence navigation usable, then qualify the existing two-task integrated-delivery workflow without weakening native authority.

**Architecture:** A separate native Profile library shares existing validation and persists optimistic revisions. Typed React clients feed focused Profile settings, dashboard and evidence features; existing workspace execution, task verification and confirmation boundaries remain authoritative.

**Tech Stack:** Existing Rust/Tauri/serde_json and React/TypeScript/Zustand/Vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-task-driven-workbench-next-design.md` (approved 2026-10-17).

## Global Constraints

- Baseline `feat/task-driven-workbench@1afa6ef`; product source equals `3ea67e0`. Preserve the current uncommitted documentation replacement.
- Workspace owns execution. Agents attach to workspaces. Never add arbitrary shell-string commands or project-specific connectors.
- Profile library: schema 1, 128 records, 64 KiB per Profile, 9 MiB generation; bounded reads; regular files; clone-shared serialized writes; atomic replacement before memory publication.
- Library revisions are positive integers no greater than `9_007_199_254_740_991`; reject unsafe/overflowing request, loaded and next revisions.
- Task acceptance still validates the copied Profile with the selected repository root. Library edits never migrate an accepted task's policy.
- No navigation creates worktrees, starts processes or makes approval decisions. Retain pending/cancellation locks and the mounted terminal host.
- Execution, observed checks, current native readiness and human acceptance remain separate facts. No frontend freshness inference from HEAD alone.
- Codex-only task qualification first. AI planning/Reviewer remain unavailable until separately qualified read-only transport exists.
- No remote mutation, release, deployment or destructive Git operation is authorized by this plan.
- Locked installation, frontend typecheck/tests/build, Linux locked Rust check and Windows/macOS/Linux local acceptance remain mandatory gates. Record unavailable environments honestly.

## Review Focus

- Two cloned writers or two editors save one revision: exactly one succeeds; the other retains its draft.
- A corrupt store or replaced storage path must preserve user data and keep direct Workspace tools usable.
- A delayed query/save result must not overwrite a newer record, draft, task selection or repository context.
- Historical successful evidence and restored same-HEAD bytes must never grant current readiness.
- Persisted task/Run selection must not expose removed-repository data or accidentally trigger work.

## Task 1: Native reusable Profile library

**Files:** Create `src-tauri/src/task_profiles.rs`, `src-tauri/src/task_profiles/tests.rs`; modify `src-tauri/src/tasks.rs`, `src-tauri/src/lib.rs`.

**Interfaces:**
- `ProfileRecord { id: String, revision: u64, profile: serde_json::Value, updated_at_ms: u64 }`, camelCase JSON with unknown fields rejected.
- `SaveProfileRequest { profile: Value, expected_revision: Option<u64> }`, camelCase JSON.
- `TaskProfileLibrary::open(path: PathBuf) -> Result<Self,String>`; `unavailable(error: String) -> Self`; `list() -> Result<Vec<ProfileRecord>,String>`; `save(request: SaveProfileRequest) -> Result<ProfileRecord,String>`.
- `tasks::validate_profile_definition(&Value) -> Result<(),String>` delegates to `validation::profile(value,None)`; task plan acceptance remains unchanged.
- `task_profile_list()` and `task_profile_save({request})` use one shared manager. App-data path is `task-profiles-v1.json`; persisted generation is `{schemaVersion:1, records:[...]}`.

- [x] Write tests for empty/reopened Unicode storage; create revision 1; exact update to 2; stale/create-only conflicts; ID-copy semantics; concurrent clone saves with one winner; max-safe revision overflow; corrupt/duplicate/unsupported/oversized loaded generations; invalid shell/secret/traversal Profiles; symlink/non-file refusal; failed persistence rollback; accepted-task Profile immutability after a library edit. Use existing TaskManager fixtures for the last assertion.
- [x] Run `cargo test --locked --manifest-path src-tauri/Cargo.toml task_profiles::`; confirm RED reflects the missing library rather than a fixture failure.
- [x] Implement shared manager and bounded schema validation. Inspect file metadata and cap reads at 9 MiB + 1; reuse established bounded-JSON and atomic persistence patterns without exposing existing private task-store internals. Serialize clone access with `Arc<Mutex<_>>`; validate before disk/memory mutation. Refuse unsafe revision increments and validate record ID equals embedded Profile ID.
- [x] Register the module, commands and independent manager setup. Failure to open either task service must not prevent application setup or initialize the other as unavailable.
- [x] Rerun focused tests and existing native Profile-validation tests; inspect diff for new process/Git access (none expected). Record results and checkpoint the deliverable.

## Task 2: Profile settings and wizard integration

**Files:** Create `src/types/taskProfiles.ts`, `src/lib/taskProfiles.ts`, `src/stores/taskProfiles.ts`, `src/features/task-profiles/ProfileEditor.tsx`, `ProfileSettings.tsx`, `profileModel.ts` and corresponding tests. Modify `TaskPlanWizard.tsx`, `TaskControlCenter.tsx`, `tasks.css` and relevant existing tests.

**Interfaces:**
- `TaskProfileRecord {id:string;revision:number;profile:TaskVerificationProfile;updatedAtMs:number}` and `SaveTaskProfileRequest {profile:TaskVerificationProfile;expectedRevision:number|null}`.
- Typed wrappers `listTaskProfiles():Promise<TaskProfileRecord[]>`, `saveTaskProfile(request):Promise<TaskProfileRecord>` enforce desktop runtime; no generic command string API is exported.
- Store exports `useTaskProfileStore`, `refreshTaskProfiles():Promise<void>` and `saveProfile(request):Promise<TaskProfileRecord>`. Request sequencing prevents a pre-save read from restoring older data.
- `parseProfileDocument(text:string):TaskVerificationProfile` checks UTF-8 bytes <= 65,536 before parsing, rejects null, and uses existing task Profile parsing. Native validation is final authority.
- `ProfileSettings` owns record selection, revision-bound draft, conflict choices and import/export; `ProfileEditor` receives a Profile and emits edits, with no native invocation.

- [x] Add tests for first-install create/save/reload; structured argument rows preserving spaces/Unicode/order; description/source/output/toolchain round trips; unsupported adapter fields retained through advanced JSON; over-limit UTF-8 input rejected before parsing; invalid import preserves draft; unavailable/browser behavior; same-revision conflict preserves draft with reload/copy choices; delayed refresh/save never replaces a different selected draft.
- [x] Run `npm test -- src/stores/taskProfiles.test.ts src/features/task-profiles`; confirm RED for the missing behavior.
- [x] Implement the types/wrappers/store/model and structured editor. Offer gate kind/approval/required, executable, cwd and timeout fields. Use ordered argument inputs, not shell parsing. Preserve adapter metadata and show unsupported capability without implying runnable qualification. Import/export is bounded configuration text via browser APIs, not an arbitrary native path reader.
- [x] Replace the read-only Profile summary with settings while retaining existing Provider/Run links. Save conflicts offer explicit reload of the latest record or copy under a new ID; never silently overwrite a draft. Library failure leaves manual Profile JSON and repository tools reachable.
- [x] Add saved-library selection to the wizard, retaining repository-task Profile reuse and manual JSON. Copy the selected full Profile into the draft only on an explicit selection. A later library refresh must not overwrite it. Add a wizard test proving the accepted request retains its snapshot after library edits and a delayed response after repository removal cannot submit work.
- [x] Run focused tests, existing `TaskControlCenter.test.tsx`, and `npm run typecheck`; record and checkpoint.

## Task 3: Actionable dashboard and navigation state

**Files:** Create `src/features/tasks/workflow.ts`, `TaskDashboard.tsx`, `TaskList.tsx` and tests; modify `src/types/tasks.ts`, `src/stores/tasks.ts`, `TaskControlCenter.tsx`, `TaskDetail.tsx`, `tasks.css`.

**Interfaces:**
- `TaskDetailTab = '概览'|'执行'|'变更与审查'|'证据'|'交付'` in `src/types/tasks.ts`.
- Store adds `activeTaskTab`, `filters:{query:string;repositoryRoot:string;attention:boolean}` and actions `selectTask(taskId:string,tab?:TaskDetailTab):void`, `setTaskFilters(patch):void`. Selection is validated against current registered roots and task records; removed repositories clear their selection/filter.
- `nextTaskStep(task:TaskRecord,readiness?:TaskReadiness):{label:string;detail:string;tab:TaskDetailTab}` and `taskQueues(tasks:TaskRecord[],readiness:Record<string,TaskReadiness>)` are pure guidance selectors. Queues expose needs-input, failed-checks, stale-or-unknown, review, active and accepted memberships. Counts derive from those same arrays.
- `TaskDashboard` consumes snapshots/loading/error and `onOpenTask(id,tab)`; `TaskList` consumes filtered tasks/readiness/selection and the same navigation callback. Neither authorizes native actions.

- [x] Write selector tests for missing Profile/workspace, running/stopping/queued, failed check, unknown native readiness, stale Run/review/acceptance, integration blockers and current acceptance. Assert Agent success plus historical PASS without native readiness cannot enter the accepted queue.
- [x] Write navigation tests for task/tab/filter restoration after Workspace round trip, repository removal, unavailable versus zero counts, overlapping queue labels and card routing. Assert view changes never invoke start/prepare/verify/review/acceptance.
- [x] Run `npm test -- src/features/tasks/workflow.test.ts src/features/tasks/TaskDashboard.test.tsx src/features/tasks/TaskControlCenter.test.tsx`; confirm RED for new behavior.
- [x] Implement selectors, dashboard and list; place navigation/filter state in the existing task store. Preserve existing refresh/action generations and revoke invalid selection when roots change. Thread controlled task/tab state into TaskDetail, keeping existing action controls and reconciliation behavior.
- [x] Add next-step guidance linking only to existing detail tabs/controls; it cannot submit operations. Active/pending/cancelling state must not unlock duplicate actions.
- [x] Rerun new tests, existing task control tests and `WorkbenchShell.tasks.test.tsx`; run typecheck, record and checkpoint.

## Task 4: Immutable task Run inventory

**Files:** Create `src/features/tasks/evidenceModel.ts`, `TaskEvidenceInventory.tsx`, `TaskEvidenceContext.tsx` and tests; modify `TaskDetail.tsx`, `TaskControlCenter.tsx`, `tasks.css` and existing evidence-page assertions.

**Interfaces:**
- `EvidenceRow {taskId:string;taskTitle:string;repositoryRoot:string;attemptId:string;evidence:TaskEvidence}`.
- `taskEvidenceRows(tasks:TaskRecord[]):EvidenceRow[]` enumerates every evidence-bearing Attempt, sorting descending `observedAtMs`, then task ID and Attempt ID ascending. Stable selection key is task + Attempt + Run, not row position.
- `TaskEvidenceContext({evidence}:{evidence:TaskEvidence})` is the extracted existing metadata renderer, including checks and artifacts.
- Inventory receives tasks/readiness/loading/errors and `onOpenTask`; it applies repository/task/check-outcome filters and clears selected rows when their repository disappears.

- [x] Write tests for multiple old/current Runs and failed historical checks; sorting ties; repository/task/outcome filtering; unknown currentness; same-SHA stale input; selected-row removal during a delayed refresh. Assert historical PASS remains visible without a current-ready label and row selection invokes no native mutation.
- [x] Run `npm test -- src/features/tasks/evidenceModel.test.ts src/features/tasks/TaskEvidenceInventory.test.tsx`; confirm RED.
- [x] Extract renderer and implement inventory with Run/SHA/time/outcome/lineage fields, metadata detail and explicit task navigation. Label superseded records. Use native currentness only; add no digest-based client qualification, artifact reader or raw-log export.
- [x] Replace the evidence task-list surface. Update old tests to preserve the task selection/workspace navigation behavior they originally protected. Keep TaskDetail available by explicit navigation from a Run.
- [x] Run inventory, TaskDetail/control center and shell regressions plus typecheck; record and checkpoint.

## Task 5: Whole-change review, documentation and qualification

**Files:** Modify `src/features/shell/WorkbenchShell.tasks.test.tsx`, applicable native/frontend regression tests, `docs/ARCHITECTURE.md`, `docs/TASK_FIRST_CONTROL_CENTER.md`, `docs/ROADMAP.md`; create `docs/acceptance/task-driven-workbench.md`.

- [ ] Add failing integration regressions for Profile-store failure while repository tools remain available, terminal host identity retained through all new pages, delayed responses across repository removal, and navigation without execution. Extend native tests only where current integrated-failure/stale-lineage coverage leaves a real gap; preserve existing candidate/lifecycle/recovery guards.
- [ ] Run those tests RED, implement missing wiring, then GREEN. Inspect new native command registration and wrappers: only list/save are added; no shell/process/Git capability broadening.
- [ ] Document implemented Profile schema/revisions/frozen snapshots/failure isolation and actual navigation. Roadmap must distinguish implemented usability from outstanding V0.6/V0.7 qualification; retain unperformed gates unchecked.
- [ ] Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`, `npm run acceptance:local`, and `git diff --check`. Confirm every exit code and record exact counts and candidate revision. Fix failures without weakening checks.
- [ ] Perform one independent whole-change review under the chosen execution workflow; fix material findings and rerun affected checks. Do not claim independent review without a separate reviewer. Keep any uncovered environment limitation in the ledger.
- [ ] Prepare an acceptance record with host/app revision/tool/provider identities, commands, observed behavior and evidence paths. Run supported local GUI/provider checks when available; for a user-selected CMake project observe two independent Codex instances, three explicitly prepared worktrees, frozen sources, confirmed integration, integrated-only failure, explicit repair, invalidation/restart, fresh review/acceptance and passport lineage. No project/path is bundled in core. Do not invent a project selection or authentication.
- [ ] Validate Linux locked Rust check and Windows/macOS/Linux local acceptance from actual host/CI evidence. If inaccessible, leave each unperformed with its blocker and the exact command to run. Printed manual checklists, npm-only dogfooding and macOS tests cannot close these gates.
- [ ] Leave a reviewable local branch/diff and report source completion, automated checks and outstanding qualification separately. Publishing a PR or any other remote mutation requires actual session authorization; never infer it from this plan.

## Preflight and execution ledger

- Design approval: user confirmed the replacement written design and requested implementation on 2026-10-17.
- Planning baseline: branch `feat/task-driven-workbench`, HEAD `1afa6ef`; pending changes are the authorized deletion of four old documents, replacement design and Roadmap update. No product code has changed.
- Plan review: user approved inline/native execution on 2026-10-17, with one final independent review.
- Isolation and setup: at execution, inspect linked-worktree state and preserve all existing documentation edits. Apply `using-git-worktrees` without overwriting or discarding pending work. Run locked setup and baseline checks before implementation.
- Baseline evidence from the prior audit only: frontend typecheck and 44 task/shell tests passed; macOS offline locked Rust check passed with unused-code warnings. Re-run required checks for the implementation; these are not completion evidence.
- Tasks 1–4: source implemented and targeted tests passed. Profile tests first failed for missing library/clients; selectors/inventory first failed for missing modules; navigation reattachment, multiline paths and unknown-readiness counts were observed failing and then fixed.
- Task 5: frontend 322 passed / 1 pre-existing skipped, typecheck/build passed; macOS locked Rust check passed (6 existing unused-code warnings), host-permission native suite 324 passed. Final review and acceptance runner pending; external qualification remains unperformed.
- Ruling: sandbox denied Git worktree ref creation, so use current feature checkout under the worktree skill fallback. Cost: implementation shares the selected checkout; existing documentation edits are preserved.
- Ruling: recognize only Native's exact sole review-required blocker for the review queue. Unknown/additional blockers remain verification work. Cost if wording changes: the queue becomes empty; no false readiness is introduced.
