# VirtualLab application version and release policy

## Current version

**0.5.0** is the application version baseline for V0.5 software features. This does not imply that all manual authenticated desktop acceptance is complete or that a GitHub Release has been published. See the roadmap for outstanding acceptance gates.

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

Quit any existing instance of VirtualLab, replace /Applications/VirtualLab.app with the newly generated bundle, and relaunch. About VirtualLab should show 0.5.0. For Windows, rebuild/reinstall the native executable or installer rather than using the old binary.
