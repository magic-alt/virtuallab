//! Opt-in, repository-neutral build workflow discovery and sequential execution.
//! Only explicitly requested user actions start processes. Presets never flash,
//! publish, or deploy, and the executor never interprets a shell command string.
use crate::execution::process_command;
use crate::output_decode::Utf8StreamDecoder;
use crate::process::background_command;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const MAX_STEPS: usize = 12;
const MAX_ARGS: usize = 64;
const MAX_DISCOVERY_DIRS: usize = 180;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildStep {
    name: String,
    program: String,
    args: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSuggestion {
    id: String,
    name: String,
    kind: String,
    tool: String,
    description: String,
    supported: bool,
    steps: Vec<BuildStep>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildWorkflowSpec {
    id: String,
    cwd: String,
    steps: Vec<BuildStep>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildEvent {
    event_type: &'static str,
    id: String,
    step_index: Option<usize>,
    step_name: Option<String>,
    stream: Option<&'static str>,
    data: Option<String>,
    exit_code: Option<i32>,
    result: Option<&'static str>,
    timestamp_ms: u128,
}

impl BuildEvent {
    fn new(event_type: &'static str, id: &str) -> Self {
        Self {
            event_type,
            id: id.to_owned(),
            step_index: None,
            step_name: None,
            stream: None,
            data: None,
            exit_code: None,
            result: None,
            timestamp_ms: now_ms(),
        }
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn emit(app: &AppHandle, event: BuildEvent) {
    let _ = app.emit("build://event", event);
}

#[derive(Default)]
struct ActiveBuild {
    cancel: AtomicBool,
    child: Mutex<Option<Child>>,
}

#[derive(Clone, Default)]
pub struct BuildWorkflowManager {
    active: Arc<Mutex<HashMap<String, Arc<ActiveBuild>>>>,
}

#[tauri::command]
pub fn build_workflow_discover(workspace_root: String) -> Result<Vec<BuildSuggestion>, String> {
    let root = fs::canonicalize(&workspace_root)
        .map_err(|error| format!("Cannot inspect build workspace: {error}"))?;
    if !root.is_dir() {
        return Err("Build workspace must be an existing directory".to_string());
    }
    Ok(discover(&root))
}

fn step(name: &str, program: &str, args: &[&str]) -> BuildStep {
    BuildStep {
        name: name.into(),
        program: program.into(),
        args: args.iter().map(|s| (*s).into()).collect(),
    }
}

fn discover(root: &Path) -> Vec<BuildSuggestion> {
    let mut found = Vec::new();

    let package = root.join("package.json");
    // Bounds prevent accidental parsing of a large/generated package manifest.
    if fs::metadata(&package).map(|m| m.len() < 1_048_576).unwrap_or(false) {
        if let Ok(content) = fs::read_to_string(package) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                let scripts = json.get("scripts").and_then(|s| s.as_object());
                // Tauri packaging builds the frontend and native host. Prefer it
                // over npm build, which generally outputs web assets only.
                if scripts.and_then(|s| s.get("tauri:build")).and_then(|v| v.as_str()).is_some() {
                    found.push(BuildSuggestion {
                        id: "npm-tauri-package".into(),
                        name: "Tauri · Desktop build".into(),
                        kind: "package".into(),
                        tool: "Node.js / Tauri".into(),
                        description: "Build the frontend, Rust backend and desktop bundle (npm run tauri:build). Does not install or publish.".into(),
                        supported: true,
                        steps: vec![step("Build desktop app", "npm", &["run", "tauri:build"])],
                    });
                }
                if scripts.and_then(|s| s.get("build")).and_then(|v| v.as_str()).is_some() {
                    found.push(BuildSuggestion {
                        id: "npm-build".into(),
                        name: "npm · Frontend only".into(),
                        kind: "build".into(),
                        tool: "Node.js / npm".into(),
                        description: "Build frontend assets into dist/ (npm run build). This does not compile Rust or generate an installer.".into(),
                        supported: true,
                        steps: vec![step("Build frontend", "npm", &["run", "build"])],
                    });
                }
            }
        }
    }

    if root.join("CMakeLists.txt").is_file() {
        let is_qt = fs::read_to_string(root.join("CMakeLists.txt"))
            .map(|source| source.contains("find_package(Qt") || source.contains("QT_VERSION_MAJOR"))
            .unwrap_or(false);
        found.push(BuildSuggestion {
            id: "cmake-configure-build".into(),
            name: if is_qt { "Qt / CMake · Build" } else { "CMake · Build" }.into(),
            kind: "build".into(),
            tool: if is_qt { "Qt / CMake" } else { "CMake" }.into(),
            description: "Configure into build/virtuallab, then compile. Edit the profile for Qt paths, generator and target.".into(),
            supported: true,
            steps: vec![
                step("Configure", "cmake", &["-S", ".", "-B", "build/virtuallab"]),
                step("Compile", "cmake", &["--build", "build/virtuallab", "--config", "Release"]),
            ],
        });
    }

    for relative in find_keil_projects(root) {
        found.push(BuildSuggestion {
            id: format!("keil-{relative}"),
            name: format!("Keil · {relative}"),
            kind: "build".into(),
            tool: "Keil MDK / µVision".into(),
            description: "Keil UV4 batch build (Windows only). Set the UV4.exe path in an editable profile if not on PATH. No flash.".into(),
            supported: cfg!(windows),
            steps: vec![BuildStep {
                name: "Compile firmware".into(),
                program: "UV4.exe".into(),
                args: vec!["-b".into(), relative],
            }],
        });
    }

    found
}

fn find_keil_projects(root: &Path) -> Vec<String> {
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut projects = Vec::new();
    let mut visited = 0;
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        if visited > MAX_DISCOVERY_DIRS || projects.len() >= 8 {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() { continue; }
            let path = entry.path();
            if kind.is_file() && path.extension()
                .and_then(|v| v.to_str())
                .map(|v| v.eq_ignore_ascii_case("uvprojx"))
                .unwrap_or(false)
            {
                if let Ok(relative) = path.strip_prefix(root) {
                    projects.push(relative.to_string_lossy().replace('\\', "/"));
                }
            } else if kind.is_dir() && depth < 3 {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if !matches!(name.as_str(), ".git" | ".worktrees" | ".virtuallab" | "node_modules" |
                    "target" | "build" | "dist" | "vendor" | ".venv")
                {
                    queue.push_back((path, depth + 1));
                }
            }
            if projects.len() >= 8 { break; }
        }
    }
    projects
}

fn validate_spec(spec: &BuildWorkflowSpec) -> Result<PathBuf, String> {
    if spec.id.trim().is_empty() || spec.id.len() > 160 {
        return Err("Invalid workflow run ID".into());
    }
    if spec.steps.is_empty() || spec.steps.len() > MAX_STEPS {
        return Err(format!("A workflow must contain 1–{MAX_STEPS} steps"));
    }
    for build in &spec.steps {
        if build.name.trim().is_empty() || build.name.len() > 160 ||
           build.program.trim().is_empty() || build.program.len() > 2048 ||
           build.program.contains('\0') || build.program.contains('\n') ||
           build.args.len() > MAX_ARGS ||
           build.args.iter().any(|arg| arg.len() > 8192 || arg.contains('\0'))
        {
            return Err("Invalid workflow step (program, name or arguments)".into());
        }
    }
    let root = fs::canonicalize(&spec.cwd)
        .map_err(|error| format!("Cannot resolve build workspace: {error}"))?;
    if !root.is_dir() {
        return Err("Build workspace must be a directory".into());
    }
    Ok(root)
}

#[tauri::command]
pub fn build_workflow_start(
    app: AppHandle,
    state: State<'_, BuildWorkflowManager>,
    spec: BuildWorkflowSpec,
) -> Result<(), String> {
    let root = validate_spec(&spec)?;
    let run = Arc::new(ActiveBuild::default());
    let manager = state.inner().clone();
    {
        let mut active = manager.active.lock()
            .map_err(|_| "Build manager lock poisoned".to_string())?;
        if active.contains_key(&spec.id) {
            return Err("Build workflow ID already running".into());
        }
        active.insert(spec.id.clone(), run.clone());
    }

    let id = spec.id.clone();
    let thread_manager = manager.clone();
    let task = thread::Builder::new()
        .name("virtuallab-build-workflow".into())
        .spawn(move || execute_workflow(app, thread_manager, run, spec, root));
    if let Err(error) = task {
        if let Ok(mut active) = manager.active.lock() { active.remove(&id); }
        return Err(format!("Cannot start workflow thread: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub fn build_workflow_cancel(
    state: State<'_, BuildWorkflowManager>,
    id: String,
) -> Result<(), String> {
    let active = state.active.lock()
        .map_err(|_| "Build manager lock poisoned".to_string())?
        .get(&id).cloned();
    if let Some(active) = active {
        active.cancel.store(true, Ordering::SeqCst);
        // The workflow worker terminates its own process group. This avoids
        // blocking the UI on slow compiler shutdown or on a held child lock.
    }
    Ok(())
}

fn execute_workflow(
    app: AppHandle,
    manager: BuildWorkflowManager,
    active: Arc<ActiveBuild>,
    spec: BuildWorkflowSpec,
    root: PathBuf,
) {
    emit(&app, BuildEvent::new("build.started", &spec.id));
    let mut result = "passed";
    let mut exit_code = Some(0);

    for (index, step) in spec.steps.iter().enumerate() {
        if active.cancel.load(Ordering::SeqCst) {
            result = "stopped";
            exit_code = None;
            break;
        }

        let mut event = BuildEvent::new("build.step_started", &spec.id);
        event.step_index = Some(index);
        event.step_name = Some(step.name.clone());
        emit(&app, event);

        let mut command = process_command(step.program.trim());
        command.args(&step.args).current_dir(&root)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let mut event = BuildEvent::new("build.output", &spec.id);
                event.stream = Some("system");
                event.data = Some(format!("Failed to launch {}: {error}\n", step.program));
                event.step_index = Some(index);
                emit(&app, event);
                result = "failed";
                exit_code = Some(-1);
                break;
            }
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut slot = active.child.lock().unwrap_or_else(|e| e.into_inner());
            *slot = Some(child);
        }
        let mut readers = Vec::new();
        if let Some(stdout) = stdout {
            readers.push(stream_output(app.clone(), spec.id.clone(), index, "stdout", stdout));
        }
        if let Some(stderr) = stderr {
            readers.push(stream_output(app.clone(), spec.id.clone(), index, "stderr", stderr));
        }

        let mut termination_sent = false;
        let status = loop {
            let mut slot = active.child.lock().unwrap_or_else(|e| e.into_inner());
            let Some(child) = slot.as_mut() else {
                break Err("Build child disappeared".to_string());
            };
            if active.cancel.load(Ordering::SeqCst) && !termination_sent {
                terminate_tree(child);
                termination_sent = true;
            }
            let polled = child.try_wait();
            drop(slot);
            match polled {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => thread::sleep(Duration::from_millis(60)),
                Err(error) => break Err(format!("Build wait failed: {error}")),
            }
        };
        // Wait for all output readers before reporting a finished step, so
        // the UI does not lose the last compiler diagnostic on fast exits.
        for reader in readers { let _ = reader.join(); }
        {
            let mut slot = active.child.lock().unwrap_or_else(|e| e.into_inner());
            *slot = None;
        }

        if active.cancel.load(Ordering::SeqCst) {
            result = "stopped";
            exit_code = None;
            break;
        }
        let code = match status {
            Ok(status) => status.code().unwrap_or(-1),
            Err(error) => {
                let mut event = BuildEvent::new("build.output", &spec.id);
                event.stream = Some("system");
                event.data = Some(error);
                emit(&app, event);
                -1
            }
        };
        let mut event = BuildEvent::new("build.step_exited", &spec.id);
        event.step_index = Some(index);
        event.exit_code = Some(code);
        emit(&app, event);
        if code != 0 {
            result = "failed";
            exit_code = Some(code);
            break;
        }
    }

    if active.cancel.load(Ordering::SeqCst) {
        result = "stopped";
        exit_code = None;
    }
    let mut finished = BuildEvent::new("build.finished", &spec.id);
    finished.result = Some(result);
    finished.exit_code = exit_code;
    emit(&app, finished);
    if let Ok(mut items) = manager.active.lock() { items.remove(&spec.id); }
}

fn stream_output<R: Read + Send + 'static>(
    app: AppHandle, id: String, index: usize, stream: &'static str, reader: R,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = std::io::BufReader::new(reader);
        let mut decoder = Utf8StreamDecoder::default();
        let mut buf = [0u8; 4096];
        let emit_data = |data: String| {
            if data.is_empty() { return; }
            let mut event = BuildEvent::new("build.output", &id);
            event.step_index = Some(index);
            event.stream = Some(stream);
            event.data = Some(data);
            emit(&app, event);
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => emit_data(decoder.push(&buf[..n])),
                Err(_) => break,
            }
        }
        emit_data(decoder.finish());
    })
}

