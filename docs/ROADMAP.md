# Roadmap

**Planning snapshot (2026-10-16, inspected local and GitHub `main@9523b3e433c4339e1e0a4a0ea784ae91ccf485b4`):** V0.1–V0.3 foundations and V0.4/V0.5 software feature baselines are delivered; authenticated desktop/provider acceptance, durable evidence registry and release readiness remain open. V0.6 metadata journal/recovery slices are present, but V0.6 is not complete. GitHub reports [PR #63](https://github.com/magic-alt/virtuallab/pull/63) as merged; its lifecycle implementation is absent from this main snapshot. Reconcile that gap before parallel execution. See the [product strategy](PRODUCT_STRATEGY.md), [architecture](ARCHITECTURE.md#planned-task-and-verified-result-model-v07v08) and [historical multi-agent design review](MULTI_AGENT_DESIGN_REVIEW.md).

**Product direction:** **VirtualLab — AI Engineering Control Plane**, a local-first workbench for turning AI-generated changes into **Verified Engineering Work**. The first differentiating milestone is two isolated Agent tasks followed by user-confirmed local integration, fresh verification and human acceptance of the integrated result. Workspace and Agent capabilities support this workflow; their count is not the success metric.

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
- [ ] basic durable evidence index / delivery-readiness summary (first slice in V0.7-A/C [#23](https://github.com/magic-alt/virtuallab/issues/23))
- [ ] searchable/comparable evidence history and registry hardening (V0.8 [#23](https://github.com/magic-alt/virtuallab/issues/23))
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


## Product direction — V0.6 to V1.0: AI Engineering Control Plane

**Objective:** organize engineering Tasks and Verified Results above workspace-owned execution. The flagship workflow is **two parallel implementation tasks → user-confirmed local integration → fresh build/test → revision-bound review → human acceptance**. The minimal task home, evidence index and delivery gate move forward from V0.8/V0.9 into V0.7; general scheduling and advanced observation follow the working delivery loop.

**2026-10-17 source update:** local Task-first services/UI, shared lifecycle reservations, bounded scheduling, candidate/integration adapters and evidence/review/acceptance software are now present. See [implementation and qualification boundaries](TASK_FIRST_CONTROL_CENTER.md). The unchecked gates below still require appropriate acceptance evidence; source presence alone does not close authenticated-provider, packaged-GUI, three-host or user-trial work. AI planning/Reviewer remain unavailable until read-only capability qualification.

### Release discipline

- **Evidence before completion:** distinguish source implementation, automated checks, authenticated packaged-desktop acceptance and user validation. A merged PR establishes none of the other three by itself.
- **Workspace ownership:** a Task references a Workspace; an Agent attaches to it. Preserve one active harness and one controlled writer per canonical worktree. Implementer, integrator, Reviewer, Fixer and Verifier handoffs on one worktree are sequential.
- **Operator control:** plans and resource scopes require acceptance; worktree creation requires a user-triggered action. Local integration and remote GitHub mutations have separate preview/confirmation gates. No automatic merge, destructive recovery, release or physical action.
- **Truthful delivery:** bind results to exact committed input, Profile content and observed executor/toolchain identity. Agent completion, gate PASS, delivery readiness and human acceptance are distinct facts. Missing, stale, failed or unsupported required checks cannot yield ready.
- **Provider rollout:** first prove the complete workflow using two independent Codex instances. Keep the other adapters and label their actual qualification status; four-provider acceptance does not block the first MVP. General boundaries still apply to every adapter.
- **Platform and privacy:** Windows/macOS/Linux local-first design and CI; real GUI/provider qualification is recorded per host/version. Do not read, display, store or export sensitive environment-variable values or `.env` contents. No named user repository, device or lab dependency.
- **Tracking:** retain [Epic #17](https://github.com/magic-alt/virtuallab/issues/17) and #18–#25. This document proposes revised slice ownership; remote issue descriptions were not changed by this documentation update. Their existing acceptance requirements remain open unless evidence closes them.
- **Versions:** V0.7-A/B/C are delivery slices, not automatic package versions or release tags. Follow [version policy](VERSIONING.md).

### V0.6 — Reliable execution foundation (P0; next)

**Present in the inspected source:** bounded native metadata journal, idempotent unverified-turn interpretation, canonical path handling, managed process cleanup and Codex executable/version detection. These are partial implementations, not a complete V0.6 qualification.

- [ ] [#19](https://github.com/magic-alt/virtuallab/issues/19) — reconcile [PR #63](https://github.com/magic-alt/virtuallab/pull/63): GitHub reports merged, but merge commit `5ad98cd` is not an ancestor of inspected main and `workspace_lifecycle.rs` is absent. Review/reintegrate the missing capability against current source; do not blindly replay a historical patch.
- [ ] [#18](https://github.com/magic-alt/virtuallab/issues/18) — qualify journal rotation/corruption/replay, schema migration and interruption semantics; expose incomplete recovery honestly. Full indexed task lineage arrives in V0.7-A; opt-in payload history remains outside the MVP.
- [ ] [#19](https://github.com/magic-alt/virtuallab/issues/19) — qualify atomic startup/removal/deregistration coordination, symlink/case identity, timeout/interrupt/stop and process-descendant cleanup across all execution entry points.
- [ ] [#19](https://github.com/magic-alt/virtuallab/issues/19) — record real Codex executable, version, capabilities, authentication and failure behavior on each claimed host; retain explicit permission boundaries and other-provider qualification backlog.

**Exit gate:** forced interruption/restart does not produce false running/success states or automatic replay; duplicate native starts and startup/removal races are prevented; managed descendants do not leak and unrelated workspaces survive. No parallel release before this gate.

### V0.7-A — Task and evidence foundation (P1)

- [ ] [#20](https://github.com/magic-alt/virtuallab/issues/20) — versioned TaskSpec/TaskAttempt, explicit transitions, stable task/attempt identity, durable bounded local storage and migration/recovery.
- [ ] [#24](https://github.com/magic-alt/virtuallab/issues/24) — minimal Tasks home and Task Detail showing goal, dependencies, owner/worktree, candidate revision, current action, blockers and acceptance; existing tools become task-context panels while direct workspace navigation remains available.
- [ ] [#23](https://github.com/magic-alt/virtuallab/issues/23) — basic durable evidence index, task/attempt/run lineage, Profile digest and executor/toolchain metadata; keep older manifests readable as historical, unqualified evidence.

**Exit gate:** after restart, an operator can find the task, distinguish execution from verification/acceptance, inspect its candidate and evidence, and understand unknown or blocked state without raw provider logs. This is a foundation slice, not the flagship delivery milestone.

### V0.7-B — Bounded parallel execution (P1)

- [ ] [#20](https://github.com/magic-alt/virtuallab/issues/20) — minimal validated DAG with cycle/missing-dependency rejection, bounded queue, capability matching, native ownership reservations, cancel and explicit retry; a retry creates a new Attempt.
- [ ] [#21](https://github.com/magic-alt/virtuallab/issues/21) — explicit same-repository creation of two implementation worktrees and one integration worktree, from an accepted base; guard branch/path/resource conflicts and opt-in structured setup steps.
- [ ] [#20](https://github.com/magic-alt/virtuallab/issues/20) — durable dependency handoff with frozen candidate commits and required prerequisite checks; a failed, cancelled or unverified predecessor keeps integration blocked. Never replay merge/publish side effects after restart.

**Exit gate:** two mock tasks run concurrently in separate worktrees, a third waits, and failure/restart preserves ownership and lineage without duplicate effects. Shared-checkout writers and automatic fetching/checking out remote PRs remain prohibited.

### V0.7-C — Multi-Agent Verified Delivery MVP (P1; first differentiating milestone)

- [ ] [#21](https://github.com/magic-alt/virtuallab/issues/21) — narrowly typed local integration preview and confirmation, bound to selected repository, integration worktree/HEAD, ordered source commits and impact. Revalidate before mutation; stale previews are rejected. Conflicts stop for explicit human resolution or abort; no automatic reset/clean/stash.
- [ ] [#23](https://github.com/magic-alt/virtuallab/issues/23) — rerun required software checks against the final integration commit. Use a fixed commit and clean controlled source input for formal readiness; dirty-workspace exploration is provisional. Profile-declared build/evidence outputs must not mask source edits; input changes invalidate readiness even when HEAD is unchanged.
- [ ] [#22](https://github.com/magic-alt/virtuallab/issues/22) / [#23](https://github.com/magic-alt/virtuallab/issues/23) — revision-bound human review and acceptance, native readiness blockers and an Engineering Evidence Passport covering task lineage, source/integrated revisions, execution configuration, toolchain observations, checks, artifacts and unresolved risks.
- [ ] [#19](https://github.com/magic-alt/virtuallab/issues/19) / [#24](https://github.com/magic-alt/virtuallab/issues/24) — record the real two-Codex-instance workflow using a user-selected CMake C++ project; use npm for general regression. Unqualified hosts/providers stay explicitly unqualified.

**Exit gate:** two independently passing branches can still fail integrated build/test and must then block delivery. Only fresh integrated evidence plus required review permits readiness; human acceptance is separately recorded for that same revision. PR, release and deployment actions remain independent confirmations.

### V0.8 — Verified Review Loop and evidence hardening (P1)

- [ ] [#22](https://github.com/magic-alt/virtuallab/issues/22) — independent read-only Reviewer → structured feedback → sequential Fixer → native Verifier → re-review, with failures and comments tied to actual revisions/checks.
- [ ] [#23](https://github.com/magic-alt/virtuallab/issues/23) — harden registry/index atomicity, immutable run identity, integrity validation, recovery/migrations, bounded retention and historical query/compare; extend the basic V0.7 index rather than defer it here.
- [ ] [#22](https://github.com/magic-alt/virtuallab/issues/22) — deepen confirmed PR handoffs, unresolved-thread/conflict blockers and offline fallback; existing GitHub capabilities remain separate from local delivery qualification.
- [ ] [#23](https://github.com/magic-alt/virtuallab/issues/23) — missing, tampered, stale or unexecuted required gates never yield ready. Hardware/HIL remain blocked without an independently assessed external executor; hash integrity is not proof of correctness or device safety.

**Exit gate:** a fix invalidates previous review/readiness and requires fresh verification; evidence tampering and missing provenance fail closed. All GitHub writes remain human-confirmed.

### V0.9 — Target-user validation and workflow refinement (P2)

- [ ] [#24](https://github.com/magic-alt/virtuallab/issues/24) — improve first-use setup, actionable failures, task search, recovery and keyboard/accessibility behavior; deepen graph/observability only where the MVP reveals a need.
- [ ] [#24](https://github.com/magic-alt/virtuallab/issues/24) — validate reusable opt-in Qt/CMake and Keil/cross-compiler Profiles on provisioned hosts; retain toolchain-neutral core contracts and no physical operations.
- [ ] [#24](https://github.com/magic-alt/virtuallab/issues/24) — recruit 5–10 target engineers for real tasks, measuring Time to Verified Change, manual tool/context switches, reproducibility, false-green rate, first-task completion and second-task reuse as defined in [product strategy](PRODUCT_STRATEGY.md#validation-and-investment-decisions).
- [ ] [#20](https://github.com/magic-alt/virtuallab/issues/20) / [#24](https://github.com/magic-alt/virtuallab/issues/24) — extend scheduling/observability based on measured bottlenecks; token/cost data stays unknown when the provider does not report it.

**Exit gate:** record pilot results and remaining friction, not a claimed market advantage. Zero observed false greens is necessary but does not prove their absence; any reproduced false green blocks release until fixed.

### V1.0 — Qualified local desktop delivery (P2)

- [ ] [#25](https://github.com/magic-alt/virtuallab/issues/25) — packaged Windows/macOS/Linux installation, upgrade, migration, crash/restart and native UI acceptance from the final candidate commit.
- [ ] [#25](https://github.com/magic-alt/virtuallab/issues/25) — permission/path/privacy review, cleanup stress, evidence/task retention and explicit known limitations.
- [ ] [#25](https://github.com/magic-alt/virtuallab/issues/25) — real provider/toolchain/host compatibility matrix; mark available, qualified and unsupported combinations separately.
- [ ] [#25](https://github.com/magic-alt/virtuallab/issues/25) — qualify the complete three-worktree integrated-delivery workflow and confirmed GitHub handoff on every claimed host; retain outstanding V0.3/V0.5 acceptance until recorded.

**Exit gate:** every advertised combination has appropriate evidence. Automated minimum checks include locked dependency installation, frontend typecheck/tests/production build, Linux `cargo check --locked`, and the Windows/macOS/Linux local acceptance runner. Packaged GUI and authenticated-provider qualification are separate records; CI alone cannot close them.

### Post-V1.0 research and commercial hypotheses

Cross-project Release Graph, optional toolchain extensions and reusable workflow/diagnostic knowledge are follow-on investments after user validation. Profiles are repository-neutral and opt-in; no named project connector ships in core. Any physical integration requires a separate safety RFC and independently enforcing external leases/interlocks/watchdog/safe state.

Open Core is a commercial hypothesis: keep local tasks/build/test/basic evidence useful in Community; validate willingness to pay for advanced history/analysis/Profiles and team policies before building paid or server features. Accounts, cloud agents, multi-tenancy, billing and shared approval services are outside V1.0.


## Project build workflow foundation (source present; manual qualification pending)

- [x] Opt-in worktree-local npm/Tauri package, CMake/Qt and Keil MDK recipe discovery (no third-party project binding)
- [x] Repository-scoped Build/Test/Package/Deploy profiles with ordered executable/argv steps; V0.2 profile compatibility
- [x] Native sequential workflow start/stop, step output and fail-fast status
- [x] Explicit user confirmation for manually configured deployments; no automatic firmware flash/publish
- [x] TypeScript/Rust detection, orchestration and UI regression tests added
- [ ] Cross-platform CI and manual native toolchain acceptance recorded (Keil Windows; Qt and npm on provisioned hosts)
- [ ] Durable run-history and reliable process-recovery integration (V0.6 reliability, V0.7 task/evidence linkage, V0.8 hardening)

See [Project Build Workflows](PROJECT_BUILD_WORKFLOWS.md). The workflow's return code is not a trusted release gate.

## Non-goals through V1.0

- cloud execution or multi-tenant team backend
- a custom LLM agent loop replacing provider harnesses
- replacing IDEs or bundling other repositories and project-specific hardware dependencies
- automatic destructive Git, remote merge, release or physical hardware operations
- cross-repository dependency/release graphs and a general-purpose visual DAG editor
- treating worktree isolation as an OS sandbox or a UI approval as device interlock enforcement
