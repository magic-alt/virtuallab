# Workspace collaboration implementation plan

> **For agentic workers:** Use superpowers:executing-plans for the coordinated implementation; independent frontend, native context and terminal changes may run concurrently with explicit file ownership.

**Goal:** Make selected companion repositories discoverable to Codex terminals and Agents Hub while retaining one owning worktree.

**Architecture:** A shared reference contract and native validator connect persisted UI selections to managed sessions, direct Codex PTYs and task records. Existing ownership and task verification stay scoped to the primary repository.

**Tech stack:** React, TypeScript, Zustand, Tauri, Rust, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-workspace-collaboration-design.md`

## Constraints and review focus

- Provider-neutral local repository references; no project-specific paths or dependencies.
- Exact JSON contract: `contextRepositories?: { repositoryRoot: string; workspaceRoot: string }[]`, default empty on native deserialization.
- At most eight references. Missing paths and overlapping writable roots fail visibly; no implicit write grants.
- Windows paths, Unicode and argument metacharacters must survive without shell interpretation.
- Changes to references cannot silently change a running provider's effective context.
- Old persisted tasks and session bindings remain readable; task retries retain the accepted reference list.

## Task 1: Native context and managed sessions

- [x] Add `src-tauri/src/workspace_context.rs` with canonical Git membership validation, context formatting and lifecycle retention; first cover real Git fixtures and failures.
- [x] Add optional/default references to session requests/bindings and pin them to the native process lifetime in `agent.rs`.
- [x] Reject changed references on an active session, include reference instructions in turns, retain primary write restrictions, and reject unsupported CLI reference contexts explicitly.

## Task 2: Typed Codex terminal

- [x] Add `terminal_spawn_codex({ id, cwd, cols, rows, executablePath, contextRepositories })` in the native process adapter.
- [x] Use shared validation/retention and structured PTY argv; retain notifications and ordinary shell support.
- [x] Test spaces/Unicode/metacharacters, explicit executable selection, no write grants to references and teardown behavior.

## Task 3: Collaboration interface

- [x] Add reference types, persisted store and reusable selector. Test isolation, removed repositories and fixed worktree selection.
- [x] Wire the selector into repository overview, Hub sessions and task creation; show saved task references.
- [x] Send references to managed attach, refuse stale active bindings and start Codex terminals through the typed native wrapper.

## Task 4: Task snapshot and integration

- [x] Extend native task draft/record storage with default-empty references. Validate before acceptance and provider launch; pass task references to its managed session.
- [x] Test old record compatibility and snapshot retention, invalid references and prepared-worktree context propagation.
- [x] Update architecture/user documentation and run frontend/Rust checks and UI inspection.
- [x] Independently review the resulting branch and resolve material findings.
- [x] Commit and open a reviewable pull request against current main: [PR #92](https://github.com/magic-alt/virtuallab/pull/92). Platform CI remains the integration gate.

## Verification record

- Locked dependency installation completed without lockfile changes. TypeScript typecheck and the production build passed.
- Full frontend run: 97 suites / 618 tests passed; one existing suite / test skipped.
- Linux `cargo check --locked` passed. The full native run covered 494 tests: 488 passed, five environment failures, one ignored. Three failures required the missing CMake/Ninja packages; two markerless lifecycle fixtures inherited the environment's temporary-directory Git marker. After installing the prerequisites and using an isolated temporary directory, the same binary passed all three CMake cases and all 30 lifecycle tests. No assertion or production code was changed for those environment failures.
- Browser checks covered the shared selection, fixed companion Worktree, typed terminal payload, managed-session reconnect requirement, task defaults and desktop/narrow layouts with mocked native IPC. Real Linux PTY tests separately verified literal arguments and retained reference leases.
- The installed Codex 0.159.2 configuration protocol was independently checked without starting a model turn. Permission, task-history, canonical-path and lifecycle regressions passed; independent code and documentation review found no remaining actionable issue.
- Authenticated model-driven repair and actual Windows/macOS desktop operation were not exercised locally. Cross-platform automated acceptance runs on the pull request.
- PR CI confirmed Node 22/26 checks, Windows native acceptance and qualification checks, and macOS core acceptance, application bundle and provider-review fixtures. It also exposed two existing test synchronization issues: an immediate session-store assertion before its passive effect, and a cancellation clock that included Git preflight/hook startup. The former now waits for the exact state contract (24 related tests passed). The latter now measures from the first observed cancellation and still requires cleanup in less than 15 seconds, with explicit cancellation and original workspace-content assertions. An injected 16-second pre-readiness delay failed the old test and passed the corrected test; normal execution also passed. These corrections change tests only; the final follow-up commit reruns platform CI.
