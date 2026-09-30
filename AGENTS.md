# Agent development guide

VirtualLab is a local Engineering Workbench. Preserve the workspace-first architecture.

## Rules

- Keep React UI in `src/`; native OS/process/Git access belongs in `src-tauri/`.
- Frontend code must call typed wrapper functions in `src/lib/` rather than invoking arbitrary native commands throughout components.
- Prefer feature folders over a global components dump.
- Keep Git/process arguments structured. Platform compatibility wrappers such as `cmd.exe /d /s /c <resolved .cmd>` may exist only inside reviewed native adapters around an explicit executable + argument vector; never expose an arbitrary shell command string as an agent/native API.
- Read-only inspection is the default capability. Reversible workspace operations (for example validated worktree creation) must use narrow typed commands.
- Any destructive Git, release, firmware flashing, motor enable or power-stage action requires an explicit human confirmation gate.
- Do not make an agent session the owner of repository state. Agents attach to workspaces.
- New long-running features should emit structured events rather than scrape terminal text in UI code.
- Keep Windows paths, spaces and Unicode paths in mind.
- Update `docs/ARCHITECTURE.md` when a boundary or domain model changes.

## Pull request quality bar

At minimum:

- frontend typecheck
- frontend production build
- locked dependency installation
- Rust `cargo check --locked` on Linux
- Windows/macOS/Linux local acceptance runner
- no new arbitrary-shell execution path
- docs updated for architectural changes
