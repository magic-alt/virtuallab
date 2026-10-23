# Codex-assisted Git review

Status: approved by the user on 2026-10-23; inline implementation authorized.

## Intent

Replace the fixed Clean merged workflow with a user-triggered Codex analysis that explains which branches may be retired and lets the user select exact deletion targets. Review the other repository Git actions for consistent destination, concurrency, confirmation and stale-state handling.

## Approaches

1. Recommended: a native supervised Codex analysis process, structured progress and a selectable report. The backend supplies bounded Git evidence; the model returns recommendations bound to that evidence. A terminal-style activity view exposes progress without parsing terminal escape sequences as application data.
2. An interactive Codex terminal: useful for manual investigation, but requires the user to interpret results and does not reliably produce a validated selection list.

Approach 1 was approved. The details below record its implementation constraints.

## Analysis and selection

- Start inspection in the selected repository without switching branches, stashing, fetching or deleting anything.
- Resolve the comparison/default branch from repository metadata rather than requiring `main`. Fail clearly when it cannot be established.
- Inventory local and remote branches separately, commit identities, ancestry, upstreams and registered worktree state. Label missing objects and unavailable remote evidence as unknown. Ancestry alone cannot establish squash/rebase integration; preserve uncertain branches and explain the limitation.
- Launch the user's configured Codex executable through a reviewed native process adapter with structured arguments. Supply only bounded, sanitized evidence. Exclude environment values, credentials, `.env` contents, file contents and credential-bearing remote URLs.
- Prefer analysis without model command execution or repository file access: the native evidence collector owns Git inspection. Model output is untrusted data and cannot authorize operations.
- Emit operation-scoped structured events for collecting, analyzing, completed, failed and cancelled states. Expose progress and conclusions in an in-app terminal-style panel. Enforce process timeout, cancellation and cleanup.
- Show recommendation, evidence, risk and keep reason per branch. Provide separate local, remote and worktree selections; leave remote/worktree deletion unselected by default. Protected or unknown targets remain disabled.
- Codex failure never silently executes the old cleanup. Offer an explicitly chosen deterministic preview as a fallback.

## Execution boundary

The existing native Git adapter remains the only deletion executor. Validate the user's selection as a subset of the inspected inventory; reject duplicate, forged and stale targets. Bind approval to repository identity, destination, base and target SHAs and worktree state. A fresh native confirmation lists the exact selected actions and their consequences. Revalidate immediately before each action, use atomic reference checks and explicit remote leases, and report partial outcomes without automatic force retries.

Active/default/primary, dirty/ignored/locked and task-owned worktrees remain protected. Codex recommendations never override these checks. Repository refresh or selection changes invalidate actionable reports; late events cannot replace another repository's view.

## Git operation audit and proposed changes

| Operation | Current evidence | Proposed work |
| --- | --- | --- |
| Clean merged | UI switches to literal `main`; native preview requires it; all targets share one confirmation | Replace with analysis, independent selection and snapshot-bound execution |
| Local branch deletion | Native dialog; separate force dialog and SHA-bound force transaction; ordinary deletion follows upstream semantics | Explain comparison target and distinguish pushed from integrated; bind ordinary approval to inspected identity |
| Remote branch deletion | Default branch check and push lease exist; inspection uses fetch origin and deletion uses push origin; tracking cleanup is unconditional | Verify identical approved fetch/push destination; bind preview/confirmation to exact remote SHA; compare-and-delete tracking ref |
| Pull | Uses `pull --ff-only origin <current-name>` regardless of configured upstream | Resolve and display configured upstream; reject missing/ambiguous targets; preserve ff-only and dirty-state safeguards |
| Fetch | Explicit origin fetch with prune; serialized lifecycle reservation | Make pruning and destination clear; verify stale UI and failure outcomes |
| Switch | Registered workspace validation; protects tracked edits and ignored collisions; remote tracking creation | Keep safeguards; audit stale selection and branch identity throughout stash/switch |
| Worktree creation/removal | Typed commands, reservations, primary/locked protections and separate force removal confirmation | Retain protections; cover Unicode/spaces, missing registrations and task/terminal ownership |
| Stash/restore/untracked deletion | Native confirmations, status/HEAD checks and scoped pathspecs | Audit state changes across dialogs and preserve unrelated/ignored files |
| Review/task integration | Separate GitHub and task domains | Inspect exposed mutations and confirmation/stale-head guards before deciding additional changes; do not broaden authority implicitly |

## Scope and validation

Keep UI in feature folders, typed wrappers in `src/lib`, and process/Git authority in `src-tauri`. Update `docs/ARCHITECTURE.md` for the analysis/report boundary. Do not add arbitrary-shell APIs, project-specific connectors, automatic force deletion, implicit remote checkout or automatic merging.

Add focused tests for evidence privacy, malformed model output, selections, cancellation, changed repository/destination/SHA, protected targets and partial failures. Run locked dependency installation, frontend typecheck/build and relevant tests. Run the local acceptance runner and document the host actually exercised; Linux Rust checks and macOS/Linux interactive acceptance require corresponding available environments and must not be claimed from Windows output.
