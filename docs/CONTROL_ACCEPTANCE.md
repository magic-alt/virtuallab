# V0.2 control acceptance matrix

Every visible interactive control must be backed by an automated test or an explicit desktop acceptance step.

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
