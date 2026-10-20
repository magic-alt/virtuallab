# Agents Hub: Tasks, workspace sessions and execution configuration

Source implementation added 2026-10-17. This document describes available local software surfaces, not a release qualification or authenticated-provider acceptance record.

## One Hub, two execution contexts and shared configuration

| Hub section | Use it for | Execution and records |
| --- | --- | --- |
| Agent 任务 | A goal that needs an isolated worktree, queue, retries and reports | Native Codex Task/Attempt lifecycle; durable output, independent verification and acceptance |
| 工作区会话 | An existing workspace thread, provider configuration, roles/skills and recovery | Explicit direct attach/resume; four existing harnesses; bounded live output and redacted lifecycle metadata |
| 执行配置 | The shared Codex executable, Verification Profile library and explicit Provider/Run configuration actions | Configuration for new requests; accepted Task execution inputs and Profiles stay frozen |

Select **会话仓库** and **会话工作区** to manage an existing workspace. The list is
built from registered repository/worktree inspection, including sibling paths
outside the repository directory. A saved thread alone does not authorize a path.
Task-bound workspaces link back to their Task; ordinary session commands cannot
adopt or control a native Task runtime. Cancelling a Task retains its durable state
transition and exact-thread cleanup.

Hub and repository navigation retain drafts and Terminal sessions. Agent notices
navigate to the owning Task/session; Terminal notices retain the original terminal
ID. Workspace persistence v8 maps a retired `agents` tab to `overview`, preserving
its repository/worktree. Session and Task storage formats remain compatible.

The default Codex executable is shared between Hub execution configuration, manual sessions and
new Tasks. A Task-specific edit overrides that default; accepted launch requests
retain their original executable selection.

## Navigation and ownership

The application navigation provides Agents Hub, 工程仓库 and 设置. The Hub contains Agent 任务, 工作区会话 and 执行配置. Task lists, per-task reports and collapsed historical verification records are part of Agents Hub; there is no standalone Reports page. Global Settings provides IDE, notification and terminal preferences. A new installation opens Agents Hub; an existing selected repository keeps its workspace view during migration. 工程仓库 retains Overview, Changes, GitHub, Terminal and Run. Application navigation hides the persistent workspace host instead of unmounting it; navigation does not stop PTYs or start work.

Tasks belong to a selected repository and reference explicitly created registered Git worktrees. A task never owns repository state through an Agent session. The footer build identity still identifies the running application independently of task/repository selection.

Agents, Run/build processes and verification share an exclusive workspace writer reservation. Interactive PTYs hold separate terminal leases and coexist with branch switches, Run and other workspace operations; navigation and branch switches never stop them implicitly. Their leases block worktree removal and repository detach until terminal cleanup is observed. Independent worktrees can execute concurrently.

## Local workflow

1. Add/select a local repository, open **Agents Hub**, and enter a concrete goal in **工作任务**, such as “修复 git 提交错误，检查原因、完成修复和测试，并总结发现的问题”. Choose **开始任务** (or Ctrl/⌘+Enter). The composer displays the current branch/HEAD, rechecks it, and submits one native launch operation. That action accepts the task, creates its independent worktree, and starts Codex. The execution panel opens automatically; there is no separate prepare/start sequence on this default path.
2. Optional settings can narrow the default repository scope (`.`), select a frozen verification Profile, override the Codex executable, and permit local auto-commit. The executable defaults to the path configured in Agents Hub, or automatic native discovery. Without auto-commit, validated changes stay in the worktree. Without a Profile, successful Codex execution completes but delivery remains **unverified**, with its report preserved. Repository scope still excludes Git metadata and environment-secret files; it is not an OS sandbox.
3. The native coordinator has two global execution slots and a queue of at most 32 tasks. The execution console shows the real supervised Codex app-server's messages, commands and file activity; it does not start another interactive writer. Task text is sent through the existing structured turn API. Cancellation waits for observed process cleanup. Retry creates a new Attempt. Duplicate launch requests reuse a durable request receipt. A lost response can be retried without accepting another task, including after the original repository HEAD moves.
4. The native verifier runs the accepted structured software gates against committed, clean controlled inputs. Failed/unsupported/missing required gates prevent readiness. Optional limitations remain warnings. Ordinary Run output is exploratory and does not grant task readiness.
5. For integration, prepare a dedicated worktree from the accepted base. Wait for fresh prerequisite checks and candidates, preview their exact source commits and target HEAD, then confirm through the native dialog. The preview expires after five minutes and is consumed once. No remote fetch/checkout, push or PR merge occurs.
6. Independently verify the final integrated commit, review that revision, and explicitly accept it. After a conflict or interrupted merge, use the IDE to inspect/resolve/commit the worktree, then choose 验证已解决的集成. Native checks the clean source and dependency ancestry; it does not replay merges.

