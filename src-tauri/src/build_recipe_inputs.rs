//! Bounded metadata readers. Script import never reads or executes script content.
use super::{BuildStep, BuildSuggestion};
use std::{fs, io::Read, path::Path};

pub(super) fn keil_program() -> String {
    #[cfg(windows)] {
        if let Some(path) = crate::execution::resolve_windows_program("UV4.exe") {
            if Path::new(&path).is_file() { return path; }
        }
        for key in [r"SOFTWARE\WOW6432Node\Keil\Products\MDK", r"SOFTWARE\Keil\Products\MDK"] {
            if let Some(path) = read_keil_registry_program(key) {
                if Path::new(&path).is_file() { return path; }
            }
        }
    }
    "UV4.exe".into()
}

#[cfg(any(windows, test))]
fn keil_registry_program(wide: &[u16]) -> Option<String> {
    let end = wide.iter().position(|c| *c == 0)?;
    let value = String::from_utf16(&wide[..end]).ok()?;
    if value.is_empty() || value.chars().any(char::is_control) { return None; }
    // Use the registry's installed MDK root, never a repository-specific path.
    let value = value.trim_end_matches(['/', '\\']);
    let parent = value.rfind(['/', '\\'])?;
    Some(format!("{}/UV4/UV4.exe", &value[..parent]))
}

#[cfg(windows)]
fn read_keil_registry_program(key: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let key: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
    let value: Vec<u16> = "Path".encode_utf16().chain(Some(0)).collect();
    let mut bytes = 0u32;
    // Read only the installed MDK Path value, with no expansion or code-page conversion.
    let status = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut bytes) };
    if status != 0 || bytes < 2 || bytes > 8192 || bytes % 2 != 0 { return None; }
    let mut data = vec![0u16; bytes as usize / 2];
    let status = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), data.as_mut_ptr().cast(), &mut bytes) };
    if status != 0 { return None; }
    keil_registry_program(&data)
}

pub(super) fn is_keil_build(step: &BuildStep) -> bool {
    let program = step.program.rsplit(['/', '\\']).next().unwrap_or("");
    (program.eq_ignore_ascii_case("UV4.exe") || program.eq_ignore_ascii_case("UV4"))
        && step.args.iter().any(|arg| matches!(arg.as_str(), "-b" | "-r"))
        && !step.args.iter().any(|arg| matches!(arg.as_str(), "-f" | "-d"))
}

pub(super) fn step_succeeded(step: &BuildStep, code: i32) -> bool {
    code == 0 || (code == 1 && is_keil_build(step))
}

/// A new file for each batch run prevents stale Keil output being shown as a new build.
pub(super) struct KeilLog(std::path::PathBuf);
impl KeilLog {
    pub(super) fn prepare(step: &BuildStep) -> Result<Option<Self>, String> {
        if !is_keil_build(step) { return Ok(None); }
        if step.args.iter().any(|arg| arg.starts_with("-o")) {
            return Err("Keil Run manages its batch log. Remove -o from the profile arguments.".into());
        }
        static NEXT_LOG: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = NEXT_LOG.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("virtuallab-keil-{}-{}-{sequence}.log", std::process::id(), super::now_ms()));
        fs::OpenOptions::new().write(true).create_new(true).open(&path)
            .map_err(|e| format!("Cannot create Keil batch log: {e}"))?;
        Ok(Some(Self(path)))
    }
    pub(super) fn path(&self) -> &Path { &self.0 }
    pub(super) fn read(&self) -> Result<String, String> {
        let file = fs::File::open(&self.0).map_err(|e| format!("Cannot read Keil log: {e}"))?;
        let mut bytes = Vec::new();
        file.take(4 * 1024 * 1024).read_to_end(&mut bytes).map_err(|e| format!("Cannot read Keil log: {e}"))?;
        if bytes.is_empty() { return Err("Keil produced no build log. Check the UV4 path and whether another µVision instance owns the project.".into()); }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}
impl Drop for KeilLog {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}

