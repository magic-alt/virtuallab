# Local build guide

## Cross-platform quick path

From Windows PowerShell, macOS Terminal, or Linux shell at the repository root:

```bash
npm ci
npm run doctor
npm run acceptance:local
npm run tauri:build
```

`acceptance:local` is a Node script and runs TypeScript type checking, all frontend control tests, the production frontend build and Rust native tests on Windows, macOS and Linux before the release build.

## Development modes

### Frontend preview only

```bash
npm run dev
```

This starts Vite at `http://localhost:1420/`. The command is expected to remain running until you press `Ctrl+C`; seeing `VITE ... ready` means it succeeded.

### Native desktop development

```bash
npm run tauri:dev
```

This runs Vite plus the Tauri/Rust host and opens the native VirtualLab window.

### Frontend production build

```bash
npm run typecheck
npm run test:controls
npm run build
```

Output: `dist/`.

### Native release build

```bash
npm run tauri:build
```

Typical Windows outputs:

- application binary: `src-tauri/target/release/virtuallab.exe`
- installers/bundles: `src-tauri/target/release/bundle/`
- MSI, when produced: `src-tauri/target/release/bundle/msi/`
- NSIS installer, when produced: `src-tauri/target/release/bundle/nsis/`

The first native build can take several minutes because Cargo must compile the Tauri dependency graph.

## Windows prerequisites

`npm run doctor` should report Node, Git, Cargo and Rustc as OK.

A complete native build also requires the MSVC linker/toolchain. If you see `link.exe`, Windows SDK or MSVC errors, install Visual Studio Build Tools with **Desktop development with C++**.

If a MinGW compiler is also on `PATH`, run the acceptance command from a Visual Studio Developer Command Prompt and select MSVC for Cargo's C/C++ build dependencies:

```cmd
set "CC=cl"
set "CXX=cl"
npm run acceptance:local
```

This avoids linking MinGW C++ objects with the MSVC linker. The acceptance runner also preserves the existing Windows `Path` variable when adding Cargo to the child process path.

Tauri renders through WebView2 on Windows. Current Windows 10/11 systems normally already have the Edge WebView2 runtime; install/update it if the native window cannot initialize.

## Why the old control-test command failed

The previous package script was:

```
vitest run src/**/*.test.tsx
```

PowerShell/npm does not expand that Unix-style glob before invoking Vitest, so Vitest received the literal string and reported `No test files found`.

The script is now cross-platform:

```
vitest run
```


## Dev executable vs standalone executable

There are two different debug workflows in Tauri and they should not be confused.

### Hot-reload development

```bash
npm run tauri:dev
```

This launches:

```text
Vite dev server :1420
        +
Tauri/Rust debug host
        ↓
VirtualLab window loads build.devUrl
```

The `target/debug/virtuallab.exe` produced by this development session is not the artifact to distribute or launch later by itself. Development mode uses `build.devUrl`, so if Vite is no longer running the WebView has no frontend page to load and the window can appear blank.

### Standalone debug build

Use this when you want debug symbols/devtools behavior but still want an executable that can be launched without a Vite server:

```bash
npm run tauri:build:debug
```

This is equivalent to Tauri `build --debug`. It runs the frontend production build and embeds `frontendDist` into the desktop application.

Outputs:

- standalone debug executable: `src-tauri/target/debug/virtuallab.exe`
- debug bundles/installers: `src-tauri/target/debug/bundle/`

### Standalone release build

```bash
npm run tauri:build
```

Outputs:

- standalone release executable: `src-tauri/target/release/virtuallab.exe`
- release bundles/installers: `src-tauri/target/release/bundle/`

The wrapper script forwards additional Tauri CLI arguments, so commands such as the debug build use the same toolchain preflight as normal builds.


## macOS prerequisites

Install Xcode Command Line Tools:

```bash
xcode-select --install
```

