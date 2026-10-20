# VirtualLab

VirtualLab is a local desktop engineering workbench for managing Git repositories, isolated workspaces, terminals, build and test processes, and code review. Optional coding agents attach to the selected workspace alongside these tools.

The workspace is the unit of work: it owns the Git branch or worktree, execution context, review state, and agent bindings. Repositories and build tools are selected by the user; VirtualLab does not require a particular application project, device, or hardware lab.

## Features

- **Unified Agents Hub** — one place for isolated Codex tasks, durable execution reports and existing-workspace agent sessions. Repository tabs stay focused on Overview, Changes, GitHub, Terminal and Run. Task-owned agents are controlled through their Task; saved sessions retain provider, role, skill and recovery controls.
- **Prompt-to-report control center** — describe a task and choose **开始任务** to create an isolated worktree, start the installed Codex, follow its live output, and read the persisted result and problems. Task lists are part of the control center; **报告** includes execution results even without a verification Profile. Failed setup preserves the task for recovery, and repeated launch requests do not create duplicate worktrees.
- **Repository and workspace management** — inspect local Git repositories and create isolated worktrees with explicit branch and base selections. Removing a dirty worktree requires a second native **Force remove** confirmation; cancellation and stale status previews never force-delete local files.
- **Open a whole worktree in an external IDE** — launch the currently selected project, any repository, or a checked-out branch/worktree directly in Zed, VS Code or Cursor. Auto-detect respects supported VISUAL/EDITOR settings and common installations; projects open in separate windows without switching or modifying Git branches.
- **Changes and review** — inspect worktree, staged, and base-reference changes in a read-only Monaco diff viewer; preview untracked text files and expand untracked directories without staging; save local line comments and track review state.
- **Terminals and project workflows** — use workspace terminals, auto-detected npm/Keil/CMake/Qt one-click builds, editable repository-scoped multi-step Build/Test/Package/Deploy profiles, and streamed output with Run/Stop controls. Deploy is manual and confirmation-gated.
- **Non-blocking agent task notifications** — launch an interactive Codex CLI with per-launch OSC 9 completion/attention signals, receive native desktop toasts when working elsewhere, and return through an in-app notification inbox to the originating worktree and terminal. Structured Agents turn-completion events use the same inbox; ordinary terminal bells never imply success.
- **GitHub PR and CI dashboard** — browse open pull requests from any workspace, inspect all GitHub CI checks and failed jobs, review merge readiness, and explicitly confirm a SHA-pinned remote merge (Squash/Merge/Rebase). Existing issue context and review drafts remain supported.
- **Agent workspace** — connect optional Codex, DeepSeek-through-Codex, Claude Code, or OpenCode adapters, with workspace-specific session bindings, custom roles, opt-in skills, and a live event timeline.
- **Verification infrastructure** — run supported process gates and record workspace-local evidence with Git revision metadata and SHA-256 artifact hashes.
- **Offline illustrated Guide** — open **Help → 使用文档** from the application menu bar (not a workspace tab), search Chinese how-to articles, see bundled diagrams, follow end-to-end npm/Qt/Keil/GitHub examples, and copy commands without a web connection or repository.

Local repository inspection and review work without GitHub authentication or an agent provider. GitHub and agent features require their respective CLI tools, configuration, and credentials. The general agent timeline is session-local; control-center tasks additionally retain bounded execution reports in local application data. Hardware execution is not available through a bundled provider.

## Requirements

- Node.js **22.12 or newer**, with npm.
- Rust stable, including Cargo.
- Git available on `PATH`.
- Native build prerequisites for your platform:

| Platform | Prerequisites |
| --- | --- |
| Windows | Visual Studio Build Tools with **Desktop development with C++**, Windows SDK, and WebView2 |
| macOS | Xcode Command Line Tools |
| Linux | WebKitGTK 4.1 development libraries and the native packages listed in the [Linux CI setup](.github/workflows/ci.yml) |

Optional integrations require an installed and configured provider CLI. GitHub features use the existing `gh` authentication session. See the [agent harness guide](docs/V0.5_AGENT_HARNESSES.md) for agent setup and provider limitations.

