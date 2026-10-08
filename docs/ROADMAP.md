# Roadmap

## V0.1 — Local Workbench foundation

Goal: useful on day one without any AI dependency.

- [x] Tauri 2 + React/TypeScript/Vite foundation
- [x] polished desktop workbench shell
- [x] persisted local repository list
- [x] native folder picker
- [x] read-only Git repository inspection
- [x] worktree inventory
- [x] change summary
- [x] recent commit history
- [x] lock dependency graph after first green build (`package-lock.json` + `src-tauri/Cargo.lock`)
- [x] Windows/macOS/Linux automated smoke/acceptance baseline

**V0.1 closeout:** dependency installation is reproducible with `npm ci` and Cargo `--locked`; CI exercises the shared local acceptance runner on Windows, macOS and Linux.

## V0.2 — Workspace execution

- [x] embedded xterm.js PTY
- [x] PowerShell/bash native PTY
- [x] multi-terminal tabs, resize and Ctrl+C
- [x] process supervisor and streamed output
- [x] create/remove Git worktrees
- [x] New Workspace flow
- [x] persisted workspace context/state restore (repository → active worktree + active tab, stale-worktree fallback)
- [x] configurable repository-scoped build/test process profiles
- [x] Run/Stop lifecycle
- [x] filesystem watcher with generated-directory filtering
- [x] structured process/filesystem events
- [x] normalized typed check results for repository/process outcomes

**V0.2 closeout:** runtime PTY/process objects remain ephemeral by design; only durable workspace context is restored. `CheckResult` normalizes local readiness/process outcomes, while durable evidence/history and release-gate policy remain V0.4 responsibilities.

## V0.3 — Review and GitHub

**Status: IN PROGRESS** — local diff/Monaco review is merged on `main`; A/B completion is developed on `feat/v0.3-review-drafts-github` and tracked by issue #4.

Goal: make the workspace a complete local review lane before introducing agent harnesses.

### A. Local diff/review foundation

- [x] typed read-only Git diff command (worktree/index/base-ref modes)
- [x] changed-file selection → bounded diff surface
- [x] Monaco read-only diff viewer with unified/side-by-side modes
- [x] large/binary diff fallback and size limits
- [x] local inline review draft model
- [x] review draft persistence per workspace

### B. GitHub integration

- [x] GitHub adapter boundary with capability detection
- [x] `gh` CLI adapter baseline using existing local authentication
- [x] PR metadata, changed files and check/status summary
- [x] issue/PR URL → repository/workspace context
- [x] explicit user action for posting review comments
- [x] graceful local-only mode when GitHub/`gh` is unavailable

### C. Review loop

- [ ] issue → isolated workspace flow
- [ ] review → fix → refresh → re-review state
- [ ] correlate local HEAD with PR head/base
- [ ] surface stale review/diff state after HEAD changes
- [ ] no merge/force-push/destructive Git path in V0.3

### V0.3 quality gate

- [x] Git diff parser/adapter tests including rename/binary/large-file cases
- [x] Monaco/review UI control tests
- [x] GitHub adapter fixtures + offline/error cases
- [ ] Windows/macOS/Linux acceptance remains green
- [x] all network mutations require an explicit user gesture
- [x] architecture and control-acceptance docs updated

See `docs/V0.3_REVIEW_GITHUB.md` for the implementation contract.

## V0.4 — Verification control plane

- [x] versioned `VerificationProfile` contract
- [x] build/unit/HIL/hardware/soak/evidence gate kinds
- [x] process gates keep executable + argument vectors structured
- [x] versioned `EvidenceManifest` contract bound to workspace + repository HEAD
- [x] evidence check/artifact normalization and final status derivation
- [ ] verification runner
- [ ] durable evidence artifact registry/history
- [ ] release readiness summary
- [ ] explicit human approval gates for hardware-affecting operations

## V0.5 — Agent harnesses

- [x] common `HarnessAdapter` protocol
- [x] `CodexAppServerAdapter` baseline
- [x] native Codex app-server stdio JSON-RPC lifecycle
- [x] durable workspace ↔ Codex thread binding
- [x] thread start/resume and turn start/steer/interrupt
- [x] normalized structured `agent://event` stream
- [x] one active agent runtime per workspace
- [ ] agent workspace UI / event timeline
- [ ] eight embedded-agent roles
- [ ] embedded/HIL skill catalog
- [ ] hardware resource lease integration
- [ ] approval broker for motion/power/flash/release
- [ ] Claude Code adapter
- [ ] OpenCode adapter

The first bridge contract is documented in `docs/V0.4_V0.5_AGENT_FOUNDATION.md`. The Codex baseline intentionally runs `workspace-write` with `approvalPolicy = "never"` until VirtualLab owns approval routing.

## Non-goals for the first releases

- cloud execution
- team collaboration backend
- custom LLM agent loop
- replacing IDEs
- automatic destructive Git or hardware operations

## V0.2 quality gate

- [x] frontend control wiring tests
- [x] Git worktree create/remove native round-trip test
- [x] filesystem ignore-filter unit test
- [x] structured execution event unit test
- [x] persisted workspace-state tests
- [x] normalized check-result tests
- [x] cross-platform Node local acceptance runner
- [x] locked Node/Rust dependency installation
- [x] Linux + Windows + macOS CI runs local acceptance
