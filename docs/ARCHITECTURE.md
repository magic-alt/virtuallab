# VirtualLab architecture

VirtualLab is a **local-first AI Engineering Control Plane**, with the product promise **Verified Engineering Work**. Workspace remains the durable owner of repository context and execution resources; the planned user-facing workflow is organized around Tasks and Verified Results. An AI chat session never owns repository state. See [product strategy](PRODUCT_STRATEGY.md) and [delivery Roadmap](ROADMAP.md).

## Architecture principles

1. **Workspace owns execution context.** Repository, branch/worktree, terminal, checks, diff and attached agent sessions all hang from one workspace. Planned Tasks reference this context without transferring ownership to an Agent.
2. **AI is an adapter, not the product core.** Codex, DeepSeek-through-Codex, Claude Code, and OpenCode are optional harnesses attached to a worktree.
3. **Native operations stay behind a narrow Rust boundary.** The frontend requests typed commands; Rust performs filesystem/process/Git operations.
4. **Typed native operations.** Interactive PTYs are human-controlled; Git/GitHub/verification services use narrowly defined Tauri commands, not arbitrary agent-supplied shell strings.
5. **Hardware-changing actions require explicit human approval.** Flashing, drive enable, power-stage enable, destructive Git operations and merge actions will be gated.
6. **Local-first and offline-capable.** Git inspection and workspace inventory must work without cloud services.

## Application-level documentation

Bundled Help/Guide content is an application service, not a workspace tab or
execution context. The GUI menu bar offers **Help → 使用文档** even without an
active repository; it opens an overlay reader without changing the selected
repository, worktree, tab, or persisted workspace state. Workspace navigation exposes only Overview, Changes, GitHub, Agents, Terminal
and Run. Overview retains recent commits; local readiness duplicates have no
separate page. Run results and GitHub CI remain independent. Persisted state
schema v7 accepts only current workspace tab values; invalid values normalize
to `overview` while retaining repository/worktree selection, and migration
writes the validated state back to storage. There are no legacy page aliases.

## Background agent and terminal notification boundary

Task notifications are an application-level observer, not a scheduler or a process
owner. The per-PTY byte parser recognizes only OSC 9 terminal notifications and
BEL; OSC 9;4 progress markers are ignored. No text scraping, idle-output timers,
shell exit heuristics or automatic retries are used. For an opt-in Codex terminal,
the UI sends fixed Codex CLI config overrides (`tui.notification_method=osc9`,
`tui.notification_condition=always`) through its already-authorized PTY;
neither global Codex preferences nor existing shell lifecycle are changed.

Codex app-server/CLI structured turn completion events are consumed once at
the Workbench level, with turn identity de-duplication. Raw terminal BEL means
attention only; unmonitored OSC 9 is not classified as successful completion.
A bounded in-memory Zustand inbox records originating worktree and terminal ID,
not transcript text. The native `desktop_notify` command passes only generic
bounded and control-character-validated titles/bodies to the Tauri notification
plugin. Toasts are suppressed when the source task is already visible and focused;
they neither steal focus nor block work. Native notification errors fall back
to the in-app inbox. Routing to an inbox item only navigates to a registered
repository/worktree and never creates or starts work.

## External workspace editor boundary

The Workbench header, repository rows, checked-out branch rows and workspace
lanes expose an explicit **Open in IDE** action, separate from the OS file
manager action. The preferred editor is a locally persisted enum (Auto/Zed/
VS Code/Cursor); no executable path or shell command is accepted from the
frontend. `src/lib/backend.ts` forwards the repository root, selected
worktree root and editor enum to `open_workspace_in_editor` in
`src-tauri/src/external_editor.rs`. Rust reuses the registered Git worktree
validator from `git.rs` before looking up the editor binary and spawning a
non-interactive OS process with a fixed `--new` / `--new-window` argument
vector. Zed on Windows must use its `bin/zed.exe` CLI shim, not the GUI
binary in the installation root. macOS Zed uses the app bundle's
`Contents/MacOS/cli`; its GUI executable does not accept `--new`.
Windows desktop launch arguments convert Git's forward-slash paths to native
backslashes and remove extended-length drive/UNC prefixes for Explorer/IDE
compatibility, after registered-worktree validation. Git identity paths are
unchanged. Editor startup checks early exit status for up to 750 ms and returns
failures to the UI instead of silently reporting a successful spawn. A launcher
still running after that interval is reaped in the background without taking
ownership of the editor; later failures are outside this startup check.
Auto selects only recognized executable
families from `VISUAL` / `EDITOR`; environment strings are never evaluated
as shell commands. Path arguments remain distinct, including spaces and
Unicode. Unsupported/unavailable launchers return actionable errors.

Opening a project does not create a worktree, switch branches, stash changes,
modify Git state or transfer ownership of a workspace. External editors are
user-owned processes, not VirtualLab-managed Run/Agent processes; closing or
removing a worktree in VirtualLab does not terminate external IDE instances.

## Application build identity

`src-tauri/build.rs` embeds the application source commit, branch, dirty status
and UTC build timestamp into the native executable. `AppBuildInfo` also exposes
the native package version and Debug/Release mode through the read-only
`app_build_info` command and its typed `src/lib/backend.ts` wrapper. The shell
footer shows the short commit and dirty marker; its details panel shows the
full record independently of the selected repository or workspace.

Git runs only at compile time using fixed argument vectors and the application
source root. Linked worktrees and detached HEAD builds are supported. Missing
Git metadata remains unknown; source archives must not inherit a surrounding
repository's identity. Dirty includes staged, unstaged and non-ignored untracked
files; it means the commit alone cannot reproduce the compiled program. No
file contents, credentials or runtime repository state enter this record.

An intentionally absent Cargo rerun input refreshes the build script on every
Cargo invocation, including incremental self-builds and builds after Git-only
changes. This trades a native rebuild/relink for reliable provenance without
recursively watching generated folders. Browser previews are explicitly labeled
and do not claim native executable provenance. This record identifies a build;
it does not query a remote or claim that the executable is the latest release.

