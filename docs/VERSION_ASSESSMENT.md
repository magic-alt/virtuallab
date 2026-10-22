# Application version assessment

Version: 0.5.11 → 0.5.12 (patch).

Baseline commit: a0622e07dc085e1be9c8f6b81a8ce712f40ca7f0
Assessed main commit: 5570ad1f7e54543e3c455fa0c634b0a6f1eddc9d

A patch may be synchronized as build metadata; milestones remain proposals. This does not authorize a tag, Release, deployment or hardware operation.

## Merged PRs

- #92 — feat\(workspaces\): 打通协作仓库上下文与 Agents Hub (patch): Product changes; ordinary features and fixes use a patch until milestone qualification.

## Roadmap qualification

Next milestone: 0.6.0; pending.
- V0.6: \[\#19\]\(https://github.com/magic-alt/virtuallab/issues/19\) — qualify the current shared \`workspace\_lifecycle.rs\` reservation implementation and its startup/removal/runtime consumers. The earlier PR \#63 missing-source observation is superseded by current source presence; validate capability coverage and recovery against this implementation rather than replaying a historical patch. Source presence alone does not close lifecycle or cross-platform acceptance.
- V0.6: \[\#18\]\(https://github.com/magic-alt/virtuallab/issues/18\) — qualify journal rotation/corruption/replay, schema migration and interruption semantics; expose incomplete recovery honestly. Full indexed task lineage arrives in V0.7-A; opt-in payload history remains outside the MVP.
- V0.6: \[\#19\]\(https://github.com/magic-alt/virtuallab/issues/19\) — qualify atomic startup/removal/deregistration coordination, symlink/case identity, timeout/interrupt/stop and process-descendant cleanup across all execution entry points.
- V0.6: \[\#19\]\(https://github.com/magic-alt/virtuallab/issues/19\) — record real Codex executable, version, capabilities, authentication and failure behavior on each claimed host; retain explicit permission boundaries and other-provider qualification backlog.
- V0.6: Release qualification for V0.6: exit-gate evidence reviewed and accepted; cross-platform lifecycle/recovery and authenticated execution requirements above are satisfied.
- 0.6.0: explicit release qualification must be checked exactly once
