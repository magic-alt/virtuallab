# Project Build Workflows — one-click builds and explicit deployments

Status: opt-in desktop feature; automatic recipes do not install, publish, flash or run privileged operations. These process results are **not** V0.4 trusted verification/evidence or release certification.

## Why

V0.2 already had a repository-scoped single executable + argv Build/Test profile. This feature adds read-only project detection, sequential steps and a UI to configure Build/Test/Package/Deploy without depending on any particular repository, device or hardware laboratory.

## Workflow in the app

1. **Add Repository**, select a workspace/worktree, then open **Run**.
2. **One-click project builds** shows recipes discovered from files in the *selected worktree*. Click **Build now** or **Package now** to execute without changing repository configuration.
3. Click **Customize** to store and edit a repository-scoped copy. Saved profiles are reusable across that repository's worktrees.
4. Select **Profile** to create a custom Build, Test, Package or Deploy workflow; use **Add step** for configure → compile → package or similar sequences.
5. **Run** starts exactly one workflow; **Stop** requests cancellation. Output includes each step and exit status; later steps are not executed after a failure. Reopen the Run tab to rescan or click the rescan icon when project files change.

Recipe detection is bounded, local and read-only. It does not execute project files or inspect tool availability. An inferred recipe can fail if its compiler, SDK, Qt installation or dependencies are not configured.

### Auto-detected recipes

| Source in active worktree | Recipe | Steps | Platform |
| --- | --- | --- | --- |
| package.json with scripts.tauri:build | Tauri · Desktop build (displayed first) | npm run tauri:build — includes frontend + Rust + OS package | Windows/macOS/Linux |
| package.json with scripts.build | npm · Frontend only | npm run build — dist/ web assets, no desktop installer | Windows/macOS/Linux |
| CMakePresets.json / CMakeUserPresets.json with buildPresets + configurePresets | CMake · project preset (Qt label when detected) | cmake --preset <configure-preset>; cmake --build --preset <build-preset> | Host-compatible presets |
| CMakeLists.txt | CMake · Generic build (fallback) | cmake -S . -B build/auto; cmake --build build/auto --config Release | Windows/macOS/Linux |
| *.uvprojx under the worktree (up to 3 folders deep) | Keil · project | UV4.exe -b <relative-project-path> | Windows |

Keil discovery never invokes the IDE or a flashing command. An absolute path to UV4.exe can be entered via **Customize** if Keil MDK is not on PATH. To target a specific configuration, add two separate arguments: -t and the exact target name.

CMake build presets defined **by the selected worktree** take priority over the generic fallback. Each usable build preset is paired with its configure preset; hidden and known host-incompatible presets are omitted, and simple inherited conditions are respected. CMake itself resolves preset configuration, generator, build directory, toolchain and Qt paths; VirtualLab does not inject application-specific paths. Unsupported/unknown preset conditions and external includes are not executed or guessed during discovery. For projects without a usable build preset, the generic recipe uses this worktree's isolated `build/auto` directory and the host's default CMake generator. Customize that fallback for explicit Ninja/MSVC generators, `CMAKE_PREFIX_PATH`/`Qt6_DIR`, toolchain files and targets. Qt's windeployqt/macdeployqt tooling is *not* inferred.

The project manifests and npm scripts are user-controlled: npm itself may invoke a shell internally. **Only run recipes from trusted repositories.** VirtualLab does not sandbox build scripts.

### Example: JavaScript / Tauri

For a desktop executable or installer, choose **Tauri · Desktop build → Build desktop app** (`npm run tauri:build`). This invokes its configured frontend build and compiles the native Rust application. Choose **npm · Frontend only → Build frontend** (`npm run build`) only when you want Vite/React `dist/` assets; a PASS exit code for that command does not mean a desktop installer was produced. Typical Tauri bundle output is under `src-tauri/target/release/bundle/`, but the actual path depends on the project/target configuration. Neither recipe automatically runs npm ci or uploads any artifacts. The Windows current-app self-build exception below relaunches the freshly built executable after explicit confirmation; it is not a general software installer or updater. If dependencies are missing, add a deliberate npm ci step to a saved profile.

#### Windows: build and relaunch the running application

