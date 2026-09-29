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
| Run | add/remove/close profile | `ProcessRunner.test.tsx` | persistence after restart |
| Watcher | generated-dir filter | Rust `watch.rs` unit test | source edit auto-refresh |
| Git | create/remove worktree | Rust `git.rs` real temporary-repo test | real project worktree |
| Execution | event payload | Rust `execution.rs` unit test | streamed output in UI |

## Local gate

From PowerShell:

```powershell
npm install
npm run acceptance:local
npm run acceptance:local -- -Launch
```

The first command set runs automated checks and prints the desktop checklist. The second also launches the Tauri desktop runtime for the native-control portion.

A PR should not claim a native control is fully accepted until the corresponding desktop checklist item has been exercised on at least one supported OS.
