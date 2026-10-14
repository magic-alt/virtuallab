# Multi-workspace behavior, safety and acceptance audit

> Scope: VirtualLab `main` after PR #58, and candidate PR #59. This is a source-level audit and a regression test plan, **not** a claim that every Windows/macOS/Linux desktop interaction has been manually certified.

## Ownership model

- **Repository record**: identifies a local Git repository; switching records restores that repository's last selected worktree and page. Opening the same path twice reuses its record; Windows drive/UNC identities are case-insensitive, POSIX identities preserve case.
- **Workspace (Git worktree)**: owns its working directory, checked-out branch, dirty status, diff, agent context, terminal PTYs and process working directory. Switching to another worktree never transfers pending edits.
- **Branch inside a worktree**: Git's one-branch-per-worktree rule applies. A branch already checked out elsewhere navigates to that owner instead of attempting a duplicate checkout.
- **Terminal**: one persistent xterm/PTy collection per workspace path. Switching tabs, repositories or worktrees hides panes but does not stop processes. Explicit Stop/Close, worktree removal, repository removal and application exit release sessions. A new pane is initialized only on its first Terminal visit.
- **Run/process jobs**: native run registry maintains job ownership by directory; Run UI discovers existing runs after navigation. A tab change does not itself stop a native run.
- **Review and agent state**: keyed by normalized worktree path, not by whichever worktree is currently displayed. Do not send commands against stale page context.

## Confirmed issues and changes

| Case | Pre-fix risk | Change in PR #59 |
|---|---|---|
| Repository A has a slow pending inspection, then B is selected | A's late callback can overwrite the selected snapshot or persisted workspace state | owner-qualified async selection, cancellation guards, stale view disables mutation controls |
| Rapid worktree navigation and filesystem notifications | older refresh/stop affects new selection; global loading may be held by a slow unrelated request | per-owner snapshot ownership and unique watcher lifecycle IDs |
| Worktree contains tracked staged/unstaged edits; user clicks another branch | Git refuses and user must manually stash elsewhere | native-confirmed `stashAll` then normal safe `git switch`; Rust verifies original branch, HEAD, full status and registered worktree after confirmation |
| Branch switch has only untracked files | untracked filenames may conflict with files in the destination branch | normal switch is allowed when no conflict; Git rejects collisions. Use **Changes → Stash all** before retrying a rejected switch |
| Checkout would overwrite ignored/generated files | Git may overwrite ignored paths by default | `git switch --no-overwrite-ignore` including remote-tracking checkout |
| User wants the worktree on disk | no dedicated file-manager shortcut | Open folder from header, repository row or worktree row; Rust validates it is a registered worktree and calls Explorer/Finder/xdg-open without a command shell |
| Deleting a worktree/repository while a PTY is retained in another tab | detached pane and process can outlive the removed directory | explicit terminal retirement/unmount; moving between existing workspaces still preserves session buffers |
| Directory names differ only by case on Unix | repository store may merge different folders | deduplicate using Windows-aware path keys instead of unconditional lowercase |
| Filtered worktree list | first *visible* worktree may lose its Remove button, even if it is not the primary | identify primary from unfiltered native worktree list |

## Safe branch switching contract

1. Switching between **different** worktrees does not move, stash, clean or otherwise touch either worktree's local changes.
2. Switching branches **inside the same worktree** with staged or unstaged tracked edits prompts to create a **Git stash** (including nonignored untracked files). Cancel leaves branch and files unchanged. The native operation validates current worktree registration, branch, HEAD and changes again after approval.
3. The checkout runs **only after** the confirmed stash succeeds. If checkout fails, the stash is retained, the error includes recovery instructions, and the view is refreshed. It does not silently `stash pop` onto the destination branch.
4. Switching with only untracked files skips automatic stash where Git can preserve them. Conflicts fail closed. Ignored paths are deliberately not stashed; `--no-overwrite-ignore` prevents unexpected overwrites.
5. Stashes belong to the **Git repository**, not uniquely to a worktree. Use the original worktree and validate the stash contents before applying:

   ```bash
   git stash list
   git stash show --stat "stash@{0}"
   git stash apply --index "stash@{0}"
   ```

   Replace the index with the correct entry; do not drop the stash until restoration has been verified. A stash can conflict with later changes and require manual resolution.

## Regression and manual acceptance matrix

| Scenario | Automated coverage | Required native validation |
|---|---|---|
| Repo A ↔ B while old Git inspection is unresolved | Shell race regression | Rapid switching while Git status is slow |
| Root ↔ worktree and tab navigation | Shell navigation and terminal fixtures | Same repository, 2+ worktrees; repeat 50 times |
| Multi-terminal independent output/input | Existing PR #58 PTY tests | 2 repositories × 2 worktrees × 2 terminals, background output and Ctrl+C |
| Worktree/repo removal | Terminal owner cleanup test | Confirm native PTY child processes are gone; other workspace PTYs remain |
| Tracked changes → switch, Cancel and failed checkout | Branch-switch tests | Modify tracked/staged/renamed files, cancel and approve; inspect stash list |
| Untracked and ignored file collisions | Rust Git safeguards + native switch flags | Verify no file was overwritten or deleted |
| Open folder | Sidebar/header actions and registered-worktree native boundary | Explorer, Finder, Linux file manager, Unicode/space/UNC paths |
| Native watch race and Run/Agents/Changes/GitHub | Existing component tests + source audit | Simultaneous build/agent output while navigating and reopening tabs |
| Application teardown | Existing PTY lifecycle tests | Exit during native PTY/build activity and inspect orphan processes |

**Release gate:** frontend typecheck, test suite, production bundle, Rust tests, and the three-platform CI matrix must pass at the *final PR head SHA*. Native GUI interaction and process/IO soak tests are separate acceptance requirements. No operating system has been interactively exercised by this GitHub-only audit.

## Operational constraints

VirtualLab works with **Git repositories and registered worktrees**, not arbitrary non-Git folders. Opening an OS folder is not equivalent to importing arbitrary directories as Git workspaces. The UI retains existing terminal sessions during navigation; it must not silently run `git reset --hard`, `git clean`, `git stash pop`, or a forced branch checkout.
