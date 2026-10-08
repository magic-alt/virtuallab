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