pub(super) fn keil_targets(path: &Path) -> Vec<String> {
    let Ok(file) = fs::File::open(path) else { return vec![] };
    let mut source = String::new();
    if file.take(8 * 1024 * 1024 + 1).read_to_string(&mut source).is_err() || source.len() > 8 * 1024 * 1024 { return vec![]; }
    let mut reader = quick_xml::Reader::from_str(&source);
    let mut targets = Vec::new();
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(tag)) if tag.name().as_ref() == "TargetName" => {
                let Ok(raw) = reader.read_text(tag.name()) else { return vec![] };
                let Ok(name) = quick_xml::escape::unescape(&raw) else { return vec![] };
                let name = name.trim();
                if !name.is_empty() && name.len() <= 160 && !name.chars().any(char::is_control)
                    && !targets.iter().any(|t| t == name) {
                    targets.push(name.to_owned());
                }
                if targets.len() >= 32 { break; }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => return vec![],
            _ => {}
        }
    }
    targets
}

#[tauri::command]
pub fn build_workflow_import_script(workspace_root: String, script_path: String) -> Result<BuildSuggestion, String> {
    let root = fs::canonicalize(workspace_root).map_err(|e| format!("Cannot resolve build workspace: {e}"))?;
    let selected = Path::new(&script_path);
    let selected = if selected.is_absolute() { selected.to_path_buf() } else { root.join(selected) };
    let path = fs::canonicalize(selected).map_err(|e| format!("Cannot resolve build script: {e}"))?;
    if !root.is_dir() || !path.is_file() { return Err("Select an existing workspace and script file".into()); }
    let relative = path.strip_prefix(&root).map_err(|_| "Build scripts must be inside the selected worktree")?;
    let relative = relative.to_str().ok_or("Build script path must be Unicode")?.replace('\\', "/");
    // CMD can expand percent variables in batch file paths. Reject ambiguous paths,
    // rather than introducing command-string escaping or environment interpolation.
    if relative.chars().any(char::is_control) || relative.contains(['%', '"']) {
        return Err("Unsupported control character, percent or quote in script path".into());
    }
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    let (program, mut args, supported): (String, Vec<String>, bool) = match extension.as_str() {
        "ps1" => ("pwsh".into(), vec!["-NoLogo".into(), "-NoProfile".into(), "-NonInteractive".into(), "-File".into()], true),
        "bat" | "cmd" => (format!("./{relative}"), vec![], cfg!(windows)),
        "sh" => ("bash".into(), vec!["--".into()], !cfg!(windows)),
        "py" => ("python".into(), vec![], true),
        "js" | "mjs" | "cjs" => ("node".into(), vec![], true),
        _ => return Err("Supported build scripts: .ps1, .cmd, .bat, .sh, .py, .js, .mjs, .cjs".into()),
    };
    if !matches!(extension.as_str(), "cmd" | "bat") { args.push(format!("./{relative}")); }
    Ok(BuildSuggestion {
        id: format!("script-{relative}"), name: format!("Build script · {relative}"),
        kind: "build".into(), tool: "Project script".into(),
        description: "Selected project script. Review its interpreter and arguments before saving. Runs from the selected worktree; script-owned toolchain setup is preserved.".into(),
        supported, steps: vec![BuildStep { name: "Build script".into(), program, args }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keil_installation_lookup_preserves_spaces_and_unicode() {
        let wide: Vec<u16> = "D:\\Tools 中文\\Keil MDK\\ARM\\\0".encode_utf16().collect();
        assert_eq!(keil_registry_program(&wide), Some("D:\\Tools 中文\\Keil MDK/UV4/UV4.exe".into()));
        assert!(keil_registry_program(&[0xD800, 0]).is_none());
        assert!(keil_registry_program(&[65]).is_none());
    }
    #[test]
    fn script_import_preserves_space_unicode_paths_and_never_runs_content() {
        let root = super::super::tests::fixture();
        fs::create_dir(root.join("脚本 space")).unwrap();
        let script = root.join("脚本 space/build.ps1");
        fs::write(&script, "throw 'must not execute during import'").unwrap();
        let recipe = build_workflow_import_script(root.to_string_lossy().into(), script.to_string_lossy().into()).unwrap();
        assert_eq!(recipe.steps[0].program, "pwsh");
        assert_eq!(recipe.steps[0].args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", "./脚本 space/build.ps1"]);
        assert!(build_workflow_import_script(root.to_string_lossy().into(), "../outside.ps1".into()).is_err());
        fs::write(root.join("secret.env"), "never read").unwrap();
        assert!(build_workflow_import_script(root.to_string_lossy().into(), "secret.env".into()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imported_node_script_runs_from_selected_worktree_with_literal_arguments() {
        let root = super::super::tests::fixture();
        let script = root.join("build 中文 space.cjs");
        fs::write(&script, "require('node:fs').writeFileSync('artifact.json', JSON.stringify(process.argv.slice(2))); process.exit(7)").unwrap();
        let recipe = build_workflow_import_script(root.to_string_lossy().into(), script.to_string_lossy().into()).unwrap();
        let step = &recipe.steps[0];
        let literal = ["a b", "中文", "a&b", "a|b", "100%", "\"quoted\""];
        let output = crate::execution::workspace_process_command(&step.program, &root)
            .args(&step.args).args(literal).current_dir(&root).output().unwrap();
        assert_eq!(output.status.code(), Some(7), "script failures must reach Run");
        let actual: Vec<String> = serde_json::from_slice(&fs::read(root.join("artifact.json")).unwrap()).unwrap();
        assert_eq!(actual, literal);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imported_batch_script_resolves_against_workspace_including_space_unicode() {
        let root = super::super::tests::fixture();
        fs::create_dir(root.join("scripts 中文 space")).unwrap();
        let script = root.join("scripts 中文 space/build.cmd");
        fs::write(&script, "@echo off\r\nnode.exe -e \"require('fs').writeFileSync('built.txt','ok')\"\r\nexit /b 7\r\n").unwrap();
        let recipe = build_workflow_import_script(root.to_string_lossy().into(), script.to_string_lossy().into()).unwrap();
        assert_eq!(recipe.supported, cfg!(windows));
        #[cfg(windows)] {
            let step = &recipe.steps[0];
            let output = crate::execution::workspace_process_command(&step.program, &root)
                .args(&step.args).current_dir(&root).output().unwrap();
            assert_eq!(output.status.code(), Some(7));
            assert_eq!(fs::read(root.join("built.txt")).unwrap(), b"ok");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_rejects_existing_file_outside_worktree_and_ambiguous_batch_paths() {
        let root = super::super::tests::fixture();
        let outside = super::super::tests::fixture();
        fs::write(outside.join("build.ps1"), "never read").unwrap();
        assert!(build_workflow_import_script(root.to_string_lossy().into(), outside.join("build.ps1").to_string_lossy().into()).is_err());
        fs::write(root.join("build%NAME%.cmd"), "never read").unwrap();
        assert!(build_workflow_import_script(root.to_string_lossy().into(), "build%NAME%.cmd".into()).is_err());
        #[cfg(unix)] {
            std::os::unix::fs::symlink(outside.join("build.ps1"), root.join("linked.ps1")).unwrap();
            assert!(build_workflow_import_script(root.to_string_lossy().into(), "linked.ps1".into()).is_err());
        }
        fs::remove_dir_all(root).unwrap(); fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn keil_batch_log_is_fresh_bounded_and_removed_after_use() {
        let step = super::super::step("Firmware", "UV4.exe", &["-b", "Board.uvprojx"]);
        let log = KeilLog::prepare(&step).unwrap().unwrap();
        let path = log.path().to_owned();
        assert!(log.read().is_err(), "empty log is not evidence of a new build");
        fs::write(&path, "Build: 0 Error(s), 1 Warning(s).").unwrap();
        assert!(log.read().unwrap().contains("1 Warning(s)"));
        drop(log); assert!(!path.exists());
        let custom = super::super::step("Firmware", "UV4.exe", &["-b", "Board.uvprojx", "-o", "old.log"]);
        assert!(KeilLog::prepare(&custom).is_err());
    }
}
