# Agents Hub consolidation design

## Intent and baseline

The user requested an audit of the latest repository Agents page and Control
Center, consolidation under **Agents Hub**, and preservation of repository Git,
Terminal and Run tools. Baseline: `3976ea6fcee52e8d00ebf5899998be6dbf4d4e49`
(0.5.9), including merged PR #89 and its CI corrections.

## Audit and selected architecture

Both surfaces accept a goal, start an Agent, show progress and offer recovery.
Their ownership contracts differ. Scheduled Tasks create an isolated worktree,
use the Codex scheduler, retain Attempts and reports, and independently record
verification/review/acceptance. Direct workspace sessions support four harnesses,
resume a saved thread, steer/interrupt turns, configure roles/skills, and retain
redacted lifecycle metadata rather than durable conversations.

One Hub will compose these existing services. **Agent 任务** is the default
section, and **工作区会话** provides existing-workspace sessions and configuration.
The repository tool tabs become Overview, Changes, GitHub, Terminal and Run.
Tasks and sessions remain workspace-owned; no Task is fabricated from a binding.

Alternatives considered: keeping both navigation entries would preserve the
reported duplication; coercing every old session into a Task would invent
baselines, Attempts and verification evidence. The selected design removes
duplicate navigation while preserving both valid execution contexts.

## Boundaries and interactions

- `AgentsHub` owns global presentation, its task/session section and shared
  navigation. Existing task components retain launch, queue, report and Profile
  behavior. The old `TaskControlCenter` export is a compatibility facade only.
- `AgentSessionHub` discovers primary and linked worktrees from registered
  repository inspection, including external sibling worktrees. Saved bindings
  annotate inventory; they never authorize an arbitrary path. Selection carries
  both repository and workspace roots.
- A Task-bound workspace opens its Task controls. Direct session controls remain
  unavailable while task sources or workspace ownership are unconfirmed.
- A native Task runtime receives internal ownership authority. Public ad hoc
  attach/start/steer/interrupt/stop cannot operate on it. Internal Task cancellation
  retains exact-thread/turn cleanup and durable state transitions.
- Native observers remain application-level and singular. Session drafts and
  threads survive Hub/repository navigation; visibility only controls UI work
  and notification suppression, never process ownership.
- Agent notices open the owning Task or Hub session. Terminal notices continue
  focusing their original workspace and terminal ID. Navigation starts no work.
- Workbench persistence v8 maps obsolete `agents` tabs to `overview`, preserving
  the exact repository/worktree. Existing session/configuration storage keys and
  Task records remain compatible.
- Codex executable preference is shared reactively between direct sessions and
  new Tasks. Accepted launch requests remain immutable; edited per-task inputs
  remain explicit overrides.

## Acceptance criteria

1. There is one global Agents Hub entry and no repository Agents tab.
2. Natural-language Task creation, worktrees, Attempts, output and reports remain
   usable without visiting a repository Agents page.
3. All four manual providers, CLI identity, roles/skills, saved-thread recovery,
   structured events and confirmed metadata purge remain available in Hub.
4. A Task-owned runtime cannot be adopted, steered or stopped by direct session
   commands, including a stale UI request. Task cancellation still works.
5. Sibling worktrees resolve to their actual registered repository; stale or
   removed targets cannot enable a session or redirect to an unrelated root.
6. Legacy state, multi-workspace selection, retained Terminal panes, notices and
   async inventory responses preserve their original ownership.
7. No provider run, Git mutation or worktree creation occurs merely on navigation.
8. Current guide, architecture and acceptance documentation match the UI.

## Verification scope

Use focused behavior regressions for navigation, inventory isolation, task/manual
exclusion, runtime authority, shared preference and draft retention. Then run
frontend typecheck, complete frontend suite, production build, locked Rust check
and the required native suites. CI supplies Windows/macOS/Linux host matrices.
Real authenticated provider sessions and packaged desktop interactions require
their corresponding hosts and must be reported separately from automated tests.