If the selected worktree is **the application currently running VirtualLab**, choose **Build desktop app** and accept the native **Build and restart** confirmation. The Rust backend verifies the worktree's Tauri identifier matches the running app and requires the exact one-step `npm run tauri:build` recipe. No other repository, multi-step command or CMake/Keil build can close VirtualLab. Declining the confirmation starts nothing.

1. The exact npm recipe is run as `npm run tauri:build -- --no-bundle`, with `CARGO_TARGET_DIR=<worktree>/src-tauri/target/self-build-stage` (a release build). `--no-bundle` is appended **only after** the native backend verifies the current-app self-restart request. It produces a standalone EXE and **does not invoke WiX `candle.exe` or create MSI/NSIS installers**, avoiding failures in installer tooling after a successful Rust compile. The isolated output also avoids `os error 5` when the original `src-tauri/target/release/*.exe` is still in use. Rust/Tauri dependencies in the isolated directory compile the first time, so this build may take longer and use additional disk space.
2. If the build fails or is cancelled, the running app remains open and displays the diagnostics. If compilation succeeds but no staged release EXE exists or the helper cannot be spawned, it also remains open and displays a restart error.
3. Only after a successful build, the newly compiled EXE starts a headless handoff, waits for the existing process to exit, and launches the new build. If VirtualLab is running from **this worktree's `src-tauri/target/release/`**, the helper replaces that EXE using a staged adjacent file, retaining `.self-build-previous` as a rollback copy. If VirtualLab is installed elsewhere or launched from a debug build, the installed/debug EXE is **not modified**; the new release is copied into alternating `src-tauri/target/self-build-runtimes/{a,b}/` slots and launched from there. This avoids locking the Cargo stage EXE during the next build. The runtime copy is preflighted **before** closing the current application, so a missing/writable-output error does not terminate the working app. Shortcut installations therefore remain at their installed version.

This is a local developer workflow, **not** a Windows installer upgrade. To build an installer separately, run `npm run tauri:build` (default configured bundles), `npm run tauri:build -- --bundles nsis` (NSIS only), or `npm run tauri:build -- --bundles msi` (MSI only). The latter requires WiX; a `candle.exe` error must be diagnosed from its detailed output and does not imply Rust compilation failed. To update an installed copy persistently, use a generated installer separately. The new helper supports the special handoff argument from within `main.rs`, before any Tauri window is initialized. If the version of VirtualLab *currently in memory* predates this feature, first upgrade it once from an externally built binary/installer; changes to source code alone cannot retroactively fix the already-running process.

### Example: Keil MDK firmware

Save the detected Keil recipe; set the program to the actual UV4.exe path if necessary (for example C:\Keil_v5\UV4\UV4.exe). Set separate arguments, one per line:

    -b
    Firmware/MDK-ARM/App.uvprojx
    -t
    Release

The target name must match the .uvprojx configuration. The result is the configured Keil build output only; *flash/download/debug* are out of scope for automatic discovery.

### Example: Qt/CMake

For a Qt6 project such as `servo_host` that defines `CMakePresets.json`, choose a host-compatible project preset. For example, with its Windows MinGW Qt6 Release preset:

- Configure: `cmake --preset windows-mingw-release-qt6`
- Compile: `cmake --build --preset windows-mingw-release-qt6`

The project's preset controls the binary directory, generator, and toolchain; no `virtuallab`-named directory is introduced. Alternatively, customize the **Generic build** fallback:

- Configure: program `cmake`; args `-S`, `.`, `-B`, `build/auto`, `-DCMAKE_PREFIX_PATH=<Qt-install-prefix>` (one argument per line).
- Compile: program `cmake`; args `--build`, `build/auto`, `--config`, `Release`.

Configure/build run sequentially, with the active worktree as cwd. The compiler environment (Windows MSVC Developer Prompt, Xcode, Ninja, cross SDK, etc.) must already be installed. For staging/install, create a separate, explicitly invoked Deploy profile using cmake --install and an operator-reviewed destination; do not point it at a privileged/system directory by default.

### Deployment semantics

**Deploy is user-defined; there is no automatic deployment preset.** Every Deploy run displays a *native Tauri confirmation* containing the configured commands before it can launch. Cancelling means no process starts.

- Deploy may mean a **local staging install/copy** to a user-selected output directory or an externally configured release process.
- There is no automatic remote SSH, registry push, OTA, firmware flash, programming probe, power enable, motion or hardware lease integration.
- Human confirmation does not give software access to safety-critical hardware. Device-side authorization and independent physical interlocks would require a separate provider and safety review.
- Tools run with the desktop user's OS permissions. No command is claimed safe merely because its Profile kind is Build.