The default action is the user's authorization to create and start that task.
Merely opening a page, changing a filter, or selecting a task never starts work.
Queued and running tasks keep their linked worktrees protected from native removal
and **Clean merged**, including the gaps before Codex starts and while it stops.
Cancelling queued work releases that protection after the cancellation is saved;
running work releases it only after observed cleanup. Other active native owners
can still keep the workspace busy.
The advanced **高级任务图 / JSON** editor retains multi-node dependencies,
integration and manual preparation/start controls. A partial worktree creation or
persistence failure keeps the task, worktree and preparation intent for explicit
reconciliation; it never deletes work or silently replays an uncertain operation.

A definitive pre-acceptance rejection closes that request ID durably. The form
keeps the task description, shows the reason, and refreshes the repository baseline
for a new submission. An unknown/lost response retains the original request ID.
Setup errors remain readable after restart even if no Attempt was created. Their
recovery action can reconcile an existing worktree; an old error alone does not
prevent corrected explicit creation when Native has no retained preparation intent.

AI plan suggestions and machine Reviewer are currently unavailable: the implementation does not claim a qualified read-only provider mode. The quick composer **does not invoke an AI planner** or synthesize a dependency DAG: it freezes the user's words as the implementation Agent's goal, with a bounded title derived locally. This provides low-friction Vibe Coding task creation without fabricating an AI capability, execution or verification. Manual planning and human review remain usable. These labels are intentional capability gates, not simulated AI output. Other existing harnesses remain available through Agents Hub → 工作区会话; the task coordinator's first implementation uses Codex only.

## Task-driven surfaces

Agents Hub → 执行配置 includes an independent reusable Profile library, even before the first
task exists. Choose 新建 Profile, edit its name/ID and structured gates/arguments,
then save. Paths/toolchain lists use one entry per line. Advanced JSON and bounded
JSON import/export preserve the supported configuration. A save conflict leaves
your draft intact: explicitly reload the latest selected record, or copy it to a
new ID. An ID change creates a separate record; delete/rename migration is not
provided. Saving configuration proves neither tool availability nor authentication.

In the quick composer, a Profile is **optional** and defaults to none; without one, formal native verification/readiness is unavailable. Choose a saved Profile explicitly from the advanced section to freeze a copy. In the advanced task wizard, 已保存 Profile copies a full snapshot into the draft.
Changing the library later cannot update the draft or an accepted task. Manual
JSON and existing-task reuse remain available if library storage is unavailable.
A task accepted without a Profile keeps that frozen policy; create a new plan
with a configured Profile rather than assuming a settings edit repairs it.
Saving/exporting uses the currently visible advanced JSON, with validation;
“应用 JSON” also updates the structured form. A delayed reload cannot replace
edits made after that reload began. If the backing library file is changed or
removed outside the application, saving refuses to overwrite it: inspect/repair
the file explicitly and reopen the application.

The dashboard separates overlapping action queues and routes a task to the
relevant detail tab. Unknown readiness is displayed as unknown, not a zero count.
The next-step panel explains known blockers; its button only navigates to existing
controls. Selection, detail tab and task filters survive Workspace round trips;
removing the repository invalidates its selection. Navigation never creates or
starts work, and retained terminals continue to belong to Workspace.

