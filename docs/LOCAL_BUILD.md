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
