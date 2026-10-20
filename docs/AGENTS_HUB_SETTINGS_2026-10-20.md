# Agents Hub and settings follow-up

## Intent and baseline

The user requested one home for all Agent work, no standalone Reports page,
usable settings, and a clearer explanation of failed and running tasks.
Baseline: `8f184db05c15fdeedbe722acb7ed62c619259d4c` (0.5.10).

The supplied screenshot shows **different task IDs** sharing the same title:
an older failed task and a selected running task. It does not establish that
the selected running attempt failed. Both existing surfaces derive execution
state from the latest native Attempt. Historical failures must remain intact.

## Design

- Application navigation: **Agents Hub / 工程仓库 / 设置**.
- Hub sections: **Agent 任务 / 工作区会话 / 执行配置**. Codex executable
  defaults and verification Profiles belong to execution configuration.
- Tasks share one searchable collection and selected detail. Compact rows show
  native execution state, identity, repository, time, goal and current failure.
  Running and historical tasks are visually distinguishable without rewriting
  saved task titles or inventing status from Agent prose.
- Detail has **概览 / 执行 / 报告** as primary navigation. Report contains
  secondary review and delivery actions; internal `证据`, `变更与审查`, and
  `交付` keys remain valid. Attempts and detailed qualification are disclosures.
  Opening a different active task selects Execution; a terminal Attempt selects
  Report, and an unstarted task selects Overview. Re-selecting the same task
  preserves the user's explicitly chosen tab.
- Historical verification inventory remains available inside Hub. The old
  `evidence` component view is a compatibility alias, not a global destination.
- Hub uses available width and a compact application rail. Repository navigation
  retains its wider tree. Width selection depends on semantic route identity.
- Global settings contain existing native notification preference, supported IDE
  preference, and live terminal font/scrollback/cursor controls. No inert theme,
  language, or concurrency controls are introduced.

## Correctness and ownership

Publish authoritative TaskRecords before slow readiness checks finish. Revoke
readiness while checking and apply results only to the same revision. A newer
retained task or navigation decision must survive delayed reads. Failed source
reads remain visible and never grant acceptance.

Report event notifications invalidate native snapshots. Active reports also
catch up periodically and on focus; these reads never launch work or determine
execution state. Switching views must retain drafts, PTYs and workspace sessions.
The execution-configuration component remains mounted after its first visit, so
Profile form fields and unfinished JSON imports survive ordinary Hub navigation.

Manual start/retry follows the shared Codex default unless explicitly overridden;
an explicitly empty override requests native auto-detection. Saved request
receipts and already accepted launches keep their original executable identity.

Git, review, verification, cancellation, ownership and confirmation boundaries
remain enforced by the existing typed native adapters.

## Verification record

See the implementation plan for checked steps and the pull request for final
command results and platform limitations. Browser fixtures validate UI behavior;
they do not establish authenticated Codex or packaged Windows acceptance.
