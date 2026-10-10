# Changelog

## Unreleased — 0.5.0 Release Candidate qualification

- Native Worktree/PR/Agent confirmation, stop/cleanup, Run reattachment, startup arbitration, watcher generation and CSP baseline were implemented in PR #41 (already on main).
- macOS noninteractive GitHub origin authentication was corrected in PR #42 (already on main).
- RC qualification branch: cross-platform workspace identity correctness and native symlink alias ownership, with regression tests.
- Windows NSIS, macOS .app archive, and Linux .deb **unsigned QA-only** CI artifacts with exact checked-out Git SHA and SHA-256 manifest validation.
- Release checklist explicitly separates CI evidence from real GUI, authenticated provider, packaged installer, signing and governance acceptance.

No stable release has been announced or published. See docs/RELEASE_CANDIDATE_CHECKLIST.md for blocking manual gates and docs/RELEASE_GATE_V0.5.0.md for prior native acceptance evidence.
