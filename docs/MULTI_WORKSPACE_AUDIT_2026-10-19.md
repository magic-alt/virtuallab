# Architecture, workflow and multi-workspace audit — 2026-10-19

## Scope and revision

This audit starts at `main@5dc6ce8b872d225ed620418053adf5004edad1e7`
(VirtualLab 0.5.5) and is delivered on
`fix/multi-workspace-audit-20261019`. It includes the recently merged terminal
lease, Git ownership, worktree action and full-HEAD changes. The implementation
plan is [recorded separately](superpowers/plans/2026-10-19-multi-workspace-audit.md).

The scope is the current architecture and its concrete operator flows: multiple
repositories and linked worktrees, native ownership and cleanup, asynchronous UI
state, structured Agent events, Task dependency contracts, and native data
availability. No repository-specific connector, provider configuration,
arbitrary-shell interface, remote merge or release publication is introduced.

## Architecture assessment

The workspace-first boundary remains appropriate. React selects and presents
workspace state; typed adapters request native operations; Rust validates Git,
filesystem and process identities before mutation. A Task records fixed work
and evidence identities, while its worktree continues to own terminals, runs
and attached harnesses. An Agent completion event does not qualify a delivery.

The defects repaired here occur at transitions between these layers. A physical
target reserved by the lifecycle service must identify the same directory passed
to Git; its internal comparison key is not a command argument. A
retirement reservation must cover nested activity that deletion would affect.
A delayed response must retain the authority of its original request. A Task
consumer must retain per-repository failure information instead of interpreting
one failed query as absence of all tasks.

### Data and ownership contracts reviewed

| Boundary | Authority and result | Audit conclusion |
| --- | --- | --- |
| Repository/worktree inspection | Native Git derives full HEAD and registered worktree inventory; UI keys are presentation identifiers | Keep full commit IDs and native validation; repair directory target consistency and sibling metadata observation |
| Worktree creation/removal | Typed Git commands plus shared `WorkspaceLifecycle` reservations; destructive removal retains native confirmation | Relative targets resolve once; overlapping retirement blocks affected startup, writer, terminal and creation activity |
| Human terminal vs controlled writer | Separate counted PTY leases and controlled writer reservations | Preserve terminal coexistence with Run/branch operations while protecting removal; hiding the host retains sessions |
| GitHub reads and writes | `github_list_pull_requests` / `github_context` read through the selected local origin; native mutation revalidates exact PR/HEAD | Scope every asynchronous read by revision; keep existing native confirmation and mutation preconditions |
| Harness commands and `agent://event` | `HarnessAdapter` selects fixed native commands; events carry workspace, thread and turn identities | Track completion/stop independently of the transcript; retain CLI provisional-to-provider promotion and current-process exit identity |
| `task_list` and `task_readiness` | Native durable Task records and freshly derived readiness | Query registered roots independently, filter responses to their requested root, and display per-root errors |
| `task_events` and `task://event` | Durable sequence supplies structural history; live notifications trigger snapshot refresh | Failed-root recovery resets the query cursor; obsolete observation generations cannot restore detached records |
| Implementation candidate adoption | Accepted base, source scope, immutable prerequisite context and candidate identity | An implementation dependency is not an implicit merge requirement |
| Integration / verification / acceptance | Fixed prerequisite ancestry, independent source/tool evidence and revision-bound human decisions | Integration still requires all source commits; execution, verification and human acceptance remain separate |
| Durable and live state | Task generations are atomically persisted; live Agent/terminal activity is in memory | Do not infer live ownership from restart history; independent application-process writers remain unqualified |

## Reproduced defects and repairs

### 1. Nested workspace retirement

An exact-key lifecycle check allowed a parent worktree removal to overlap an
active nested workspace. Git removal affects a directory tree, so exclusive
writers, interactive terminals, task activity and pending creation below that
tree must block removal. The reverse order must also fail: after retirement
reserves a tree, overlapping work cannot start.

The lifecycle service now distinguishes creation and removal reservations and
checks the relevant ancestor/descendant relationships under its existing mutex.
An existing parent terminal can still coexist with creation of a nested worktree.
Unrelated siblings and other repositories remain independent. Lifecycle tests
cover both acquisition orders with real directory fixtures; the Git tests
separately exercise registered linked worktrees.

### 2. Relative worktree creation target

