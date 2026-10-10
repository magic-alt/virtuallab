# Changelog

## Unreleased — 0.5.0 Release Candidate qualification

- Native Worktree/PR/Agent confirmation, stop/cleanup, Run reattachment, startup arbitration, watcher generation and CSP baseline were implemented in PR #41 (already on main).
- macOS noninteractive GitHub origin authentication was corrected in PR #42 (already on main).
- RC qualification branch: cross-platform workspace identity correctness and native symlink alias ownership, with regression tests.
- PR #44 closed source-level audit gaps: Verification process-tree cancellation/timeouts and bounded 8 MiB/stream evidence, 128 KiB Agent protocol records, atomic evidence manifest replacement, macOS GUI Homebrew/CLI interpreter PATH resolution, Windows UNC/verbatim workspace alias normalization. Merged main SHA: `e693f4f690d10a6439377e1466e6a828cf54e7e8`.
- Windows NSIS, macOS .app archive, and Linux .deb **unsigned QA-only** CI artifacts with exact checked-out Git SHA and SHA-256 manifest validation.
- Release checklist explicitly separates CI evidence from real GUI, authenticated provider, packaged installer, signing and governance acceptance.

Main CI after PR #44 passed 6/6 jobs, but the PR #44 unsigned bundle workflow was skipped because it was not on a `release/*` branch. There is still no installed desktop/authentication qualification, main required-check protection, final-SHA signed/notarized distribution or stable GitHub Release. See docs/RELEASE_CANDIDATE_CHECKLIST.md and docs/RELEASE_GATE_V0.5.0.md.
