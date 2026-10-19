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

For a manual version change, commit all five files together in a reviewed PR. Automatic patch synchronization uses the guarded mainline workflow below. Never update only one language's metadata. CI checks version consistency and packaging refuses inconsistent sources; version unit tests cover mismatch detection, bumps, and tag matching. macOS CI checks the actual app bundle CFBundleShortVersionString against package.json.

## Automatic version synchronization

A trusted `main` push (including a merged PR) now triggers `.github/workflows/version-assessment.yml` directly, regardless of the outcome of unrelated cross-platform CI. The version policy `.github/version-policy.json` enables `automaticPatchOnMain`. Ordinary feature/fix PRs cause one aggregated **patch** synchronization for all eligible changes since the committed version baseline, for example `0.5.0 → 0.5.1`. It is not one increment per historical PR. Subsequent merges produce the next patch.

The workflow uses only default-branch code with a write token, reads complete GitHub merged-PR metadata, and validates the patch using `setVersion` and `inspectVersions`. It creates a fast-forward-only metadata commit directly on `main` affecting only the five version files and `docs/VERSION_ASSESSMENT.md`. It checks that the inspected branch head has not changed before updating the ref. A concurrent merge cannot be overwritten. `GITHUB_TOKEN`-authored pushes do not recursively trigger this workflow.

**This updates source/build version metadata, not release readiness.** It does not create a version tag, GitHub Release, binary publication or deployment. Full CI, manual provider/desktop acceptance and release gates remain separate; a failed build remains failed even when the version metadata is up to date. A protected branch or missing `contents:write` permission makes the automation fail visibly rather than force-pushing or bypassing protections. The source version is not proof of the version installed on a user's machine.

### Classification and milestone gates

| Changes | Version handling |
| --- | --- |
| Ordinary feature/fix/refactor with product files | Automatic one-patch synchronization on `main` |
| Docs, tests and CI changes only | Skip by default |
| `release:skip`, `release:patch` | Explicit nonbreaking classification overrides |
| Next milestone fully qualified in the roadmap | Draft version PR for `0.x → 0.(x+1).0`; **human review still required** |
| Breaking title/body or `release:major` | No automatic patch; qualified milestone or manual stability review |
| Prerelease version | Manual version management |

`0.6.0` is not yet qualified until all mapped V0.6 tasks and its explicit release-qualification checkbox are accepted. As such, merged PRs #79 and #80 can trigger `0.5.1` but not `0.6.0`.

### Recovery and release proposals

When a patch sync fails, inspect the **Automatic version assessment** Actions run. Missing pushes, a stale snapshot, incomplete GitHub PR metadata, an existing legacy bot proposal PR or missing repository permissions are visible errors/holds rather than silent non-updates. Use `workflow_dispatch` on `main` to perform one explicit catch-up assessment. If main advanced during assessment, the job skips the stale snapshot and the next push/dispatch reassesses.

Qualified milestone versions retain the reserved `automation/version-update` branch and a Draft PR. It is kept in draft until reviewed and explicitly marked Ready for review, with full PR CI and human merge required. The automation never auto-merges minor/major versions, never auto-approves a release and never modifies roadmap acceptance. Existing legacy automatic version PRs must be resolved before direct patch synchronization to avoid conflicting proposals.

### Read-only local preview

With authenticated `gh` and full local history:

    npm run version:assess
    npm run version:assess -- --json

The CLI reads the selected checkout and its GitHub repository. It makes only read-only `gh` API requests and never modifies versions, branches or PRs. Uncommitted local changes make the result provisional; checkout selection and history determine the assessed range, so use an up-to-date default branch for the same range as automation.

For offline inspection, supply a JSON array of PR records containing `number`, `title`, `files` and optional `labels` (string array) / `body`:

    npm run version:assess -- --input merged-prs.json --json

Example input: `[{"number":78,"title":"fix: correction","labels":[],"files":["src/app.tsx"]}]`. Supplied JSON is marked provisional; it is not independently verified merged-PR evidence. Automated mainline synchronization and minor-version proposals always use live GitHub metadata instead.

## Tags, builds and releases

Feature roadmap names (such as V0.5) are not formal application releases. Never create a release tag merely because a roadmap item is checked.

1. Verify the synchronized mainline version (automated patch or reviewed minor PR), green CI, and any required platform-specific manual acceptance.
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
