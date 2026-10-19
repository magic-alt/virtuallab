# Control acceptance matrix — V0.1 to V0.5 foundations

Every visible interactive control must have an automated test and/or an explicit desktop acceptance step. Automated success does not prove authenticated GitHub posting or safe physical hardware behavior.

## Task-first local implementation

See [capability boundaries](TASK_FIRST_CONTROL_CENTER.md). These automated regressions do not close the remaining packaged GUI, authenticated provider or three-host qualification gates.

| Surface | Automated evidence | Desktop acceptance still required |
| --- | --- | --- |
| App navigation and terminal retention | `WorkbenchShell.tasks.test.tsx`, existing workspace/terminal tests | Switch Task/repository pages with live PTYs in multiple worktrees |
| Natural-language quick create | `TaskQuickCreate.test.tsx`, `tasks.test.ts`, native task-scope tests | Enter Unicode goal in new task composer, inspect auto HEAD; change/switch repository; use advanced node wizard; confirm task accepted without implicit worktree/Agent start and with protected paths refused |\n| Plan, explicit preparation and recovery | Task UI/store tests; native task/coordinator fixtures | Manual plan through native folder/worktree provisioning; interrupted preparation reconciliation |
| Execute, Cancel and Retry | Task cancellation tests; exact-run/thread and bounded-slot native fixtures | Authenticated concurrent Codex instances; cancellation during startup, verification and integration |
| Task review context | `ChangesReview.taskBase.test.tsx`, `TaskWorkspaceTools.test.tsx` | Clean committed changes against accepted base; responsive diff and independent scroll |
| Evidence, review, acceptance and passport | Native source/toolchain/runtime/atomic-store tests | Source change-and-restore, tool replacement, restart, stale dependency and superseded human decision |
| Fixed-source integration and repair | Real temporary-repository native fixtures | Native confirmation cancellation/expiry, conflict preservation, committed scoped repair and independent re-verification |
| Offline prototype | Standalone syntax/state checks | Visual inspection of all six mock scenarios; no native execution |

| Surface | Control | Automated evidence | Desktop acceptance |
| --- | --- | --- | --- |
| Top bar | Search text | `WorkspaceSearch.test.tsx` | type repository/worktree name |
| Top bar | Ctrl+K focus | `WorkspaceSearch.test.tsx` | press Ctrl+K |
| Top bar | Clear search | `WorkspaceSearch.test.tsx` | clear button / Escape |
| Sidebar | Add repository | `ProjectSidebar.test.tsx` wiring | native folder picker + load |
| Sidebar | Repository select | `ProjectSidebar.test.tsx` | switch local repository |
| Sidebar | Repository remove | `ProjectSidebar.test.tsx` | remove from local inventory |
| Sidebar | New workspace | `ProjectSidebar.test.tsx`, `NewWorkspaceDialog.test.tsx`, Rust Git round-trip | create branch/worktree |
| Sidebar | Workspace select | `ProjectSidebar.test.tsx` | switch worktree |
| Sidebar | Workspace remove | `WorkbenchShell.branchSwitch.test.tsx`, `backend.worktreeRemoval.test.ts`, Rust `git.rs` force-removal fixtures | clean removal; dirty requires second native confirmation; cancel preserves selection/files; stale HEAD/status, primary, unknown and locked worktrees refused |
| Header | Fetch (default prune); no manual Refresh | `WorkspaceHeader.test.tsx`, `WorkbenchShell.watchRefresh.test.tsx`, Rust Git prune fixture | fetch/prune origin; local state refreshes automatically |
| Navigation | Overview/Changes/Terminal/Run/Checks/History | `WorkspaceContent.test.tsx` | switch each tab |
| Workspace dialog | Create / Cancel / close | `NewWorkspaceDialog.test.tsx` | create real worktree |
| Terminal | Start/New/Select/Stop | `TerminalWorkspace.test.tsx` | real PowerShell/bash PTY |
| Terminal | typing / Ctrl+C / resize | backend compile + local acceptance | required manual PTY check |
| Run | profile Run/Stop | `ProcessRunner.test.tsx` | real command execution |
| Run | repository profile isolation | `ProcessRunner.test.tsx` | switch between two repositories and verify profiles never leak |
| Run | add/remove/close profile | `ProcessRunner.test.tsx` | persistence after restart |
| Watcher | generated-dir filter + event rate limit + async start/stop | Rust `watch.rs` unit tests | source edit auto-refresh without event storms or UI-thread watcher teardown |
| Git | inspect/create/remove worktree | Rust `git.rs` real temporary-repo tests; blocking Git is offloaded from the Tauri UI thread; read-only Git disables optional locks and avoids recursive untracked expansion | real project worktree |
| Execution | event payload | Rust `execution.rs` unit test | streamed output in UI |

