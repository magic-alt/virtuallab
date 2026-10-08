# Control acceptance matrix — V0.1 to V0.5 foundations

Every visible interactive control must have an automated test and/or an explicit desktop acceptance step. Automated success does not prove authenticated GitHub posting or safe physical hardware behavior.

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
| Sidebar | Workspace remove | `ProjectSidebar.test.tsx`, Rust Git round-trip | clean remove; dirty/primary refusal |
| Header | Refresh | `WorkspaceHeader.test.tsx` | update repository state |
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
| Changes | stale HEAD handling | `workbench.test.ts` | create draft, advance HEAD, Refresh; draft changes from active → stale |
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
| Stale open Diff | `ChangesReview.test.tsx` | keep Monaco open, edit tracked content, Refresh; old editor is invalidated until reloaded |
| HEAD change / stale draft | `workbench.test.ts` | save draft, create new commit, Refresh; previous active draft becomes stale |
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
   works **without** a console flash; click Refresh repeatedly.
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
| Agents | provider selector and capability detection | \`agentHarness.test.ts\` | Codex/DeepSeek/Claude/OpenCode availability, missing CLI, missing DeepSeek env key |
| Agents | Attach, resume, stop and forget saved thread | \`workspaceAgent.test.ts\`, \`agentSessions.test.ts\` | restart application and explicitly resume saved provider session |
| Native | exactly one harness runtime per workspace | \`agent_ownership.rs\` Rust test | attempt a second provider without stopping first; must refuse |
| Agents | bounded structured event timeline, interrupt | \`AgentWorkspace.test.tsx\`, native protocol unit tests | stream real provider turn and inspect 300-event cap; stop and interrupt |
| Agents | custom roles and optional skills | \`agentConfiguration.test.ts\`, \`AgentWorkspace.test.tsx\` | select role, add user-defined skill, switch worktrees, verify isolation |
| Safety | human acknowledgement broker and one-use typed provider | \`agentSafety.test.ts\` | request motion/power/flash/release and verify DENY with no provider |
| Windows | CLI visibility | Rust static subprocess guard | repeat provider detection and turns in packaged Windows GUI: no recurring console windows |

### V0.5 manual provider checks (not covered by CI)

1. Use two disposable worktrees. Select **Agents**, check Codex availability, Attach and run a harmless prompt. Confirm \`item/agentMessage/delta\` and \`turn/completed\` appear as structured events.
2. Run a long non-destructive Codex turn and Interrupt; verify the runtime can accept another turn. Stop and resume; thread ID should remain bound.
3. Set \`DEEPSEEK_API_KEY\` in the desktop process environment and configure the official Codex DeepSeek model catalog. Check availability, select DeepSeek, Attach, run a harmless request, confirm selected provider/model and that no API key appears in UI logs/argv.
4. With native \`claude\` and \`opencode\` executables installed and authenticated, run harmless read-only prompts. Verify provider-native session IDs replace provisional IDs and subsequent turns resume the same session. Test missing executable and malformed event failure behavior.
5. Stop the current runtime and Forget binding before changing harness; a second harness must not attach while the first still owns the workspace. Switch to another workspace and confirm isolation.
6. Add custom role and opt-in skill. Compare prompt behavior across worktrees. Check that no other repository or hardware-specific backend appears by default.
7. In Protected operations request a resource ID and a motion/power/flash/release human acknowledgement. Confirm explicit dialog, one-use outcome and a fail-closed denial without an independent provider. **Do not connect an energized DUT or flash live hardware as part of this test.**
8. On Windows, packaged GUI must not flash console windows during provider capability checks or subprocess turns. This is a real desktop acceptance check, not asserted from CI.

A green CI means tests/builds passed on that commit, not that provider credentials, remote API compatibility, desktop interaction or physical interlocks were validated.