## Layers

```text
React / TypeScript UI
  ├─ features/sidebar
  ├─ features/workspace
  ├─ Monaco review + GitHub panel
  ├─ Agents panel: roles, opt-in skills, live timeline, safety requests
  ├─ stores / typed adapters
  └─ typed backend client
          │ Tauri invoke/events
          ▼
Rust native core
  ├─ git service
  ├─ workspace service
  ├─ PTY/process supervisor
  ├─ filesystem watcher
  ├─ restricted verification runner + hashed evidence files
  ├─ Codex / DeepSeek app-server, native Claude/OpenCode CLI transport
  ├─ exclusive agent workspace ownership + private hardware policy contract
  └─ persisted workspace context
          │
          ├─ git
          ├─ PowerShell/bash
          ├─ build/test tools
          └─ opt-in Codex / DeepSeek / Claude Code / OpenCode harness
```

## Frontend stack

- React 19 + TypeScript
- Vite
- Tailwind CSS v4
- shadcn/ui-compatible component layout
- Zustand for local application state
- Lucide icons

Implemented: xterm.js/PTy, structured `workbench://event`, Monaco read-only diff, optional `gh` PR/issue context, Agent workspace UI and four harness transports. V0.6 adds bounded, metadata-only agent lifecycle history; full durable event/transcript history remains planned.

## Native stack

- Tauri 2
- Rust 2021
- Tauri dialog and notification plugins
- Git CLI through `std::process::Command`
- portable-pty for PowerShell/bash sessions
- notify for workspace change observation

Git is intentionally CLI-backed at first. It matches developer machines, supports worktree semantics well and avoids prematurely coupling the product to libgit2 behavior.

## Domain model (implemented foundation)

```text
Repository
  └─ Workspace
      ├─ Git worktree / branch
      ├─ Terminal session(s)
      ├─ Build / test run(s)
      ├─ Change set / review
      ├─ Verification checks
      ├─ PR metadata
      └─ Agent session(s)
```

The workspace survives even when there is no agent attached.

## Planned Task and Verified Result model (V0.7–V0.8)

**Status: local software implementation with qualification outstanding.** The Task-first implementation adds a durable native task service (`tasks`), bounded coordinator (`task_execution`), typed local candidate/integration adapters (`task_inputs`), independently observed evidence helpers (`task_evidence`) and native review/readiness/acceptance (`task_runtime`). The [Task-first guide](TASK_FIRST_CONTROL_CENTER.md) distinguishes implemented local behavior from read-only planning/Reviewer and host/provider/user qualification still outstanding. The remaining design direction below is not a claim that every roadmap/release gate has passed. The [historical design review](MULTI_AGENT_DESIGN_REVIEW.md) remains rationale; the [Roadmap](ROADMAP.md) supplies sequencing.

Implemented delivery assessment is shared by readiness, acceptance and passport export. Exact fixed dependency lineage and atomic dependency-revision guards prevent newer/rejected sources from qualifying an older integration. Candidate adoption checks the full accepted base-to-HEAD scope, including manual first-conflict recovery. Source qualification compares actual byte-preserving files with committed/indexed objects, while `task_git_watch` observes linked-worktree HEAD/index/relevant refs outside the workspace. Tool/selection changes remain sticky within a session; restart requires new verification. Formal CMake verification requires preconfigured observable compiler selection; exploratory configuration grants no qualification.

### Current Task boundary

Task metadata, immutable Attempts, structural event sequence and superseded human decisions are persisted in a bounded, atomically replaced application-data JSON generation. Failed writes do not change in-memory state. Startup marks unfinished Attempts interrupted and never replays Git/process side effects. Store corruption is exposed as unavailable while direct workspace tools remain usable. App-level React observation reads native snapshots through typed wrappers and rejects delayed results after repository/action changes.

One shared `WorkspaceLifecycle` reservation spans startup through observed writer shutdown across harnesses, PTYs, Run, Verification and Git mutations; subdirectory writers normalize to their owning worktree. Missing worktree creation targets have explicit reservations before directory creation/registration. Cancelling is not completion. Task scheduling is bounded to two active slots and 32 queued tasks; application shutdown revokes new dispatch and cancels pending controlled work before process managers shut down.

The integration boundary consumes a five-minute, one-use fixed-source/target preview before its native human dialog, revalidates afterwards, and preserves partial failure state. New task verification wraps a newly executed native runner with source/Profile/executable observations and archives v2 lineage/artifacts in app data; historical v1 records are never synthesized into qualified evidence. Native source/toolchain watches invalidate live and persisted applicability, and acceptance rechecks current inputs. Four separate UI facts remain execution, checks, readiness and human acceptance. Local acceptance has no remote/release/hardware authority.

```text
Repository
  ├─ Workspace(s) ── own worktree, terminal, runs and attached harness
  └─ TaskSpec(s) ── goal, accepted scope, dependency IDs, required Profile
       └─ TaskAttempt(s) ── reference Workspace identity and candidate commit
            ├─ structured native lifecycle events
            ├─ Verification run(s) ── observed checks and artifact digests
            └─ revision-bound review / readiness / human acceptance

Implementation Task A ── fixed candidate A ──┐
                                          ├─ Integration Task C
Implementation Task B ── fixed candidate B ──┘    └─ final commit + fresh evidence
```

### Ownership and execution flow

