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

`acceptance:local` is implemented in Node and is cross-platform. The first command runs automated checks and prints the desktop checklist. The second also launches the Tauri desktop runtime for the native-control portion.

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