A custom relative path was reserved and created relative to the application
directory, while `git -C <repository> worktree add` interpreted it relative to
the selected repository. The creation flow now resolves the path against that
repository before reservation, then freezes the reservation's absolute target
for directory creation, Git arguments and the returned workspace path.
Ambiguous Windows drive/root-relative targets are rejected by the native path
contract.

### 3. Sibling branch changes were invisible to metadata observation

Switching an existing sibling worktree between already-existing branches can
modify only its private administration `HEAD`. Watching the common `worktrees`
directory nonrecursively missed that event. The shared worktree administration
directory is now watched recursively; shared Git objects are not added as a
recursive metadata watch. The regression uses actual Git branch switches and
the actual native notify registration helper.

### 4. GitHub request ownership across workspace transitions

A delayed manual context read could update the UI or saved PR reference after
switching A → B → A, changing the panel root, or removing the workspace. Initial,
manual and list reads now share a monotonic request revision that is invalidated
on replacement or disposal. Only the current read writes local/persisted state
or completes the current loading indicator. Tests also exercise intersecting
list/context requests so invalidation cannot leave a permanent spinner. A late
successful comment post updates its draft only while that draft and owner still
exist; it cannot recreate state after repository detach.

### 5. Agent turn lifecycle and native exit identity

Native events and invoke replies travel independently. Fast completion could
precede the start reply, and an older turn's completion could clear a newer turn.
The timeline now tracks exact thread/turn identities, bounded terminal-turn
history, stopped threads and session revisions independently of visible
transcript clearing. Replacing an active turn retires its old identity so a second
late start event cannot replace the newer turn. A stopped turn cannot be revived
by an old reply; explicit session resume remains usable.

The first Claude/OpenCode CLI turn starts with a provisional thread ID and learns
the provider ID through an explicit `agent.session_binding` event. This mapping
is part of the existing protocol and is retained while closing late-reply races.
Promotion requires the matching stored attachment; buffered provider output
cannot recreate a binding that the operator has explicitly forgotten.
The Codex exit monitor attaches a thread ID only if its observed process pointer
still matches the current runtime under the lifecycle lock; an old monitor does
not borrow a replacement session's identity.

### 6. Retained workspace visibility

The repository view stays mounted behind Tasks, Evidence, Settings and Home.
Its terminal host previously received only the selected workspace tab, so a
hidden retained terminal still appeared visible internally. Agent completion
notifications were likewise suppressed when an Agents tab was selected in a
hidden repository view.

Application visibility now reaches the retained terminal pane and the Agent
notification focus check. Navigation preserves the same terminal host/session
boundary, while only the actually visible source can suppress its notification.

### 7. Implementation dependency contract

Manual candidate adoption required every prerequisite commit to be an ancestor
of every Task candidate. This contradicted implementation Tasks that start at
the accepted base and consume dependencies as immutable read-only context.

The ancestor requirement now applies to integration Tasks. Implementation
candidates still pass accepted-base, scope and source checks. A real repository
with prerequisite, implementation and integration siblings proves that the
implementation can adopt its independent candidate without importing or changing
the prerequisite, an out-of-scope result still fails, and integration still fails
until the actual fixed source commits are incorporated.

### 8. Partial repository availability

One unavailable root caused the native multi-root query to reject and the UI to
clear every repository's Task list. The native command retains its strict
validation. The app-level store queries each registered root independently,
keeps only records belonging to that root, combines successful results, and
reports repository-specific failures. Healthy selection, detail tab and fresh
readiness remain usable. If every root fails, the overall source is unavailable.

Failed repositories' records/evidence are removed from the current view instead
of presented as current. Recovery resets the structural event cursor so their
history can return. Existing request generations also reject late results after
repository detach. Tests cover failure, recovery, selection and detached-root
races through the actual typed IPC wrapper boundary.

### 9. POSIX workspace key collision