- `TaskSpec` records the operator-approved goal, same-repository dependencies, required verification Profile and capability/resource scope. `TaskAttempt` records a distinct execution, workspace identity, harness identity, candidate revision and observed lifecycle. A retry creates a new Attempt; it cannot overwrite previous evidence.
- A bounded native scheduler validates dependencies and reserves canonical workspace/resource identities before starting work. Preserve one active harness and one controlled writer per worktree. Agent, integration, Fixer and Verifier phases on that worktree are sequential; read-only Reviewer access must not acquire write authority.
- Workspace creation is a user-triggered action within the selected repository. The first flagship flow uses two implementation worktrees and a dedicated third integration worktree. Both predecessors must satisfy their accepted prerequisite checks and produce fixed commits before integration becomes eligible.
- Native task persistence and a basic evidence index arrive in V0.7-A. They cannot depend on the ephemeral 300-event UI ring or reconstruct complete task history from the rotating Agent metadata journal. Crash recovery reconciles durable task/attempt records with observed native owners; unknown outcomes stay unverified, with no automatic mutation replay.
- React feature surfaces consume typed wrappers in `src/lib/`. Rust owns persistence, process/Git operations, resource reservations and readiness transitions, emitting structured task/verification events. No component-supplied shell string or provider completion message can authorize those transitions.

### Planned interface responsibilities

These are capability contracts for subsequent implementation slices, not registered Tauri commands or a frozen wire schema.

| Boundary | Inputs and result |
| --- | --- |
| Task service | Accept goal/scope/Profile/dependencies; create/query Task and Attempt identities; request cancel or explicit retry; expose durable structural state |
| Integration preview/confirm | Preview repository identity, target worktree/HEAD, ordered fixed source commits and impact; confirm an unexpired one-use plan after native revalidation |
| Verification/evidence service | Run approved structured software executors; bind independently observed results to Task/Attempt, integrated revision, Profile digest and toolchain observations; query indexed history |
| Delivery decision service | Compute readiness and actionable blockers from current native Git/input state, evidence and required review; separately record explicit human acceptance bound to the result |

Local integration requires a dedicated, registered same-repository target and a clean source state. Confirmation covers only the previewed local commits/order and target; it grants no remote or release authority. A stale source/target snapshot is rejected before mutation. A conflict or interrupted partial merge stops for human resolution/abort and native reconciliation. Never automatically stash, reset, clean, force-push, replay a merge or fetch/checkout a remote PR. The existing human-confirmed GitHub merge API remains a separate network boundary.

### Evidence binding and freshness

Extend the versioned `EvidenceManifest` contract beyond schema-v1 HEAD/check/artifact fields with Task/Attempt lineage, integrated source commits, exact tested revision, Profile content digest, observed runner/toolchain identity and explicit non-secret configuration. Use a new schema version for the expanded contract; retain v1 records for historical inspection without synthesizing missing provenance or promoting them to qualified delivery evidence.

Formal readiness in the MVP requires committed, clean controlled source inputs. Dirty-workspace exploration remains provisional. Profile-declared build/evidence outputs are distinct from source inputs; broad ignored-directory rules must not conceal source changes. Recheck input identity and required toolchain/Profile observations before and after execution and before acceptance. Detect source changes during/after verification even if HEAD is unchanged; a change invalidates current readiness and acceptance while preserving the historical run. Unknown required provenance blocks qualification. Native reservations prevent VirtualLab-controlled writers during verification; external processes are outside that reservation and require freshness detection, not an OS-isolation claim.

The basic V0.7 index associates immutable run identities with their manifests and Tasks; V0.8 hardens atomic persistence, integrity checking, migration/recovery, query/compare and retention. Index recovery must never manufacture PASS from an incomplete run. Hashes support tamper detection relative to a trusted digest; writable local files are not signed execution attestations and do not prove correctness or test sufficiency.

Never inspect or retain sensitive environment-variable values or `.env` contents to fingerprint an environment. Do not hash such values as a substitute for disclosure. Record only allowed non-secret Profile configuration and bounded toolchain identity observations; credentials remain outside task/evidence/export contracts. Default durable Agent history remains structural metadata, without raw prompts/responses/tool output.

### Execution, readiness and acceptance

Keep four separate facts: Agent execution outcome, observed software-check outcome, current delivery readiness and human acceptance. The current `EvidenceStatus` remains a run/check status and is not itself an acceptance record.

- **ready:** fresh qualified evidence satisfies all required checks and required review for the current integrated inputs; a user may then accept that exact result.
- **warning:** required checks/review are satisfied but explicit policy leaves optional limitations; display these before a human decision and never silently treat them as clean ready.
- **blocked:** a required check failed, dependencies/conflicts remain unresolved, or a known scope/policy violation prevents delivery. Human acceptance cannot override a failing required check.
- **unverified:** execution/provenance is incomplete, missing, stale or unknown. Historical PASS does not turn this into ready.

Acceptance is a separate native-validated, version-bound operator action. It does not merge a PR, publish a release or enable hardware. Later source/Profile/toolchain/review changes invalidate its applicability to the current result without erasing the historical decision. A policy change creates a new accepted task/Profile revision and requires evaluation again; it is not a way to relabel failed old evidence.

### Baseline gap and release qualification

At inspected `main@9523b3e` (2026-10-16), `TaskSpec`/`TaskAttempt`, scheduler, local integration executor and trusted delivery-readiness service remain planned. PR #63 is MERGED on GitHub, but commit `5ad98cd` is not an ancestor of this main and its `workspace_lifecycle.rs` is absent. Review/reintegrate that missing lifecycle capability and qualify it before parallel execution; the existing per-manager owner checks are not the planned shared atomic reservation.

The first real workflow uses two independent Codex instances; other adapters keep explicit qualification status. CMake C++ is the primary project fixture, npm a general regression fixture, and Qt/Keil/cross-compilers follow on provisioned hosts. Three-platform automated checks do not qualify untested packaged GUIs or authenticated providers. No hardware executor, cross-repository Release Graph or cloud/team service is part of the MVP.

## Event model direction

Long-running operations should converge on an append-only event envelope:

```ts
type WorkbenchEvent =
  | { type: "process.started"; ... }
  | { type: "process.output"; ... }
  | { type: "process.finished"; ... }
  | { type: "git.changed"; ... }
  | { type: "check.updated"; ... }
  | { type: "agent.started"; ... }
  | { type: "agent.tool"; ... }
  | { type: "agent.finished"; ... }
```

