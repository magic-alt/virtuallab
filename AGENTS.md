# Agent development guide

VirtualLab is a local Engineering Workbench. Preserve the workspace-first architecture.

## Rules

- Keep React UI in `src/`; native OS/process/Git access belongs in `src-tauri/`.
- Frontend code must call typed wrapper functions in `src/lib/` rather than invoking arbitrary native commands throughout components.
- Prefer feature folders over a global components dump.
- Keep Git/process arguments structured; do not add `cmd /c`, `powershell -Command`, `sh -c` or equivalent arbitrary-shell execution without a reviewed security design.
- Read-only inspection is the default capability.
- Any destructive Git, release, firmware flashing, motor enable or power-stage action requires an explicit human confirmation gate.
- Do not make an agent session the owner of repository state. Agents attach to workspaces.
- New long-running features should emit structured events rather than scrape terminal text in UI code.
- Keep Windows paths, spaces and Unicode paths in mind.
- Update `docs/ARCHITECTURE.md` when a boundary or domain model changes.

## Pull request quality bar

At minimum:

- frontend typecheck
- frontend production build
- Rust `cargo check`
- no new arbitrary-shell execution path
- docs updated for architectural changes
