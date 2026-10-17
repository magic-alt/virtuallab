# Task-first Engineering Control Center

Source implementation added 2026-10-17. This document describes available local software surfaces, not a release qualification or authenticated-provider acceptance record.

## Navigation and ownership

The application navigation provides 控制中心, 任务, 工程仓库, 证据 and 设置. A new installation opens the control center; an existing selected repository keeps its workspace view during migration. 工程仓库 retains the six existing workspace tools. Application navigation hides the persistent workspace host instead of unmounting it; navigation does not stop PTYs or start work.

Tasks belong to a selected repository and reference explicitly created registered Git worktrees. A task never owns repository state through an Agent session. The footer build identity still identifies the running application independently of task/repository selection.

Active PTYs, Agents, Run/build processes and verification hold the same workspace writer reservation. Stop an existing session before handing that workspace to another writer; navigation preserves sessions and never stops them implicitly. Independent worktrees can execute concurrently.

## Local workflow

1. Add/select a local repository and choose 新建任务. Read its current HEAD, define goals and relative file scope, and configure a verification Profile. Edit the implementation/integration nodes and dependencies, then accept the frozen plan.
2. Create each task worktree explicitly. Creation does not start an Agent. A partial creation/persistence failure preserves the worktree and its preparation intent for manual reconciliation; it never silently cleans up or replays creation.
3. Start implementation tasks. The native coordinator has two global execution slots and a queue of at most 32 tasks. Retry creates a new Attempt. Provider completion only advances execution; Native observes shutdown, checks scope and optionally seals a local candidate commit.
4. The native verifier runs the accepted structured software gates against committed, clean controlled inputs. Failed/unsupported/missing required gates prevent readiness. Optional limitations remain warnings. Ordinary Run output is exploratory and does not grant task readiness.
5. For integration, prepare a dedicated worktree from the accepted base. Wait for fresh prerequisite checks and candidates, preview their exact source commits and target HEAD, then confirm through the native dialog. The preview expires after five minutes and is consumed once. No remote fetch/checkout, push or PR merge occurs.
6. Independently verify the final integrated commit, review that revision, and explicitly accept it. After a conflict or interrupted merge, use the IDE to inspect/resolve/commit the worktree, then choose 验证已解决的集成. Native checks the clean source and dependency ancestry; it does not replay merges.

AI plan suggestions and machine Reviewer are currently unavailable: the implementation does not claim a qualified read-only provider mode. Manual planning and human review remain usable. These labels are intentional capability gates, not simulated AI output. Other existing harnesses remain available through workspace Agents; the task coordinator's first implementation uses Codex only.

## Task-driven surfaces

Settings includes an independent reusable Profile library, even before the first
task exists. Choose 新建 Profile, edit its name/ID and structured gates/arguments,
then save. Paths/toolchain lists use one entry per line. Advanced JSON and bounded
JSON import/export preserve the supported configuration. A save conflict leaves
your draft intact: explicitly reload the latest selected record, or copy it to a
new ID. An ID change creates a separate record; delete/rename migration is not
provided. Saving configuration proves neither tool availability nor authentication.

In the task wizard, 已保存 Profile copies a full snapshot into the draft.
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

The evidence page lists all Runs persisted on task Attempts, with repository,
task, Attempt, tested SHA, historical outcome and time. Filter by repository/task/
check outcome; select 查看 Run for checks, digests and artifact metadata, then
explicitly open its task. Superseded records remain historical even if HEAD
matches. This inventory does not scan all archived files or open artifact paths.

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

Committed-clean qualification compares actual bounded file bytes with committed and indexed objects; it does not trust Git's timestamp cache. This implementation supports byte-preserving regular-file inputs. Hidden index flags, submodules/symlinks, automatic CRLF/encoding conversions and external clean filters require separate qualification and are refused. Direct workspace tools remain available for those repositories.

Each manual re-verification creates a verification-only Attempt and a new Run. Review and acceptance bind to that exact Run and toolchain; a new Run requires new human decisions. After application restart, observation continuity is unknown and previous results remain historical until re-verification and review.

Automatic sealing refuses executable commit hooks or configured signing rather than bypassing user policy. Commit manually in the workspace and use verification to adopt the clean committed candidate; native checks still enforce the accepted scope and base ancestry. Generated binaries are not currently qualified delivery artifacts; the archived artifacts establish verification output integrity.

Explicit verification can adopt a clean committed repair even after a failed integration already recorded an older candidate. Every candidate is checked against the accepted base and full task scope, including first conflict recovery without a prior candidate. An integration task's scope must encompass all source changes and conflict repairs. Its readiness, acceptance and passport all require the current dependency candidates to match the fixed source lineage in the verified manifest; a newer source cannot silently qualify an older integration.

## Durability and privacy

Application data contains `tasks-v1.json` and `task-evidence/<runId>/manifest-v2.json` plus bounded local artifacts. The task store persists a validated generation before exposing new state/events, with atomic replacement and rollback on failure. Reopening marks unfinished queued/running/stopping Attempts interrupted. No mutation is replayed automatically. An unavailable/corrupt store disables Task operations without overwriting the file or disabling direct workspace tools.

Existing workspace `.virtuallab/evidence` manifests are not promoted. New task verification obtains its own before/after observations around a newly invoked native run and archives its artifacts into application data. Removing a worktree does not erase archived task evidence. Human decisions are archived transactionally when superseded or cleared.

Passport export retains the accepted task title, goal, relative scope, fixed commits, observed tool digests and structural decision history. It omits raw provider transcripts, logs, native repository/executable paths and free-text review notes. Local logs can still contain output emitted by a user's build tools; they are not uploaded by this feature. Hashes detect divergence against recorded digests; the writable local store is not signed attestation, an OS sandbox or a correctness guarantee.

## Qualification still required

- Real authenticated two-Codex/three-worktree workflow on the supported hosts.
- Packaged GUI checks, including native confirmation, cancellation, terminal retention, small windows and production CSP.
- Windows/Linux locked native checks and local acceptance in their actual hosts/CI.
- User trials, Qt/Keil/cross-compiler qualification and provider parity.
- Qualified read-only planning/Reviewer support before enabling those actions.

The independent [offline prototype](prototypes/task-first-control-center.html) uses mock data and six scenario controls. It has no network or native/Git execution. Its simulated success is not evidence of application qualification.
