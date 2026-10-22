# Workspace collaboration

## Intent and success criteria

Allow a developer fixing one repository to inspect explicitly selected related local repositories, including a selected worktree, from both the repository's Codex terminal and Agents Hub. A host application and device firmware are examples; VirtualLab must remain independent of any named project.

The current owner remains one repository/worktree. Its branch, diff, commits, process ownership, task DAG and verification continue to have the existing meaning. Related repositories supply live source context and are not additional write targets. This implements the user's requested collaboration within existing flows.

## Current gaps

- Repository records and workspace preferences have no relationship model.
- Managed sessions only receive a cwd. Automatic task prompts explicitly restrict all work to that worktree.
- The Codex terminal writes a fixed command into a shell and does not use the shared executable preference.
- A task created in an isolated worktree cannot discover the related source directories from its owning repository.

## Design

Persist opt-in `contextRepositories` per owning repository in a dedicated frontend store. Each reference has `repositoryRoot` and `workspaceRoot`; the latter is an explicit selected, registered Git worktree, not a dynamically changing active selection. Reuse one editor in the repository overview, task composer and Hub workspace session. Show concrete paths and explain that changes apply to new sessions/tasks. Removed repositories must not leave invisible references.

Native validates absolute existing Git roots, membership of a selected worktree in its declared repository, canonical path identity, a maximum of eight references, duplicate references, and overlap with the primary writable directory. It returns normalized references. A shared native module formats reference context and retains repository/worktree lifecycle leases while a provider process uses them. Missing or changed bindings fail before execution, with an actionable error.

Managed Codex sessions pin references in the session binding and process. A changed selection requires stopping and reconnecting. Every turn receives the current reference list and instructions to inspect it as context, keep edits in the primary worktree, and report companion changes separately. The primary sandbox is preserved, references never become writable roots, and no permission restriction is silently bypassed. Context starts qualify effective configuration and managed requirements before any legacy override; named/custom permission profiles are rejected until their restrictions can be retained. Existing read-only mode stays read-only. CLI adapters without a qualified implementation reject nonempty references explicitly.

A typed `terminal_spawn_codex` command launches the selected Codex executable directly in a PTY with structured arguments, configured notifications and the reference instructions. It never interpolates paths or prompts into terminal shell input. Ordinary shell terminals keep their existing behavior; only newly launched Codex terminals receive the selection.

Task drafts and stored records gain backward-compatible `contextRepositories` arrays. Acceptance validates and snapshots these references; execution revalidates them before a provider starts. Prepared task worktrees inherit the task's explicit references. The references do not modify allowed file scope, dependencies, candidate commits or formal verification coverage. Task details show the saved list.

## Verification

Test native validation with real temporary Git repositories/worktrees, invalid/missing roots, duplicates, overlapping paths, Unicode/spaces and lifecycle leases. Test managed context binding, prompt propagation and unchanged write scope. Test direct PTY launch arguments without shell injection, and old context-free behavior.

Test frontend persistence, selection isolation, repository removal, session reconnect messaging, task launch payloads and terminal native launch payloads. Run frontend tests/typecheck/build, locked Rust checks/tests where supported, acceptance scripts, and a rendered UI inspection. Document which platform/provider checks were actually performed.

## Boundaries

This is live source inspection, not an immutable multi-repository snapshot or an atomic cross-repository commit/merge. A companion repository requiring edits gets its own task/session with that repository as owner. Manual terminal commands and external IDE processes remain user-controlled. Operating-system and managed Codex read restrictions still apply.
