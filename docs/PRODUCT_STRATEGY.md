# VirtualLab product strategy

**Decision date:** 2026-10-16. **Inspected baseline:** local and GitHub `main@9523b3e433c4339e1e0a4a0ea784ae91ccf485b4`.

This document records the accepted product direction and planned delivery gates. It does not claim the future Task, integration or evidence-registry capabilities are implemented. [Roadmap](ROADMAP.md) defines sequencing; [Architecture](ARCHITECTURE.md#planned-task-and-verified-result-model-v07v08) defines ownership and trust boundaries. Earlier audits remain historical snapshots.

## Positioning and target user

**VirtualLab — AI Engineering Control Plane**

A local-first engineering workbench for individual engineers and small R&D teams to coordinate interchangeable AI Agents, execute real development toolchains, inspect verification evidence and control acceptance of an engineering result.

**Core promise: Verified Engineering Work.** A useful outcome connects the task, actual source version, execution configuration, observed checks, review and remaining risks. Verification means the specified checks were observed against the recorded inputs; it is not a guarantee that the software is correct or that tests are sufficient.

The first audience is experienced engineers and technical leads in 2–10-person teams with complex local C/C++, desktop or embedded-software builds. Use a CMake C++ project for the first flagship acceptance and npm for general regression; qualify Qt, Keil and cross-compilers on provisioned hosts later. Repositories are user-selected. Toolchain Profiles and optional adapters remain provider-neutral, opt-in and independent of any named lab, device or companion project.

The user-facing objects are **Task** and **Verified Result**. Workspace remains the durable owner of repository context, worktree and runtime resources. Agents attach to workspaces as replaceable executors. Multi-workspace support, terminals, harness selection and diff review remain essential infrastructure.

## Strategic rationale and evidence limits

Parallelism, task tracking and check aggregation already overlap with existing products:

| Official source | Supported observation | Planning implication |
| --- | --- | --- |
| [Cursor 3.2, April 24, 2026](https://prod.cursor.com/changelog/04-24-26) | Async subagents, worktrees and multi-root workspaces | Workspace/Agent count and cross-folder editing are insufficient differentiation |
| [Conductor Checks](https://www.conductor.build/docs/reference/checks) | Combines Git, PR, CI, review and other readiness signals | A checks panel alone is insufficient differentiation |
| [GitHub Agents panel, August 19, 2025](https://github.blog/changelog/2025-08-19-agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github-com/) | Delegates tasks, tracks progress and hands off draft PRs for review | Task-first navigation alone is insufficient differentiation |

Sources were consulted for this planning revision on 2026-10-16. Dated announcements establish the stated release; undated live documentation does not establish an exact 2026-10-14 historical feature set. No claim about a September 2026 competitor launch or comprehensive capability gap is needed for this strategy. Detailed OpenAI/Claude feature comparisons in the original proposal are not independently established here.

**Hypothesis:** engineers with complex local toolchains will reuse a workflow that reduces the work required to validate integrated AI changes, explain blockers and reproduce results. Local execution, evidence lineage and accurate invalidation are the investment priorities. An independent product category, lower competitive intensity, paid demand and a durable moat are hypotheses to test, not measured findings.

The intended accumulated assets are reusable engineering Profiles, structured failure knowledge and interoperable task/evidence/review contracts. Failure knowledge requires explicit opt-in and sanitization; it is not collected from user repositories or logs by default.

## Source baseline and gaps

| Capability at inspected main | Source finding | Remaining product gate |
| --- | --- | --- |
| Git/worktrees, terminals, Run and project recipes | Present | Native GUI and real toolchain qualification, resource/lifecycle coordination |
| Codex, Claude Code, OpenCode and DeepSeek adapters | Present; Codex executable/version detection improved in #64 | Actual provider/version/host qualification; adapter availability is not acceptance |
| Agent metadata journal/recovery | #60/#62 slices present; bounded metadata and unverified interruption interpretation | Durable Task/Attempt lineage, broader retention/migration and qualification |
| Native lifecycle reservations | #63 reports MERGED but its merge commit `5ad98cd` is not an ancestor of main; `workspace_lifecycle.rs` is absent | Reconcile missing capability against current source before concurrent delivery |
| Verification | Schema-v1 manifests, Profile snapshots, observed gate results and local artifact hashes | Task/integration linkage, toolchain/configuration identity, basic index and trustworthy readiness |
| GitHub review/merge controls | Human-confirmed PR operations present; #65 adds a SHA-checked draft-to-ready path | A complete local integrated-delivery gate and revision-bound review/fix/verify workflow |
| TaskSpec/TaskAttempt, DAG and task home | Proposed in earlier design documents; no implementation contracts in source | V0.7-A/B delivery |

The #63 finding is an ancestry/source observation, not a diagnosis of how the divergence occurred. GitHub's compare endpoint reports the two histories as diverged. Reintegrating that work requires current-source review and fresh tests, not an assumption that the historical patch applies cleanly. See [PR #63](https://github.com/magic-alt/virtuallab/pull/63) and the [comparison](https://github.com/magic-alt/virtuallab/compare/5ad98cd...9523b3e).

Historical issues #17–#25 remain the tracking references. Their current remote descriptions retain the earlier release sequence; this documentation revision does not modify, close or publish GitHub issues.

## First differentiating milestone: multi-Agent integrated delivery

The first milestone uses **one repository, two independent Codex instances and three user-created worktrees**. It deliberately includes integrated verification; a single-task foundation slice is necessary but does not satisfy the selected milestone.

1. The user approves the parent goal, two implementation tasks, their required checks, allowed execution scope and shared base revision.
2. A user-triggered create action provisions two implementation lanes and a dedicated integration lane in the selected repository. No implicit remote PR fetch/checkout occurs.
3. Two native-supervised Codex instances execute in separate worktrees. Each produces a fixed candidate commit and satisfies its prerequisite checks. A provider's completion message does not satisfy those checks.
4. The third task waits for both dependencies. The user previews and confirms the ordered source commits and current integration target before typed native local integration.
5. Stale previews are rejected. Conflicts stop for explicit human resolution or abort; no automatic discard, stash, reset or speculative merge retry is permitted. A partially completed integration is visible and must be reconciled before continuing.
6. The final integration commit is independently built and tested. Human review and acceptance are bound to that version. A source, configuration or relevant toolchain change invalidates current readiness and acceptance.
7. The user can inspect the resulting Evidence Passport locally. PR writes, remote merge, release, deployment and hardware operations remain independent actions with their own gates.

Formal delivery requires a fixed commit and clean controlled source input. Dirty-workspace checks may aid exploration but remain provisional. Verification/evidence outputs are declared separately from source inputs; exclusions cannot hide source modifications. Native reservations prevent VirtualLab-controlled concurrent writers during integration/verification. They do not confine an external editor or malicious process, so input changes must also be detected and the product must not claim an OS sandbox or cryptographic execution attestation.

### Engineering Evidence Passport

The task detail should answer:

- What goal and acceptance criteria were approved, and what remains unresolved?
- Which Attempts, Agents, source commits and integration commit produced this result?
- Which Profile contents, executable/toolchain observations and explicit non-secret configuration were used?
- Which required/optional checks ran, with what outcome, time, exit status and artifacts?
- Do artifact integrity, revision freshness and required provenance still hold?
- Who reviewed and accepted which version, and is that decision still current?

A hash supports integrity checking; it does not prove test adequacy, software correctness, safe execution or authenticity against an attacker who can rewrite local records. Unknown toolchain information is displayed as unknown; when required by the accepted Profile, missing provenance prevents readiness. No environment dump, sensitive value/hash, `.env` contents or credential-bearing configuration enters the passport.

### Task-first navigation

| Surface | User question | Minimum information and action |
| --- | --- | --- |
| Home / Tasks | What needs my attention? | Running, waiting, blocked and ready-for-acceptance tasks; next required user action; recent accepted results |
| Project | What is the engineering state? | Selected repository, worktrees, dependencies, resource conflicts and aggregate delivery blockers |
| Task Detail | Is this work complete and acceptable? | Goal, execution owner, changes, run output, evidence, review, blockers and explicit acceptance |

Existing Agent, Terminal, Changes, Run and GitHub surfaces become context-aware panels, with direct workspace access retained. Agent completion, software PASS, readiness and acceptance must not share one ambiguous green status. Begin with a readable task list and dependency information; a general graph editor is not an MVP dependency.

## Sequencing and investment boundaries

V0.6 reliability gates precede parallel release. V0.7-A establishes Tasks and evidence linkage; V0.7-B adds bounded dependency scheduling; V0.7-C completes local integrated delivery. Bring minimum #22/#23/#24 slices into V0.7 while retaining their original tracking relationships. V0.8 deepens independent review and evidence history; V0.9 validates users and additional toolchains; V1.0 qualifies the advertised desktop combinations. See the [full Roadmap](ROADMAP.md#product-direction--v06-to-v10-ai-engineering-control-plane).

Two independent Codex instances are the first real-provider exit gate. Other existing adapters remain available with explicit qualification labels. Their unperformed acceptance work stays open; the first milestone does not require four-provider parity. Real acceptance records identify application commit, host, actual CLI path/version, fixture/Profile and observed outcome without storing credentials.

Cross-repository Release Graph, advanced task scheduling and optional physical integrations are later investments. Hardware authority must be independently enforced outside VirtualLab and assessed in a separate safety RFC. There is no default backend.

Open Core is an option to validate: Community should provide useful local workspaces, providers, tasks, build/test and basic evidence; Pro could offer advanced history/analysis and professional Profiles; Team could offer shared policies and approval traceability. No accounts, billing, cloud Agent fleet, multi-tenancy or team backend is scheduled through V1.0, and no paid tier is committed before willingness to pay is tested.

## Validation and investment decisions

Recruit 5–10 engineers from the target audience. Start with the CMake workflow and then run provisioned Qt/embedded-software trials. Compare ordinary AI-plus-manual-tool workflows with VirtualLab on comparable task pairs; alternate order where practical to reduce learning bias. Record project/toolchain differences and setup time separately. Report sample sizes, failures and limitations rather than presenting the pilot as market-share evidence.

Collect only opt-in, local, sanitized task/check metadata. Do not upload repository content, environment-variable values, `.env` files or raw provider/build logs for pilot analysis.

| Metric | Measurement |
| --- | --- |
| Time to Verified Change | Elapsed time from accepted task creation to required integrated checks/review being ready; report human acceptance delay and incomplete tasks separately |
| Manual intervention | Count workflow-directed user actions and external tool/context switches, distinguishing required approvals from avoidable recovery/setup work |
| Reproducibility | Fresh reruns that reproduce required check outcomes divided by attempted reruns of the recorded commit/Profile/toolchain; this is not a bit-for-bit artifact guarantee |
| False-green rate | Incorrect ready/accepted states divided by evaluated readiness decisions, using deliberately stale/missing/failed/tampered fixtures as well as observed pilot failures |
| First-use completion | New users completing the flagship workflow divided by users attempting it; record assistance needed |
| Second-task reuse | Users choosing VirtualLab for a second real eligible task divided by users offered such a task after first use |

Any reproduced false green blocks release until corrected and regression-tested. Zero observed false greens is necessary, not proof that all such defects are absent. Speed/reuse are investment signals: report distributions and user reasons; do not invent success percentages before collecting a baseline. If accurate evidence adds friction without repeat use, improve the core workflow before expanding scheduling, templates or commercialization.

Required engineering acceptance covers integrated-only failures, stale integration previews, conflicts, cancel/restart, changed source with unchanged HEAD, changed Profiles/toolchains, missing/tampered evidence, same-worktree concurrent starts and Windows/Unicode/POSIX path identity. Locked dependencies, frontend checks/build, Linux locked Cargo checking and three-platform local acceptance remain the minimum automated gates. Authenticated provider and packaged GUI records are separate.

## Documentation and rollout contract

This revision changes planning documentation only. It adds no Task API, merge executor or trusted delivery badge, changes no package versions and marks no future gate complete. Keep historical audits intact; link forward from the Roadmap and Architecture. At implementation time, recheck the current remote/source baseline and use per-slice code plans and acceptance artifacts. Publishing issues, releases or product claims is a separate operation.
