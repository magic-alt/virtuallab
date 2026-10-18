# VirtualLab application version and release policy

## Current version

Read the current application version from `package.json` or run `npm run version:check`. The initial **0.5.0** baseline represents V0.5 software features; it does not imply that all manual authenticated desktop acceptance is complete or that a GitHub Release has been published. See the roadmap for outstanding acceptance gates.

VirtualLab uses Semantic Versioning 2.0 while developing in 0.x: 0.5.1 is a bugfix release, 0.6.0 is the next feature milestone, and 0.6.0-rc.1 is a pre-release candidate. Stable 1.0.0 requires a separate product/API stability review.

## Single source of truth

The authoritative version is the top-level package.json version. All five locations must agree:

| Location | Consumer |
| --- | --- |
| package.json | npm and frontend footer |
| package-lock.json | locked npm root metadata, including packages[""] |
| src-tauri/tauri.conf.json | Tauri bundle, native macOS About VirtualLab |
| src-tauri/Cargo.toml | Rust crate version |
| src-tauri/Cargo.lock | locked Rust package version |

Check with:

    npm run version:check

Bump to a new version in one operation:

    npm run version:set -- 0.5.1
    npm run version:check
    npm ci
    cargo check --locked --manifest-path src-tauri/Cargo.toml
    npm run acceptance:local

Commit all five changed files together in a PR. Do not update only one language's metadata. CI checks version consistency and packaging refuses inconsistent sources; version unit tests cover mismatch detection, bumps, and tag matching. macOS CI checks the actual app bundle CFBundleShortVersionString against package.json.

## Automatic version assessment

After a successful **CI** push run on `main`, `.github/workflows/version-assessment.yml` inspects the latest default-branch revision. It executes only default-branch source, without installing dependencies or consuming PR artifacts. A stale CI revision is skipped; a later successful run assesses the full pending range. Maintainers can rerun **Automatic version assessment** through workflow dispatch on the default branch, including for initial backlog assessment. Dispatch creates only a draft proposal; the version PR still requires full CI and human review.

The baseline is the first-parent mainline commit that introduced the current `package.json` version, rather than the last dependency/script edit or the most recent release tag. All eligible merged PRs after that commit are aggregated and deduplicated. Merge, squash and rebase merges are identified through GitHub's commit-to-PR API, with merged state, repository, target branch and an in-range merge commit required. Direct commits without an eligible PR are listed separately for review. File lists must be complete; API errors, GitHub's file-list cap or shallow Git history stop assessment rather than guessing.

### Upgrade rules

| Changes / qualification | Proposal |
| --- | --- |
| Fixes, ordinary features, refactors or other product changes | One patch increment from the committed version, e.g. `0.5.0 → 0.5.1` |
| Only documentation, tests or `.github/` configuration | No bump by default; file paths determine this, so a misleading title cannot hide code edits |
| `release:skip` label | Explicitly skip a nonbreaking PR |
| `release:patch` label | Explicitly include a PR in the patch proposal |
| Next configured roadmap milestone, all mapped tasks and explicit release qualification accepted | Next minor version, e.g. `0.6.0`; earlier configured milestone gates must also remain accepted |
| Conventional `feat!:` / `fix(scope)!:` title or `BREAKING CHANGE:` body | Hold the update until a qualified 0.x minor is available or a human manages the version manually |
| `release:major` label | Hold automatic version changes for separate human stability review |
| Prerelease application versions | Manual version management; automatic assessment rejects them |

Conflicting override labels are rejected. Breaking and major declarations cannot be bypassed using `release:skip` or `release:patch`. Test files/directories and documentation extensions are skipped, but mixed changes and both sides of renames are checked. Titles, PR bodies and paths are data; none become shell commands.

`.github/version-policy.json` maps `0.6.0` through `0.9.0` to roadmap headings. V0.7-A/B/C map together to `0.7.0`, never to three version increments. Each mapped section must exist exactly once and contain a fully checked acceptance list. Each milestone additionally requires exactly one checked entry beginning `Release qualification for V0.N:` in its mapped sections. Code-fenced examples are ignored. Maintainers check these entries only after reviewing the exit-gate evidence, through the normal roadmap PR review. Source implementation or a merged PR alone cannot close qualification. Automation never changes roadmap checkboxes and never automatically promotes to `1.0.0`.

### Draft version PR and repository setup