On POSIX, `literal\child` and `literal/child` are distinct directory names;
`trailing\` and `trailing` can also be distinct. Unconditional backslash rewriting
and trimming collapsed their ownership/UI keys. Native identity now follows
the host platform; frontend keys detect actual Windows drive/UNC syntax before
normalizing separators. POSIX case and literal backslashes are preserved.

Tests create both actual directories and exercise persisted Agent binding
rehydration for old/current store versions. Bindings preserve their original
`workspaceRoot`, allowing correct rekeying without borrowing another workspace's
thread. No persistence version bump or unsafe legacy-key fallback is introduced.

### 10. Windows creation-path regression caught by the first CI matrix

The initial creation repair used `WorkspaceReservation::workspace_root()` as its
frozen target. That accessor is an ownership comparison key. On Windows the key
is case-folded and contains the verbatim filesystem prefix returned by
`canonicalize`. Git for Windows rejected that representation, causing four
native Git tests to fail in the first PR run even though Linux passed.

The follow-up preserves the existing comparison-key API and adds an internal
reservation result that returns the physical canonical target before case
folding, from the same locked resolution. The Git boundary converts only
recognized Windows drive/UNC representations to ordinary paths, preserving case,
spaces and Unicode. Components ending in a dot or space, and unsupported device
namespaces, are rejected when conversion could change the addressed directory.
Directory creation, Git's structured arguments and the returned workspace path
use the same physical target; the original cwd or symlink spelling is not resolved
again. POSIX paths bypass that conversion.

New tests cover drive/UNC representation, target case, ambiguous namespace
rejection, real POSIX backslash worktree creation/removal, and a symlink parent
that resolves to the reserved target. The existing real Git roundtrip now also
checks a mixed-case target containing spaces and Unicode. This is a separately
committed regression repair, not a skipped or weakened Windows test.

## Verification record

### Baseline

- Locked `npm ci --no-audit --no-fund` and TypeScript typecheck passed.
- Frontend baseline with subprocess execution enabled: **425 passed, 1 skipped**.
  The restricted sandbox's five failures were `spawnSync ... EPERM`; the exact
  same tests passed without changing product code or tests.
- The initial native dependency cache contained incomplete generated `web_atoms`
  output. Its unchanged build script produced complete output independently;
  only that dependency's generated cache was rebuilt.
- The pristine-main native run produced **353 passed, 6 failed, 1 ignored**.
  Four failures came from fixture paths under a temporary directory that was
  itself inside another Git worktree; all original lifecycle tests passed when
  fixtures used an independent temporary root. The remaining process timeout and
  ambient-Git-environment tests passed unchanged when repeated with a stable
  copied test executable and the independent fixture root. The final suite is
  run without concurrent relinking of that executable.

### Targeted regression evidence

| Group | Result after repair | Evidence type |
| --- | --- | --- |
| Native workspace lifecycle | 26 / 26 passed | Real directory/symlink fixtures and both reservation orders |
| Native Git operations | 53 / 53 passed | Real repository/worktree creation and path validation |
| Metadata and Task Git watches | 25 / 25 passed | Native notify events and actual sibling Git changes |
| Native Task runtime | 18 / 18 passed | Real independent/integration candidates and existing evidence checks |
| Task frontend contracts | 44 / 44 passed | Five store/UI files using typed native boundaries |
| Agent / GitHub / persisted state contracts | 81 / 81 passed | Seven frontend files, including all four independent-review follow-ups |
| Native Agent exit identity | 2 / 2 passed | Observed current process vs replaced/unregistered runtime |
| Retained host and notification flow | 22 / 22 passed | Real shell observation / retained terminal pane, three files |
| Native platform identity | 4 / 4 passed | Standalone module tests with actual POSIX directories/symlinks |
| Frontend identity and binding migration | 16 / 16 passed | Actual directories plus persisted store rehydration, three files |
| Version consistency | Passed, 0.5.5 | Package, Tauri, Cargo and lockfiles agree |
| Icon consistency | Passed | PNG/ICO/ICNS parity across 16–1024 px |
| Candidate artifact integrity | 3 / 3 passed | Missing/ambiguous provenance and corruption rejection |

The regression cases failed before their corresponding fixes. Group totals
overlap and must not be added to derive a suite total.

### Initial overall regression and independent review

The initial full local run used `2fabb7adbb37584ccc5753ae0f4882aae9bc38d7`.
The independent reviewer rechecked all four material follow-ups against the
production reducer/store and reported no unresolved Critical, Important or
Minor findings. The review applies to that published commit's tree.

- Linux `cargo check --locked --manifest-path src-tauri/Cargo.toml`: passed.
- Acceptance frontend suite: **472 passed, 1 skipped**, across 78 passing
  files and one platform-specific skipped file. The skip is the existing Windows
  Cargo-path recovery test on Linux. The baseline had 425 passing tests; this
  branch adds 47 passing frontend regressions without converting failures to skips.
- Full native suite: **375 passed, 0 failed, 1 ignored**, 376 tests, in 263.23 s.
  The ignored test is the existing build-recipe probe that requires an explicitly
  prepared workspace/script fixture. Default Linux acceptance does not run that
  opt-in qualification probe.
- Frontend production build: passed, Vite completed in 56.38 s.
- Complete `npm run acceptance:local`: **exit 0**, including toolchain doctor,
  typecheck, all frontend tests, production build and full native tests.
- Whitespace check: passed. The next commit, `71cc1e8`, added only the audit/plan
  record. The first remote CI run then exposed the Windows creation-path issue
  described below, which is repaired in a separate follow-up commit.

Local execution used Node 24.19.0, npm 11.9.0, Git 2.51.1 and Rust/Cargo 1.99.1
on Linux. Locked dependency installation, version/icon checks and artifact
integrity checks use the same unchanged package/Cargo lockfiles. The native
fixture root is outside another Git worktree, and no concurrent native build
relinked the executable during this full run.

PR [#86](https://github.com/magic-alt/virtuallab/pull/86) runs the existing
Node 22/26 and Linux/Windows/macOS matrix.
Its live checks at the final branch head are the authoritative remote CI record;
local Linux success is not copied into an unobserved platform status. See
[branch CI runs](https://github.com/magic-alt/virtuallab/actions?query=branch%3Afix%2Fmulti-workspace-audit-20261019).

### Windows CI follow-up and final-head verification

The first [PR CI run](https://github.com/magic-alt/virtuallab/actions/runs/39219563284)
tested `71cc1e8`. Both Node frontend jobs and Linux desktop acceptance passed.
macOS desktop acceptance passed before its application packaging step. Windows
reported **339 passed, 4 failed, 3 ignored** in the native suite. All four failures
traced to the creation target's `//?/` comparison-key representation: direct
roundtrip, repository-relative creation, external-worktree detach/re-import, and
the detach inventory-change fixture's attempted worktree creation.

