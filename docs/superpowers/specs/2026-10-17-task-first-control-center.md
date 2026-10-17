# Task-first Engineering Control Center

Approved in conversation on 2026-10-17. Workspace remains the owner of repository state and runtime resources; Tasks reference Workspaces. Implement the accepted staged roadmap, preserving direct workspace tools and explicit human confirmation for integration, remote mutations and destructive operations.

## Product contract

- Task-first navigation: control center, tasks (including attention filters), repositories, evidence, settings and application help.
- Separate execution outcomes, observed checks, current delivery readiness and revision-bound human acceptance. Agent completion never establishes PASS or readiness.
- AI suggests a structured plan in a qualified read-only session; users edit/accept it before explicit worktree creation and execution. Manual planning remains available when read-only planning is unavailable.
- Approved task-local commits are sealed by Native after scope and input validation. Two implementation worktrees feed a dedicated integration worktree; fixed sources and target are previewed and explicitly confirmed before integration.
- Final integrated committed clean inputs are independently verified. Input/Profile/toolchain changes invalidate readiness and review/acceptance applicability, including changes without a new HEAD.
- Retry creates an Attempt; re-verification creates a Run. Persist structural records and recover unknown outcomes honestly; never replay mutations after restart.
- Shared lifecycle reservations cover every controlled writer, startup, stopping, deletion and deregistration. Worktrees are not OS sandboxes.
- Versioned app-data task/evidence storage, typed Rust commands through src/lib wrappers, structured task events, bounded concurrency (2) and queued leaf tasks (32).
- Evidence v2 records lineage, exact inputs, Profile digest, observed toolchain, checks and artifact digests. v1 stays historical and unqualified. No credential/environment dump or .env fingerprint.
- Neutral dark surfaces with orange accents, legible typography, keyboard access, bounded independent log/diff scroll areas and a persistent workspace-owned terminal host.

## Delivery slices

1. Reliable shared lifecycle and read-only planning capabilities.
2. Durable task/attempt/plan records and Task-first UI, with capability-gated future actions.
3. Bounded dependency scheduling and explicit worktree provisioning.
4. Candidate sealing, confirmed integration, fresh verification, review, acceptance and passport.
5. Independent review/fix loop, evidence hardening, simulated prototype scenarios and qualification documentation.

## Required checks

Locked dependency installation; frontend typecheck, tests and production build; Rust locked check/tests; Windows/macOS/Linux acceptance runner; no new arbitrary-shell API. Packaged GUIs and authenticated providers require separate host-specific records. No test success can substitute for these records. No hardware executor, cloud/team backend, release automation or cross-repository DAG is in scope.
