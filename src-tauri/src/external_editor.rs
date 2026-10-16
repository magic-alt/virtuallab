//! Open registered Git worktrees as independent projects in an external editor.
//! No shell evaluation, unchecked paths, Git mutations, or process ownership.
use crate::cli_path::find_executable;
use crate::git::resolve_git_workspace;
use crate::process::background_command;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExternalEditor {
    Auto,
    Zed,
    Vscode,
    Cursor,
}

impl ExternalEditor {
    fn label(self) -> &'static str {
        match self {
            Self::Auto => "default editor",
            Self::Zed => "Zed",
            Self::Vscode => "VS Code",
            Self::Cursor => "Cursor",
        }
    }

    fn executable_names(self) -> &'static [&'static str] {
        match self {
            Self::Zed => {
                #[cfg(windows)]
                { &["zed.exe"] }
                #[cfg(not(windows))]
                { &["zed", "zeditor"] }
            }
            Self::Vscode => {
                #[cfg(windows)]
                { &["code.exe", "Code.exe"] }
                #[cfg(not(windows))]
                { &["code"] }
            }
            Self::Cursor => {
                #[cfg(windows)]
                { &["cursor.exe", "Cursor.exe"] }
                #[cfg(not(windows))]
                { &["cursor"] }
            }
            Self::Auto => &[],
        }
    }

    fn new_window_flag(self) -> &'static str {
        match self {
            Self::Zed => "--new",
            Self::Vscode | Self::Cursor => "--new-window",
            Self::Auto => unreachable!("resolve auto before constructing a launch"),
        }
    }
}

/// On Windows Zed has *two* executables; its bin/zed.exe CLI is required
/// for --new and workspace-directory arguments (not the GUI root zed.exe).
fn installation_paths(editor: ExternalEditor) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local).join("Programs");
            match editor {
                ExternalEditor::Zed => paths.push(local.join("Zed/bin/zed.exe")),
                ExternalEditor::Vscode => paths.push(local.join("Microsoft VS Code/Code.exe")),
                ExternalEditor::Cursor => {
                    paths.push(local.join("cursor/Cursor.exe"));
                    paths.push(local.join("Cursor/Cursor.exe"));
                }
                ExternalEditor::Auto => {}
            }
        }
        for name in ["PROGRAMFILES", "PROGRAMFILES(X86)"] {
            if let Some(base) = std::env::var_os(name) {
                let base = PathBuf::from(base);
                match editor {
                    ExternalEditor::Zed => paths.push(base.join("Zed/bin/zed.exe")),
                    ExternalEditor::Vscode => paths.push(base.join("Microsoft VS Code/Code.exe")),
                    ExternalEditor::Cursor => paths.push(base.join("Cursor/Cursor.exe")),
                    ExternalEditor::Auto => {}
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut app_dirs = vec![PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME") {
            app_dirs.push(PathBuf::from(home).join("Applications"));
        }
        for base in app_dirs {
            match editor {
                ExternalEditor::Zed => paths.push(base.join("Zed.app/Contents/MacOS/cli")),
                ExternalEditor::Vscode => paths.push(base.join("Visual Studio Code.app/Contents/Resources/app/bin/code")),
                ExternalEditor::Cursor => paths.push(base.join("Cursor.app/Contents/Resources/app/bin/cursor")),
                ExternalEditor::Auto => {}
            }
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = editor;
    paths
}

fn search_directories() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    #[cfg(target_os = "macos")]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]
        .map(PathBuf::from));
    dirs
}

fn locate_editor(editor: ExternalEditor) -> Option<PathBuf> {
    // Prefer Windows' known CLI location over a PATH entry pointing at Zed's
    // GUI binary, which is not interchangeable with the Zed CLI.
    let defaults = installation_paths(editor);
    for path in defaults {
        if find_executable(&path, &[]).is_some() {
            return Some(path);
        }
    }
    let directories = search_directories();
    editor.executable_names().iter().find_map(|name|
        find_executable(Path::new(name), &directories))
}

/// Interpret only the *recognized editor binary*, never execute the contents
/// of VISUAL/EDITOR as a shell command (which may contain flags or scripts).
fn editor_from_setting(value: &str) -> Option<ExternalEditor> {
    let value = value.trim();
    let executable = if let Some(rest) = value.strip_prefix('"') {
        rest.split('"').next()?
    } else {
        value.split_whitespace().next()?
    };
    let name = executable.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    match name.as_str() {
        "zed" | "zed.exe" | "zeditor" => Some(ExternalEditor::Zed),
        "code" | "code.exe" | "code.cmd" => Some(ExternalEditor::Vscode),
        "cursor" | "cursor.exe" | "cursor.cmd" => Some(ExternalEditor::Cursor),
        _ => None,
    }
}

fn select_editor(requested: ExternalEditor) -> Result<(ExternalEditor, PathBuf), String> {
    if requested != ExternalEditor::Auto {
        return locate_editor(requested)
            .map(|binary| (requested, binary))
            .ok_or_else(|| format!("{} is not installed or its CLI cannot be found. Add it to PATH or install its desktop application (Zed on Windows: %LOCALAPPDATA%\\Programs\\Zed\\bin\\zed.exe).", requested.label()));
    }
    let preferred = ["VISUAL", "EDITOR"].iter()
        .filter_map(|key| std::env::var(key).ok())
        .find_map(|value| editor_from_setting(&value));
    let candidates = preferred.into_iter()
        .chain([ExternalEditor::Zed, ExternalEditor::Vscode, ExternalEditor::Cursor]);
    for editor in candidates {
        if let Some(binary) = locate_editor(editor) {
            return Ok((editor, binary));
        }
    }
    Err("No supported IDE was found. Install Zed, VS Code, or Cursor, or add its CLI to PATH. You can select a specific editor in the workspace header.".into())
}

fn open_workspace_in_editor_blocking(
    repository_root: String,
    workspace_root: String,
    editor: ExternalEditor,
) -> Result<(), String> {
    // Native revalidation is essential: a stale UI must never launch an
    // unrelated path or a worktree that was removed by another process.
    let (_, workspace) = resolve_git_workspace(&repository_root, &workspace_root)?;
    if !Path::new(&workspace).is_dir() {
        return Err(format!("Workspace directory no longer exists: {workspace}"));
    }
    #[cfg(windows)]
    let workspace = crate::process::windows_desktop_path(&workspace);
    let (resolved_editor, binary) = select_editor(editor)?;
    let mut command = background_command(&binary);
    command
        .arg(resolved_editor.new_window_flag())
        .arg(&workspace)
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    launch_editor(command, resolved_editor.label())
}

fn launch_editor(mut command: std::process::Command, label: &str) -> Result<(), String> {
    let mut child = command.spawn()
        .map_err(|error| format!("Could not start {label}: {error}"))?;
    // Catch CLI argument/initialization failures before reporting success.
    // GUI binaries can stay alive indefinitely; keep the wait bounded and
    // leave the user's IDE running independently after this launch window.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(750);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!(
                "{label} could not open the workspace (launcher exited with {status}). Check the editor installation and CLI.",
            )),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            result => {
                std::thread::spawn(move || { let _ = child.wait(); });
                return result.map(|_| ()).map_err(|error|
                    format!("Could not check {label} startup: {error}"));
            }
        }
    }
}

