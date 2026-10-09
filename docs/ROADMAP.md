# Roadmap

**Snapshot (2026-10-08, baseline `main@084f466`):** V0.1–V0.3 delivered; V0.4 restricted software runner/evidence baseline delivered; **V0.5 software feature scope delivered via [PR #13](https://github.com/magic-alt/virtuallab/pull/13)**. V0.3/V0.5 authenticated desktop acceptance and V0.4 durable registry/release-readiness remain open. New planning epic: [#17](https://github.com/magic-alt/virtuallab/issues/17). The next execution gate is **V0.6 reliable lifecycle, journal and trust boundaries**, not more harness logos. See [multi-agent research and architectural decisions](MULTI_AGENT_DESIGN_REVIEW.md).

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
- [ ] searchable evidence history / immutable registry (carried to V0.8 [#23](https://github.com/magic-alt/virtuallab/issues/23))
- [ ] release readiness summary (carried to V0.8 [#23](https://github.com/magic-alt/virtuallab/issues/23))
- [x] private L0–L4 lease and human-grant *policy contract* (not an exposed authorization API)
- [ ] real human approval routing (V0.6 [#19](https://github.com/magic-alt/virtuallab/issues/19)); independent hardware-side enforcement is an optional external provider, not a bundled feature

## V0.5 — Agent harnesses (software feature scope complete)

**Status:** features merged in [PR #13](https://github.com/magic-alt/virtuallab/pull/13) and validated by PR CI. Real authenticated provider calls, packaged GUI acceptance, and independently enforced physical operations are **not** covered by a merged PR. Retain their unchecked acceptance entries until evidence exists.

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
- [ ] optional post-V1.0 hardware provider with on-device lease enforcement and interlocks (deferred RFC; **no backend bundled**)
- [x] cross-platform V0.5 feature PR CI recorded ([PR #13](https://github.com/magic-alt/virtuallab/pull/13))
- [ ] authenticated V0.5 desktop/provider acceptance recorded (V0.6 [#19](https://github.com/magic-alt/virtuallab/issues/19))

**V0.5 feature-scope note:** a UI approval or TypeScript lease is never device authorization; the provider boundary remains intentionally fail-closed until an independently enforcing hardware implementation is configured. See `docs/V0.5_AGENT_HARNESSES.md`.

The current bridge contract is documented in `docs/V0.4_V0.5_AGENT_FOUNDATION.md`. The Codex baseline intentionally runs `workspace-write` with `approvalPolicy = "never"` until VirtualLab owns approval routing.


## Product direction — V0.6 to V1.0: local Agent Supervisor

**Objective:** evolve from *one HarnessAdapter per workspace* to a multi-workspace, multi-task control plane. Follow Conductor's worktree/review lifecycle, Gas Town/Beads' recoverable task ownership and dependencies, and Codex's structured app-server boundary **without** recreating a custom LLM loop or binding a hardware lab. See [design review](MULTI_AGENT_DESIGN_REVIEW.md) for audited file paths, source links, decisions and reference architecture.

### Release discipline

- **Completed ≠ production certified:** V0.5 transports/UI are delivered; V0.3/V0.5 provider/desktop manual acceptance is still unrecorded. Evidence registry, release readiness and independent hardware enforcement are not yet implemented.
- **Concurrency contract:** preserve **one active harness per worktree**. Parallel writers operate in *separate* branches/worktrees; same-branch Reviewer → Fixer → Verifier passes are sequential and revision-bound. No implicit shared-checkout writers.
- **Operator control:** task decomposition requires an accepted plan and resource scope. GitHub comments/PR writes require preview + confirmation. Never auto-merge, force push, flash, enable motion/power, or turn UI acknowledgement into a device authority.
- **Truthful results:** a green gate requires exact HEAD, trusted profile/runner, completed evidence and validated provenance. Missing, outdated, blocked and non-executable hardware checks never count as PASS.
- **Platform:** Windows/macOS/Linux local-first support; mock adapters in CI, explicit manual acceptance for authenticated providers. No named repo, board, device or external laboratory dependency.
- **Tracking:** [Epic #17](https://github.com/magic-alt/virtuallab/issues/17); the numbered child issues below are the source of truth for engineering acceptance.

### V0.6 — Durable agent runtime and trust boundaries (P0; next)

**Goal:** predictable restart/stop, provenance and safe authority boundaries *before* launching multiple autonomous tasks.

- [ ] [#18](https://github.com/magic-alt/virtuallab/issues/18) — versioned append-only native event journal, metadata-only/redacted by default, indexed history, opt-in payload retention, crash recovery and migration
- [ ] [#18](https://github.com/magic-alt/virtuallab/issues/18) — reconcile workspace/thread/turn identity and aborted tasks after restart, with idempotent event replay
- [ ] [#19](https://github.com/magic-alt/virtuallab/issues/19) — native canonical workspace identity, cross-platform case sensitivity and symlink alias handling; safely migrate old lowercased session bindings
- [ ] [#19](https://github.com/magic-alt/virtuallab/issues/19) — process-group/tree supervision, timeout/interrupt/stop/cleanup; guard against Windows console popups and orphan descendants
- [ ] [#19](https://github.com/magic-alt/virtuallab/issues/19) — per-provider capability/version and failure semantics; explicit human-only approvals, no implicit elevation or real hardware activation
- [ ] [#19](https://github.com/magic-alt/virtuallab/issues/19) — authenticated Codex/DeepSeek/Claude/OpenCode desktop manual acceptance with redacted evidence, each on supported host(s)

**Exit gate:** mock harness interrupted/restarted at arbitrary points without lying about active work or persisting secrets by default; case-distinct paths stay distinct; process descendants do not leak. No concurrency release without this gate.

### V0.7 — Parallel workspaces and task supervisor (P1)

**Goal:** introduce a bounded, deterministic and operator-controlled task DAG above existing worktrees.

- [ ] [#20](https://github.com/magic-alt/virtuallab/issues/20) — versioned TaskSpec / TaskAttempt / dependency DAG / attempt lease and explicit state machine
- [ ] [#20](https://github.com/magic-alt/virtuallab/issues/20) — bounded queue/scheduler, cycle validation, retry/idempotency, provider capability matching, pause/cancel and resource budgets
- [ ] [#20](https://github.com/magic-alt/virtuallab/issues/20) — issue/task → approved plan → isolated workspace assignment, with durable handoffs
- [ ] [#21](https://github.com/magic-alt/virtuallab/issues/21) — safe branch/worktree provisioning, opt-in typed setup profiles and missing-dependency error reporting
- [ ] [#21](https://github.com/magic-alt/virtuallab/issues/21) — conflicting branch, path, ports/resources and optional environment settings guard; safe reversible archive / explicit delete
- [ ] [#21](https://github.com/magic-alt/virtuallab/issues/21) — user-selectable competing worktree attempts; no automatic cherry-pick/merge or untracked secret copies

**Exit gate:** two independent mock-provider tasks run concurrently in separate worktrees; a dependent third task remains blocked until its predecessors succeed; restart and failure preserve lineage and prevent duplicate side effects.

### V0.8 — Review → verification → PR-ready integration (P1)

**Goal:** make the output reviewable and verifiable, not merely completed according to the model.

- [ ] [#22](https://github.com/magic-alt/virtuallab/issues/22) — reviewer (read-only) → structured inline feedback → sequential fixer handoff → revision-aware re-review
- [ ] [#22](https://github.com/magic-alt/virtuallab/issues/22) — typed GitHub PR create/update/comment preview and explicit confirmation; offline/read-only fallback; no auto-merge
- [ ] [#22](https://github.com/magic-alt/virtuallab/issues/22) — show checks, unresolved threads, conflicts and stale review or HEAD mismatch as readiness blockers
- [ ] [#23](https://github.com/magic-alt/virtuallab/issues/23) — versioned local evidence index, atomic manifests, hash validation, immutable run identity and query/compare
- [ ] [#23](https://github.com/magic-alt/virtuallab/issues/23) — exact HEAD/profile/runner/task binding; release readiness states ready/warning/blocked/unverified; block stale/missing gates
- [ ] [#23](https://github.com/magic-alt/virtuallab/issues/23) — keep HIL/hardware/soak and any physical actuation **BLOCKED** without independently verified external provider

**Exit gate:** review feedback yields a new commit requiring re-verification; tampered/stale evidence cannot yield green; all GitHub writes are explicitly approved by the operator.

### V0.9 — Supervisor UX, observability and evaluation (P2)

- [ ] [#24](https://github.com/magic-alt/virtuallab/issues/24) — multi-task DAG board, current owner/worktree, retry/wait/conflict states and stop/recover UI
- [ ] [#24](https://github.com/magic-alt/virtuallab/issues/24) — searchable events and evidence with privacy filters, provider token/cost data where available (unknown is unknown)
- [ ] [#24](https://github.com/magic-alt/virtuallab/issues/24) — reproducible synthetic workload measuring concurrency, resume, failure, review gates and resource usage
- [ ] [#24](https://github.com/magic-alt/virtuallab/issues/24) — cross-platform accessibility, Monaco layout/wrapping and focus/control-regression coverage

**Exit gate:** an operator can trace which agent ran against which revision and which independently observed check passed, from the task board without inspecting raw logs.

### V1.0 — Stable local desktop release (P2)

- [ ] [#25](https://github.com/magic-alt/virtuallab/issues/25) — packaged Windows/macOS/Linux native GUI smoke, upgrade and crash/restart acceptance
- [ ] [#25](https://github.com/magic-alt/virtuallab/issues/25) — privilege/permission audit, path and secret handling, process-cleanup stress, retention and migrations
- [ ] [#25](https://github.com/magic-alt/virtuallab/issues/25) — real authenticated provider compatibility matrix recorded separately from mock CI
- [ ] [#25](https://github.com/magic-alt/virtuallab/issues/25) — reproducible 2–4-worktree workload, documentation/changelog and explicit known limitations

**Exit gate:** on a fresh supported desktop, an operator can delegate two independent tasks, recover safely after a restart, validate SHA-bound software evidence, review changes and manually approve a PR operation.

### Optional post-V1.0 research (not a blocker for software Supervisor)

An independent, opt-in, provider-neutral hardware/HIL integration may be proposed **only** via a separate safety RFC. The provider must enforce leases/interlocks/watchdog/safe-state outside VirtualLab; neither a TypeScript approval broker nor the Rust policy model is a physical authorization boundary. No reference project or hardware board will be bundled.


## Cross-project build workflow extension (feature branch; pending manual acceptance)

- [x] Opt-in worktree-local npm/Tauri package, CMake/Qt and Keil MDK recipe discovery (no third-party project binding)
- [x] Repository-scoped Build/Test/Package/Deploy profiles with ordered executable/argv steps; V0.2 profile compatibility
- [x] Native sequential workflow start/stop, step output and fail-fast status
- [x] Explicit user confirmation for manually configured deployments; no automatic firmware flash/publish
- [x] TypeScript/Rust detection, orchestration and UI regression tests added
- [ ] Cross-platform CI and manual native toolchain acceptance recorded (Keil Windows; Qt and npm on provisioned hosts)
- [ ] Durable run-history and reliable process-recovery integration (tracked with V0.6/V0.8)

See [Project Build Workflows](PROJECT_BUILD_WORKFLOWS.md). The workflow's return code is not a trusted release gate.

## Non-goals through V1.0

- cloud execution or multi-tenant team backend
- a custom LLM agent loop replacing provider harnesses
- replacing IDEs or bundling other repositories and project-specific hardware dependencies
- automatic destructive Git, remote merge, release or physical hardware operations
- treating worktree isolation as an OS sandbox or a UI approval as device interlock enforcement