This gives the UI one streaming model for terminals, builds, HIL runs and future agents.

## Security boundary

The native layer must distinguish:

- **read-only:** inspect repository, diff, log, status
- **reversible write:** create branch/worktree, stage files
- **destructive:** reset, clean, force push, delete worktree
- **hardware / release:** flash, enable motor/power stage, merge/release

Destructive and hardware/release operations must never execute from an implicit agent decision.

## V0.2 execution boundary

Interactive terminals and build/test processes are separate execution paths:

- **Terminal:** true PTY, interactive input, resize and Ctrl+C. Intended for human-driven shells and future agent harnesses.
- Native terminal commands explicitly set `TERM=xterm-256color` to match the xterm.js renderer rather than inheriting the launching application's terminal type. This keeps shell erasure and cursor editing functional when macOS Finder/Dock launches omit `TERM` or a parent supplies `dumb`. Run/Build/Agent process environments are configured separately.
- The production frontend separates React and xterm vendor chunks from the application. Monaco remains behind the review surface's dynamic import, with its editor core in a separate local chunk. Vite enforces a 500 kB minified JavaScript budget per UI chunk and a 4500 kB budget for the lazy Monaco core; exceeding either fails the build. Worker assets are emitted independently of these UI chunk budgets.
- `WorkspaceTerminals` retains a separate mounted `TerminalWorkspace` per normalized workspace path for the workbench lifetime. Tab, worktree and repository navigation only changes visibility; hidden terminals continue receiving output and keep their shell state, selected terminal and xterm scrollback. Windows path spelling variants reuse the same pane. Preview panes have separate identities and cannot disable native panes. Stop/Close remain explicit session actions; workbench teardown and native application shutdown clean up running sessions. Retention is in memory and does not restore sessions after application restart; the native eight-session cap remains global.
- **Process profile:** structured executable + argument vector + working directory. Intended for repeatable build/test/check commands; it does not accept a shell command string.
- **Worktree mutation:** branch validation and explicit native confirmation precede ordinary worktree removal. A dirty registered non-primary worktree returns a typed `needsForce` preflight instead of being deleted. A separate irreversible-loss native confirmation is required before a single `git worktree remove --force`; Rust revalidates registered path, primary exclusion, full HEAD, checked-out branch and a SHA-256 digest of NUL-delimited status entries against the preflight snapshot. Stale previews and direct force calls without a matching snapshot fail closed; a locked worktree is not bypassed (never supply a second `--force`). Removing a worktree never deletes its Git branch. Ignored/generated files inside the directory can also be lost.
- Native removal also rejects workspaces held by attached agent runtimes, running/stopping Run/Build jobs, active verification runs or retained PTY sessions/startup. These are conservative ownership checks; a shared lifecycle reservation to close concurrent start-versus-delete races remains future work.
- **Filesystem watcher / Git refresh:** the workspace header has no manual Refresh control; local state refresh is built in. The Fetch action retains `git fetch --prune origin` while displaying only Fetch. Source-file events are coalesced (850 ms quiet period, 2.6 s max wait) and invoke the lightweight native `inspect_worktree_status` (HEAD + porcelain status) without toggling global loading or rebuilding the branch/worktree inventory. Identical status data retains the current React snapshot. A changed HEAD/branch or an explicit Git operation triggers a full `inspect_repository`; targeted Git HEAD/refs/worktrees/config events also trigger a quiet full refresh (400 ms debounce). `.git/index` updates refresh status only; read-only status uses `git --no-optional-locks status` to prevent the watcher from retriggering itself. Git objects/logs/lock files and generated-heavy directories (`node_modules`, `target`, `dist`, `.virtuallab`) do not trigger source rescans. Linked-worktree metadata paths and their shared `commondir` are watched explicitly. Refresh results are scoped to the selected repository/worktree and fenced against older full inspections.

On Windows, `.cmd`/`.bat` process profiles are routed through `cmd.exe /d /s /c` only after the program and its arguments have already been separated by the profile model. Arbitrary command strings are not exposed as an agent API.

