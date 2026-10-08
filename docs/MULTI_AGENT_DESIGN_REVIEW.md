# Multi-agent architecture review and next-stage design (2026-10-08)

> **Decision record / proposal, not an implementation claim.** Reviewed against `main@084f466480c9df6698fd58013321822a52e5f05f` (after PR #16). Tracking: [#17](https://github.com/magic-alt/virtuallab/issues/17), execution issues [#18–#25](https://github.com/magic-alt/virtuallab/issues).

## 1. Scope and principles

VirtualLab V0.5 completed its **software feature scope** in merged [PR #13](https://github.com/magic-alt/virtuallab/pull/13): local-first workspace, four harness identities (Codex, DeepSeek-via-Codex, Claude Code, OpenCode), per-workspace live stream, configurable roles and opt-in skills. It is **not** yet a reliable parallel multi-agent scheduler, a production approval router, a durable history service, or a hardware authority. Cross-platform CI was green on the PR; authenticated desktop/provider acceptance remains a separate release gate.

Keep these invariants:
1. A repository is user-selected; a workspace/worktree and pinned Git revision are the unit of execution and review.
2. Harness transports remain swappable. No custom model loop, specific project/lab, fixed hardware ID, repo-specific scripts, or cloud coordination service is a core dependency.
3. One native harness owns a workspace at a time. Parallel writing requires **distinct worktrees**. Sequential review/fix handoff can share a workspace without simultaneous writers.
4. Explicit human confirmation is required for remote GitHub mutation, privileged local operations and any dangerous actuation. A UI click or agent tool approval is **not** independent hardware interlock enforcement.
5. Code isolation by Git worktree is not OS sandboxing. Provider plan/read-only modes are not privilege boundaries.

## 2. Comparative research (mechanisms, not code reuse)

| Project / mechanism | Relevant engineering lesson | Adaptation in VirtualLab | What **not** to copy |
| --- | --- | --- | --- |
| [Conductor: Git worktrees](https://www.conductor.build/docs/concepts/git-worktrees), [parallel agents](https://www.conductor.build/docs/concepts/parallel-agents), [workflow](https://www.conductor.build/docs/concepts/workflow) | Independent deliverables use their own worktree/branch, setup/run commands, review and PR flow; coordinated agents sharing one branch need deliberate sequencing | Generic workspace provisioning and per-workspace Agent ownership; review/verify/PR handoff | Equating worktree isolation to security; letting two writers race on one checkout |
| [Conductor: checks](https://www.conductor.build/docs/reference/checks), [review and merge](https://www.conductor.build/docs/guides/review-and-merge) | Git state, unresolved comments, CI, todos and deployments are separate merge-readiness signals | Revision-bound readiness matrix, manual review feedback and explicit PR-action preview | Automatic green status merely because the agent says tests passed |
| [conduct (open source)](https://github.com/ldlac/conduct) | Lightweight parallel fan-out, competing isolated attempts and selectable winning approach | Optional multiple worktree attempts, resource caps and human choice of preferred result | Automatic auto-commit/merge/branch removal without product-level confirmation |
| [Gas Town provider integration](https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md), [Beads task graph](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/index.md) | Task identity, dependency tracking, work claims, recovery and provider-neutral dispatch survive agent restart | Typed TaskSpec / Attempt / DAG / lease / event journal | Recreating a heavyweight tmux/distributed issue backend inside Tauri |
| [OpenAI Codex App Server](https://openai.com/index/unlocking-the-codex-harness/), [multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent) | Use structured session/turn events and subagent decomposition when work can be separated | Keep JSON-RPC as one HarnessAdapter; expose provider capability discovery, model-independent orchestration | Treating Codex-specific transport semantics as universal; spawning agents recursively without caps |

Conductor is consulted through its **published product documentation**, not assumed open source. Open-source conduct, Gas Town and Beads offer inspectable architectural patterns, but no external code or license is imported as part of this planning change.

## 3. Verified repository audit

| Existing implementation | Evidence in tree | Gap and priority |
| --- | --- | --- |
| Native Codex/DeepSeek app server, Claude/OpenCode NDJSON CLI | `src-tauri/src/agent.rs`, `agent_cli.rs`; `src/lib/agentHarness.ts` | Version/permission compatibility and real authenticated manual matrix — **P0** |
| Exclusive harness by workspace | `src-tauri/src/agent_ownership.rs`; `src/lib/workspaceAgent.ts` | Path canonicalization/identity and stale owner recovery — **P0** |
| Persisted provider thread binding | `src/stores/agentSessions.ts` | Lowercases path key even on case-sensitive file systems; migrate to native identity — **P0** |
| Up to 300 in-memory timeline events | `src/stores/agentTimeline.ts` | No durable redacted event history, restart replay or archival — **P0** |
| Top-level process kill on agent/verification cancellation | `agent.rs`, `agent_cli.rs`, `verification.rs` | Descendant process cleanup and crash consistency not guaranteed — **P0** |
| SHA-256 per-run software verification files | `src-tauri/src/verification.rs`; `docs/V0.4_VERIFICATION_HARDWARE_POLICY.md` | No searchable registry, fully atomic manifests or strong provenance/readiness gate — **P1** |
| Local review drafts and opt-in `gh` comments | `src/features/review`, `src-tauri/src/github.rs` | No full review-feedback-to-agent → re-verify → PR-ready orchestration — **P1** |
| Hardware policy/lease contract, no provider | `src-tauri/src/hardware.rs`, `src/lib/agentSafety.ts` | Intentionally blocked for real physical actions, no bundled executor; retain default DENY |

These are **code/document observations**, not evidence that all failure modes were reproduced. Do not mark any proposed behavior as PASS without a test artifact.

## 4. Target architecture

```text
Operator UI (task DAG / multi-workspace board / review / approvals)
    |
    v
Supervisor control plane (typed task IDs, DAG, retries, quotas, policy)
    |                     |
    |                     +--> durable redacted event journal / index
    |                     +--> verification & evidence registry (HEAD-bound)
    |                     +--> review / PR readiness (explicit operator actions)
    v
Workspace scheduler / lifecycle controller (one active harness/worktree)
    +--> worktree A / branch A --> HarnessAdapter(Codex | DeepSeek | Claude | OpenCode)
    +--> worktree B / branch B --> HarnessAdapter(...)
    +--> worktree C / branch C --> queued until dependencies pass
    |
    +--> optional independent *external* hardware provider (NOT bundled;
         independent lease, watchdog, interlock and fail-safe enforcement)
```

### Proposed typed contracts (design, not existing code)

- `TaskSpec`: schemaVersion, taskId, repository identity, baseSha, dependencyIds, expectedOutputs, allowedAdapters, verificationProfileRef, resourceBudget, approvalPolicy.
- `TaskAttempt`: attemptId, taskId, workspaceIdentity/worktreePath, headSha, harnessKind, threadId, turnId, state, startedAt, endedAt, failureKind.
- `SupervisorEvent`: schemaVersion, eventId, seq, taskId/attemptId, workspaceIdentity, harness/thread/turn, eventKind, timestamp, redactionClass, summary, optional contentRef.
- `VerificationVerdict`: profileHash, headSha, manifestDigest, outcome (ready / warn / blocked / unverified), missingOrStaleChecks, observedAt.
- `ApprovalIntent`: operator-requested action, exact workspace/head/target, impact preview, expiry, one-use id; **never** a hardware power/flash authorization token.

Run each task through explicit state transitions:

`draft -> queued -> ready -> running -> verifying -> review -> done`

Exceptional states: `waiting-human`, `failed`, `cancelled`, `blocked`. No automatic retries for side-effecting external mutations. Resume requires checking the process owner and comparing workspace HEAD to the stored attempt.

### Boundary decisions

- **Control plane vs execution:** model responses are untrusted data; the supervisor validates typed intent and native scope before execution.
- **Worktree vs OS permissions:** tasks edit only their assigned checkout by policy; add OS-level enforcement in an independent hardening slice, never claim Git alone prevents traversal or command execution outside the worktree.
- **Durability vs privacy:** journal metadata by default; recording raw prompts, responses or tool payload is opt-in, redacted, bounded and purgeable.
- **Concurrency:** cap workers and resources; task graph rejects cycles and duplicate ownership. Do not launch a parallel writer against a shared checkout in V0.7.
- **Review & PR:** every successful check is tied to exact workspace HEAD, profile and artifacts; any new commit invalidates old readiness and review drafts as applicable. Any remote PR write requires human confirmation.
- **Hardware:** L0–L4 UI/software policy is not a device safety system. Physical actuation remains unavailable without a separately assessed hardware authority and interlocks.

## 5. Sequencing, acceptance and test strategy

| Phase | Main dependency | Acceptance demo | Issue |
| --- | --- | --- | --- |
| V0.6 event journal / recovery | V0.5 baseline | Forced restart restores ordered, deduplicated redacted events and accurate outcomes | [#18](https://github.com/magic-alt/virtuallab/issues/18) |
| V0.6 runtime and authority | Coordinate with journal schema | Two case-distinct worktrees remain distinct; cancel kills process descendants; real provider failures are explicit | [#19](https://github.com/magic-alt/virtuallab/issues/19) |
| V0.7 scheduler / DAG | V0.6 | Two independent isolated tasks execute, one dependent task waits; restart/retry idempotent | [#20](https://github.com/magic-alt/virtuallab/issues/20) |
| V0.7 setup / worktrees | Identity + scheduler | Setup fails closed; branches/ports do not collide; safe cleanup | [#21](https://github.com/magic-alt/virtuallab/issues/21) |
| V0.8 review → PR | Task lineage | Reviewer feedback → fixer → new SHA verification; GitHub writes operator-confirmed | [#22](https://github.com/magic-alt/virtuallab/issues/22) |
| V0.8 evidence readiness | Event lineage + task IDs | Tamper/stale SHA blocks; missing gate != PASS; no physical HIL claim | [#23](https://github.com/magic-alt/virtuallab/issues/23) |
| V0.9 usability / evaluation | V0.7–V0.8 | Mock-provider workload deterministically measures concurrent vs sequential tasks and failure paths | [#24](https://github.com/magic-alt/virtuallab/issues/24) |
| V1.0 release qualification | Prior slices | Packaged Windows/macOS/Linux acceptance, recovery, privacy/security and clear known limitations | [#25](https://github.com/magic-alt/virtuallab/issues/25) |

Priority gate: **finish V0.6 durability and lifecycle hardening before general parallelism**. Build CI with mock harnesses plus selected real local integration smoke. External authentication, model versions, GUI interactions and any device safety require distinct human/device acceptance evidence; test green does not imply those passes.

## 6. Explicit non-goals

- Cloud multi-tenant orchestration, billing or team backend.
- A generic autonomous custom LLM agent loop.
- Silent auto-merge, auto-force-push or destructive workspace deletion.
- Automatic workspace synchronization of ignored secret files.
- Bundled HIL board adapters, real motor/power/flash authority or any coupling to other user projects.

## 7. Source links / provenance

- VirtualLab source: [PR #13 V0.5](https://github.com/magic-alt/virtuallab/pull/13), [Roadmap](ROADMAP.md), [Agent harness contract](V0.5_AGENT_HARNESSES.md), [Verification policy](V0.4_VERIFICATION_HARDWARE_POLICY.md).
- Conductor official: [workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches), [worktrees](https://www.conductor.build/docs/concepts/git-worktrees), [parallelism](https://www.conductor.build/docs/concepts/parallel-agents), [review workflow](https://www.conductor.build/docs/concepts/workflow), [checks](https://www.conductor.build/docs/reference/checks).
- Open source comparators: [conduct](https://github.com/ldlac/conduct), [Gas Town](https://github.com/gastownhall/gastown), [Beads](https://github.com/gastownhall/beads).
- Codex official: [App Server architecture](https://openai.com/index/unlocking-the-codex-harness/), [multi-agent guidance](https://developers.openai.com/api/docs/guides/agents-api/multi-agent).

Research links are design inputs and may evolve; validate upstream provider protocol compatibility at implementation time.
