# Agents Hub Implementation Plan

> **For agentic workers:** Use Superpowers implementation and verification workflows; execute the authorized consolidation continuously.

**Goal:** Consolidate Task and direct Agent management into Agents Hub while retaining repository development tools.

**Architecture:** Compose existing Task and workspace-session services through one application surface. Keep native runtime authority and workspace identity explicit.

**Tech Stack:** React 19, TypeScript, Zustand, Tauri 2/Rust, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-agents-hub-design.md`

## Global constraints

- No new dependency or arbitrary-shell command API.
- Workspace owns repository/process state; Hub navigation never starts work.
- Preserve four manual providers and Codex-only scheduled Tasks.
- Keep existing Task records, saved bindings and explicit approval boundaries.
- Preserve Windows/UNC normalization and POSIX case-sensitive identities.

## Review focus

- External sibling worktree ownership, stale persisted bindings and removed roots.
- Late async inventory/session results after selection or repository removal.
- Task/manual runtime takeover, including direct IPC and cleanup races.
- Hidden Hub/repository panes, notification focus and retained Terminal sessions.
- Changed executable preferences versus frozen or explicitly edited Task inputs.

## Task 1: Native session authority

Files: `src-tauri/src/agent.rs`, trusted call sites in `task_execution.rs`.

- [x] Reproduce generic session control reaching a Task-owned runtime.
- [x] Add an internal runtime owner and reject incompatible public control.
- [x] Retain Task-only exact-bound startup, turn and cleanup paths.
- [x] Run focused authority and Task cancellation/provider regressions.

## Task 2: Hub workspace session inventory

Files: `src/features/agents/AgentSessionHub.tsx`, `AgentWorkspace.tsx`,
`agentsHub.css`, corresponding tests, `src/stores/agentPreferences.ts`.

- [x] Test explicit owner selection, sibling worktrees, stale results, task-owned
  exclusion and hidden draft retention before implementation.
- [x] Implement read-only inventory and keyed workspace session panels.
- [x] Preserve existing advanced configuration/recovery capabilities.
- [x] Share the existing Codex executable preference reactively.
- [x] Run session/inventory/preference tests.

Interface: `AgentSessionHub({repositories,activeRepository,visible,onOpenWorkspace,onOpenTask})`.
`useAgentPreferences` exposes `codexExecutablePath` and `setCodexExecutablePath(path)`.

## Task 3: Application navigation and migration

Files: `WorkbenchShell.tsx`, `WorkspaceContent.tsx`, `types/workbench.ts`,
`stores/workbench.ts`, relevant shell/workspace/store tests.

- [x] Test one Hub entry, obsolete-tab migration and retained workspace tools.
- [x] Remove repository Agents, migrate schema v8, add contextual Hub navigation.
- [x] Route Agent notices to their task/session; preserve Terminal notice focus.
- [x] Validate external worktree owners without path-prefix assumptions.
- [x] Run focused navigation, persistence and notification regressions.

Interface: `useAgentsHubStore` exposes `section`, `sessionTarget`,
`visibleSessionRoot`, `showTasks()`, `showSession({repositoryRoot,workspaceRoot})`,
and `setVisibleSessionRoot(root|null)`; no execution occurs in these actions.

## Task 4: Integrate task surface and current documentation

Files: new `src/features/agents/AgentsHub.tsx`, compatibility export in
`TaskControlCenter.tsx`, `TaskDetail.tsx`, `TaskQuickCreate.tsx`, Hub store/tests,
current guide/docs.

- [x] Test task/session switching, retained prompt, configuration destination,
  shared executable preference and no generic controls for managed tasks.
- [x] Compose the Hub; remove redundant task-to-Agents link; keep typed links to
  repository Terminal/Run/Changes/GitHub.
- [x] Update current documentation and audit evidence.
- [x] Run typecheck, complete frontend tests/build, locked native check and
  relevant/full native acceptance as available.
- [x] Independently review the complete diff and resolve findings.
- [ ] Publish the staged commits and a reviewable PR; use its exact-head CI to
  finish the complete frontend and host gates. Record final check receipts in
  the PR so verification is tied to the published commit.

## Execution record

- Initial audit established two valid execution lifecycles and four legacy
  navigation paths. Main baseline and merged PR #89 were verified through GitHub.
- Locked dependency installation completed. The baseline's restricted-process
  failures and both final local full-suite timing failures are recorded explicitly
  in `docs/AGENTS_HUB_AUDIT_2026-10-20.md`; none is represented as a passing gate.
- Implementation and focused frontend/native regression checks are complete.
  Production compilation and actual-browser layout/navigation checks passed.
- Independent source review found four P2 issues; all were reproduced, fixed and
  reread. The reviewer reported no remaining P1/P2 source finding.
- No source change or relaxed timeout was justified by the local full-suite
  failure diagnosis. The final published commit's configured Node 22/26 and
  three-host CI checks remain the gate of record.
