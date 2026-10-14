# VirtualLab product audit and staged remediation — 2026-10-14

> Source baseline: `main@5f5b471154392bea6f4f57b64299b3c1e20f48d6`, after merged #58 and #59. The changes under review are in draft PR #60. All observations below distinguish source implementation from authenticated desktop/packaged acceptance.

## Product thesis and non-goals

**Category:** local-first **engineering task and review orchestration workbench**. The differentiator is coordinated Git worktrees, independent harness processes, reproducible verification, and operator-reviewed GitHub handoffs. It should not become another full editor, multi-user cloud SaaS, LLM model runtime, or a hardware-specific laboratory.

**Primary user:** engineer/technical lead moving among 2–4 feature/fix/review lanes in one or several existing repositories. A unit of work is an operator-approved task assigned to a specific, identifiable Git worktree/HEAD; a worktree may own a terminal, runs, review state and one harness. Branch switching and workspace switching are different user operations.

**Core jobs-to-be-done:** import any Git repository; create safe isolated lanes; continue shell/build/agent output while navigating; inspect actual revisions; detect and resolve change conflicts with explicit action; hand off review/verification evidence; build an auditable result without implicit merges or local data loss.

## Audited baseline

| Surface | Implementation evidence | Remaining product/quality gap |
| --- | --- | --- |
| Repository/worktree navigation | `WorkbenchShell`, `workbench` store; #59 owner-scoped snapshot requests | Rapid repository changes and external deleted/moved worktrees need packaged GUI soak |
| Git changes/branch handling | Native `git.rs`; #59 confirmation-before-stash, --no-overwrite-ignore | Per-stash worktree provenance and guided selective recovery absent; collisions must remain safe failures |
| PTY/workspace terminal | `WorkspaceTerminals`, `execution.rs`; #56, #58 retention/cleanup | 2×2×2 interactive terminal qualification and strict cross-workspace resource ownership still needed |
| Run/build | `build_workflows.rs`, `run_registry.rs`, `ProcessRunner` | Native run history ephemeral; cannot truthfully claim resumed job after restart |
| Changes/GitHub/review | `ChangesReview`, `GithubPanel`, `github.rs` | No controlled reviewer → fixer → SHA-bound reverify → approval loop |
| Agent harnesses | `agent.rs`, `agent_cli.rs`, `AgentWorkspace` | One harness/worktree but no durable task board/DAG, reliable restart reconciliation or provider acceptance matrix |
| Verification | `verification.rs`; SHA-256 local manifests | No indexed immutable evidence registry and release-readiness gate |
| Safety/privacy | Native confirmations, worktree registration, execution modes | Worktree is NOT a process sandbox; no system-level resource sandbox, no real hardware authorization |

### Confirmed source issue, fixed in candidate PR #60

- `ProjectSidebar` compared occupied branch worktree paths using unconditional lowercase. This incorrectly conflates case-distinct POSIX paths. Fix: reuse `workspaceKey` (Windows-drive and UNC folding only), with POSIX/Windows regressions.
- `remove_worktree` did not consult persistent native execution ownership; the view can be unmounted while a PTY/Agent/Run continues. Candidate fix: refuse removal when native Agent (Codex/DeepSeek/CLI), Run/Build registry, or live terminal owns the path. **Limitation:** this is a conservative native preflight, not an atomic start/remove lock; close the race through a shared scheduler/workspace lifecycle reservation in V0.7.
- `run_registry.rs` used its own simplistic path comparison, inconsistent with canonical agent ownership for symlink spellings. Candidate fix: use the common native identity key for run ownership.

### Important gaps, not claimed as fixed

- **P0 — durable task state:** live Agent timeline holds only 300 events and session thread bindings outlive active processes. No persisted attempt graph, task lease, or crash-proof outcome.
- **P0 — execution boundaries:** a stale UI or model output cannot authorize a new active worker/force Git operation. Strengthen native reservations and real-provider permission negotiation, especially across worktree deletion.
- **P0 — release qualification:** must validate packaged UI on Windows/macOS/Linux and live CLI/provider versions, not merely tests or mocked UI.
- **P1 — operator flow:** no overview showing all workspaces' running/stopped/waiting tasks, safe handoff points, port collisions, or multi-worktree dependency DAG.
- **P1 — provenance:** checks and review readiness need exact SHA/profile evidence, and stale revisions must invalidate claimed PASS.
- **P2 — UX efficiency:** bulk lane setup, search and context navigation, traceable task messages, keyboard accessibility and long-log memory profiling.

