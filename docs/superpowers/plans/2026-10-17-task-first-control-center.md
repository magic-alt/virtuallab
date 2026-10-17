# Task-first Control Center Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task; preserve this ledger across handoffs.

**Goal:** Deliver the approved Task-first UI backed by native task persistence, lifecycle reservations and a revision-bound local delivery workflow.

**Architecture:** Rust owns structural task records, scheduling, Git/verification and readiness. React consumes typed wrappers and a single event observer, with the existing workspace tools kept mounted and available. No provider completion or frontend flag can grant delivery readiness.

**Tech Stack:** Existing React/TypeScript/Zustand/Tauri/Rust/serde_json/sha2; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-task-first-control-center.md` and the approved conversation design.

## Global Constraints

- Workspace owns repository/runtime state; agents attach to workspaces.
- Structured program/argv only; explicit native confirmation for integration and destructive/remote operations.
- Default concurrency 2; queued leaf tasks limit 32; retry creates a new Attempt.
- Preserve old tools and v1 evidence as historical; never synthesize qualified evidence.
- No secrets, .env content/digests or raw provider transcripts in durable task events/export.
- No claim of authenticated provider, packaged GUI or cross-platform qualification without a host record.

## Review Focus

- Restart between mutation intent and observed result must not replay Git operations.
- Same HEAD with changed controlled inputs must invalidate readiness.
- Same-worktree startup/removal and stopping races must remain reserved.
- Repository switching must not apply delayed data or controls to another repository.
- Optional or missing checks must never masquerade as required PASS.

## Shared interface contract

All JSON uses camelCase. Native commands receive a single `request` object except task_list/task_get/task_events/task_readiness (their typed wrapper arguments are direct).

`TaskRecord`: id, repositoryRoot, title, goal, scope:string[], baseSha, kind:"implementation"|"integration", dependencies:string[], profile:VerificationProfile|null, autoCommit:boolean, revision:number, workspaceRoot:string|null, attempts:TaskAttempt[], review:TaskReview|null, acceptance:TaskAcceptance|null, createdAtMs:number, updatedAtMs:number.

`TaskAttempt`: id, state:"queued"|"running"|"stopping"|"succeeded"|"failed"|"cancelled"|"interrupted", phase:"implementation"|"sealing"|"integration"|"verification"|"review", candidateSha:string|null, failure:string|null, startedAtMs:number, endedAtMs:number|null, evidence:TaskEvidence|null.

`TaskEvidence`: runId, headSha, profileDigest, inputDigest, toolchainDigest, status:EvidenceStatus, checks:EvidenceCheck[], artifacts:EvidenceArtifact[], observedAtMs:number.

`TaskReview`: headSha, inputDigest, profileDigest, approved:boolean, note:string, createdAtMs:number.

`TaskAcceptance`: headSha, inputDigest, profileDigest, acceptedAtMs:number, acknowledgedWarnings:boolean.

`TaskReadiness`: status:"ready"|"warning"|"blocked"|"unverified", blockers:string[], warnings:string[], candidateSha:string|null, reviewCurrent:boolean, acceptanceCurrent:boolean.

`TaskDraft`: key,title,goal,scope:string[],kind,dependencyKeys:string[],profile:VerificationProfile|null,autoCommit:boolean.

`TaskPlanRequest`: repositoryRoot,expectedHeadSha,tasks:TaskDraft[]. `task_accept_plan` returns TaskRecord[]. Dependencies reference keys in this plan or existing same-repository Task IDs. Native validates and freezes the plan before any worktree exists.

`TaskEvent`: schemaVersion:1,eventId,seq:number,taskId,attemptId:string|null,kind:string,timestampMs:number. Structural events only, no raw payload.

Commands: task_list({repositoryRoots:string[]}), task_get({taskId}), task_events({afterSeq}), task_accept_plan({request}), task_prepare_workspace({request:{taskId,branch,targetPath:string|null}}), task_start({request:{taskId,executablePath:string|null}}), task_cancel({request:{taskId}}), task_retry({request:{taskId,executablePath:string|null}}), task_verify({request:{taskId}}), task_readiness({taskId}), task_review({request:{taskId,expectedHeadSha,note,approved}}), task_accept_result({request:{taskId,expectedHeadSha,acknowledgedWarnings}}), task_integration_preview({request:{taskId}}), task_integration_confirm({request:{planId}}), task_export_passport({request:{taskId}}). Export returns sanitized JSON string; UI downloads locally. Prepare/start never run on page navigation. Planning suggestion remains unavailable until qualified read-only support exists, and UI states why.

## Tasks

### Task 1: Shared lifecycle reservations

Files: create `src-tauri/src/workspace_lifecycle.rs`; integrate `agent.rs`, `agent_cli.rs`, `execution.rs`, `build_workflows.rs`, `verification.rs`, `git.rs`. Controller owns lib.rs registration.

- [x] Write failing native tests for competing starts, startup/removal race, stopping retention, alias identity and independent workspaces.
- [x] Implement `WorkspaceLifecycle::reserve(root:&str, owner:&str)->Result<WorkspaceReservation,String>` with RAII reservation and exclusive claims; expose `is_reserved`/`begin_removal` through the same atomic manager.
- [x] Hold reservation across actual startup until observed shutdown; terminal sessions count as potential writers; removal holds exclusive reservation through mutation.
- [x] Verify locked native tests; report exact integration requirements.

### Task 2: Durable task service

Files: create `src-tauri/src/tasks.rs` and focused submodules if needed. Controller owns runtime and lib.rs.

- [x] Tests: plan validation/dependency cycle and cross-repository rejection, atomic persistence/reopen, failed save rollback, corruption fail closed, interrupted recovery and queue bound.
- [x] Implement public(crate) serde contract above, TaskManager with Mutex-backed app-data JSON store, atomic save and structural events.
- [x] Expose `TaskManager::list(roots:&[String])`, `get(id:&str)`, `update(id:&str, f:impl FnOnce(&mut TaskRecord)->Result<(),String>)`, `accept_plan(request:TaskPlanRequest)`, `events(after:u64)`; methods persist before committing in-memory state. Init via `TaskManager::open(path:PathBuf)`.
- [x] Register query/plan commands in module; emit task://event only after successful durable updates. Dependency existence and cycle validated before plan acceptance. State recovery marks active attempts interrupted without replay.
- [x] Verify locked native tests.

### Task 3: Task-first UI and typed client

Files: create `src/types/tasks.ts`, `src/lib/tasks.ts`, `src/stores/tasks.ts`, `src/features/tasks/` and styles. Controller owns shell integration and global theme.

- [x] Tests first for separate status semantics, stale query races, task filters and creation validation.
- [x] Typed wrappers match shared commands; app-level observer owns hydration and events (components do not invoke native directly).
- [x] Export `TaskControlCenter({view:"home"|"tasks"|"evidence"|"settings", repositories, activeRepository, searchQuery, onOpenWorkspace})`; repositories use existing RepositoryRecord. Provide control center, task list, five-tab detail and four-step manual plan flow; AI suggestions explicitly capability unavailable rather than unsafe write sessions.
- [x] Workspace creation is explicit; integration confirmation uses existing native confirmation helper. All mutations refresh structural state, catch errors and prevent duplicate clicks. Existing review/GitHub/Run tools link via onOpenWorkspace(root,tab).
- [x] Neutral surfaces, Chinese copy, responsive layout and empty/offline/error states. No simulated PASS in live views.
- [x] Verify frontend targeted tests/typecheck.

### Task 4: Native task runtime and delivery boundary

Files: controller creates `task_runtime.rs`, task Git/evidence helpers, registers modules/commands and observer; integrates TaskControlCenter into persistent shell.

- [x] Tests first: source freshness without HEAD change, candidate scope validation, required failure/missing evidence, stale review, expired integration and single use, integrated-only failure and side-effect recovery.
- [x] Implement typed prepare/start/cancel/retry; native bounded scheduler; observe structured provider completion then stop writer and seal only validated scoped candidate.
- [x] Qualified verification wraps independently observed Profile/input/toolchain/artifact identity, stored in app data; no v1 upgrade. Readiness recomputes current inputs, Profile, artifacts and review; acceptance revalidates and remains separate.
- [x] Integration preview binds fixed source commits and clean dedicated target; confirmation uses native dialog, single-use five-minute plan and revalidation. Preserve partial state on failure, no implicit retry.
- [x] Read-only AI plan suggestion and Reviewer only when adapter capability is actually qualified; unsupported operations fail explicitly.
- [x] Integrate shell app navigation without unmounting terminal host or auto-starting work. Replace saturated global pixel theme with neutral token styling.

### Task 5: Prototype, docs and verification

- [x] Add independent offline mock HTML prototype covering creation, dependency wait, integrated failure, stale evidence, acceptance and recovery, with explicit mock label and reset.
- [x] Update architecture/guide/acceptance documentation with implemented capability boundaries and remaining host qualification work.
- [x] Run locked install, frontend full tests/typecheck/build, native locked check/tests and local acceptance. Record unavailable platforms honestly; no publishing or remote mutations.
- [x] Perform independent whole-change review and fix material findings, reverify changed boundaries.

## Execution ledger

- Setup: managed worktree `b548`, branch `feat/task-first-control-center`, clean starting tree `4cea3b7`; locked npm installation completed without install scripts, zero audit vulnerabilities.
- Preflight: Task 1 lifecycle consumed by Task 4; Task 2 contract consumed by Tasks 3/4; controller alone edits lib.rs/shell/theme to avoid shared-file races. Shared contracts above are authoritative.
- Scope: the implementation supplies local software capabilities; real-provider/packaged-GUI/user-trial release gates remain qualification work, never fabricated completion.
- Implemented source: shared workspace lifecycle; durable validated Task/Attempt generations; bounded coordinator; typed task client and persistent shell navigation; candidate sealing; confirmed fixed-source local integration; v2 observations, human review/acceptance and sanitized passport; offline prototype and guide.
- Independent review found ten important boundary issues. Follow-up fixes cover isolated Git index and policy refusal, hidden index flags, output/source consistency, session continuity, exact Run/toolchain human decisions, selected compiler observation, rejected prerequisites, slot dispatch, independent cancellation and preparation reconciliation. Final review/check results are recorded below when complete.
- Model ruling: manual re-verification appends a verification-only Attempt plus a new Run, retaining old immutable evidence. Every new Run requires fresh human review/acceptance. Application restart makes prior observation continuity unknown, requiring re-verification.
- Capability ruling: AI planning/Reviewer remain explicitly disabled until read-only transport is qualified. Automatic sealing refuses executable hooks/signing; a manually committed clean candidate may be adopted through native verification and scope checks. Archived verification logs do not qualify generated binary deliverables.
- Safety review rejected a proposed temporary removal of the manifest hash guard for a negative test. No removal was applied; tampered-input tests exercise the intact guard instead.

## Final local verification (2026-10-17)

- Stable source: macOS `npm run acceptance:local` exited 0; frontend 298 passed / 1 pre-existing skipped; Rust 304 passed / 0 failed. Typecheck and production build passed.
- Locked Rust check passed on macOS (`cargo check --offline --locked`); initial locked npm installation passed. `git diff --check` passed. Source/slot/lineage/watch and real CMake/Ninja positive regressions are included in the native suite.
- Independent follow-up review closed native dependency/acceptance/export lineage, manual candidate adoption, linked Git metadata observation, stat-cache and RPC backpressure findings. Independent selected-tool follow-up closed T1–T4: real Rust/npm identity changes and CMake/Ninja positive/launcher rejection verified; 27 focused tests passed. Sandbox notification delivery remained unavailable in the reviewer environment; the host-permission sticky-notification regression and full 304-test acceptance passed. No remaining confirmed Critical/Important finding in the reviewed supported scope.
- Linux/Windows locked native checks and actual acceptance, packaged GUI/production CSP, authenticated providers and user trials remain unqualified. No push, merge, remote PR mutation or hardware action was performed.
- Worktree and uncommitted implementation preserved on `feat/task-first-control-center`; original main checkout remained clean.