#[tauri::command]
pub async fn open_workspace_in_editor(
    repository_root: String,
    workspace_root: String,
    editor: ExternalEditor,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace_in_editor_blocking(repository_root, workspace_root, editor)
    })
    .await
    .map_err(|error| format!("Open external editor task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn editor_early_exit_is_reported_instead_of_silent_success() {
        // Fixed test executable/arguments; the public API never accepts shell text.
        let mut command = background_command("/bin/sh");
        command.args(["-c", "exit 7"]);
        let error = launch_editor(command, "fixture editor").unwrap_err();
        assert!(error.contains("fixture editor") && error.contains('7'));
    }

    #[cfg(unix)]
    #[test]
    fn successful_editor_shim_returns_success() {
        let mut command = background_command("/bin/sh");
        command.args(["-c", "exit 0"]);
        assert!(launch_editor(command, "fixture editor").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn running_editor_does_not_block_until_it_closes() {
        let mut command = background_command("/bin/sleep");
        command.arg("2");
        let start = std::time::Instant::now();
        assert!(launch_editor(command, "fixture editor").is_ok());
        assert!(start.elapsed() < std::time::Duration::from_millis(1500));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn installed_zed_launcher_supports_new_window_arguments() {
        // A real app installation exposes the GUI/CLI distinction: the GUI
        // accepts --help but rejects the --new flag used by this adapter.
        if let Some(binary) = locate_editor(ExternalEditor::Zed) {
            let output = background_command(binary).arg("--help").output().unwrap();
            assert!(output.status.success());
            assert!(String::from_utf8_lossy(&output.stdout).contains("--new"),
                "Zed launcher must support opening an independent workspace");
        }
    }

    #[test]
    fn accepts_only_supported_editor_ids() {
        for name in [r#""auto""#, r#""zed""#, r#""vscode""#, r#""cursor""#] {
            assert!(serde_json::from_str::<ExternalEditor>(name).is_ok());
        }
        for name in [r#""shell""#, r#""bash""#, r#""../../other""#] {
            assert!(serde_json::from_str::<ExternalEditor>(name).is_err());
        }
    }

    #[test]
    fn default_editor_setting_cannot_become_an_arbitrary_command() {
        assert_eq!(editor_from_setting("zed --wait"), Some(ExternalEditor::Zed));
        assert_eq!(editor_from_setting(r#""C:\\Program Files\\Zed\\bin\\zed.exe" --wait"#), Some(ExternalEditor::Zed));
        assert_eq!(editor_from_setting("code --wait"), Some(ExternalEditor::Vscode));
        assert_eq!(editor_from_setting("cursor"), Some(ExternalEditor::Cursor));
        assert_eq!(editor_from_setting("cmd /c something"), None);
        assert_eq!(editor_from_setting("sh -c something"), None);
    }

    #[test]
    fn each_editor_opens_its_own_window_not_reusing_another_worktree() {
        assert_eq!(ExternalEditor::Zed.new_window_flag(), "--new");
        assert_eq!(ExternalEditor::Vscode.new_window_flag(), "--new-window");
        assert_eq!(ExternalEditor::Cursor.new_window_flag(), "--new-window");
    }

    #[test]
    fn refuses_paths_that_are_not_git_worktrees_before_editor_lookup() {
        let missing = std::env::temp_dir().join(format!("virtuallab no-worktree {}", std::process::id()));
        let result = open_workspace_in_editor_blocking(
            missing.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
            ExternalEditor::Zed,
        );
        assert!(result.is_err());
    }
}