Windows terminal lifetime also owns the ConPTY master. After confirmed process cleanup, Stop closes the master so the output reader can receive EOF and release the session reservation. A native monitor observes shell exit independently of EOF. The first ConPTY startup cursor query is consumed and answered at `(1,1)` by the native reader using a separately synchronized writer, so teardown does not depend on a mounted xterm or the session mutex; later application cursor queries continue to reach xterm. Input writes release the session mutex before pipe I/O. This follows the [ConPTY teardown requirement](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session#ending-the-pseudoconsole-session) to keep cursor replies and output draining serviceable during close.


## Project build workflow boundary

The **Run** panel augments V0.2 profiles with worktree-local, read-only detection of package.json scripts, CMakeLists.txt (including Qt) and bounded Keil MDK *.uvprojx files. Detected recipes can be run directly or saved as editable repository-scoped profiles. A profile can contain multiple ordered `BuildStep { name, program, args[] }` entries. Persisted V0.2 single-command Build/Test profiles remain valid.

One-step recipes normally retain the existing `process_spawn` route. Multi-step recipes and explicitly confirmed Windows self-builds invoke `build_workflow_start` in `src-tauri/src/build_workflows.rs`: one canonical working directory, independently spawned executable/argv vectors, output events on `build://event`, stop-on-first-failure, and a cancellable process tree/group. The frontend receives a final pass/fail/stopped status; exit code 0 alone is not a signed verification gate. Windows invocations reuse the background process adapter to avoid transient console windows.

**Windows self-build boundary:** when a single, exact `npm run tauri:build` recipe targets the currently running Tauri app (identifier and Cargo executable verified in Rust), the user first approves a native restart dialog. The executor sets `CARGO_TARGET_DIR` to this worktree's `src-tauri/target/self-build-stage-v2` and appends `-- --no-bundle` to the verified `npm run tauri:build` argv, preventing the Windows linker from touching the running EXE and avoiding WiX/MSI/NSIS installer failures during the local self-restart. This argument change is not applied to ordinary packaging. On successful standalone EXE compilation only, an unmanaged helper process launched from the newly compiled binary waits on the old process handle, then replaces a release EXE *only inside the selected worktree's target/release directory* before launching it; a packaged/installed or dev/debug copy is left unchanged and a newly built EXE is launched from alternating `target/self-build-runtimes/{a,b}` slots instead. The runtime slot is preflight-copied before the current app exits, preventing the Cargo staging binary from remaining locked during the next build. Failure/cancellation preserves the current running window. No arbitrary process command can request this handoff. The helper runs before Tauri initialization so it does not create a second window during replacement; failures are logged under the staging target directory. It is not an installer/managed software update mechanism.


The Cargo target directory passed to the Windows self-build subprocess uses ordinary drive/UNC spelling, while native workspace and restart identity checks retain canonical paths. Passing a canonical `\\?\` path to Cargo can make Tauri 2 permission globs produce empty core manifests: `core:default` then resolves without event commands and Terminal cannot subscribe. The versioned staging directory avoids reusing those broken build-script caches. Windows CI checks the generated context with `--release --features tauri/custom-protocol`, including local main-window listen/unlisten access and rejection for unrelated windows; default-feature Rust tests alone do not cover the production ACL.

**Packaging is not deployment:** inferred Tauri package recipes build files but do not install/publish. Deployment is a *manually authored* profile and requires a Tauri-native confirmation every time. Because user scripts and executables can perform arbitrary writes, confirmation is only an explicit interaction gate, not a sandbox or hardware authority. Build suggestions do not trigger SDK installation, firmware flashing, motion, power or publication. No other repository is referenced by this feature.

**Desktop scroll ownership:** The shell and workspace stage use a shrinkable `min-height: 0` flex chain. The Run tab's `WorkspaceContent` viewport prevents outer overflow at `xl` widths, while `ProcessRunner` uses an explicitly bounded `minmax(0,1fr)` grid row. Its workflow card column and log `pre` own independent vertical scrolling; the output remains bounded as events append. Below `xl`, cards stack inside a naturally scrolling workspace but the output panel has a separate fixed viewport-height cap. Manual scrolling away from the log tail disables auto-follow until the operator selects `Latest output` or a different run. Other tabs preserve their existing scroll contracts (terminal scrollback, review editor, GitHub lists and agent timeline) rather than being globally clipped.

The workflow UI output ring and process lifetime are ephemeral; worktree/profile settings are persisted locally, not in Git. Restart reconciliation, durable run/evidence history and full process-tree cleanup remain separate V0.6–V0.8 acceptance items. See [project build workflows](PROJECT_BUILD_WORKFLOWS.md).

## V0.2 persisted workspace context

The local Zustand store persists one workspace context per repository: active worktree path, active tab and update timestamp. Repository switching restores that context. If a remembered worktree no longer exists, VirtualLab falls back to the primary repository and Overview. Runtime PTY/process objects are deliberately not persisted.

## Normalized process results

Run outcomes use the typed `CheckResult` contract with stable ID, source, status, detail, observation time and optional exit code. Repository readiness normalization was removed with the standalone Checks page; repository state remains visible in Overview. V0.4 persists verification manifests, hashes and logs; searchable evidence history and enforceable release gates are future work.

## V0.3 review boundary

V0.3 starts read-oriented: Git diff retrieval and GitHub PR/check metadata are read-only adapters. Inline review drafts may be edited locally before network mutation. Posting comments, changing PR state and merge/release remain explicit user actions.

Changes opens with the file list and read-only diff. Worktree/Staged and layout
controls remain visible; Base comparison, review-phase controls, line selection
for comments and saved drafts are opt-in under **Advanced review**. Closing
advanced review hides the draft composer/list without deleting saved drafts;
closing it from Base returns to Worktree and invalidates pending Base requests.
**Manage local changes** reveals the existing typed stash/discard/delete actions
without bypassing native confirmations. Merely expanding either section does
not mutate Git. Diff invalidation notices remain visible with both sections
closed, and fresh content must still be loaded after workspace refresh.

The local change count includes tracked and untracked status entries. Changes/Worktree lists unstaged tracked changes and untracked files or grouped directories; Staged lists index changes, while Base lists committed changes against the chosen base. Untracked entries show their status and path without calling the tracked Git diff adapter or enabling line drafts / mark-reviewed. Directory grouping follows the native Git status snapshot, so one untracked directory is one counted entry. Selecting any entry invalidates a pending diff request to prevent an older response from replacing the selected state.


## GitHub PR discovery and merge boundary

The GitHub workspace tab can enumerate open PRs from the current origin without checking out any branch. Native `github_list_pull_requests` loads a bounded list through `gh pr list --repo`; `github_context` uses a resolved PR number or local branch selector instead of an ambiguous bare `gh pr view`. The UI displays the full `statusCheckRollup` (success/pending/failure/neutral) and the GitHub mergeability and review decision fields.

`github_merge_pull_request` is an explicit, typed, human-confirmed network mutation. It re-derives the repository from the selected local workspace origin; validates repository identity, merge method, and a full expected HEAD SHA; reloads current PR metadata and CI checks; and rejects drafts, missing/failed/pending checks, unknown mergeability, non-CLEAN GitHub merge state or blocked reviews. The merge uses GitHub's PR merge REST endpoint with a SHA precondition. GitHub remains authoritative for branch protection and merge permission. No local pull, checkout, force-push, auto-merge or branch deletion follows a merge.

The frontend mirror in `src/lib/github.ts` only controls presentation: native checks must never be omitted because a button is disabled. Github CLI authentication stays outside VirtualLab; secrets are neither read into UI state nor persisted.

## V0.4 → V0.5 agent and verification bridge

The first V0.4/V0.5 bridge keeps the workspace as the durable owner while adding a thin agent-harness runtime and versioned verification contracts.

- Frontend harness code depends on the `HarnessAdapter` interface; the first implementation is `CodexAppServerAdapter`.
- Rust `AgentManager` owns only the local Codex app-server process and JSON-RPC transport. Repository/workspace state is not owned by Codex.
- Each workspace has at most one persisted Codex thread binding. The binding survives application restart; the app-server process does not. A later attach resumes the saved thread id.
- VirtualLab talks to `codex app-server` over stdio JSON-RPC and emits structured `agent://event` notifications. UI code must not scrape the Codex TUI or terminal text.
- Until VirtualLab owns approval routing, Codex sessions use `workspace-write` with `approvalPolicy = "never"`. This permits workspace-local edits while failing closed for operations that need elevation.
- `VerificationProfile` defines versioned build/unit/HIL/hardware/soak/evidence gates using structured executable + argument vectors or future typed adapters.
- `EvidenceManifest` binds a verification run to the workspace, repository HEAD, individual gate results, artifacts, and optional firmware/bitstream/DUT/hardware-revision metadata.

This slice defines the contracts but does not yet make an agent authoritative for verification. The restricted native verification runner writes evidence into `.virtuallab/evidence/<run-id>/`. A private hardware lease policy contract exists but cannot authorize real hardware: there is no public grant-minting method, physical interlock, or approved hardware execution provider. Release readiness UI, searchable history and complete authorization are not implemented.

See [V0.4 → V0.5 agent foundation](./V0.4_V0.5_AGENT_FOUNDATION.md).

V0.6 native agent producers also write an allowlisted lifecycle metadata journal under the application data directory. Raw prompts, messages, tool output and stderr are omitted; workspace/thread/turn identifiers are hashed. Two rotating JSONL segments are bounded to 2 MiB each, with Unix directory/file permissions of 0700/0600. Appends repair torn trailing records using a separate write-capable handle before reopening for append, including on Windows; invalid interior records fail closed. The typed `agent_journal_recent` command returns at most 300 records for the selected workspace. The frontend displays restart history separately from live events and never treats a historical active status as a running process or permission to reattach. Browser events cannot inject journal rows.


## V0.3 review loop (current)

```text
Authenticated same-origin issue / PR reference
  → user confirms new local Git worktree
  → workspace-local source reference + review state
  → Changes diff / optional local line draft
  → fix in Terminal or external editor
  → refresh native Git snapshot; invalidate cached Monaco diff
  → reload changed file / base file list → mark reviewed
  → optional explicit, confirmed GitHub comment (PR head match only)
```

Source references are workspace-local and restored when that worktree is revisited. `baseRefOid` and `headRefOid` from `gh pr view --json` are compared with the local (abbreviated) Git HEAD; a local HEAD at PR base does not authorize posting to PR head. A new worktree starts at a user-selected **local** base ref, not at a remote PR branch. Changes/Monaco always remain read-only. A post-refresh diff is considered invalid until explicitly reloaded.

The native boundary continues to reject nonmatching GitHub repository URLs; no automatic fetch/checkout/merge/reset/force-push behavior was added. Workspace and review state remain meaningful offline.


## V0.5 independent harness boundary

- \`HarnessAdapter\` selects Codex, DeepSeek, Claude Code or OpenCode without changing repository/worktree ownership. The Rust \`AgentOwnership\` guard forbids two different harness runtimes in the same workspace until stopped.
- Codex and DeepSeek use the same stdio app-server RPC lifecycle; DeepSeek explicitly configures the Responses provider from \`DEEPSEEK_API_KEY\` and a user-managed local Codex model catalog. No secrets are saved by VirtualLab.
- Claude Code and OpenCode use direct executable/argument vectors, non-interactive NDJSON streams and native process supervision; they do not invoke arbitrary shell strings, parse TUI escape codes or expose a privileged terminal.
- Claude and OpenCode default to provider plan/read-only mode. Provider permissions are NOT OS sandboxing; a malicious or modified local CLI can still exercise user permissions.
- Provider-native CLI session IDs are learned from authenticated local executable events and persisted per workspace. CLI thread/turn streams and server notification streams share \`agent://event\`, with a 300-entry UI ring buffer (ephemeral, not a signed audit trail).
- User-created role and skill instructions are persisted locally and must never contain credentials. Only selected opt-in skills enter prompts; none reference or bind other repositories.
- \`AgentApprovalBroker\` records a direct human decision and validates limited TTL. The \`EnforcingHardwareProvider\` interface requires an independent scoped device-side lease. There is no installed provider, so attempts to authorize motion, power, flash or release fail closed; no UI record permits hardware I/O.
- Software-side permissions and process interruption are NOT interlocks, emergency stops or security boundaries. Any future hardware integration must independently enforce revocation, watchdog, safe state and transport isolation.

See [V0.5 agent harnesses](./V0.5_AGENT_HARNESSES.md).


## Release gate lifecycle hardening (v0.5.0 candidate)

`RunRegistry` is native workspace state, independent of mounted React tabs. `process_spawn` and `build_workflow_start` reserve a canonical workspace slot and a unique run ID before starting work. `list_runs(cwd)` returns bounded snapshots including profile identity, output, exit code and state. A workspace cannot start another run while its slot is `running` or `stopping`. Completed history is bounded to 100 records globally; output is bounded to 180,000 UTF-8 bytes per record. History is in memory and is not restored after application restart.

`ProcessRunner` consumes structured events for live output and reconciles with native snapshots on mount and every two seconds. UI cancellation means `stopping`; only confirmed process-tree cleanup plus observed exit and drained output permit terminal status. Native startup failures release the slot through a failed record. A permanent registry close flag rejects new work during application shutdown, including delayed Agent/CLI/Terminal starts.

`ManagedChild` owns background process trees for Run, Build and Agent adapters. Windows creates a suspended child, assigns it to a kill-on-close Job Object, then resumes its initial thread. Termination queries the Job until active process count reaches zero. Unix children receive an isolated process group; native group signals escalate from TERM to KILL and group disappearance is observed with a bounded deadline. Linux excludes already-dead zombies when checking `/proc/*/stat`; process environments and arguments are never read. A cleanup error retains an occupied stopping slot and a diagnostic instead of announcing successful completion. PTY terminals remain behind portable-pty. Windows cancellation uses taskkill tree termination. Unix TerminalProcess captures the isolated session leader before publication and keeps it unreaped to pin the session ID. Stop, startup cancellation, reader EOF, shell exit and application shutdown share session-wide TERM/KILL cleanup across job-control groups, with a three-second exit deadline. The process scan requests only PID/state from /bin/ps, is capped at 8 MiB and shares the cleanup deadline; it never reads arguments or environments. Linux requires kernel 5.3+ pidfds: targets are pinned before getsid validation and signalled through pidfd_send_signal, preventing PID reuse from redirecting signals. Other Unix platforms (including macOS) recheck getsid immediately before POSIX kill; this is best effort and retains a small PID reuse race between those syscalls, so no atomic target-identity guarantee is claimed. Darwin can hide exiting leaders from getsid, so WNOWAIT validates the still-owned unreaped child; transitional exit states retry within the deadline. Darwin zombie-only group EPERM is accepted only after bounded PGID/state inspection confirms no live members. A WNOWAIT monitor observes shell exit without reaping, including when background jobs keep the PTY open. It also observes startup/Stop cancellation so failed cleanup retries do not depend on shell exit or EOF. Reaping and release occur only after no live session members remain; cleanup failures retain ownership and emit diagnostics for retry. Daemons that deliberately create a new session are outside this terminal ownership boundary. Terminal startup reserves the ID before scheduling native work, with an eight-session cap and cancellation compensation.

Windows executable resolution skips extensionless POSIX shims and accepts `.exe/.com/.cmd/.bat`. Resolved paths and regular argument vectors are passed to Rust `Command`, whose Windows batch adapter handles outer quoting, argument escaping and rejection of unrepresentable input. VirtualLab no longer manually builds `cmd /c` strings. This adapter is shared by build tools and opt-in Agent harnesses.

Filesystem watch starts reserve generations before blocking initialization. Stop invalidates the slot immediately; a late or superseded watcher cannot be installed, and watcher destruction occurs outside the shared lock. Callbacks also reject obsolete generations.

If inspection of a selected or restored linked worktree fails, the shell reads
its selected repository's primary worktree inventory. Only a successful inventory
that excludes the failed path and includes the primary permits recovery. Recovery
replaces the branch/worktree snapshot, drops the failed path's cache, persists
Overview selection and clears the obsolete error. Status-only watch failures also
request full inspection. Still-registered worktrees and unavailable primaries keep
their selection; delayed/queued refreshes cannot override a newer selection.
Recovery changes only UI state. Explicit lane navigation clears previous action
errors without moving terminal/agent sessions between workspaces.

Worktree removal blocked by a terminal offers a separate native **Stop and retry**
confirmation. This ends that worktree's terminal shells and their commands,
including agent CLIs inside those terminals. Cancellation or dialog failure does
not request shutdown. The typed `stop_worktree_terminals` adapter revalidates an
exact registered, non-primary worktree before cancellation. `TerminalManager`
matches immutable reservation identity (including subdirectory starts), snapshots
a fixed set, and verifies session pointer identity before marking cancellation.
Unattributed startup reservations fail closed. No other workspace or separately
managed Agent/Run session is stopped. A bounded wait uses the existing terminal
monitors/readers and waits for native lifecycle reservation release, rather than
assuming map removal or a stop request means completion. The original removal is
retried once, retaining all lifecycle/registration checks and the exact force
snapshot. New terminal starts or shutdown-side file changes cannot bypass native
occupancy checks or the independent dirty-worktree confirmation.

Dangerous frontend actions use the typed `confirmNativeAction` gate. An unavailable or cancelled native dialog fails closed. GitHub actions recheck the current workspace/PR/HEAD and draft after the asynchronous dialog; native merge/comment preflight remains authoritative. No remote merge, deletion or comment is performed by release automation.

Production CSP restricts scripts to local assets and connections to local IPC, with local/blob workers and inline styles for Monaco. Development alone adds Vite loopback HTTP/WebSocket origins. No remote editor CDN or `unsafe-eval` is enabled. Real WebView acceptance remains required on Windows/macOS/Linux. Agent timeline payloads are bounded to 16 KiB per event in addition to the existing 300-event workspace limit; full transcripts are not persisted.


## Post-merge release audit reliability

Verification process gates use the same Windows Job Object / Unix process-group ownership as Run, Build and Agent through ManagedChild. Every terminal path (leader exit, cancellation, timeout or wait error) confirms process-tree termination before joining output readers. Reader completion has a separate three-second deadline: failed cleanup or missing EOF produces a failed gate rather than a successful verdict or an unbounded join. Deliberate Unix process-group/session escape remains outside this ownership boundary; a failed reader deadline can leave a bounded drainer until that pipe closes.

Each verification stdout/stderr file stores at most 8 MiB. Excess output is drained through a fixed 8 KiB buffer; a truncated log makes the gate fail explicitly and its bounded artifact still receives a digest. The evidence manifest is written to an exclusive sibling temporary file, synced, then atomically renamed over manifest.json; Unix also syncs the directory. A failed replacement leaves the previous manifest intact, and an open temporary file is cleaned up on failure.

All macOS background commands share native executable lookup: inherited PATH directories take precedence over /opt/homebrew/bin, /usr/local/bin, /opt/local/bin and user .cargo/bin, .local/bin, .npm-global/bin and .volta/bin. Explicit paths are preserved; relative PATH entries are frozen against the application working directory before setting a child working directory. Only executable regular files are selected; misses are not cached. The same directories are supplied to each child PATH so /usr/bin/env interpreters work for GUI-launched CLI scripts. No login shell is evaluated or application-wide environment changed. GitHub probes/requests and Agent capability/start paths already use this launcher; Git's existing GitHub credential adapter resolves gh through it and quotes a path containing shell metacharacters.

Codex/DeepSeek, Claude and OpenCode native streams consume bounded records (128 KiB of content, plus optional CR terminator). Oversized or invalid UTF-8 protocol records are rejected with diagnostics, drained to the next newline and never parsed as partial JSON; subsequent records remain usable. stderr uses the same input bound. These native allocation bounds complement the frontend 16 KiB event and 300-event history budgets.

Windows canonical workspace identity removes the filesystem verbatim prefix and normalizes UNC spelling before case folding, keeping existing-path and ordinary-path aliases consistent.

## Safe local changes recovery (branch switch / Pull)

The Changes workspace provides `StashAll`, `DiscardTrackedAll`, `DiscardTrackedSelected` and `DeleteUntrackedSelected` typed scopes. The frontend gates them with a fail-closed Tauri native confirmation. The Rust `git_local_changes` backend rechecks registered worktree identity, selected branch, abbreviated HEAD and the entire parsed porcelain-z Git status **after** user confirmation. It rejects stale status/selection, never force-resets HEAD, and isolates explicit path operations using Git literal pathspecs after path traversal checks.

`stash push --include-untracked` is the preferred reversible route for dirty user workspaces, including KiCad untracked history. `restore --source=HEAD --staged --worktree` changes only tracked scopes; `git clean -f -d` is reserved for one explicitly selected untracked path, with an immediate dry-run guard, never repository-wide `clean -fdx`. Tracked-only restore preserves untracked content by default. Pull continues to use `--ff-only` and rejects tracked modifications, but lets Git preserve non-conflicting untracked files; Git refuses checkout collisions itself. No arbitrary shell string is executed. A GUI background refresh invalidates previous review content and opens the Pull button when the tracked dirty count clears.



## V0.6-A · Restart-safe Agent journal interpretation (candidate)

The native `agent_journal.rs` records only a fixed structural event allowlist. Per-workspace/thread/turn identifiers are SHA-256 hashes and raw provider prompts, tool messages and stderr are never persisted by default. Bounded two-segment JSONL retention supports torn trailing-record recovery and rejects damaged interior records.

`agent_journal_recover` serializes access with native journal writes and replays retained events by **turn identity**. Codex records the authoritative turn ID after a successful `turn/start` RPC; CLI harnesses record both session attach/stop and turn events. Duplicate start notifications do not re-open a completed turn. Process exit or explicit session stop without a matching successful completion marks incomplete turns `unverified`, never `completed`. If no native Agent runtime owns a workspace, unmatched retained starts receive an idempotent durable `recovery.unverified` marker. A GUI refresh never automatically resumes or reruns a previous turn.

`agent_journal_purge_all` deletes only VirtualLab's own application-metadata segments after an explicit frontend **native confirmation**. It neither deletes provider threads nor stops processes. The recovered-state pane shows whether the **current app process** has an Agent runtime registered. That is not proof that the provider's last task passed verification.

Limits: Recovery inspects only the retained journal window and cannot resurrect a process/OS Job Object. No task DAG, exactly-once external side-effect execution, provider-verified completion or immutable release approval is implied. Authenticated cross-platform desktop testing remains separate from mock/unit CI.


### Reusable task Profile configuration and task navigation

The Task-driven Workbench increment adds a separate native `TaskProfileLibrary`
managed independently of TaskManager. Application data `task-profiles-v1.json`
holds `{schemaVersion:1, records:[{id, revision, profile, updatedAtMs}]}`. The
library is bounded to 128 records, 64 KiB per Profile and 9 MiB per generation;
positive revisions cannot exceed JavaScript's maximum safe integer. The narrow
`task_profile_list` / `task_profile_save` commands expose configuration only.
Null expectedRevision creates; exact revision updates; conflicts never overwrite
records. Cloned managers serialize writes, atomically persist before memory
publication, and preserve existing corrupt/nonregular/unsupported stores on open.
The manager retains the last persisted file-content digest and rejects a changed,
missing or replaced backing generation before replacement, preserving disk and
memory. One manager owns one path inside this application; the change detector is
not a cross-process locking or atomic compare-and-swap protocol. A library failure cannot prevent direct workspace tools from
loading, and library validation never grants execution qualification.

Library Profile definitions reuse task validation without a repository root.
Accepting a plan still validates the copied Profile against the selected actual
repository. A task's accepted Profile is immutable when the library changes.
React reaches the library through `src/lib/taskProfiles.ts`, with a focused
request-sequenced store, structured editor and bounded JSON import/export.
Adapter configuration can be retained in advanced JSON but unsupported/hardware
executors remain blocked. No new filesystem reader or process/Git API is exposed.

The control center now separates dashboard queues, task list, Profile settings
and an inventory of evidence-bearing task Attempts. Task selection, detail tab
and filters live in the task store; root metadata retains valid navigation when
the observer reattaches and clears removed-repository selection. The workspace
host remains mounted. Queue guidance never invokes native operations. Missing
native readiness produces unknown counts for readiness-dependent queues. The
current native review-required blocker is recognized conservatively only when
it is the sole blocker; unknown/additional blockers remain verification work.

The Run inventory renders all persisted task evidence, including failed and
superseded Attempts. It is not complete archive discovery, indexed retention or
an artifact file-opening service. Current applicability is native task readiness,
never a React SHA/digest comparison. Existing verification, integration,
confirmation and human review/acceptance boundaries are unchanged. Authenticated
providers, packaged desktop and three-host integrated delivery still require
separate qualification records; see `docs/acceptance/task-driven-workbench.md`.
