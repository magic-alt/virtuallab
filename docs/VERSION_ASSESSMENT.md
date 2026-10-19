# Application version assessment

Version: 0.5.0 → 0.5.1 (patch).

Baseline commit: a18a8605568c0671a7741357c076b882e49e0eef
Assessed main commit: e74ea936f5e405758773b6dc727cbd2c69c1d457

A patch may be synchronized as build metadata; milestones remain proposals. This does not authorize a tag, Release, deployment or hardware operation.

## Merged PRs

- #30 — fix\(ui\): responsive startup window and prevent clipped workbench content (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #31 — fix: prevent recurring Cargo.lock changes from blocking pulls (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #32 — feat\(git\): support safe deletion of origin branches (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #33 — feat: one-click project build workflows for npm, Keil and Qt/CMake (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #35 — feat: illustrated offline Guide in VirtualLab with third-party usage manual (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #36 — fix: prioritize Tauri desktop build and clean ANSI/UTF-8 build logs (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #37 — fix\(build\): prefer each project's CMake presets instead of hard-coded build/virtuallab (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #38 — fix\(ui\): move documentation to application Help menu (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #39 — feat: GitHub PR list, CI visibility and SHA-guarded merge actions (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #41 — fix: harden v0.5 release gates and Unix terminal cleanup (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #42 — fix\(macos\): prevent Keychain prompts when deleting origin branches (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #43 — fix\(release\): v0.5.0 RC qualification, native identity and reproducible QA bundles (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #44 — fix: harden verification lifecycle and macOS CLI discovery (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #45 — docs\(release\): refresh v0.5.0 release readiness after PR \#44 (skip): Only documentation, tests or CI changed.
- #47 — fix\(git\): recover local changes safely and unblock branch switch/Pull (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #48 — fix\(git\): confirm force removal for dirty worktrees (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #49 — fix: build and relaunch running VirtualLab without Windows EXE lock (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #50 — fix: skip WiX/MSI packaging for in-app Windows self-build and restart (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #51 — fix\(ui\): contain live build logs in Run pane and prevent workspace scroll growth (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #52 — fix\(terminal\): restore native PTY startup and preserve sessions across tabs (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #53 — fix\(terminal\): bind Tauri event ACL and launch the host shell reliably (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #54 — fix\(tauri\): unblock Windows isolated self-build after event ACL change (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #55 — fix\(terminal\): preserve event ACL in Windows self-builds (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #56 — fix: qualify terminal lifecycle and cross-platform release builds (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #57 — feat: show compiled Git provenance in the workbench (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #58 — fix: preserve terminals across workspace and repository navigation (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #59 — fix: harden multi-workspace navigation, safe branch switching and folder access (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #60 — feat\(v0.6\): audit workspace safety and add privacy-first Agent lifecycle journal (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #61 — fix: restore macOS terminal editing and clean desktop builds (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #62 — feat\(v0.6-A\): reconcile interrupted agent turns and make journal recovery explicit (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #64 — fix\(agents\): resolve Codex CLI version mismatch and simplify task workflow (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #65 — fix\(github\): preserve tab state and streamline Draft PR review readiness (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #66 — fix\(workbench\): refresh Git status quietly during continuous Agent edits (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #67 — docs: prioritize verified multi-agent engineering delivery (skip): Only documentation, tests or CI changed.
- #68 — fix\(terminal\): crisp Codex menus with readable fonts and shared zoom (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #69 — feat: open Git worktrees and branches directly in external IDEs (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #70 — feat: non-blocking desktop alerts for long-running terminal agents (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #71 — Fix IDE and Windows folder launches; simplify workspace refresh controls (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #72 — ui: simplify workspace navigation and Changes review (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #73 — feat: add task-first engineering control center (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #74 — fix: preview untracked files and folders in Changes without staging (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #75 — feat: complete task-driven workbench configuration and evidence views (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #76 — fix: recover deleted worktrees and confirm terminal cleanup (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #77 — fix: safely detach repositories across workspace and task lifetimes (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #78 — fix\(git\): confirm force deletion of unmerged local branches (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #79 — feat: automate version assessment from merged PRs and roadmap (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #80 — feat\(tasks\): 流程模板化工作台与真实 Agent 内置案例 (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.
- #81 — fix\(version\): 自动同步合并后的补丁版本，不再被无关 CI 失败阻断 (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.

## Roadmap qualification

Next milestone: 0.6.0; pending.
- V0.6: \[\#19\]\(https://github.com/magic-alt/virtuallab/issues/19\) — qualify the current shared \`workspace\_lifecycle.rs\` reservation implementation and its startup/removal/runtime consumers. The earlier PR \#63 missing-source observation is superseded by current source presence; validate capability coverage and recovery against this implementation rather than replaying a historical patch. Source presence alone does not close lifecycle or cross-platform acceptance.
- V0.6: \[\#18\]\(https://github.com/magic-alt/virtuallab/issues/18\) — qualify journal rotation/corruption/replay, schema migration and interruption semantics; expose incomplete recovery honestly. Full indexed task lineage arrives in V0.7-A; opt-in payload history remains outside the MVP.
- V0.6: \[\#19\]\(https://github.com/magic-alt/virtuallab/issues/19\) — qualify atomic startup/removal/deregistration coordination, symlink/case identity, timeout/interrupt/stop and process-descendant cleanup across all execution entry points.
- V0.6: \[\#19\]\(https://github.com/magic-alt/virtuallab/issues/19\) — record real Codex executable, version, capabilities, authentication and failure behavior on each claimed host; retain explicit permission boundaries and other-provider qualification backlog.
- V0.6: Release qualification for V0.6: exit-gate evidence reviewed and accepted; cross-platform lifecycle/recovery and authenticated execution requirements above are satisfied.
- 0.6.0: explicit release qualification must be checked exactly once
