# Agents Hub and Settings Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or bounded parallel
> implementation with explicit file ownership; verify each deliverable before
> integration.

**Goal:** Make Agent tasks, sessions, reports and execution configuration coherent,
and make global settings control real application behavior.

**Architecture:** Preserve native Task/Attempt authority and workspace process
ownership. Refactor existing React navigation and preferences; separate task
snapshot publication from readiness observation.

**Tech Stack:** React 19, Zustand, TypeScript, xterm, Tauri/Rust.

**Spec:** `docs/AGENTS_HUB_SETTINGS_2026-10-20.md`.

## Global constraints

- Base on main `8f184db`; no dependency or native authority expansion.
- Keep stored task IDs, titles, Attempt history, Profile freezing and detail keys.
- Preserve Windows paths, spaces and Unicode; trim executable paths only on use.
- Settings changes do not launch processes, create worktrees or grant acceptance.
- Keep repository Terminal/Run hosts and visited workspace sessions mounted.

## Review focus

- Identical titles across repositories and old failed/new running tasks.
- Slow readiness returning after a newer revision or a navigation change.
- Report event loss and responses from the previous task/Attempt.
- Corrupt/unavailable preference storage and hidden live terminal panes.
- Narrow windows, repository rail width, keyboard navigation and old view aliases.

## Task 1: Execution observations

Files: `src/stores/tasks.ts`, store regression tests,
`src/features/tasks/useTaskAttemptReport.ts`, scoped observation tests.

- [x] Reproduce structural snapshot starvation and stale-revision overwrite.
- [x] Publish task state independently; bind readiness to the retained revision.
- [x] Add bounded active-report catchup with no concurrent polling backlog.
- [x] Run affected store, selection, report and observer tests.

## Task 2: Coherent Hub navigation and task detail

Files: `AgentsHub.tsx`, `agentsHub.ts`, `WorkbenchShell.tsx`, TaskList/TaskDetail,
scoped CSS, task presentation helpers and navigation/detail tests.

- [x] Assert three main routes, Hub configuration and legacy report routing.
- [x] Assert same-title task identity, latest Attempt status and editable search.
- [x] Consolidate reports/configuration; use compact rows and primary detail tabs.
- [x] Connect manual start/retry to default executable with explicit blank override.
- [x] Verify retained sessions, drafts, native guards and report/review navigation.
- [x] Inspect wide/narrow rendered application layout.

## Task 3: Practical global settings

Files: `src/features/settings/*`, `externalEditor.ts`, `terminalAppearance.ts`,
TerminalWorkspace and corresponding tests. Shell consumes `usePreferredEditor()`.

- [x] Reproduce missing controls and missing reactive/live preference behavior.
- [x] Add IDE and desktop-notification controls using existing persistence.
- [x] Add terminal font (12–22, default 15), scrollback (1,000–50,000, default
  8,000), and cursor blink (default true) controls with validated defaults.
- [x] Apply changes to mounted/hidden xterm instances without PTY recreation.
- [x] Run focused preference/UI tests.

## Task 4: Integration and delivery

- [x] Update current help, architecture, navigation map and acceptance checklist.
- [x] Run locked installation, typecheck, full frontend suite and production build;
  retain the actual results below, including the isolated timeout.
- [x] Run Linux locked Cargo check and frontend browser acceptance checks.
- [x] Obtain independent whole-branch review and resolve material findings.
- Delivery gate tracked in the PR: publish the isolated branch and observe the
  existing Windows/macOS/Linux acceptance matrix.
- Delivery record in the PR: exact CI outcomes and untested provider behavior.

## Execution notes

- Locked offline installation passed after an approved normal-permission retry;
  the sandbox initially denied the esbuild install script's child process.
- Two observer regressions were observed failing before correction. The initial
  observer/launch/selection/task-model regression run passed 30 tests.
- Root coordinates navigation/detail; parallel workers own observer, preferences,
  and current documentation. No overlapping product-file ownership is assigned.
- The full local frontend run (`npm test -- --maxWorkers=2`) completed with
  **598 passed, 1 failed, 1 skipped**. The only failure was the unchanged version
  automation Git fixture at `scripts/version-automation.test.mjs:209`, which
  exceeded the default 5-second timeout. Its isolated rerun with one worker and
  unchanged timeout passed in **411 ms**. No test or timeout was changed to bypass
  that result; the PR's existing CI supplies the full-suite delivery gate.
- Three additional review regressions were observed failing, then passed: Profile
  draft retention, navigation made after a task read began, and initial task-tab
  selection. Independent follow-up review closed both material findings.
- Browser acceptance used the actual Vite frontend with disposable native-data
  fixtures at **1920, 1440, 900 and 600 pixels**. Task and settings layouts had no
  document horizontal overflow. Reports were also checked at 1440/900/600.
  Identity, search, filters, report actions, Profile import drafts, session drafts,
  preference reloads and settings without repositories passed. No page errors or
  unexpected native fixture commands were recorded.
- Linux `cargo check --locked --offline` passed with existing warnings. Locked
  dependency installation, final typecheck, version parity, icon parity and the
  RC-asset Node check passed. Production build output is recorded in the PR.
- Browser fixtures do not establish authenticated Codex execution or packaged
  desktop GUI acceptance. Real provider authentication was not available here.
