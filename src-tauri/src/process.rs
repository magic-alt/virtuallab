//! Background subprocess creation for a GUI-hosted Tauri application.
//!
//! Windows starts console programs (git.exe, gh.exe, where.exe, cmd.exe,
//! build/test tools) in visible console windows unless CREATE_NO_WINDOW is
//! specified when this app is built as a GUI subsystem executable.
//! Do not use this for the intentionally interactive portable-pty terminal.
//!
//! Keep all non-interactive native process execution behind this helper.
use std::ffi::OsStr;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Win32 CREATE_NO_WINDOW, applied only to background child processes.
/// stdout/stderr pipes continue to work, and this does not change process
/// exit codes or turn explicit terminal/PTY sessions into hidden processes.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)] // Windows creation_flags mutates the command.
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(test)]
mod tests {
    use super::background_command;

    #[test]
    fn background_child_preserves_output_and_exit_status() {
        let output = background_command("git")
            .arg("--version")
            .output()
            .expect("Git is required by the workbench acceptance tests");
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("git version"));
    }

    #[test]
    fn no_native_background_service_bypasses_hidden_launcher() {
        // Guard this desktop regression when future adapters are added.
        // Deliberately excludes portable-pty::CommandBuilder, which creates
        // an explicitly requested interactive terminal.
        for (name, source) in [
            ("git", include_str!("git.rs")),
            ("github", include_str!("github.rs")),
            ("execution", include_str!("execution.rs")),
            ("agent", include_str!("agent.rs")),
            ("agent_cli", include_str!("agent_cli.rs")),
            ("verification", include_str!("verification.rs")),
        ] {
            assert!(!source.contains("Command::new("),
                "{name} bypassed background_command and may flash a console on Windows");
        }
    }

    #[cfg(windows)]
    #[test]
    fn background_cmd_wrapper_keeps_stdout_available() {
        let output = background_command("cmd.exe")
            .args(["/d", "/c", "echo", "background-process-test"])
            .output()
            .expect("Windows command interpreter must launch");
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("background-process-test"));
    }
}

/// All non-interactive managed runs receive an isolated Unix process group.
pub(crate) fn configure_process_tree(command: &mut Command) {
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))] let _ = command;
}
pub(crate) fn terminate_pid(pid: u32) -> Result<(), String> {
    #[cfg(windows)] {
        let status = background_command("taskkill.exe").args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .status().map_err(|e| format!("Cannot terminate process tree: {e}"))?;
        if !status.success() { return Err("Process tree termination was not confirmed".into()); }
    }
    #[cfg(unix)] {
        signal_group(pid, libc::SIGTERM)?;
        std::thread::sleep(std::time::Duration::from_millis(250));
        signal_group(pid, libc::SIGKILL)?;
    }
    Ok(())
}
pub(crate) fn terminate_tree(child: &mut crate::managed_process::ManagedChild) -> Result<(), String> {
    let tree_result = child.terminate_remaining().map_err(|e| e.to_string());
    let _ = child.kill();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() { return tree_result; }
        if std::time::Instant::now() >= deadline { return Err("Process exit was not confirmed within 3 seconds".into()); }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

#[cfg(unix)]
pub(crate) fn signal_group(pid: u32, signal: i32) -> Result<(), String> {
    let pid = i32::try_from(pid).map_err(|_| "Invalid process group")?;
    if pid <= 1 { return Err("Refusing to signal an invalid process group".into()); }
    // SAFETY: only the isolated group of an owned process is used; no pointers.
    if unsafe { libc::kill(-pid, signal) } == 0 { return Ok(()); }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) { Ok(()) } else { Err(format!("Process group signal failed: {error}")) }
}
#[cfg(unix)]
pub(crate) fn group_exited(pid: u32) -> Result<bool, String> {
    let group = i32::try_from(pid).map_err(|_| "Invalid process group")?;
    if group <= 1 { return Err("Invalid process group".into()); }
    // SAFETY: signal zero only checks group existence/permission.
    if unsafe { libc::kill(-group, 0) } == -1 {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ESRCH) { Ok(true) } else { Err(error.to_string()) };
    }
    #[cfg(target_os = "linux")] {
        // Linux kill(0) also sees unreaped zombies, which cannot execute or hold pipes.
        // Inspect only process stat, never process environments or command arguments.
        for item in std::fs::read_dir("/proc").map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            if item.file_name().to_string_lossy().parse::<u32>().is_err() { continue; }
            let stat = match std::fs::read_to_string(item.path().join("stat")) {
                Ok(stat) => stat,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("Cannot verify process group exit: {error}")),
            };
            let Some(end) = stat.rfind(')') else { return Err("Invalid process stat".into()); };
            let fields: Vec<_> = stat[end+1..].split_whitespace().collect();
            if fields.get(2).and_then(|field| field.parse::<u32>().ok()) == Some(pid)
                && !matches!(fields.first().copied(), Some("Z" | "X")) { return Ok(false); }
        }
        return Ok(true);
    }
    #[cfg(not(target_os = "linux"))] Ok(false)
}