Compact Task rows show identity, time and goal context to distinguish repeated
titles. Status, repository and search filters do not start or stop work. Task
execution state and output remain available while delivery readiness is loading;
unknown readiness cannot qualify review or acceptance. The selected detail keeps
the full execution/check/readiness/acceptance distinctions.

Task detail has three primary tabs: **概览 / 执行 / 报告**. Within **报告**,
secondary **结果报告 / 变更与审查 / 交付** controls organize the recorded result,
review and acceptance; existing internal detail keys retain their navigation
meaning. Attempt history and detailed check/acceptance status are collapsed,
while current failures remain visible.

Each Task's **报告** tab includes its result, even without a verification Profile
or Run. Independent verification remains there; exploratory legacy Run controls
appear once under secondary report controls. A task report leads with Codex's
recorded response and observed
problems, then independent verification and current readiness. The prompt requests
clear completion, discovered-problem, verification and unresolved-item sections;
missing provider output is shown as missing, never synthesized into success.
After an independent verification-only Attempt, the report may also display the
last implementation summary with its source Attempt labeled. A new implementation
retry does not inherit an earlier implementation report.
The Hub's collapsed history retains verification Runs, checks, digests and artifact metadata;
superseded records remain historical even if HEAD matches.

The shell continues monitoring tasks while another workspace/page is visible.
Events trigger scoped refreshes and active tasks have a periodic catch-up path.
A task finishing automatically opens its report only if the user still follows
that same Attempt on **执行**. It does not select another task or replace an
explicitly chosen review tab. The report console has its own bounded scroll area.

## Verification Profile

The existing schema-v1 Profile declares gates with explicit executable/argument vectors. Task Profiles additionally accept:

- `sourcePaths`: relative source paths to include explicitly, including ignored sources. These must be committed for formal qualification.
- `outputPaths`: relative generated output directories/files. They cannot hide tracked source inputs.
- `toolchainPrograms`: additional executable identities to observe. CMake requires the actual selected compiler to be declared. This records observed executable bytes, not a signed claim of every transitive build dependency.

The software verifier retains its narrow executable allowlist. Unsupported HIL/hardware/soak or approval-required executors remain blocked. Profiles do not carry environment-variable dumps or `.env` contents/digests. Environment-secret inputs cannot be silently fingerprinted as controlled source.

Example for a provisioned CMake/Ninja host (review compiler selection and generated output declarations for the actual project before accepting). First configure the declared `build` directory through exploratory Run using executable `cmake` and argv `["-S", ".", "-B", "build", "-G", "Ninja"]`. Formal qualification supports the default Ninja build with direct observed native C/C++ compilers; compiler launchers, custom targets, shell chains and other generators are unqualified. Compiler selection and effective generated commands are observed before execution. Configuration/build-graph changes remain sticky even inside declared output directories. Use a build/test-only formal Profile:

```json
{
  "schemaVersion": 1,
  "id": "cmake-local",
  "name": "CMake build and test",
  "sourcePaths": [],
  "outputPaths": ["build"],
  "toolchainPrograms": ["c++"],
  "gates": [
    {"id":"build","label":"Build","kind":"build","required":true,"approval":"none","executor":{"type":"process","program":"cmake","args":["--build","build"],"cwd":"workspace"}},
    {"id":"test","label":"CTest","kind":"unit","required":true,"approval":"none","executor":{"type":"process","program":"ctest","args":["--test-dir","build","--output-on-failure"],"cwd":"workspace"}}
  ]
}
```

## Truthful result states

Execution outcome, historical gate outcomes, current readiness and human acceptance are separate facts. `ready` requires all required checks and current review; `warning` exposes optional limitations before acceptance; `blocked` means a known required failure/integrity/scope problem; `unverified` means missing/stale/unknown qualification.

Source changes invalidate evidence even without a changed HEAD. Native input watches persist an invalidation marker after verification, so restoring old contents does not silently restore that evidence. Readiness re-observes source, Profile, executable identity and artifact integrity; required unknown provenance fails closed. A subsequent run is a new immutable run; older evidence and human decisions remain historical.

