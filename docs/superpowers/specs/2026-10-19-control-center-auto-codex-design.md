# Control center: prompt to execution report

## User outcome

Submitting a concrete task in the control center creates its isolated worktree,
starts Codex with the task text, follows the real execution, and presents the
result and discovered problems. The task list belongs to the control center;
the former Evidence navigation is called Report. This document implements the
user's explicit request to finish that workflow.

## Design

The default screen has an inline repository selector and task prompt. A single
**开始任务** action accepts a single implementation task, prepares a unique task
worktree at the inspected HEAD, and queues the existing supervised Codex
app-server process. Scope, executable override, verification profile, and local
commit permission remain optional. Existing multi-task/template workflows remain
available as advanced tools.

Native code owns acceptance, request deduplication, worktree creation, queueing,
process ownership, cancellation, and report persistence. The UI opens an execution
console for that same Codex process. It does not start a second writer or inject
task text into a shell. Structured Codex assistant/command/file events supply the
console; an exact workspace/thread/turn completion determines execution outcome.

The quick-launch request carries a stable request ID. Repeating a request after a
lost reply returns the already created task. Partial setup failures retain their
task and worktree for inspection; they do not delete work or silently replay an
uncertain Git operation. Submission rechecks the current repository and HEAD.

Execution success, independent verification, and human acceptance remain separate
facts. Without a verification profile, successful Codex work is an unverified
completed execution. With automatic local commit disabled, changed files remain
in the worktree and successful implementation is not relabeled as failed merely
because no candidate commit was created.

## Report contract

`task_launch({request:{requestId,plan,executablePath}})` returns
`{task,launchError}`. Failures after acceptance return the retained task and the
concrete launch error. Command rejection is structured as
`{requestId,acceptance:'rejected'|'unknown',message}`. A definitive rejection
durably closes that request ID under the acceptance lock before returning;
previously queued commands cannot subsequently accept it, including after restart.
The UI refreshes the baseline and releases only that matching rejected token.
Transport, worker and persistence uncertainty keep the original frozen request.
Closed IDs are bounded and never evicted to make room for later failures.

`task_launch_error({taskId})` reads the durable setup failure even if no Attempt
was created. It enables explicit recovery without inventing execution history.
Native retained preparation intents remain the authority for preventing replay;
a historical error alone cannot disable valid explicit workspace creation.

`task_attempt_report({request:{taskId,attemptId}})` returns a bounded persisted
attempt report or null for an attempt with no recorded report. A report contains
the final assistant response, ordered execution entries, provider/native problems,
actual attempt status, update time, and truncation flag. It is stored separately
from task list metadata. `task://report` events invalidate one task/attempt snapshot.
No model response can grant verification or acceptance.

The persisted report is capped at 512 KiB, with a 64 KiB final response, 128 KiB
of log text (200 entries, 16 KiB each), and 32 KiB of problem text (32 problems,
4 KiB each). Limits preserve UTF-8 boundaries and include room for JSON escaping.

The report view includes unprofiled tasks and startup/execution failures. It keeps
the implementation response accessible when a later verification creates another
attempt. Existing verification artifacts and identity bindings remain available.

## Navigation and monitoring

Primary navigation is Control Center, Repositories, Report, Settings. Internal
`evidence`/`证据` route keys remain compatible; visible labels become 报告.
The control center combines the prompt, task list, selected execution, and results;
advanced templates and status inventories are secondary.

The shell's observer runs independently of page visibility. Completion can select
the report only while the user follows the same attempt on its Execution tab.
Background completion must not switch the active task, workspace, or explicitly
selected review tab. A delayed launch response also respects explicit task/tab
navigation after submission while retaining the accepted task in the list.
Report subscriptions catch up after listener registration,
ignore foreign bindings and stale requests, and clean up when scope changes.

## Validation

Regression cases cover one-click launch and stable replay tokens; changed HEAD,
duplicate submits, removal/navigation during launch; successful unprofiled and
uncommitted execution; exact report bindings and rapid completion; failures,
cancellation, UTF-8 output bounds, legacy report absence, and multi-workspace UI
continuity. Run frontend typecheck/tests/build, locked Rust check/tests and the
local acceptance runner. The PR's Windows/macOS/Linux jobs provide platform gates;
real installed Codex authentication and interactive desktop behavior require the
corresponding desktop environment and must not be represented as simulated proof.
