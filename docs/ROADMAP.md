# Roadmap

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
- [ ] lock dependency graph after first green build
- [ ] Windows/macOS/Linux smoke test

## V0.2 — Workspace execution

- embedded xterm.js PTY
- process supervisor and streamed output
- create/remove Git worktrees
- workspace state machine
- configurable build/test commands
- filesystem watcher
- structured check results

## V0.3 — Review and GitHub

- Monaco diff viewer
- inline review comments
- GitHub PR metadata/checks
- `gh` adapter or GitHub API adapter
- issue → workspace flow
- review → fix → re-review loop

## V0.4 — Verification control plane

- reusable verification profiles
- build/unit/HIL/hardware/soak/evidence gates
- evidence artifact registry
- release readiness summary
- explicit human approval gates for hardware-affecting operations

## V0.5 — Agent harnesses

- common agent adapter protocol
- Claude Code
- Codex
- OpenCode
- session resume/interrupt
- normalized event stream
- agent-per-workspace isolation

## Non-goals for the first releases

- cloud execution
- team collaboration backend
- custom LLM agent loop
- replacing IDEs
- automatic destructive Git or hardware operations