Enable **Allow GitHub Actions to create and approve pull requests** in repository **Settings → Actions → General → Workflow permissions**, if repository/organization policy permits it. The workflow uses the built-in token with only contents/pull-request write permissions; it never approves a PR. If policy forbids PR creation, assessment fails visibly and maintainers can still use the local preview and existing manual version command. No PAT or new secret is required.

The workflow maintains one draft PR from the reserved `automation/version-update` branch. It synchronizes the five version files using `setVersion` and includes `docs/VERSION_ASSESSMENT.md` with the baseline, assessed SHA, included/skipped PRs and roadmap blockers. The same report appears in the Actions job summary. Pending PRs continue to propose the same increment until the version update actually lands. After the update merges, its committed version becomes the new baseline, preventing a self-bump loop.

Updates preserve the previous bot tip as a commit parent and fast-forward the branch; no force-push, branch deletion or automatic merge occurs. A manually edited branch tip or unrecognized PR body stops automation rather than overwriting user edits. The bot records its proposed tree SHA in the commit message, so an amendment that retains the message but changes the tree is also rejected. This is an accidental-edit guard, not an authentication mechanism against repository maintainers. Identical repeated assessments preserve the PR revision and ready state. The branch is reserved for generated changes. If a proposal becomes ineligible, its PR returns to draft with a **HOLD** title and an updated explanation. A later eligible assessment can reuse it. Closed proposals can be proposed again by a later assessment; remove eligibility labels/change policy if the proposal should stay suppressed.

Review the proposal and mark it **Ready for review** to run full PR CI. The CI workflow explicitly includes `ready_for_review`, so this human action can start checks even when automation-triggered checks need approval or are suppressed by the built-in token. Approve any workflow-run approval prompt shown by GitHub. Every automated update returns a ready PR to draft; review and validate the new revision again. Merge only after required checks pass. GitHub's [token event restrictions](https://docs.github.com/en/actions/concepts/security/github_token) and [PR event types](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) explain the trigger behavior.

Merging a version PR changes source/build metadata. It does not create a tag or GitHub Release, publish a package, deploy, update an installed application or certify roadmap evidence. Those actions retain their separate human gates.

### Read-only local preview

With authenticated `gh` and full local history:

    npm run version:assess
    npm run version:assess -- --json

The CLI reads the selected checkout and its GitHub repository. It makes only read-only `gh` API requests and never modifies versions, branches or PRs. Uncommitted local changes make the result provisional; checkout selection and history determine the assessed range, so use an up-to-date default branch for the same range as automation.

For offline inspection, supply a JSON array of PR records containing `number`, `title`, `files` and optional `labels` (string array) / `body`:

    npm run version:assess -- --input merged-prs.json --json

Example input: `[{"number":78,"title":"fix: correction","labels":[],"files":["src/app.tsx"]}]`. Supplied JSON is marked provisional; it is not independently verified merged-PR evidence. Automatic PR creation always uses live GitHub metadata instead.

## Tags, builds and releases

Feature roadmap names (such as V0.5) are not formal application releases. Never create a release tag merely because a roadmap item is checked.

1. Merge a version bump after green CI, and complete any required platform-specific manual acceptance.
2. Build, run and inspect the platform bundles; for macOS verify the fresh app bundle's About metadata.
3. Create and push an annotated tag for the accepted main commit (for example: git tag -a v0.5.0 -m "VirtualLab 0.5.0"; git push origin v0.5.0).
4. GitHub's tag verification workflow rejects a tag that does not match all five version sources; it does not publish unverified binaries.
5. Publish a GitHub Release with tested assets, checksums and release notes only after signing/notarization and platform acceptance where applicable.

Do not move or overwrite a published tag. Changes after release require a new patch/minor version.

## Why About may still display 0.2.0

The native macOS About menu reads the installed app's CFBundleShortVersionString. It is embedded when the native bundle is built. Editing source files, refreshing a Vite preview, or merging the GitHub PR does not update an already-installed copy.

After merging, rebuild using:

    npm ci
    npm run version:check
    npm run tauri:build -- --bundles app
    /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" src-tauri/target/release/bundle/macos/VirtualLab.app/Contents/Info.plist

Quit any existing instance of VirtualLab, replace /Applications/VirtualLab.app with the newly generated bundle, and relaunch. About VirtualLab should show the current `package.json` version. For Windows, rebuild/reinstall the native executable or installer rather than using the old binary.
