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
| package.json with scripts.build | npm · Build | npm run build | Windows/macOS/Linux |
| package.json with scripts.tauri:build | Tauri · Package | npm run tauri:build | Windows/macOS/Linux |
| CMakeLists.txt | CMake · Build (Qt label when detected) | cmake -S . -B build/virtuallab; cmake --build build/virtuallab --config Release | Windows/macOS/Linux |
| *.uvprojx under the worktree (up to 3 folders deep) | Keil · project | UV4.exe -b <relative-project-path> | Windows |

Keil discovery never invokes the IDE or a flashing command. An absolute path to UV4.exe can be entered via **Customize** if Keil MDK is not on PATH. To target a specific configuration, add two separate arguments: -t and the exact target name.

The generic CMake recipe uses the host's default CMake generator; adjust the editor for Ninja/MSVC generators, CMakePresets, CMAKE_PREFIX_PATH/Qt6_DIR, toolchain files, build directory and build target. Qt's windeployqt/macdeployqt tooling is *not* inferred because deployment directories and host targets differ by project.

The project manifests and npm scripts are user-controlled: npm itself may invoke a shell internally. **Only run recipes from trusted repositories.** VirtualLab does not sandbox build scripts.

### Example: JavaScript / Tauri

Use the auto-detected npm Build or Tauri Package button. It runs the package's scripts as authored; it does not automatically run npm ci, install/update dependencies or upload artifacts. If dependencies are missing, add a deliberate npm ci step to a saved profile.

### Example: Keil MDK firmware

Save the detected Keil recipe; set the program to the actual UV4.exe path if necessary (for example C:\Keil_v5\UV4\UV4.exe). Set separate arguments, one per line:

    -b
    Firmware/MDK-ARM/App.uvprojx
    -t
    Release

The target name must match the .uvprojx configuration. The result is the configured Keil build output only; *flash/download/debug* are out of scope for automatic discovery.

### Example: Qt/CMake

A saved multi-step profile for Qt6 may use:

- Configure: program cmake; args -S, ., -B, build/virtuallab, -DCMAKE_PREFIX_PATH=<Qt-install-prefix> (one argument per line).
- Compile: program cmake; args --build, build/virtuallab, --config, Release.

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
           ├─ CMakeLists.txt
           └─ bounded *.uvprojx search
                 │ typed BuildSuggestion[]
                 ▼
      React ProcessRunner / editable ProcessProfile
         ├─ legacy one-step → process_spawn (V0.2)
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
| npm package.json build | Build now → npm run build, stdout/stderr and exit status shown |
| Tauri packaging script | Package now → npm run tauri:build, no install/publish |
| Qt CMake | Configure must succeed before Compile; failure skips Compile |
| Keil *.uvprojx | Windows-only suggestion; missing UV4 path fails visibly; no flash |
| Custom two-step editor | Saves across app restart and runs in selected worktree |
| Repo A / Repo B | Saved profiles are not shown in unrelated repos |
| Git worktrees | Shared repository profile executes in selected worktree cwd |
| Deploy cancelled | No native process is started |
| Stop requested | Marks completed native workflow stopped and prevents the next step |
| Missing tools / bad args | Failing step is reported; no later steps run |
| Windows/macOS/Linux | Frontend tests and native acceptance; manual toolchain build separately |

Native end-to-end Keil, Qt and npm desktop acceptance still requires a host with those toolchains installed. CI tests generic orchestration/detection and does **not** certify customer-specific builds, compiled firmware outputs or deployment targets.