Install Rust with rustup when Cargo/Rustc are missing:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup default stable
```

Verify:

```bash
npm run doctor
```

On Apple Silicon, `rustc -vV` should normally report `host: aarch64-apple-darwin`.


## Reproducible dependency graph

V0.1 closeout commits both lockfiles:

- `package-lock.json`
- `src-tauri/Cargo.lock`

Normal local/CI setup should use `npm ci`. Rust checks/tests should use Cargo `--locked` so dependency drift fails fast instead of silently updating the graph.


## V0.3 review-loop development checks

For updates to the issue/PR review workflow run `npm run test:controls`, `npm run typecheck`, `npm run build` and `npm run acceptance:local`. The acceptance runner covers Rust Git tests and UI fixtures; it does not authenticate to GitHub or post review comments.

To exercise the actual Issue/PR → worktree flow, open the Tauri app with a user-selected local Git repository, authenticate the optional `gh` CLI, and follow `docs/CONTROL_ACCEPTANCE.md`. A new review worktree uses a user-confirmed local base ref and does not fetch/checkout PR code. After editing, use **Refresh and re-review** to invalidate cached Diff before re-opening it.

No other repository is a required build dependency or hard-coded integration.

## Desktop app icon parity (Windows / macOS / Linux)

The app uses a **single deterministic vector-geometry definition** in `scripts/icon-core.mjs` to build matching orange-V icons for all platforms. The old 16px/32px ICO-to-ICNS conversion was inadequate for macOS Dock rendering; do not use or restore it.

The generated and committed resources are:

- `src-tauri/icons/icon.png`: full RGBA 1024×1024 image.
- `src-tauri/icons/icon.ico`: Windows PNG images at 16/32/48/64/128/256px.
- `src-tauri/icons/icon.icns`: macOS standard representations from 16px through 1024px, including Retina variants.

```bash
npm run icons:generate
npm run icons:check
npm run tauri:build
```

Both the generated output and the generator are committed. `icons:check` fails when committed binary assets differ from the shared source. The macOS CI runner now also builds `VirtualLab.app`, decodes its **actual bundled ICNS** using `iconutil`, `sips`, and ImageIO/CoreGraphics, checks 1024px availability, and checks expected orange/dark pixel content. A mere file-copy equality check is not sufficient.

### Upgrading a previously installed macOS app

Check that the Git checkout includes this fix, run the build again, and **replace the old application bundle**. Existing Dock shortcuts may still reference the older bundle rather than the newly built one.

```bash
git pull
npm ci
npm run icons:check
npm run tauri:build
open src-tauri/target/release/bundle/macos/VirtualLab.app
```

To install at `/Applications/VirtualLab.app`, quit VirtualLab and replace that bundle with the new `src-tauri/target/release/bundle/macos/VirtualLab.app`. Remove and re-add the old Dock shortcut if it is pinned to a different copy. If Finder/Dock still shows a cached icon after replacing the correct bundle:

```bash
touch /Applications/VirtualLab.app
killall Dock
```

Check `mdfind 'kMDItemCFBundleIdentifier == "io.magic-alt.virtuallab"'` to find duplicate installed copies. The cache reset only changes display state; it cannot fix an old or incorrectly built bundle.

## Git branch management (desktop)

**Git branches** in the sidebar lists all local branches plus origin-tracking branches; **Workspace lanes** lists checked-out worktrees only. The two lists are intentionally different.

1. Click **Fetch + prune** to run `git fetch --prune origin`: update origin-tracking branches (including `origin/main`) and **remove obsolete `origin/*` refs** for branches deleted on GitHub. It does **not** delete local branches. **Refresh** inspects local state only; it does not contact the remote.
2. In **Git branches**, click `main`. If it is only present on origin, VirtualLab creates a local tracking branch. If `main` is already checked out in another worktree, VirtualLab opens that worktree instead of forcing a second checkout.
3. Click **Pull** to fast-forward the selected branch from the matching `origin/<branch>`. Diverged histories are refused; nothing is reset or force-merged.

To delete a **local** branch, use its trash icon under **Git branches**, then confirm in the **native macOS/Windows/Linux Ok/Cancel dialog** (Tauri dialog plugin). Cancel/close or a dialog error must leave the branch unchanged. No JavaScript `window.confirm()` fallback is permitted. This requires the desktop capability `dialog:allow-message`; `dialog:allow-open` alone is insufficient. The action uses `git branch -d`, refuses unmerged commits, protects `main`/`master` and the remote default branch, and refuses branches checked out in any worktree. This never deletes a branch on GitHub. For origin-only entries there is no delete button; **Fetch + prune** removes ones deleted upstream. Git local branches deliberately remain after pruning, so delete those individually if no longer needed. Existing untracked files do not block deleting a different, merged branch.

**Switch** rejects staged/unstaged tracked modifications, but **allows untracked-only files** when Git can preserve them safely. If an untracked path would be overwritten by the target branch, Git rejects the switch and keeps the current branch and file intact. **Pull** still requires a completely clean workspace (including untracked files). After a successful switch, VirtualLab requests a fresh Git snapshot rather than reusing an in-flight filesystem-watch snapshot, so the Active badge follows the actual HEAD. The active branch and `main` appear first in the sidebar. Fetch never changes working files. This UI operates on the currently selected worktree; no workspace is deleted by branch switching. Network authentication and remote failures are reported by Git. A local branch with no corresponding origin branch cannot be pulled until its remote is configured; pushing and remote management remain terminal workflows.