## Architecture

    selected Git worktree
       └─ Read-only detector (Rust build_workflow_discover)
           ├─ package.json scripts
           ├─ CMakeLists.txt + optional project/user CMakePresets
           └─ bounded *.uvprojx search
                 │ typed BuildSuggestion[]
                 ▼
      React ProcessRunner / editable ProcessProfile
         ├─ ordinary one-step → process_spawn (V0.2)
         ├─ confirmed Windows self-build → build_workflow_start
         └─ multi-step → build_workflow_start
                            └─ Rust BuildWorkflowManager
                               sequential Command(program,args)
                               cwd = selected worktree
                               build://event (started, step, output, finished)
                               cancel → process tree best effort

BuildStep { name, program, args[] } is the execution contract. No shell command string, hidden initialization script, environment-secret persistence or checkout is introduced. Old Build/Test single-step profiles remain readable after store migration. Profiles are saved in local application settings, not Git, and are scoped to the selected repository. They are *not* portable CI definitions, and do not yet store separate per-host toolchain paths.

The native executor rejects empty/malformed steps, excessive arguments and nonexistent working directories, stops the workflow at the first failing step, and reports that exit code. A step's cwd cannot escape the selected worktree because the workflow uses one canonicalized cwd. Windows background children use CREATE_NO_WINDOW through the pre-existing process adapter. Cancellation targets the compiler's process group/tree best effort; it is not a hardware emergency stop or evidence of quiescent equipment.

The on-screen output ring is bounded and session-local. It is not an immutable log nor a persisted evidence store; switching away from Run may discard the visible process record while the native command continues. Durable process recovery, process identity and signed evidence are separately tracked in the V0.6–V0.8 roadmap.

## Acceptance matrix

| Check | Expected result |
| --- | --- |
| Existing one-step Build/Test | Executes through legacy typed process path; Run/Stop preserved |
| npm package.json build | Build frontend → npm run build, stdout/stderr and exit status shown; no installer implied |
| Tauri packaging script | Build desktop app → npm run tauri:build, preset appears before npm frontend, no install/publish |
| Running Windows Tauri app + approved restart | Isolated Cargo output; explicit `--no-bundle` bypasses WiX/MSI, only successful standalone EXE build exits current app and restarts |
| Broken WiX candle.exe, but in-app self-rebuild | No WiX invocation or installer required; a successful EXE rebuild can restart |
| Normal desktop package build | Original npm `tauri:build` args are preserved; installers are built as configured |
| Running Windows Tauri app + cancelled/failed build | No restart; existing GUI stays alive, error visible |
| Packaging a different Tauri app | No self-build restart, normal build action |
| Running installed/debug copy | Fresh EXE opens from an alternating runtime slot after successful build, installed/debug binary left unchanged |
| Repeated builds from a runtime slot | Next build uses the same isolated Cargo stage but relaunches into the alternate runtime slot, so Windows does not lock the linker target |
| ANSI / Unicode output | Compiler color codes and OSC controls are removed in the Run log; valid UTF-8 split across native pipe reads survives intact; final output is drained before status |
| Qt CMake presets | Detect worktree-owned configure/build pairs; host filter and hidden presets respected; Configure must succeed before Compile |
| Generic CMake fallback | Only uses current worktree's build/auto; no product-named paths or shared outputs |
| Keil *.uvprojx | Windows-only suggestion; missing UV4 path fails visibly; no flash |
| Custom two-step editor | Saves across app restart and runs in selected worktree |
| Repo A / Repo B | Detected recipes and saved profiles are isolated to their own selected repositories |
| Git worktrees | Shared repository profile executes in selected worktree cwd |
| Deploy cancelled | No native process is started |
| Stop requested | Marks completed native workflow stopped and prevents the next step |
| Missing tools / bad args | Failing step is reported; no later steps run |
| Windows/macOS/Linux | Frontend tests and native acceptance; manual toolchain build separately |

Native end-to-end Keil, Qt and npm desktop acceptance still requires a host with those toolchains installed. CI tests generic orchestration/detection and does **not** certify customer-specific builds, compiled firmware outputs or deployment targets.