**macOS + GitHub HTTPS origin:** VirtualLab runs Fetch/Pull/Delete origin as background Git operations. To prevent repeated `git-credential-osxkeychain` dialogs from a packaged .app, these operations use the existing `gh auth git-credential` session when `gh` is installed; missing credentials fail with actionable errors instead of opening a hidden prompt. Install GitHub CLI (`brew install gh`), then run `gh auth login --hostname github.com --git-protocol https` and verify `gh auth status -h github.com` in Terminal. Authorize an account with write access before deleting a shared branch. SSH and non-GitHub origins retain normal Git authentication. VirtualLab never saves a GitHub token or rewrites your global Git credential configuration.

## Quick start

Clone the repository and install the locked dependencies:

```bash
git clone https://github.com/magic-alt/virtuallab.git
cd virtuallab
npm ci
npm run doctor
```

Start the desktop application in development mode:

```bash
npm run tauri:dev
```

For a frontend preview:

```bash
npm run dev
```

The preview uses representative data. Native folder selection, Git operations, terminals, and process execution require the desktop application.

## Using VirtualLab

**New to VirtualLab?** Choose **Help → 使用文档** from the app menu bar. The in-app help center works before any repository is imported and includes searchable workflow tutorials, local diagrams and executable examples. The companion [Chinese user guide](docs/USER_GUIDE.md) is also available on GitHub.

For automatic task execution, add a local repository, return to **Agents Hub → Agent 任务**, enter
the work in **工作任务**, and choose **开始任务**. VirtualLab prepares the task worktree
at the displayed HEAD and launches Codex with your goal. The execution panel follows
the same supervised process and opens the report when the task finishes. Without
local auto-commit, edits remain in the task worktree; without a verification Profile,
execution completion is explicitly unverified. See the [control center guide](docs/TASK_FIRST_CONTROL_CENTER.md)
for optional verification, report history, recovery, and manual review.

Direct workspace tools remain available:

1. Select **Add Repository** and choose a local Git repository.
2. Open an existing workspace or create an isolated worktree with **New Workspace**.
3. Use **Changes**, **History**, and **Overview** to inspect the selected workspace. Worktree lists unstaged and untracked entries; Staged shows index changes; Base compares committed changes against a selected ref. Untracked text files are previewed as new additions without staging. Expand an untracked folder to inspect its files; Staged and Base continue to show only their respective Git changes.
4. Use **Terminal** for interactive work (choose **Start Codex with alerts** for long-running Codex turns and OS notifications). In **Run**, choose an automatically detected one-click build/package recipe or save an editable multi-step Build/Test/Package/Deploy profile. Steps run sequentially in the selected worktree; Deploy requires explicit confirmation every time. See [Project Build Workflows](docs/PROJECT_BUILD_WORKFLOWS.md).
5. Use **GitHub** to select an open PR, inspect failing/pending CI jobs, and confirm a merge once GitHub reports `CLEAN`; see [PR and CI workflow](docs/GITHUB_PR_CI_MERGE.md). Use **Agents Hub → 工作区会话** to manage an existing worktree session and its optional provider.

For code review, select a changed file (tracked or untracked text) and choose unified or side-by-side layout. Line comments are saved locally. After editing, use **Refresh and re-review**, reload the diff, and inspect the updated content before marking it reviewed. Posting a local draft to GitHub is a separate confirmed action and requires the local revision to match the pull request head.

## Application version

The current application version comes from `package.json`; Tauri, Cargo, and both lockfiles must match. It is distinct from roadmap feature milestones and does not imply a published GitHub Release. After successful main CI, automatic assessment maintains a draft version PR from merged changes and explicit roadmap qualification. Run `npm run version:assess` for a read-only preview and `npm run version:check` for consistency. Manual overrides remain available through `npm run version:set -- X.Y.Z`. See the [versioning and release policy](docs/VERSIONING.md) for setup, review, tags and packaged About metadata.

## Build and install

Run the automated acceptance checks, then build a standalone release application:

```bash
npm run acceptance:local
npm run tauri:build
```

Native binaries are written to `src-tauri/target/release/`, and platform bundles or installers are written to `src-tauri/target/release/bundle/`.

On macOS, the application bundle is `src-tauri/target/release/bundle/macos/VirtualLab.app`. Quit an existing instance before replacing `/Applications/VirtualLab.app`. On Windows and Linux, use the installer or package generated for the target platform.

For a standalone debug build with embedded frontend assets:

```bash
npm run tauri:build:debug
```

Debug outputs use `src-tauri/target/debug/`. An executable produced by `tauri:dev` depends on the development server and should not be used as a standalone installation.

See the [local build guide](docs/LOCAL_BUILD.md) for platform setup, output locations, and troubleshooting.

## Development

The frontend uses React, TypeScript, Vite, Tailwind CSS, Zustand, xterm.js, and Monaco. Tauri and Rust provide native Git, filesystem, terminal, and process services.

```text
src/           React features, stores, types, and typed backend wrappers
src-tauri/     Native desktop host and Git/process services
scripts/       Build, environment, icon, and acceptance tooling
docs/          Architecture, setup, integration, and acceptance guides
```

Useful checks:

```bash
npm run typecheck
npm test
npm run build
npm run icons:check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

`npm run acceptance:local` runs the toolchain preflight, frontend typecheck, frontend tests, production frontend build, and Rust tests. CI runs frontend checks and desktop acceptance on Windows, macOS, and Linux. External authentication, provider behavior, and interactive desktop controls also require manual acceptance.

Keep React features in `src/` and native OS, process, and Git access in `src-tauri/`. Frontend components use typed wrappers in `src/lib/`; native process requests use executable and argument vectors. Use `npm ci` and Cargo `--locked` checks to preserve the committed dependency graph. Update architecture documentation when changing a boundary or domain model, and add regression coverage for behavior changes.

Read [AGENTS.md](AGENTS.md) and the [architecture guide](docs/ARCHITECTURE.md) before contributing. Project plans belong in the [roadmap](docs/ROADMAP.md); the README describes the project and how to use it.

## Execution and safety

Repository inspection is read-only by default. Workspace creation, process execution, and network mutations are explicit user actions. Build scripts and external agent tools execute on the local machine; provider permission modes are not an operating-system sandbox.

Verification evidence is stored under `<workspace>/.virtuallab/evidence/`. HIL, hardware, and soak gates remain blocked without independent enforcement. Software approval records do not authorize physical actions, and process cancellation is not an emergency stop.

## Documentation

| Guide | Contents |
| --- | --- |
| [Illustrated user guide / 图文使用指南](docs/USER_GUIDE.md) | Third-party onboarding, in-app Help menu navigation, workflow diagrams, practical npm/Qt/Keil examples, GitHub review and troubleshooting |
| [Local build](docs/LOCAL_BUILD.md) | Platform setup, development modes, packaging, and troubleshooting |
| [Project build workflows](docs/PROJECT_BUILD_WORKFLOWS.md) | npm, Keil and Qt/CMake presets, multi-step builds, deployment scope and acceptance |
| [Architecture](docs/ARCHITECTURE.md) | Workspace model, native boundaries, events, and execution contracts |
| [Product audit (2026-10-14)](docs/PRODUCT_AUDIT_2026-10-14.md) | Current multi-workspace code audit, verified gaps, V0.6 safety/journal slice and next Agent Supervisor milestones |
| [Review and GitHub](docs/V0.3_REVIEW_GITHUB.md) | Diff modes, local drafts, and GitHub integration |
| [GitHub PR and CI workflow](docs/GITHUB_PR_CI_MERGE.md) | Open PR list, check/job status interpretation, merge qualification and safety |
| [Agent harnesses](docs/V0.5_AGENT_HARNESSES.md) | Provider setup, session behavior, and integration limits |
| [Verification and hardware policy](docs/V0.4_VERIFICATION_HARDWARE_POLICY.md) | Process gates, evidence storage, and hardware restrictions |
| [Control acceptance](docs/CONTROL_ACCEPTANCE.md) | Automated coverage and manual desktop checks |
| [Roadmap](docs/ROADMAP.md) | Planned capabilities and project direction |
| [Versioning](docs/VERSIONING.md) | Version bump procedure, release tags, and About metadata |


### Release Candidate qualification

Unsigned, checksummed Windows/macOS/Linux **QA-only** bundles are produced by [Release Candidate Bundles](.github/workflows/release-candidate.yml) on the `release/*` PR. Review [the release qualification checklist](docs/RELEASE_CANDIDATE_CHECKLIST.md) before any tag or public GitHub Release. A green CI is not proof of interactive GUI, authenticated-provider or installation acceptance.
