# VirtualLab v0.5.0 Release Candidate — release qualification contract

> **2026-10-10 最新结论**：PR #44 合并 main@e693f4f690d10a6439377e1466e6a828cf54e7e8；[main CI](https://github.com/magic-alt/virtuallab/actions/runs/38030779241) 6/6 全绿（Windows 156/85 前端/Rust，macOS/Linux 155/92，另跳过 1 项 Windows-only 前端测试）。[PR #44 RC 工作流](https://github.com/magic-alt/virtuallab/actions/runs/38029907168) 是 SKIPPED，不存在该 HEAD 的三平台 RC 打包验收。以下手工勾选项**仍全部待人工完成**。完整事实更新见 [Release Gate](RELEASE_GATE_V0.5.0.md) 和 [Issue #40](https://github.com/magic-alt/virtuallab/issues/40)。

> **Not a release approval.** The current branch only produces unsigned QA artifacts. The automated CI jobs never sign, notarize, install into a user's system, publish a tag, or create a GitHub Release. A green job alone cannot close the manual items below.

## Source and scope

- **Historical PR #43 RC baseline:** `main@cea4655bb1196d556a2ed88cc047c9bb41dbc27b` (PR #41 and PR #42 included). **Current accepted review baseline:** `main@e693f4f690d10a6439377e1466e6a828cf54e7e8` (PR #44 merged).
- **Historical candidate implementation:** PR #43, branch `release/v0.5.0-rc-qualification`. PR #44 fixes are already merged and were not built by the release/*-only PR artifact workflow; use manual workflow_dispatch on the final SHA.
- Tracking: #40, native lifecycle #19, real build acceptance #34 and stable desktop qualification #25.
- No relationship to any named external repository, lab, hardware board, motion controller or safety executor.
- All hardware motion/power/flashing approvals remain fail-closed in the software control plane.

## Automated evidence: exact SHA

For this PR, review **both** workflows:

1. `CI`: Node 22/26, Windows/macOS/Linux native Rust unit/acceptance checks and app/icon test.
2. `Release Candidate (unsigned QA bundles)`: Windows NSIS installer, macOS .app zipped using Apple's `ditto`, Linux .deb, each at the runner's checked-out `GITHUB_SHA`.

Each artifact contains `release-candidate-manifest.json`, `SHA256SUMS.txt` and exactly one unsigned installer/archive. The manifest requires the source Git SHA and explicitly sets `signed=false`, `notarized=false` and `manualDesktopAccepted=false`. Revalidate the file digest before installing and compare the recorded SHA against the accepted PR merge/source commit.

```sh
npm ci
npm run version:check
node --test scripts/rc-assets.node-check.mjs
npm run acceptance:local
# For an already bundled platform artifact at this exact checkout:
node scripts/rc-assets.mjs package macos   # or windows-x64 / linux-x64
node scripts/rc-assets.mjs verify macos
```

The two `rc-assets` commands require `GITHUB_SHA` to contain the full checkout SHA. Building `macos` requires an Apple host with `ditto`. Packaging must fail when multiple/stale bundles exist.

## Human real-desktop acceptance (all checkboxes currently OPEN)

| Area | Windows | macOS | Linux | Required evidence |
| --- | --- | --- | --- | --- |
| Fresh install, first launch and upgraded install | [ ] | [ ] | [ ] | OS/version, package SHA, clean VM account, upgrade baseline, screenshots |
| Native confirmations (Cancel = no mutation) | [ ] | [ ] | [ ] | PR merge/comment and local/origin branch/worktree actions in a disposable repository |
| Run attach and process cleanup | [ ] | [ ] | [ ] | Long build; change workspaces/tabs; Stop; exact parent/child PIDs and exit status |
| Git branch/prune/untracked collision | [ ] | [ ] | [ ] | Remote disposable origin and worktree paths with Unicode/spaces |
| Monaco diff, wrapping, CSP/worker console | [ ] | [ ] | [ ] | Unified/side-by-side, large/binary, WebView logs, resized window |
| Terminal session, Ctrl+C, resize, shell exit | [ ] | [ ] | [ ] | Multiple sessions; background/foreground jobs; no orphan descendants |
| Authenticated `gh` and PR CI controls | [ ] | [ ] | [ ] | Deliberately failed/pending/green PR, test merge with SHA guard in disposable repo |
| Agent CLI real provider auth/failure | [ ] | [ ] | [ ] | Installed versions, blocked policy, resume/stop/interrupt, offline/restart |
| Build workflows | [ ] npm/Tauri, Qt/CMake, Keil | [ ] Tauri and Qt/CMake | [ ] CMake/Qt + .deb | Real compiler exit codes, output, cancellation and artifact inspection |
| Privacy and resource stress | [ ] | [ ] | [ ] | Sensitive-output redaction, 2–4 worktrees, peak RSS/CPU, native process count |

Do not use real customer repositories or production PRs for destructive test cases. **Keil requires Windows and a licensed local MDK installation**; runner compilation of VirtualLab is not Keil project acceptance. DeepSeek and other paid providers require operator-owned credentials; CI must not guess or store tokens.

## Signing, distribution and governance (OPEN)

- [ ] Configure GitHub Rulesets/branch protection on `main` to require **Required quality gate** (from CI), PR review and no force pushes. The workflow now provides this stable fail-closed aggregate check; enabling/enforcing the rule requires repository administration outside the available GitHub connector mutation actions.
- [ ] Release artifact identities pinned to the accepted commit and signed with a trusted certificate; macOS hardened-runtime signing and notarization verified on the packaged app.
- [ ] On Windows, install/uninstall and SmartScreen/authenticode status inspected; on Linux, validate deb dependencies on clean supported distributions.
- [ ] Independent SHA-256 verification of **the signed final assets**; unsigned QA hashes cannot be reused when signing alters package bytes.
- [ ] Create CHANGELOG/known limitations and compatibility/support matrix; validate APP version/installer/About consistency.
- [ ] Record a maintainer Release Gate sign-off with date, OS, CLI versions, exact SHA, links to CI artifacts, failures and waivers.
- [ ] Only then create an immutable SemVer tag and a GitHub Release. Never force-move a published tag.

## Existing limitations (not hidden)

The runtime's historical Run registry is in-memory for one app process; crash-recovery event journal is V0.6 #18. Four real provider integrations and API permission drift require manual validation. GitHub PR list is limited to 50; GBK/CP936 legacy build logs lack a dedicated decoder; macOS/Linux daemonized/detached processes may escape normal worktree process ownership. Large-repository P95/P99, resource cap and cross-host GUI compatibility are not yet certified. The built-in approval broker is not an independent hardware interlock.