## Local gate

From Windows PowerShell, macOS Terminal, or Linux shell:

```bash
npm ci
npm run acceptance:local
npm run acceptance:local -- --launch
```

`acceptance:local` is implemented in Node and is cross-platform. It invokes npm through npm's JavaScript CLI with `shell: false`, so Node 26 does not emit DEP0190 shell/argument warnings. The first command runs automated checks and prints the desktop checklist. The second also launches the Tauri desktop runtime for the native-control portion.

A PR should not claim a native control is fully accepted until the corresponding desktop checklist item has been exercised on at least one supported OS.


CI repeats the automated gate on Windows, macOS and Linux. Node and Rust dependency graphs are locked by `package-lock.json` and `src-tauri/Cargo.lock`; CI uses `npm ci` and Cargo `--locked`.


## V0.3 Phase A — local diff

| Surface | Control / contract | Automated evidence | Desktop acceptance |
| --- | --- | --- | --- |
| Changes | changed-file selection | `ChangesReview.test.tsx` | select modified/staged files and verify patch changes |
| Changes | Worktree / Staged modes | `ChangesReview.test.tsx` + Rust diff fixtures | compare unstaged vs staged content |
| Changes | Base ref mode | Rust base-ref fixture | enter a valid base ref and load committed branch diff |
| Git diff | rename / delete / Unicode-space paths | Rust `git.rs` fixtures | inspect representative project changes |
| Git diff | binary fallback | Rust binary fixture | binary file shows explicit non-text state |
| Git diff | bounded large output | Rust large-patch fixture | large file shows `truncated` rather than freezing the UI |
| Git diff | safety boundary | path/worktree/ref validation tests | no arbitrary shell or Git write operation |


## V0.3 Phase A manual desktop procedure

Use a disposable Git repository so staged, unstaged, rename, binary and large-diff cases can be exercised without contaminating a real project.

### Windows PowerShell fixture

```powershell
$root = "D:\Temp\virtuallab-v03-acceptance"
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $root | Out-Null
Set-Location $root

git init
git config user.email "virtuallab@example.invalid"
git config user.name "VirtualLab Acceptance"

"base" | Set-Content README.md
"keep" | Set-Content "space file.txt"
git add .
git commit -m "base"
git branch -M main

git switch -c feat/review-fixture
git mv "space file.txt" "新 file.txt"
git commit -m "committed rename"

[IO.File]::WriteAllBytes("$root\blob.bin", [byte[]](0,1,2,3))
git add blob.bin
git commit -m "binary base"

"base`nunstaged" | Set-Content README.md
"staged" | Set-Content "staged file.txt"
git add "staged file.txt"

[IO.File]::WriteAllBytes("$root\blob.bin", [byte[]](0,9,8,7))

