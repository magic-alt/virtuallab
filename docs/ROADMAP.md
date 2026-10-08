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

**Status:** A/B/C merged into `main` (including PR #12). Manual authenticated GitHub/worktree desktop acceptance remains a separate task.

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

- [x] issue → isolated workspace flow
- [x] review → fix → refresh → re-review state
- [x] correlate local HEAD with PR head/base
- [x] surface stale review/diff state after HEAD changes
- [x] no merge/force-push/destructive Git path in V0.3

### V0.3 quality gate

- [x] Git diff parser/adapter tests including rename/binary/large-file cases
- [x] Monaco/review UI control tests
- [x] GitHub adapter fixtures + offline/error cases
- [x] PR #12 merged with automated acceptance; [ ] manual authenticated desktop GitHub/worktree walkthrough recorded
- [x] all network mutations require an explicit user gesture
- [x] architecture and control-acceptance docs updated

See `docs/V0.3_REVIEW_GITHUB.md` for the implementation contract.

## V0.4 — Verification control plane

- [x] versioned `VerificationProfile` contract
- [x] build/unit/HIL/hardware/soak/evidence gate kinds
- [x] process gates keep executable + argument vectors structured
- [x] versioned `EvidenceManifest` contract bound to workspace + repository HEAD
- [x] evidence check/artifact normalization and final status derivation
- [x] bounded native software-gate runner (build/unit/evidence only; adapters and hardware are blocked)
- [x] per-run manifest/log/artifact SHA-256 persistence
- [ ] searchable evidence history / immutable registry
- [ ] release readiness summary
- [x] private L0–L4 lease and human-grant *policy contract* (not an exposed authorization API)
- [ ] real human approval UI + independent hardware-side enforcement

## V0.5 — Agent harnesses

- [x] common `HarnessAdapter` protocol
- [x] `CodexAppServerAdapter` baseline
- [x] native Codex app-server stdio JSON-RPC lifecycle
- [x] durable workspace ↔ Codex thread binding
- [x] thread start/resume and turn start/steer/interrupt
- [x] normalized structured `agent://event` stream
- [x] one active agent runtime per workspace
- [x] agent workspace UI / bounded live structured event timeline (not durable event history)
- [x] configurable, repository-neutral agent roles
- [x] optional, repository-neutral engineering skill catalog (user-created, no bundled project skills)
- [x] provider-neutral external lease enforcement interface; default DENY with no provider
- [x] human acknowledgement / one-use approval broker for motion/power/flash/release (control-plane only; no hardware authority)
- [x] Claude Code CLI adapter (provider plan mode, structured NDJSON)
- [x] OpenCode CLI adapter (provider plan agent, structured NDJSON)
- [x] DeepSeek adapter through Codex app-server Responses provider, with environment-only API key
- [x] exclusive native workspace runtime ownership across all four harnesses
- [ ] independent optional hardware provider with on-device lease enforcement and interlocks (no backend bundled)
- [ ] cross-platform V0.5 CI and authenticated desktop acceptance recorded

**V0.5 feature-scope note:** a UI approval or TypeScript lease is never device authorization; the provider boundary remains intentionally fail-closed until an independently enforcing hardware implementation is configured. See `docs/V0.5_AGENT_HARNESSES.md`.

The current bridge contract is documented in `docs/V0.4_V0.5_AGENT_FOUNDATION.md`. The Codex baseline intentionally runs `workspace-write` with `approvalPolicy = "never"` until VirtualLab owns approval routing.

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