Committed-clean qualification reads bounded regular-file bytes and compares their
qualified Git content with committed and indexed objects; it does not trust Git's
timestamp cache. Built-in `core.autocrlf`, `text`, `text=auto`, `-text` and `eol`
rules support ordinary CRLF checkouts without changing repository configuration
or working bytes. Actual raw bytes and conversion policy remain part of input
freshness, including per-file scope checks across provider execution. Hidden index
flags, submodules/symlinks, active external filters, `ident`,
`working-tree-encoding` and legacy `crlf` attributes still require separate
qualification and are refused. Direct workspace tools remain available for those
repositories.

Each manual re-verification creates a verification-only Attempt and a new Run. Review and acceptance bind to that exact Run and toolchain; a new Run requires new human decisions. After application restart, observation continuity is unknown and previous results remain historical until re-verification and review.

Automatic sealing refuses executable commit hooks or configured signing. For a
task created with a verification Profile, commit manually in the workspace and use
verification to adopt the clean committed candidate; native checks still enforce
the accepted scope, base ancestry and the same source qualification policy.
Manual adoption does not bypass unsupported conversions. A task created without a
Profile retains that frozen policy; a new Profile requires a new task. Generated
binaries are not currently qualified delivery artifacts; the archived artifacts
establish verification output integrity.

Explicit verification can adopt a clean committed repair even after a failed integration already recorded an older candidate. Every candidate is checked against the accepted base and full task scope, including first conflict recovery without a prior candidate. An integration task's scope must encompass all source changes and conflict repairs. Its readiness, acceptance and passport all require the current dependency candidates to match the fixed source lineage in the verified manifest; a newer source cannot silently qualify an older integration.

## Durability and privacy

Application data contains `tasks-v1.json` and `task-evidence/<runId>/manifest-v2.json` plus bounded local artifacts. The task store persists a validated generation before exposing new state/events, with atomic replacement and rollback on failure. Reopening marks unfinished queued/running/stopping Attempts interrupted. No mutation is replayed automatically. An unavailable/corrupt store disables Task operations without overwriting the file or disabling direct workspace tools.

Task launch receipts are part of the atomic task generation. Execution reports
are stored separately at `task-reports/<taskId>.<attemptId>.json`, with a 512 KiB
file limit, at most 200 log entries/128 KiB of log text, a 64 KiB final response,
at most 32 problems/32 KiB of problem text, and explicit truncation. Budgets leave
room for JSON escaping. UI report queries name the exact task and attempt;
provider output is correlated to its workspace, thread and turn. Reopening
reconciles report status to interrupted attempts without replaying the provider.
Reports contain local provider/build output and remain on the user's computer.

Existing workspace `.virtuallab/evidence` manifests are not promoted. New task verification obtains its own before/after observations around a newly invoked native run and archives its artifacts into application data. Removing a worktree does not erase archived task evidence. Human decisions are archived transactionally when superseded or cleared.

Passport export retains the accepted task title, goal, relative scope, fixed commits, observed tool digests and structural decision history. It omits raw provider transcripts, logs, native repository/executable paths and free-text review notes. Local logs can still contain output emitted by a user's build tools; they are not uploaded by this feature. Hashes detect divergence against recorded digests; the writable local store is not signed attestation, an OS sandbox or a correctness guarantee.

## Qualification still required

- Real authenticated two-Codex/three-worktree workflow on the supported hosts.
- Packaged GUI checks, including native confirmation, cancellation, terminal retention, small windows and production CSP.
- Windows/Linux locked native checks and local acceptance in their actual hosts/CI.
- User trials, Qt/Keil/cross-compiler qualification and provider parity.
- Qualified read-only planning/Reviewer support before enabling those actions.

The independent [offline prototype](prototypes/task-first-control-center.html) uses mock data and six scenario controls. It has no network or native/Git execution. Its simulated success is not evidence of application qualification.
