//! Windows-only opt-in handoff for rebuilding the *running* Tauri application.
//! Cargo must not link over a running .exe. A separate target directory holds
//! the newly built binary; that binary acts as a short-lived restart helper
//! after the old process has exited. Other repositories are never restarted.
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const STAGING_DIR: &str = "self-build-stage";
const HELPER_FLAG: &str = "--virtuallab-apply-self-build";

pub(crate) struct SelfBuildPlan {
    pub(crate) target_dir: PathBuf,
    staged_exe: PathBuf,
    running_exe: PathBuf,
    root: PathBuf,
}

pub(crate) fn available(app: &AppHandle, root: &Path) -> bool {
    prepare(app, root).is_ok()
}

pub(crate) fn prepare(app: &AppHandle, root: &Path) -> Result<SelfBuildPlan, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, root);
        Err("Automatic rebuild and restart is supported on Windows only".into())
    }
    #[cfg(windows)]
    {
        use std::{env, fs};
        let root = fs::canonicalize(root).map_err(|e| format!("Invalid build directory: {e}"))?;
        if !root.join("src-tauri/Cargo.toml").is_file() {
            return Err("This worktree is not a Tauri Rust project".into());
        }
        let config_path = root.join("src-tauri/tauri.conf.json");
        if fs::metadata(&config_path).map_err(|e| e.to_string())?.len() > 262_144 {
            return Err("Tauri configuration is too large".into());
        }
        let config: serde_json::Value = serde_json::from_slice(
            &fs::read(config_path).map_err(|e| format!("Cannot read Tauri configuration: {e}"))?
        ).map_err(|e| format!("Invalid Tauri configuration: {e}"))?;
        if config.get("identifier").and_then(|value| value.as_str()) != Some(app.config().identifier.as_str()) {
            return Err("Selected project is not the running desktop application".into());
        }
        let package_path = root.join("package.json");
        if fs::metadata(&package_path).map_err(|e| e.to_string())?.len() > 1_048_576 {
            return Err("Package manifest is too large".into());
        }
        let package: serde_json::Value = serde_json::from_slice(
            &fs::read(package_path).map_err(|e| e.to_string())?
        ).map_err(|e| e.to_string())?;
        if !package.pointer("/scripts/tauri:build").and_then(|value| value.as_str()).is_some() {
            return Err("No tauri:build script in the selected project".into());
        }

        let running_exe = fs::canonicalize(env::current_exe().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let binary = format!("{}.exe", env!("CARGO_PKG_NAME"));
        if !running_exe.file_name().is_some_and(|name|
            name.to_string_lossy().eq_ignore_ascii_case(&binary))
        {
            return Err("Running executable is not the project's Cargo binary".into());
        }
        let target_dir = root.join("src-tauri/target").join(STAGING_DIR);
        let staged_exe = target_dir.join("release").join(binary);
        Ok(SelfBuildPlan { target_dir, staged_exe, running_exe, root })
    }
}

/// Spawn the newly built binary as an unmanaged, detached handoff. The old
/// process is not closed unless the helper could first be started successfully.
pub(crate) fn schedule(plan: &SelfBuildPlan) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = plan;
        Err("Restart handoff is unavailable on this platform".into())
    }
    #[cfg(windows)]
    {
        use std::process::Stdio;
        if !plan.staged_exe.is_file() {
            return Err(format!(
                "Build finished, but the staged executable was not found at {}.                  Check CARGO_TARGET_DIR and the Tauri build output; current app remains open.",
                plan.staged_exe.display()
            ));
        }
        crate::process::background_command(&plan.staged_exe)
            .arg(HELPER_FLAG)
            .arg(std::process::id().to_string())
            .arg(&plan.running_exe)
            .arg(&plan.root)
            .current_dir(&plan.root)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Build succeeded but could not start the restart helper: {e}"))?;
        Ok(())
    }
}

/// Invoked before initializing Tauri in the newly compiled EXE. Returning true
/// means the process was launched in helper mode and must not open a GUI.
pub fn maybe_handle_helper() -> bool {
    #[cfg(not(windows))]
    {
        false
    }
    #[cfg(windows)]
    {
        use std::{env, fs};
        let mut args = env::args_os().skip(1);
        if args.next().as_deref() != Some(std::ffi::OsStr::new(HELPER_FLAG)) {
            return false;
        }
        let pid = args.next().and_then(|v| v.to_str().and_then(|v| v.parse::<u32>().ok()));
        let target = args.next().map(PathBuf::from);
        let root = args.next().map(PathBuf::from);
        if args.next().is_some() { return true; }

        let (Some(pid), Some(target), Some(root)) = (pid, target, root) else {
            return true;
        };
        let result = run_helper(pid, &target, &root);
        let log_file = root.join("src-tauri/target").join(STAGING_DIR).join("self-restart.log");
        let message = match &result {
            Ok(path) => format!("Restarted from {}\n", path.display()),
            Err(error) => format!("Self-build restart failed: {error}\n"),
        };
        let _ = fs::write(log_file, message);
        true
    }
}

