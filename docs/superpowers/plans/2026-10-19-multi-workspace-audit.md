# Multi-workspace audit and repair plan

**Goal:** Audit the current architecture, interfaces and operator workflows, repair reproducible isolation failures, and deliver staged commits followed by a complete regression run.

**Baseline:** `main@5dc6ce8b872d225ed620418053adf5004edad1e7` (0.5.5), including PRs #82–#85. Branch: `fix/multi-workspace-audit-20261019`.

**Architecture:** Keep React views and typed adapters above the Rust command boundary. A workspace retains ownership of its processes and state; a Task references fixed workspace and prerequisite identities. Repair existing transitions without introducing a new scheduler, repository-specific integration or arbitrary shell interface.

**Execution:** Independent investigations and disjoint implementation files run in parallel. The coordinating agent reviews and commits each stage separately. Tests first reproduce the failure, then verify the correction. The user's request authorizes implementation and branch submission; no main-branch merge is part of this work.

## Constraints and review focus

- Preserve Windows drive/UNC semantics, POSIX case sensitivity, spaces and Unicode paths.
- Match the directory reserved by lifecycle management to the directory passed to Git.
- Refuse removal that overlaps another active workspace; unrelated siblings and repositories remain usable.
- Delayed UI requests and Agent events must retain their original owner and cannot revive retired state.
- Hiding a retained workspace preserves sessions while disabling its visible-only resize and notification suppression.
- Implementation prerequisites are frozen read-only context; integration candidates must actually contain their prerequisites.
- An unavailable repository must not erase healthy repositories' Task state. Delayed hydration must not revive removed repositories.
- Existing tests, OS/provider limitations and any pre-existing failures are reported explicitly.

## Stage 1 — Native workspace identity and lifecycle

**Files:** `src-tauri/src/git.rs`, `src-tauri/src/workspace_lifecycle.rs`, `src-tauri/src/watch.rs`.

1. Add failing real-Git and lifecycle tests for repository-relative worktree paths, active nested writer/terminal/creation ownership, removal-first startup races and sibling independence.
2. Resolve a custom relative target against the selected repository once, before reservation, directory creation and Git invocation; return the same absolute path.
3. Enforce overlapping retirement reservations while retaining nonexclusive interactive terminal semantics outside retirement.
4. Exercise the actual metadata watch registration with an existing sibling changing between existing branches; watch its worktree administration directory recursively without recursively adding the shared objects directory.
5. Run the relevant native regression groups, review the diff and commit the stage.

## Stage 2 — Frontend lifecycle, event order and visibility

**Files:** `src/features/github/GithubPanel.tsx`, `src/stores/agentTimeline.ts`, `src/stores/workbench.ts`, `src/features/agents/AgentWorkspace.tsx`, `src/features/shell/WorkbenchShell.tsx`, `src/features/workspace/WorkspaceContent.tsx`, `src-tauri/src/agent.rs` and their tests.

1. Reproduce GitHub A→B→A and detach-with-pending-request cases; reject obsolete responses before both local and persisted state writes.
2. Reproduce completion-before-start/reply and old-completion-after-new-turn cases; bind active/terminal state to workspace and thread/turn identity with bounded memory.
3. Navigate a real retained terminal pane through Tasks/Evidence/Settings/Home; propagate application visibility through the workspace host and include application view in Agent notification focus checks.
4. Run focused UI/store regressions and the frontend typecheck; review and commit the stage.

Independent review added four concrete retirement cases to this stage: late
comment success after owner removal, the second native start event for an old
turn, buffered provider identity after explicit Forget, and provider identity
promotion after destination stop/completion. All received failing regressions,
targeted fixes and a fresh independent recheck before the full acceptance run.

## Stage 3 — Task dependency contract and partial availability

**Files:** `src-tauri/src/task_runtime.rs`, `src/stores/tasks.ts`, `src/features/tasks/TaskControlCenter.tsx` and their tests.

1. Use independent implementation worktrees and a separate integration worktree to reproduce the invalid ancestor requirement. Keep identity/scope/source checks for all candidates and the actual-prerequisite-ancestry rule for integration candidates.
2. Reproduce multi-repository hydration where one root is inaccessible. Keep native single-root validation strict; hydrate registered roots independently and display scoped errors while retaining healthy results.
3. Test unavailable-root recovery and late requests during repository removal.
4. Run focused native/store/UI tests, review the resulting data flow and commit the stage.

## Stage 4 — Platform-correct workspace identities

**Files:** `src-tauri/src/workspace_identity.rs`, `src/lib/workspaceKey.ts`, binding hydration tests, `scripts/workspace-key.test.mjs`, and the platform assertion in `src-tauri/src/agent.rs`.

The native audit reproduced a collision between actual POSIX directories named
`literal\child` and `literal/child`. Separator rewriting and trailing separator
trimming must follow the path's platform semantics, including a POSIX directory
whose name ends in a literal backslash. Preserve existing Windows drive, UNC and
case normalization. Confirm stored bindings rebuild keys from their recorded roots.
Keep this correction in its own tested commit.

## Stage 5 — Overall regression and audit evidence

1. Run locked dependency installation, typecheck, all frontend tests, production build, version/icon checks, Node artifact checks, Linux `cargo check --locked`, and the local acceptance runner (including the full native suite).
2. Review the whole branch independently, correct any material findings and rerun the affected gates.
3. Update architecture and audit documentation with concrete test results and remaining qualification boundaries.
4. Push every stage to the requested branch, create a reviewable PR, and inspect the existing Windows/macOS/Linux and Node CI matrix at the final revision.

## Baseline evidence

- `npm ci --no-audit --no-fund`: passed with the committed lockfile.
- `npm run typecheck`: passed.
- `npm test` under the restricted process sandbox: 420 passed, 1 skipped, 5 failed solely with `spawnSync ... EPERM`.
- The identical `npm test` command with subprocess execution allowed: **425 passed, 1 skipped**. No test or product change was needed for those five failures.
- Initial native dependency generation left an incomplete cached `web_atoms` file. Its unchanged build script produced complete output independently; only that dependency's cache was rebuilt.
- The pristine-main native baseline was 353 passed, 6 failed, 1 ignored. Four fixture-root failures passed with the original tests under an independent temporary directory; the process timeout and ambient Git tests passed unchanged with a stable copied test executable. The overall run uses that independent fixture root and prohibits concurrent relinking. See the [audit evidence](../../MULTI_WORKSPACE_AUDIT_2026-10-19.md).

## Progress

- [x] Latest main/PR alignment, isolated branch and independent worktree.
- [x] Reproducible findings and disjoint file ownership assigned.
- [x] Stage 1: lifecycle 26/26, Git 53/53, metadata/watch 25/25; committed and pushed as `4e2a80a`.
- [x] Stage 2: focused frontend 81/81, current-process exit 2/2, typecheck; committed and pushed as `2c3e88e`.
- [x] Stage 3: Task runtime 18/18, frontend 44/44; committed and pushed as `4a2ef5f`.
- [x] Stage 4: native identity 4/4, frontend key/binding 16/16, typecheck; committed and pushed as `2fabb7a`.
- [x] Overall local regression: frontend 472 passed / 1 platform skip; native 375 passed / 1 explicit probe ignored; complete acceptance exit 0, production build and locked native check passed.
- [x] Independent source review and four follow-up fixes rechecked; no unresolved Critical/Important/Minor finding.
- [x] Architecture and audit evidence recorded. PR submission and the final revision's live CI status are recorded in the pull request and delivery handoff.
