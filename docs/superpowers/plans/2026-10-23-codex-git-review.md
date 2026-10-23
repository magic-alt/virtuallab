# Codex Git Review Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Provide supervised Codex cleanup recommendations with exact user selections, and correct unsafe or surprising Git targets.

**Architecture:** Native Git collects bounded evidence and owns all mutations. A separate cancellable Codex process interprets that evidence, while React displays structured progress and validated recommendations. Approval is bound to the inventory and only selected actions execute.

**Tech Stack:** React/TypeScript, Tauri/Rust, installed Codex CLI.

**Spec:** `docs/superpowers/specs/2026-10-23-codex-git-review-design.md` (approved by user 2026-10-23).

## Global Constraints

- No arbitrary-shell APIs or secret/environment/file-content collection.
- No automatic fetch, branch switch, force deletion or merge from cleanup.
- Preserve native confirmation, lifecycle reservations, SHA checks and remote leases.
- Work on the explicitly requested `feat/codex-git-review` branch in the current checkout.

## Review Focus

- Changed destinations or refs while analysis/confirmation is pending must invalidate execution.
- Local/remote/worktree checkboxes must never imply each other's approval.
- Model failure, malformed/duplicate/foreign targets and cancellation must never delete.
- Repository navigation and refresh must invalidate the review and ignore late events.
- Codex must receive bounded metadata only; its process must have no repository-reading tools.

### Task 1: Git evidence and selectable execution

Files: `src-tauri/src/git/cleanup.rs`, `src-tauri/src/git.rs` and native tests.

Interfaces: retain `CleanupPlan`; add typed `CleanupSelection` and native selected execution; resolve default base without switching; preserve old executor for existing internal test helpers.

- [x] Add failing tests for preview from feature/master, subset execution and forged/duplicate selections.
- [x] Run focused native tests and observe failures.
- [x] Implement base resolution, protected selected branch, selected execution and exact revalidation.
- [x] Run focused native tests.

### Task 2: Supervised Codex analysis

Files: new `src-tauri/src/git/analysis.rs`, `src-tauri/src/lib.rs`, `src/lib/gitCleanup.ts`.

Interfaces: operation-scoped `git_cleanup_analyze`, `git_cleanup_cancel`; JSON result containing summary and branch recommendations. Structured `git-cleanup-analysis` lifecycle events; typed frontend wrappers.

- [x] Add tests for bounded metadata prompt, exact recommendation validation and child cancellation/error behavior.
- [x] Observe failures, then implement a managed Codex process with bounded output, timeout, cancellation and schema validation.
- [x] Run focused tests; do not invoke a real model on repository contents during verification.

### Task 3: Review UI

Files: new `src/features/git/CleanupReviewDialog.tsx` and tests; `src/features/shell/WorkbenchShell.tsx`, sidebar and associated tests.

Interfaces: dialog receives repository/workspace identity, refresh revision and completion callback; opens on explicit Clean merged action. Typed wrappers perform preview, analysis, cancellation and selected confirmation.

- [x] Add failing tests for no implicit switch, model conclusions, independent selections, failure fallback and invalidation.
- [x] Implement terminal-style structured progress and accessible selectable report, with explicit deterministic fallback.
- [x] Run focused frontend tests and typecheck.

### Task 4: Git audit corrections and delivery checks

Files: Git backend/wrappers/tests, `docs/ARCHITECTURE.md`, `docs/GIT_OPERATIONS_AUDIT.md`, acceptance runner.

- [x] Add failing regression tests for upstream Pull and remote fetch/push mismatch; implement verified upstream/destination and conditional tracking cleanup.
- [x] Inspect switch, stash/restore/delete, worktree, GitHub/task integration guards and record evidence/findings.
- [x] Run locked dependency installation, frontend suite/typecheck/build, native tests/check and local acceptance runner; record unavailable host checks precisely.
- [x] Review complete diff and request one fresh whole-branch review, address material findings, and report results without publishing or merging.

## Execution record

- User confirmed implementation; continue inline without another design approval round.
- Branch created successfully. Initial checkout was clean; no worktree requested or created.

- Independent review found two Important issues: stalled Git collection was outside the Codex timeout, and multiple configured upstream merge targets were silently projected to the first. Both now have regression coverage and fixes; no reviewer findings were deferred.
- Workspace choice: retained the current checkout and the user-requested feature branch; no extra worktree was requested.
- Synced by fast-forward to `origin/main` at `eadc634` (0.5.13), restoring the development stash and preserving the upstream task delivery URL qualification through two conflicts. The conflict-recovery stash is retained as a backup.
- Host validation initially hit the existing version-history test's 5-second deadline at full frontend worker concurrency; the complete frontend suite passed with two workers.
- Native tests exposed an existing Node 26/Windows verbatim script-path limitation in the Codex context probe fixture. The fixed relative script filename resolves from the already pinned fixture cwd; both previously failing tests now pass.

## Final verification

- `npm ci --ignore-scripts`: passed against the synchronized 0.5.13 lockfile.
- `npm run acceptance:local` on Windows (Node 26.1.0, frontend workers 2, Rust test threads 4, Cargo jobs 1): exit 0.
- Frontend: 103 test files passed / 1 skipped; 668 tests passed / 2 skipped; typecheck and production build passed.
- Rust: 498 tests passed / 3 intentionally ignored; no failures. Context protocol, analysis cancellation/timeout, selected cleanup, stale snapshots and upstream regressions are included.
- `cargo check --locked -j 1 --manifest-path src-tauri/Cargo.toml`: passed on Windows. Version consistency, icon parity and diff whitespace checks passed.
- No real Codex/model invocation or desktop GUI smoke was performed. Linux Rust check and Linux/macOS acceptance are left to the existing PR CI jobs; they are not claimed as Windows validation.
- Independent review: two Important findings fixed with regression coverage; no unresolved or deferred findings.
