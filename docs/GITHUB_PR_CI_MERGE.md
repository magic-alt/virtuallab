# GitHub PR and CI workflow

VirtualLab's **GitHub** workspace tab can browse open pull requests for the selected repository, inspect CI check results, and merge a verified PR after an explicit human confirmation. The integration is generic: it always uses the selected workspace's Git `origin`, never a hard-coded project.

## Prerequisites

1. Install the GitHub CLI (`gh`) and authenticate it with `gh auth login`.
2. Confirm `git remote get-url origin` resolves to the intended `github.com/owner/repo` repository.
3. Open the **native Tauri desktop** application (frontend preview cannot run local GitHub operations).
4. Ensure the GitHub user has permission to merge and the repository permits the selected merge method.

VirtualLab uses the existing `gh` session. It never asks for, displays, or persists a GitHub token.

## Inspect an existing pull request

1. Select a repository and workspace, then open **GitHub**.
2. Under **Open pull requests**, select a PR even when the local worktree is on `main` or an unrelated branch. **Refresh** reloads the open list and the selected PR.
3. Alternatively, enter `pr:77`, `#77`, a full PR URL, or an issue reference and select **Load**. A blank reference tries the current Git branch; if there is no corresponding PR, select from the list rather than requiring a local checkout.
4. Read the full **PR CI checks** list. Failed checks appear first. Each check with a usable URL links to the detailed GitHub Actions/job page. `total=0` is **CI unknown**, not green.
5. Review the displayed merge status, review decision and changed files. A local worktree HEAD mismatch affects inline review posting, not remote PR inspection.

### CI status and merge controls

- **Pass:** `SUCCESS`
- **Pending:** in progress, queued, waiting, unknown/incomplete result
- **Fail:** failure, error, timed out, cancelled, action required, stale
- **Neutral:** skipped or neutral (does not count as a successful CI check)

A PR is eligible for a manual merge only when **all** of these conditions hold:

- Open and not a draft.
- At least one successful reported check; no failed or pending checks. Skipped/neutral results may coexist with successes.
- GitHub reports `mergeable=MERGEABLE` and `mergeStateStatus=CLEAN`.
- The review decision is approved or not required.
- The PR remains at the exact inspected 40-character HEAD SHA.

Merge readiness is checked twice: once to enable the UI button, and again in the native Rust command immediately before the remote mutation. The final GitHub REST merge request supplies the **expected SHA**; GitHub rejects an outdated head and independently applies repository rules and permissions.

### Merge a PR

1. Select a PR and wait for CI to finish.
2. Check the **Merge eligibility** panel. If blocked, inspect and repair the specific failure in the source repository and refresh.
3. Select **Squash** (default), **Merge commit**, or **Rebase**, then select **Merge PR**.
4. Read the confirmation dialog, which displays the target branch, PR title and exact HEAD SHA. Canceling makes no mutation.
5. After confirming, VirtualLab performs an atomic, SHA-pinned merge request and refreshes the PR state and list.

A successful merge changes **remote GitHub state**; it does not automatically pull, checkout, delete branches or alter the user's local worktree. The UI does not expose admin bypass or auto-merge.

## Troubleshooting

| Situation | What to verify |
| --- | --- |
| Local review mode | `gh --version`, `gh auth status`, and a valid GitHub `origin` |
| No open PRs | Choose an existing PR from another repository's correct workspace, or enter a PR URL; make sure `gh` can list PRs |
| Blank input cannot find PR | The current Git branch may not have an open PR; use **Open pull requests** |
| CI unknown or pending | Wait for GitHub checks to report completion; refresh; verify the workflows run for this HEAD |
| CI failure | Open its linked GitHub Actions job and fix/re-run it there |
| Merge blocked by GitHub | Check base branch protection, approvals, conflicts and `mergeStateStatus` |
| Merge rejected because HEAD changed | Refresh the PR; re-check the new SHA, CI and review status |
| No permission to merge | Check the authenticated GitHub account's repository role and allowed merge methods |

## Native implementation

- `github_list_pull_requests`: read-only list for workspace origin, using `gh pr list --repo ... --state open --json ...`.
- `github_context`: explicit PR/issue lookup, including full CI rollup and GitHub merge metadata.
- `github_merge_pull_request`: typed request with workspace root, origin identity, PR number, method and expected SHA. It validates the latest GitHub state, then calls `gh api --method PUT repos/{owner}/{repo}/pulls/{number}/merge` with `sha` and `merge_method`.
- `src/lib/github.ts`: typed Tauri invocations and conservative UI merge-readiness helper.

Local review comments remain independently gated on matching local HEAD and explicit confirmation.
