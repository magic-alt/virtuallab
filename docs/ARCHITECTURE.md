# VirtualLab architecture

VirtualLab is a **local-first Engineering Workbench / Engineering Control Plane**. The durable abstraction is the workspace, not an AI chat session.

## Architecture principles

1. **Workspace owns execution context.** Repository, branch/worktree, terminal, checks, diff and future agent sessions all hang from one workspace.
2. **AI is an adapter, not the product core.** Codex, DeepSeek-through-Codex, Claude Code, and OpenCode are optional harnesses attached to a worktree.
3. **Native operations stay behind a narrow Rust boundary.** The frontend requests typed commands; Rust performs filesystem/process/Git operations.
4. **Typed native operations.** Interactive PTYs are human-controlled; Git/GitHub/verification services use narrowly defined Tauri commands, not arbitrary agent-supplied shell strings.
5. **Hardware-changing actions require explicit human approval.** Flashing, drive enable, power-stage enable, destructive Git operations and merge actions will be gated.
6. **Local-first and offline-capable.** Git inspection and workspace inventory must work without cloud services.

## Application-level documentation

Bundled Help/Guide content is an application service, not a workspace tab or
execution context. The GUI menu bar offers **Help → 使用文档** even without an
active repository; it opens an overlay reader without changing the selected
repository, worktree, tab, or persisted workspace state. A legacy persisted
`guide` tab is normalized to `overview` while preserving its worktree path.

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

Implemented: xterm.js/PTy, structured `workbench://event`, Monaco read-only diff, optional `gh` PR/issue context, Agent workspace UI and four harness transports. Durable cross-run event history is still planned.

## Native stack

- Tauri 2
- Rust 2021
- Tauri dialog plugin
- Git CLI through `std::process::Command`
- portable-pty for PowerShell/bash sessions
- notify for workspace change observation

Git is intentionally CLI-backed at first. It matches developer machines, supports worktree semantics well and avoids prematurely coupling the product to libgit2 behavior.

## Domain model

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
- **Process profile:** structured executable + argument vector + working directory. Intended for repeatable build/test/check commands; it does not accept a shell command string.
- **Worktree mutation:** branch validation plus clean-only worktree removal. Primary worktree removal is refused.
- **Filesystem watcher:** emits debounced UI refresh signals while ignoring generated-heavy directories such as `.git`, `node_modules`, `target` and `dist`.

On Windows, `.cmd`/`.bat` process profiles are routed through `cmd.exe /d /s /c` only after the program and its arguments have already been separated by the profile model. Arbitrary command strings are not exposed as an agent API.


## Project build workflow boundary

The **Run** panel augments V0.2 profiles with worktree-local, read-only detection of package.json scripts, CMakeLists.txt (including Qt) and bounded Keil MDK *.uvprojx files. Detected recipes can be run directly or saved as editable repository-scoped profiles. A profile can contain multiple ordered `BuildStep { name, program, args[] }` entries. Persisted V0.2 single-command Build/Test profiles remain valid.

One-step recipes retain the existing `process_spawn` route. Multi-step recipes invoke `build_workflow_start` in `src-tauri/src/build_workflows.rs`: one canonical working directory, independently spawned executable/argv vectors, output events on `build://event`, stop-on-first-failure, and a cancellable process tree/group. The frontend receives a final pass/fail/stopped status; exit code 0 alone is not a signed verification gate. Windows invocations reuse the background process adapter to avoid transient console windows.

**Packaging is not deployment:** inferred Tauri package recipes build files but do not install/publish. Deployment is a *manually authored* profile and requires a Tauri-native confirmation every time. Because user scripts and executables can perform arbitrary writes, confirmation is only an explicit interaction gate, not a sandbox or hardware authority. Build suggestions do not trigger SDK installation, firmware flashing, motion, power or publication. No other repository is referenced by this feature.

The workflow UI output ring and process lifetime are ephemeral; worktree/profile settings are persisted locally, not in Git. Restart reconciliation, durable run/evidence history and full process-tree cleanup remain separate V0.6–V0.8 acceptance items. See [project build workflows](PROJECT_BUILD_WORKFLOWS.md).

## V0.2 persisted workspace context

The local Zustand store persists one workspace context per repository: active worktree path, active tab and update timestamp. Repository switching restores that context. If a remembered worktree no longer exists, VirtualLab falls back to the primary repository and Overview. Runtime PTY/process objects are deliberately not persisted.

## V0.2 normalized checks

Repository readiness and process outcomes share a typed `CheckResult` contract with stable ID, source, status, detail, observation time and optional exit code. V0.2 uses this for local readiness semantics; V0.4 now persists per-run manifests, hashes, and logs; history search and enforceable release gates are future work.

## V0.3 review boundary

V0.3 starts read-oriented: Git diff retrieval and GitHub PR/check metadata are read-only adapters. Inline review drafts may be edited locally before network mutation. Posting comments, changing PR state and merge/release remain explicit user actions.

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

Dangerous frontend actions use the typed `confirmNativeAction` gate. An unavailable or cancelled native dialog fails closed. GitHub actions recheck the current workspace/PR/HEAD and draft after the asynchronous dialog; native merge/comment preflight remains authoritative. No remote merge, deletion or comment is performed by release automation.

Production CSP restricts scripts to local assets and connections to local IPC, with local/blob workers and inline styles for Monaco. Development alone adds Vite loopback HTTP/WebSocket origins. No remote editor CDN or `unsafe-eval` is enabled. Real WebView acceptance remains required on Windows/macOS/Linux. Agent timeline payloads are bounded to 16 KiB per event in addition to the existing 300-event workspace limit; full transcripts are not persisted.
