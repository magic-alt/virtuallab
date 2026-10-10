# Release audit reliability implementation plan

**Goal:** Close source-level reliability findings from the post-PR #43 release audit on main@32238ff.
**Architecture:** Reuse ManagedChild for verification; bound native stream allocation and disk persistence; resolve GUI CLI tools in the native launcher. Keep structured executable/arguments and existing approval gates.
**Spec:** User release audit, 2026-10-10.

## Tasks
- [x] Verification: add real Node regression fixtures for exited parent with inherited pipes, cancellation, timeout and excessive output. Run RED; migrate to ManagedChild; confirm tree cleanup before bounded reader completion; cap each stream at 8 MiB and fail explicitly on truncation; run GREEN.
- [x] CLI lookup: test PATH precedence, fallback directories, explicit paths and missing tools using temporary executable fixtures. Implement shared macOS GUI search in process.rs, including child PATH for env-based interpreters; use for GitHub, Git credential helper and agents; retain Windows batch adapter.
- [x] Agent streams: test oversized newline-free input, recovery at next record, UTF-8/CRLF and I/O errors. Add bounded 128 KiB record reader; reject oversized protocol messages and bound stderr.
- [x] Evidence persistence: replace manifest through synced sibling temporary file and atomic platform replacement; test replacement and failure preserving old file.
- [ ] Update architecture and release gate documentation; run locked install, frontend typecheck/tests/build, Windows acceptance and Rust tests/check. Record Linux/macOS and signed desktop acceptance as pending when unavailable.

## Review focus
Inherited pipe holders after leader exit; cancellation concurrent with exit; log writers failing or flooding; executable paths containing spaces/Unicode; Finder CLI scripts requiring node through /usr/bin/env.

## Decisions
Work in the user-provided clean checkout on a separate topic branch. Do not create a review worktree without a user create action. Do not publish, tag, sign, merge or modify branch protection.

## Execution evidence
Windows npm ci, acceptance:local (156 frontend / 85 Rust), cargo check --locked, version consistency and diff whitespace checks passed. Log cap, bounded records, atomic manifest inode replacement and relative PATH selection were observed failing before their fixes. Process-tree fixtures ran on Windows but the original inherited-pipe hang did not reproduce there. Independent source review found no Critical/Important blockers; relative PATH minor corrected with RED/GREEN, writer and atomic replacement failure coverage added. Linux Rust toolchain and macOS runtime unavailable, so cross-platform acceptance remains pending. Signed final-SHA packaging and repository protection remain maintainer release gates.