fn terminate_tree(child: &mut Child) {
    let pid = child.id().to_string();
    #[cfg(windows)]
    {
        let _ = background_command("taskkill").args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(unix)]
    {
        // Child is launched as its own process group; negative PID targets
        // descendants too. Fallback kill handles missing system kill.
        let _ = background_command("kill").args(["-TERM", "--", &format!("-{pid}")])
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    fn fixture() -> PathBuf {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("virtuallab-build-{}-{}-{id}", std::process::id(), now_ms()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn npm_and_qt_are_detected_without_running_any_command() {
        let root = fixture();
        fs::write(root.join("package.json"), r#"{"scripts":{"build":"vite build","tauri:build":"tauri build"}}"#).unwrap();
        fs::write(root.join("CMakeLists.txt"), "find_package(Qt6 REQUIRED COMPONENTS Core)").unwrap();
        let presets = discover(&root);
        assert_eq!(presets.len(), 3);
        assert_eq!(presets[0].id, "npm-tauri-package");
        assert_eq!(presets[0].steps[0].args, vec!["run", "tauri:build"]);
        assert_eq!(presets[1].id, "npm-build");
        assert_eq!(presets[1].steps[0].args, vec!["run", "build"]);
        assert_eq!(presets[2].steps.len(), 2);
        assert_eq!(presets[2].tool, "Qt / CMake");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keil_discovery_is_bounded_and_does_not_follow_links() {
        let root = fixture();
        fs::create_dir_all(root.join("App/MDK-ARM")).unwrap();
        fs::write(root.join("App/MDK-ARM/Firmware.uvprojx"), "<Project/>").unwrap();
        let found = discover(&root);
        assert_eq!(found.len(), 1);
        assert!(found[0].steps[0].args[1].ends_with("Firmware.uvprojx"));
        assert_eq!(found[0].supported, cfg!(windows));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workflow_rejects_shell_strings_and_missing_steps() {
        let root = fixture();
        let mut spec = BuildWorkflowSpec { id: "run".into(), cwd: root.to_string_lossy().to_string(), steps: vec![] };
        assert!(validate_spec(&spec).is_err());
        spec.steps.push(step("Compile", "cmake\nrm -rf /", &["--build", "build"]));
        assert!(validate_spec(&spec).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