The stage-six path regression first produced **1 passed, 2 failed**. After the
repair, the complete native Git group passed **57/57**, and lifecycle passed
**27/27** on Linux. Five tests were added and the existing roundtrip was
strengthened. The four failing Windows cases are retained and run again by the
final-head Windows job; their Linux execution alone is not Windows evidence.
Independent source review approved this narrow correction with no unresolved
finding. The UNC regression checks representation conversion; it does not claim
an actual network-share or SMB qualification.

The complete local acceptance workflow is repeated after this source correction,
and pushing the follow-up reruns the whole existing CI matrix. Exact final-head
results and the corresponding commit are recorded in
[PR #86](https://github.com/magic-alt/virtuallab/pull/86) and its checks. The
initial local totals above remain explicitly attached to their earlier source
revision rather than being relabeled as results for changed code.

The first local repetition passed all 472 frontend tests but its unchanged Vite
build exhausted Node's default heap at approximately 2 GiB. The repetition uses
`NODE_OPTIONS=--max-old-space-size=4096` as a validation-process setting; no
application, dependency or test was changed to address that resource limit.

## Qualification boundaries and remaining work

1. **One application process owns the durable Task store.** Clones of a native
   `TaskManager` share a mutex. Separately opened managers/processes retain
   independent snapshots and do not have a cross-process lock or an atomic
   compare-and-swap on the prior store generation. Multiple simultaneous app
   instances writing the same store are not qualified by this audit. A follow-up
   must establish a single-instance or cross-process transaction contract and
   test genuine concurrent writers before claiming that support.
2. **External processes remain external.** Lifecycle coordination is process
   local and does not lock out an independently launched Git command or editor.
   Source/evidence validation must continue to detect external changes.
3. **Legacy lossy keys cannot always recover an owner.** Session bindings and
   review states retain original workspace roots and can rekey. Role/skill
   selections saved only under collapsed keys, and metadata journals hashed from
   those keys, lack enough information to reconstruct the original POSIX owner.
   They are not automatically reassigned. Existing entries already overwritten
   by the old collision cannot be recreated from the remaining data.
4. **Automated fixtures are not authenticated provider qualification.** Native
   tests exercise real Git/filesystem/process behavior; UI tests control the IPC
   boundary. Actual multi-provider work, packaged WebView interaction, terminal
   retention under GUI navigation, and the complete two-implementation plus
   third-integration desktop scenario still require the host/provider checklist.
5. **Platform acceptance is recorded per host.** This workspace supplies Linux
   execution. Windows/macOS acceptance and packaging are checked through the
   existing CI matrix where available; signed installer, Finder/Dock launch,
   Windows UNC UI paths and real credential/provider flows are not inferred from
   Linux success.

The branch is submitted for review. Passing automated checks does not close
broader Roadmap or release-qualification items without their required evidence.