("x" * 700000) | Set-Content "$root\large.txt"
git add large.txt
```

Open this repository in VirtualLab and verify:

1. **Worktree** — `README.md` renders an unstaged patch; `blob.bin` shows the binary fallback.
2. **Staged** — `staged file.txt` appears; `large.txt` displays `truncated` without freezing the UI.
3. **Base** — enter `main`, click **Load base files**, and verify the committed rename and binary addition can be selected even if there are no corresponding working-tree edits.
4. **Rename / Unicode / spaces** — the committed rename is represented as `space file.txt → 新 file.txt`, without quoting/path corruption.
5. During every operation, drag the window and switch tabs; Windows must not show **Not Responding**.

The repository is disposable. Remove it after acceptance with:

```powershell
Remove-Item -Recurse -Force "D:\Temp\virtuallab-v03-acceptance"
```


## V0.3 Phase B — Monaco review

| Surface | Control / contract | Automated evidence | Desktop acceptance |
| --- | --- | --- | --- |
| Changes | local bundled Monaco | production build + `ChangesReview.test.tsx` | disconnect network and confirm selected text diff still opens |
| Changes | side-by-side / unified toggle | `ChangesReview.test.tsx` | switch layouts without another Git request |
| Changes | language detection | `reviewLanguage.test.ts` | TS/Rust/JSON/Markdown files use matching syntax mode |
| Changes | read-only editor | Monaco options | typing must not modify original or modified panes |
| Changes | loading/error/empty/binary/truncated states | `ChangesReview.test.tsx` | exercise representative states and keep UI responsive |


### Phase B responsive layout acceptance

The Changes review surface must use the available workbench viewport rather than a fixed Monaco height.

- maximize and restore the desktop window; the file list and Monaco diff should resize with the workbench
- in both **Side by side** and **Unified**, the editor must remain fully visible between the file header and bottom path/status rows
- scroll to the last changed line; bottom content must not be hidden behind the footer/path row
- long files must scroll inside Monaco, while the outer Changes page should not create a competing editor-height scrollbar
- the left changed-file list must scroll independently and remain aligned with the right review panel


### Phase B visual line wrapping acceptance

Long source/document lines must adapt to the available Monaco pane width without mutating repository content.

- in **Side by side**, narrow the desktop window and confirm long lines wrap independently inside both panes instead of disappearing beyond the right edge
- in **Unified**, narrow the desktop window and confirm long deleted/added lines wrap to the visible editor width
- resizing wider again must reflow the visual wrapping automatically
- wrapping is presentation-only: line numbers/diff identity remain tied to the original logical lines and no working-tree/index content changes are allowed
- after interacting with wrapped text, `git diff` must be identical to the pre-review state


### Phase B side-by-side original-pane wrapping regression

Monaco diff wrapping must be symmetric in side-by-side mode.

- select a file with long logical lines and switch to **Side by side**
- narrow the workbench until wrapping is required
- confirm the **left/original** pane wraps to its own visible width, matching the already-wrapped right/modified pane
- switch **Side by side → Unified → Side by side** and confirm left-pane wrapping remains active after the layout round trip
- resize the desktop window narrower/wider and confirm both panes reflow without horizontal content loss
- this is visual-only; verify repository/index content and `git diff` remain unchanged


## V0.3 local review drafts

| Surface | Control / contract | Automated evidence | Desktop acceptance |
| --- | --- | --- | --- |
| Monaco | original/modified line selection | component wiring + store tests | click a line in either diff pane and verify LEFT/RIGHT + line badge |
| Changes | Save draft | `ChangesReview.test.tsx` | enter text, save, switch files, return and verify draft remains |
| Changes | workspace persistence | `workbench.test.ts` | restart VirtualLab and confirm draft remains attached to the same worktree |
| Changes | stale HEAD handling | `workbench.test.ts` | create draft, advance HEAD, wait for automatic refresh; draft changes from active → stale |
| Changes | remove draft | store mutation + visible control | remove one draft without modifying source/index |

Drafts are local data. Creating, editing, selecting or deleting a local draft performs no network write and never mutates the reviewed file.

## V0.3 GitHub integration

| Surface | Control / contract | Automated evidence | Desktop acceptance |
| --- | --- | --- | --- |
| GitHub | capability detection | Rust adapter tests + `GithubPanel.test.tsx` | authenticated `gh auth status` shows connected |
| GitHub | local-only fallback | Rust offline/auth fixture + UI test | rename/remove `gh` from PATH or sign out; Changes still works |
| GitHub | PR context | Rust JSON fixture + UI test | load PR URL; verify number/title/base/head/files/check summary |
| GitHub | issue context | Rust JSON fixture | load issue URL; verify number/title/state/labels |
| GitHub | repository guard | Rust URL/repository tests | URL from another repository is refused |
| GitHub | persisted reference | store test | switch workspace and back; last successful PR/issue reference remains |
| GitHub | review comment mutation | UI explicit-confirm test + typed native request | Post remains disabled for stale/mismatched/non-PR drafts |
| GitHub | explicit confirmation | `GithubPanel.test.tsx` | click Post, inspect confirmation text, cancel once and verify no request |

### GitHub manual acceptance

1. Ensure `gh --version` and `gh auth status --hostname github.com` succeed in the same desktop environment.
2. Open a GitHub-backed workspace and select the **GitHub** tab. It must show **connected** and the origin `owner/repo`.
3. Paste a PR URL from the same repository. Verify title/state/base/head, changed files and check summary.
4. Paste an issue URL from the same repository. Verify issue metadata and labels.
5. Paste a PR/issue URL from another repository. VirtualLab must refuse it rather than silently switching repository context.
6. Create a local line draft in **Changes**, return to **GitHub**, and verify it appears without any network write.
7. For a matching PR HEAD, click **Post**. The confirmation dialog must appear before the native mutation is invoked. Cancel first and verify nothing is posted.
8. Confirm once on a disposable review comment; the draft must become **posted** and retain the returned GitHub URL.
9. Sign out of `gh` or temporarily make it unavailable, press **Detect**, and verify **local only** mode while Changes/Monaco/local drafts remain usable.

The GitHub adapter exposes no merge, reset, clean, force-push or release command in V0.3.


## V0.3 C — Review loop matrix

| Scenario | Automated tests | Desktop check |
| --- | --- | --- |
| PR/issue → worktree intent | `GithubPanel.test.tsx`, `NewWorkspaceDialog.test.tsx`, `reviewLoop.test.ts` | load an issue/PR from the selected repository, inspect prefilled `review/issue-N` / `review/pr-N` and click Create |
| Isolation and scope | Rust `git.rs` worktree tests, typed shell workflow | verify a sibling worktree is created; source reference is attached only to new worktree |
| Review → fix → refresh → re-review | `ChangesReview.test.tsx`, `workbench.test.ts` | mark fix, edit file externally, click Refresh and re-review, reload diff and mark reviewed |
| Stale open Diff | `ChangesReview.test.tsx` | keep Monaco open, edit tracked content, wait for automatic refresh; old editor is invalidated until reloaded |
| HEAD change / stale draft | `workbench.test.ts` | save draft, create new commit, wait for automatic refresh; previous active draft becomes stale |
| PR head/base relation | `reviewLoop.test.ts`, `GithubPanel.test.tsx`, Rust GitHub parse fixture | HEAD at PR base shows `At PR base` and posting disabled; HEAD at PR head allows only eligible draft |
| Offline/repository mismatch | existing GithubPanel/Rust guard tests | no `gh`: Changes and drafts still work; cross-repo URL is rejected |
| Mutations | existing explicit comment confirmation + native Git guards | creating worktree and posting comment need separate deliberate actions; no merge/reset/force push |

### Review-loop manual scenario

1. Use a disposable repository with a GitHub origin and two branches and an issue/PR on that **same** repository. Authenticate local `gh` if testing the GitHub steps.
2. Load issue context, select **New issue worktree** and **cancel**. Confirm no Git branch or worktree was created.
3. Repeat and explicitly create `review/issue-N` from local HEAD; verify switch to the new worktree with persisted issue link. Revisit another worktree and return to confirm isolation.
4. Review a tracked changed file in Changes, create a draft and mark **fix in progress**. Make an edit in an external editor or terminal.
5. Click **Refresh and re-review**: confirm the displayed Monaco content is invalidated. Reopen the file and click **Mark reviewed**. Commit another change and verify review phase/drafts become stale on next refresh.
6. Load a PR. Verify local HEAD vs PR head and base OIDs; at PR base, comments are disabled. Do **not** assume a newly created PR worktree automatically contains remote PR commits.
7. Verify posting requires an active same-HEAD draft, changed file in PR and explicit confirmation. Cancel first. Post only a disposable review comment after confirming and check returned URL.
8. Run the no-`gh` / offline fallback, path spaces/Unicode, refresh while a diff is open and Windows/macOS/Linux native workflows.

Do not claim this manual checklist PASS based only on GitHub Actions CI.


## Windows — recurring console flash regression

VirtualLab is a GUI desktop application. `git.exe`, `gh.exe`, `where.exe`,
`cmd.exe` shims, Codex capability checks, and structured build/test runners
must launch through `src-tauri/src/process.rs::background_command`. On Windows
this applies Win32 `CREATE_NO_WINDOW` and preserves stdout/stderr/exit status.
The `portable-pty` interactive terminal is intentionally separate.

**Automated checks:** `cargo test --locked --manifest-path src-tauri/Cargo.toml`
includes the background process stdout/status smoke tests, including a
Windows `cmd.exe` wrapper, plus a static guard against unreviewed native
`Command::new` spawn sites. CI cannot inspect a human desktop for flicker.

**Manual Windows GUI acceptance (not automated):**

1. Build a Windows GUI release with `npm run tauri:build` and launch the
   built `src-tauri/target/release/virtuallab.exe` independently. The debug
   build uses the console subsystem and may legitimately have its own parent console.
2. Add/select a Git repository and keep VirtualLab open. Confirm there are no
   recurring console windows during initial Git status/worktree/log inspection.
3. Modify a tracked file in an external editor and verify filesystem refresh
   works **without** a console flash; edit files and change Git metadata repeatedly to trigger automatic refresh.
4. Open GitHub context (with and without `gh` on PATH), select Changes and
   reload diff; verify background Git/GitHub probes show no console windows.
5. Execute an approved structured Run profile and (when configured) native
   Verification software gates; output stays inside the UI/evidence files.
6. Open **Terminal → New terminal**. The explicitly created interactive PTY
   must still accept input, Ctrl+C and resize, with no separate pop-up shell.

Do not treat a passing GitHub Actions build as proof that the desktop flicker
has been observed and resolved on a physical Windows session.


## V0.5 — Agent workspace control acceptance

| Surface | Control or safety contract | Automated evidence | Desktop acceptance required |
| --- | --- | --- | --- |
| Navigation | Agents tab | \`WorkspaceContent.test.tsx\` | switch across all tabs and reopen Agents |
| Agents | provider selector, explicit Codex path, capability detection | \`agentHarness.test.ts\`, \`AgentWorkspace.test.tsx\`, Rust launcher-path tests | Compare PowerShell 0.162 against a GUI that resolves older 0.157.1; inspect path; choose newer launcher; verify detected/runtime paths match |
| Agents | One-click Connect & run task, manual Attach, stop and forget thread | \`AgentWorkspace.test.tsx\`, \`workspaceAgent.test.ts\`, \`agentSessions.test.ts\` | Run harmless turn without pre-attaching; stop and explicitly resume saved thread after restart |
| Native | exactly one harness runtime per workspace | \`agent_ownership.rs\` Rust test | attempt a second provider without stopping first; must refuse |
| Agents | bounded structured event timeline, interrupt | \`AgentWorkspace.test.tsx\`, native protocol unit tests | stream real provider turn and inspect 300-event cap; stop and interrupt |
| Agents | custom roles and optional skills | \`agentConfiguration.test.ts\`, \`AgentWorkspace.test.tsx\` | select role, add user-defined skill, switch worktrees, verify isolation |
| Safety | human acknowledgement broker and one-use typed provider | \`agentSafety.test.ts\` | request motion/power/flash/release and verify DENY with no provider |
| Windows | CLI visibility | Rust static subprocess guard | repeat provider detection and turns in packaged Windows GUI: no recurring console windows |

### V0.5 manual provider checks (not covered by CI)

1. Use two disposable worktrees. Select **Agents**, enter a harmless prompt, click **Connect & run task** (no manual Attach required). Confirm \`item/agentMessage/delta\` and \`turn/completed\` appear as structured events.
2. Run a long non-destructive Codex turn and Interrupt; verify the runtime can accept another turn. Stop and resume; thread ID should remain bound.
3. Set \`DEEPSEEK_API_KEY\` in the desktop process environment and configure the official Codex DeepSeek model catalog. Check availability, select DeepSeek, Attach, run a harmless request, confirm selected provider/model and that no API key appears in UI logs/argv.
4. With native \`claude\` and \`opencode\` executables installed and authenticated, run harmless read-only prompts. Verify provider-native session IDs replace provisional IDs and subsequent turns resume the same session. Test missing executable and malformed event failure behavior.
5. Stop the current runtime and Forget binding before changing harness; a second harness must not attach while the first still owns the workspace. Switch to another workspace and confirm isolation.
6. Add custom role and opt-in skill. Compare prompt behavior across worktrees. Check that no other repository or hardware-specific backend appears by default.
7. In Protected operations request a resource ID and a motion/power/flash/release human acknowledgement. Confirm explicit dialog, one-use outcome and a fail-closed denial without an independent provider. **Do not connect an energized DUT or flash live hardware as part of this test.**
8. On Windows, packaged GUI must not flash console windows during provider capability checks or subprocess turns. This is a real desktop acceptance check, not asserted from CI.

A green CI means tests/builds passed on that commit, not that provider credentials, remote API compatibility, desktop interaction or physical interlocks were validated.


## Cross-project one-click workflow acceptance

See [PROJECT_BUILD_WORKFLOWS.md](PROJECT_BUILD_WORKFLOWS.md) for the full matrix. Manually verify detected npm and Tauri scripts, Qt CMake configure/build, Windows Keil UV4 batch build, a customized two-step profile across two worktrees, cancellation and stop-on-failure. Confirm that a cancelled Deploy prompt creates no process and that no implicit firmware flashing or remote publish occurs. Build workflow output is transient and must not be claimed as durable verification evidence.


## Safe repository removal and re-import

- Open two repositories and an external linked worktree (include spaces/Unicode in its path). Start a terminal, Agent, Run or verification in the linked worktree. Confirm **Remove repository**: removal must fail, preserve the selected repository and its notification inbox, and leave the worker running.
- Cancel/close the native confirmation: no repository, selection or notification changes. While confirmation/native preflight is pending, duplicate remove and add operations are disabled.
- Stop the worker and wait for observed shutdown. Confirm removal again: only the workbench record and its owned notices disappear; files, commits, branches and all worktree registrations remain. Other repositories and their notices remain available.
- Re-add the repository through the native folder picker: its validated registered worktrees become runnable again. A failed native restore must not add a frontend record. Historical Tasks/evidence remain historical; removal does not accept, delete or replay them.
- Race a native worker startup/worktree creation against removal: either the worker wins and removal is refused, or removal wins and new reservations are refused until re-import. External Git/process changes are outside this process-local protocol. Missing registered paths remain represented in the validated inventory and do not prevent workbench detach/re-import. This does not prune or delete Git state and does not allow native startup in absent directories.


## Unmerged local branch deletion

- Create a local branch with a unique commit, switch away, and select its trash action under Git branches. Confirm ordinary deletion: a separate native warning must name the branch, repository and commit and offer **Force delete / Cancel** instead of leaving an unhandled Git error.
- Cancel/close either dialog, or deny dialog permissions: the branch and commits remain; no forced mutation occurs. Default branches and branches checked out in any linked worktree remain protected even in force mode.
- Approve the second warning: only the local branch is deleted; current checkout, files and remote branch remain. The branch inventory refreshes normally.
- While the second warning is open, change the branch tip, upstream or comparison HEAD externally, or check out the branch in another worktree. Approval must reject the stale/protected state and retain the branch; retry must show the latest state.


## Merged cleanup and missing worktree recovery (2026-10-19)

- **Clean merged…** in Git branches first switches/navigates to main. Cancelled stashing, a blocked checkout, missing main or a failed navigation prevents cleanup. Existing main worktrees are selected instead of checking main out twice. The selected workspace remains on main after cleanup.
- Inspect the native preview's repository, main SHA, origin destination and exact local/origin branch commits and worktree paths. Cancel or close it: nothing is deleted. No eligible targets means no mutation command.
- Confirm: only candidates proven by Git ancestry to be merged into main are eligible. Default/main/master branches, current/primary worktrees, unmerged local or remote commits, dirty/untracked/ignored worktrees, locked worktrees and active native work must survive. No force option exists in this bulk workflow. A local main merge that has not been published keeps the remote feature branch; remote deletion additionally requires ancestry into the live origin default branch. Squash/rebase equivalents without ancestry proof are preserved.
- During confirmation or execution, change main, a target tip/worktree, origin URL, push destinations or live default identity. Stale approval must be rejected or the affected item kept. Multiple/different push URLs and secondary URL rewrites must refuse cleanup; relative local remote URLs cannot become another remote name. Verify the individual success/failure report and refreshed inventory.
- Delete a linked worktree directory outside Git while leaving its registration. Reopen/re-import the repository: the primary stays usable, missing lane/branch directory navigation is disabled, and explicit confirmed Remove removes only that registration while preserving its branch and other worktrees. A previously held native lease must still block removal.

Automated coverage: `gitCleanup.test.ts`, `WorkbenchShell.branchSwitch.test.tsx`, `ProjectSidebar.test.tsx`, native `merged_cleanup_*`, missing-worktree, literal-path and lifecycle regressions in `git.rs`. The existing native Git suite also exercises creation, switching, fetch/prune, pull, local/origin branch deletion, dirty/force removal and stale state. These temporary bare-repository fixtures do not delete branches on a user's live remote. Windows/Linux packaged GUI qualification remains required by the existing CI/desktop matrix.

Validation notes: earlier sandboxed full acceptance was interrupted after OS process-inspection and filesystem-watcher restrictions caused failures. An unsandboxed default-concurrency native run observed `execution::worktree_terminal_stop_tests::replacement_during_shutdown_cannot_report_release_before_the_final_session_owner_drops` (`fs::rename` returned `IsADirectory`) and `task_inputs::tests::integration_cancellation_stops_hook_descendants_and_preserves_partial_worktree` (15-second deadline exceeded). A parallel frontend run timed out in `WorkbenchShell.watchRefresh.test.tsx` → `does not let a queued refresh reclaim a removed path after another worktree is selected`. The full frontend rerun with `--maxWorkers=1` passed 481 tests (1 intentionally skipped); the serial native rerun passed the earlier terminal/watcher checks and was stopped for wall-clock cost. Final native verification uses `--test-threads=4` without sandbox restrictions. No timeout was relaxed and no test was disabled for these runs.

Sandbox-restricted failures recorded before that interrupted run:

- `agent::tests::fresh_start_rejects_registered_runtime_without_touching_its_process_or_claim`
- `agent::tests::process_exit_reports_the_observed_current_thread`
- `agent::tests::bound_stop_removes_exact_runtime_and_absent_runtime_is_successful`
- `agent::tests::confirmed_agent_stop_releases_reservation_before_return`
- `agent::tests::bound_stop_rejects_changed_thread_without_signalling_the_current_process`
- `agent::tests::process_exit_never_attributes_an_old_process_to_a_replacement_binding`
- `managed_process::tests::stop_reaps_tree_and_closes_descendant_output_pipes`
- `execution::worktree_terminal_stop_tests::single_terminal_stop_waits_for_final_owner_and_keeps_other_workspaces`
- `execution::worktree_terminal_stop_tests::replacement_during_shutdown_cannot_report_release_before_the_final_session_owner_drops`
- `execution::worktree_terminal_stop_tests::replaced_symlink_cannot_redirect_a_captured_terminal_reservation`
- `execution::worktree_terminal_stop_tests::stops_target_terminal_started_in_subdirectory_and_observes_reservation_release`
- `task_git_watch::tests::real_index_lock_only_activity_is_not_an_identity_change`
- `task_git_watch::tests::real_linked_empty_commit_and_ref_restore_never_restore_watch_freshness`
- `task_git_watch::tests::real_packed_branch_ref_round_trip_without_index_events_is_sticky`
- `terminal_process::tests::cancelled_live_session_retries_cleanup_without_waiting_for_exit_or_eof`
- `terminal_process::tests::observes_shell_exit_without_reaping_while_background_keeps_pty_open`
- `terminal_process::tests::eof_cleans_background_jobs_after_shell_exits_before_reaping`
- `terminal_process::tests::signal_rechecks_session_membership_on_the_pinned_target`
- `terminal_process::tests::stop_cleans_foreground_and_background_groups_without_touching_other_sessions`
- `task_runtime::tests::compiler_selection_change_and_restore_inside_outputs_is_sticky_before_publication`
- `verification::tests::cancellation_cleans_descendants_before_joining_readers`
- `verification::tests::timeout_cleans_descendants_before_joining_readers`
- `watch::tests::linked_workspace_observes_existing_sibling_branch_switches`


Final local verification for this change (macOS):

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | Passed; committed npm lockfile retained |
| `npm run typecheck` | Passed |
| `npm test -- --maxWorkers=1` | 481 passed, 1 existing skip |
| `npm run build` | Passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | Passed; 6 pre-existing dead-code warnings |
| Latest `cargo test --locked --manifest-path src-tauri/Cargo.toml git::tests -- --nocapture` | 71 passed, including unpublished-main remote preservation |
| Full native suite before the final remote-publication guard, `--test-threads=4` | 397 passed, 1 existing ignore |
| Final full native suite including that guard, `--test-threads=4` | 397 passed, 1 failure, 1 existing ignore: the unchanged hook-cancellation test exceeded its 15-second assertion again |
| Exact hook-cancellation test rerun alone, `--exact --test-threads=1 --nocapture` | 1 passed; total test time 16.10 seconds including setup, existing internal 15-second cancellation assertion passed |
| `git diff --check` / staged whitespace check | Passed |

The final full batch is recorded as having a timing failure, despite the individual rerun passing. No production change was made to the Task integration/cancellation implementation. Linux `cargo check --locked`, Windows/Linux native acceptance and packaged GUI interaction remain pending on their corresponding hosts; the existing CI matrix is unchanged. Cleanup was exercised only against temporary repositories, not the user's live remote.