## V0.6 first slice in PR #60

Introduce a **native, bounded, metadata-only lifecycle journal**. It records only structural session/turn/process/rejection/error events, hashes workspace/thread/turn identifiers, rejects raw provider text, writes to application data outside Git, rotates at 2 MiB/segment (current + previous), syncs durable writes, ignores torn final records, rejects interior corruption, and exposes a per-workspace read-only history panel. The historical panel is separate from the live payload-bearing timeline. A persisted start without observed completion is **UNVERIFIED**, not `running` or `passed`.

**This does not close Issue #18:** future slices require searchable indexed task/attempt lineage, opt-in payload retention with explicit redaction and purge, atomic archive rotation robustness, versioned migration, crash/restart reconciliation against native process identity, idempotent replay into Supervisor, and measurable retention limits. Do not promote the first slice to full durability status.

## Phased release plan

| Stage | Gate | Demonstration (must be evidence-backed) |
| --- | --- | --- |
| V0.5 stabilization | No cross-owner UI overwrite, no lost terminal on page change, no silent destructive branch change | 2 repositories × 2 worktrees × 2 terminals; repeated navigation, dirty branch switch/cancel/recovery; clean stop |
| V0.6 #18/#19 | Metadata safely recoverable, runtime ownership verifiable, provider controls fail closed | Forced quit during mock turn; restart reports unknown until native reattachment verifies; corrupt tail fixture; case-distinct identities |
| V0.7 #20/#21 | Deterministic bounded scheduler over isolated worktrees | Two independent jobs parallel; dependent third queued; one writer/worktree; stop-all; branch/port conflict guards |
| V0.8 #22/#23 | Human-approved revision-aware review and evidence | Reviewer → fixer → new HEAD → recheck → explicit PR action; stale evidence always blocks |
| V0.9 #24 | Usable supervisor board/observability | Operator understands every task's owner, revision, approval wait and failure without reading raw provider logs |
| V1.0 #25 | Release qualification | Packaged installation/upgrade/restart, native focus/PTy stress, provider auth/version matrix on claimed hosts |

## Product-level target metrics (targets; not measured results)

- **Data loss by default:** 0 silent reset/clean/drop/force operations. Git stash recovery must stay explicit.
- **Isolation:** 0 simultaneous writer allocations to one canonical workspace identity; no cross-workspace terminal/process misrouting.
- **Truthfulness:** 0 false green when revision, provenance, approval, or verification evidence is missing/stale.
- **Recovery:** 100% ambiguous interrupted attempts visible as unverified/blocked, not automatically resumed.
- **Workflow acceptance:** define a repeatable 2×2×2 local UI test and a 2-agent/3-task fixture before claiming Supervisor readiness.
- **Privacy:** 0 raw model prompts/responses or tool stdout/stderr persisted in default metadata history.

## Implementation and approval boundaries

Operators choose repositories, branches, task plans, allowed capabilities and final PR actions. Providers supply untrusted candidate edits and model events. The native supervisor owns stable worktree identity, process lifecycle, event sequence and allowed transitions. Verification services own independently observed software results. A single UI approval never grants OS-level confinement or independent physical hardware authorization. Unsupported hardware operations remain disabled.

## Required acceptance for #60

- Frontend typecheck/test/build and locked Rust tests on Windows/macOS/Linux from the **final PR head**.
- Native metadata retention/rotation, torn trailing JSON, missing directory, corrupt interior record, case-sensitive keys, high-volume provider events and no-secret-persistence tests.
- Worktree-removal attempts with active Terminal, Agent and Run/Build must fail with actionable messages; after confirmed clean Stop and native exit, normal and force-removal flows remain available.
- Manual packaged GUI validation remains unchecked until performed and recorded; GitHub CI status alone does not constitute release approval.

See: `docs/MULTI_WORKSPACE_AUDIT.md`, `docs/MULTI_AGENT_DESIGN_REVIEW.md`, and Issues #17–#25.