#[cfg(windows)]
fn run_helper(pid: u32, target: &Path, root: &Path) -> Result<PathBuf, String> {
    use std::{env, fs};
    if pid == 0 { return Err("Invalid parent process ID".into()); }
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let staged = fs::canonicalize(env::current_exe().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let name = staged.file_name().ok_or("Staged executable has no file name")?;
    let expected = root.join("src-tauri/target").join(STAGING_DIR).join("release").join(name);
    if staged != expected {
        return Err("Restart helper is not running from this project's staged output".into());
    }
    if !target.is_absolute() || !target.file_name().is_some_and(|value| value.to_string_lossy()
        .eq_ignore_ascii_case(&name.to_string_lossy()))
    {
        return Err("Restart target executable does not match this build".into());
    }

    // Wait on the actual Windows process handle, not an arbitrary sleep or
    // taskkill. Never overwrite or relaunch while the old GUI is still alive.
    wait_for_parent_exit(pid)?;

    // In-place replacement is only safe for this worktree's *release* build.
    // Installed copies and tauri-dev/debug EXEs are deliberately left intact;
    // in those cases the newly staged binary is launched directly.
    let release_dir = root.join("src-tauri/target/release");
    if target.starts_with(&release_dir) && target.is_file() {
        if replace_release_executable(&staged, target).is_ok() {
            if launch_gui(target, &root).is_ok() {
                return Ok(target.to_path_buf());
            }
        }
    }
    launch_gui(&staged, &root)?;
    Ok(staged)
}

#[cfg(windows)]
fn wait_for_parent_exit(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
    // SYNCHRONIZE is a standard access right for waiting on a process handle.
    let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
    if handle.is_null() {
        let error = std::io::Error::last_os_error();
        // ERROR_INVALID_PARAMETER: the old process already terminated before
        // the helper could open a handle to it.
        return if error.raw_os_error() == Some(87) { Ok(()) } else {
            Err(format!("Cannot wait for previous application: {error}"))
        };
    }
    let status = unsafe { WaitForSingleObject(handle, 120_000) };
    unsafe { CloseHandle(handle); }
    match status {
        0 => Ok(()), // WAIT_OBJECT_0: prior EXE is fully terminated.
        0x102 => Err("Previous application did not exit within 120 seconds".into()),
        _ => Err(format!("Waiting for previous application failed (Win32: {status})")),
    }
}

#[cfg(windows)]
fn adjacent_file(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(windows)]
fn replace_release_executable(staged: &Path, target: &Path) -> Result<(), String> {
    use std::{fs, thread, time::Duration};
    let staged_copy = adjacent_file(target, ".self-build-new");
    let backup = adjacent_file(target, ".self-build-previous");
    // Copy first. The EXE serving as the helper remains running and should
    // never be renamed or deleted by the helper itself.
    fs::copy(staged, &staged_copy).map_err(|e| format!("Cannot stage replacement: {e}"))?;
    if backup.exists() {
        fs::remove_file(&backup).map_err(|e| format!("Cannot remove old backup: {e}"))?;
    }
    let mut last_error = String::new();
    let mut renamed = false;
    for _ in 0..40 {
        match fs::rename(target, &backup) {
            Ok(()) => { renamed = true; break; }
            Err(error) => {
                last_error = error.to_string();
                thread::sleep(Duration::from_millis(250));
            }
        }
    }
    if !renamed {
        let _ = fs::remove_file(&staged_copy);
        return Err(format!("Running executable is still locked: {last_error}"));
    }
    if let Err(error) = fs::rename(&staged_copy, target) {
        let rollback = fs::rename(&backup, target);
        let _ = fs::remove_file(&staged_copy);
        return Err(format!("Cannot install the new executable: {error}; rollback: {rollback:?}"));
    }
    // Leave a previous-version backup for manual recovery; it is overwritten
    // on the next successful in-worktree self-build.
    Ok(())
}

#[cfg(windows)]
fn launch_gui(executable: &Path, root: &Path) -> Result<(), String> {
    use std::process::Stdio;
    crate::process::background_command(executable)
        .current_dir(root)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Cannot relaunch {}: {e}", executable.display()))?;
    Ok(())
}
