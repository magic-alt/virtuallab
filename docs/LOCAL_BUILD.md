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
