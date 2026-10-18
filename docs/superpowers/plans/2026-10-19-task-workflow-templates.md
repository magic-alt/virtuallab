# Task Workflow Templates Implementation Plan

**Goal:** Add Superpowers-inspired reusable workflows and a real-Agent example to Task-driven Workbench without changing engineering repository features.

**Architecture:** Versioned template/skill catalog materializes the existing TaskDraft. An explicit launch coordinator calls the existing Native plan/workspace/start API. A read-only stage projection uses current Native records. No new execution permissions, scheduler or storage schema.

**Tech Stack:** Existing React, TypeScript, typed Tauri wrappers and Native task pipeline; Node.js built-in modules for the example.

**Spec:** `docs/TASK_WORKFLOW_TEMPLATES.md`

## Global Constraints

- Repository/Git/terminal/Changes/Provider implementation and Rust source remain unchanged.
- No fake Agent or test success; model-driven steps are instructions, not observed stage events.
- Opening/previewing never writes or starts execution. Worktree execution and local sealing require explicit consent.
- Never silently replay uncertain writes; preserve created task identity for recovery.
- Preserve Native's ban on inline JavaScript and shell/interpreter argv.

## Review Focus

- Stale baseline after repository selection changes.
- Duplicate clicks, removed repositories and unmounted dialogs between writes.
- Failed preparation/start must not produce duplicate tasks or a simulated success.
- Historical evidence and unbound acceptance never advance current delivery.
- Template Profile must satisfy existing field/argv budgets and not weaken permissions.

## Tasks

- [x] Add versioned method catalog, three templates and a bounded unique demo scope.
- [x] Add explicit launch coordination and conservative stage projection.
- [x] Add template gallery, consent-driven dialog and task stage navigation; keep manual tools.
- [x] Add focused executable contract checks and Vitest integration/interaction tests.
- [x] Document use, architecture, limitations and failure recovery.
- [ ] Run complete project CI and real authenticated desktop Agent acceptance before release qualification.

## Recorded Decisions

Native validation rejects `node --eval`; keep that boundary. The case uses an `acceptance.mjs` file whose reference is in the accepted task goal. The file remains editable and requires human comparison: it is not an immutable executable gate.

The implementation environment had connector source access and local Node/TypeScript, but no network dependency install or Rust toolchain. Focused core checks are executable locally. Do not label them a full React build, Native acceptance or successful real AI run. Use repository CI and an authenticated desktop session for those claims.
