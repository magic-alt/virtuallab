# Local build guide

## Windows quick path

From PowerShell at the repository root:

```powershell
npm install
npm run doctor
npm run acceptance:local
npm run tauri:build
```

`acceptance:local` runs TypeScript type checking, all frontend control tests, the production frontend build and Rust native tests before the release build.

## Development modes

### Frontend preview only

```powershell
npm run dev
```

This starts Vite at `http://localhost:1420/`. The command is expected to remain running until you press `Ctrl+C`; seeing `VITE ... ready` means it succeeded.

### Native desktop development

```powershell
npm run tauri:dev
```

This runs Vite plus the Tauri/Rust host and opens the native VirtualLab window.

### Frontend production build

```powershell
npm run typecheck
npm run test:controls
npm run build
```

Output: `dist/`.

### Native release build

```powershell
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

```powershell
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

```powershell
npm run tauri:build:debug
```

This is equivalent to Tauri `build --debug`. It runs the frontend production build and embeds `frontendDist` into the desktop application.

Outputs:

- standalone debug executable: `src-tauri/target/debug/virtuallab.exe`
- debug bundles/installers: `src-tauri/target/debug/bundle/`

### Standalone release build

```powershell
npm run tauri:build
```

Outputs:

- standalone release executable: `src-tauri/target/release/virtuallab.exe`
- release bundles/installers: `src-tauri/target/release/bundle/`

The wrapper script forwards additional Tauri CLI arguments, so commands such as the debug build use the same toolchain preflight as normal builds.
