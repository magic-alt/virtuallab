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
const MAX_CMAKE_PRESETS: usize = 16;
const MAX_CMAKE_PRESET_FILE_BYTES: u64 = 1_048_576;
const DEFAULT_CMAKE_BUILD_DIR: &str = "build/auto";

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

// A detected CMake preset belongs to the selected worktree, not to VirtualLab.
// Only the project manifest is read; discovery never invokes cmake or a compiler.
fn cmake_preset_documents(root: &Path) -> Vec<serde_json::Value> {
    ["CMakePresets.json", "CMakeUserPresets.json"]
        .iter()
        .filter_map(|name| {
            let path = root.join(name);
            if !fs::metadata(&path)
                .map(|meta| meta.len() <= MAX_CMAKE_PRESET_FILE_BYTES)
                .unwrap_or(false)
            {
                return None;
            }
            let source = fs::read_to_string(path).ok()?;
            serde_json::from_str(&source).ok()
        })
        .collect()
}

fn cmake_preset_definitions(
    documents: &[serde_json::Value],
    section: &str,
) -> (HashMap<String, serde_json::Value>, Vec<String>) {
    let mut definitions = HashMap::new();
    let mut names = Vec::new();
    for document in documents {
        let Some(items) = document.get(section).and_then(|value| value.as_array()) else {
            continue;
        };
        for item in items {
            let Some(name) = item.get("name").and_then(|value| value.as_str()) else {
                continue;
            };
            if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control)
                || definitions.contains_key(name)
            {
                continue;
            }
            names.push(name.to_string());
            definitions.insert(name.to_string(), item.clone());
        }
    }
    (definitions, names)
}

// CMake permits build/configure presets to inherit settings from hidden base
// presets. Resolve only the metadata used to produce a runnable build pair.
fn inherited_preset_field<'a>(
    definitions: &'a HashMap<String, serde_json::Value>,
    name: &str,
    field: &str,
    depth: usize,
) -> Option<&'a serde_json::Value> {
    if depth >= 16 {
        return None;
    }
    let preset = definitions.get(name)?;
    if let Some(value) = preset.get(field) {
        return Some(value);
    }
    let inherits = preset.get("inherits")?;
    if let Some(parent) = inherits.as_str() {
        return inherited_preset_field(definitions, parent, field, depth + 1);
    }
    inherits.as_array()?.iter().filter_map(|parent| parent.as_str())
        .find_map(|parent| inherited_preset_field(definitions, parent, field, depth + 1))
}

fn cmake_host_system_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "Darwin",
        "linux" => "Linux",
        _ => "",
    }
}

fn expand_cmake_host_macro(value: &str) -> Option<String> {
    let expanded = value.replace("${hostSystemName}", cmake_host_system_name());
    // Unknown macros cannot be safely evaluated without executing CMake;
    // those presets are left to the project's custom workflow.
    if expanded.contains("${") || expanded.contains("$env{") || expanded.contains("$penv{") {
        None
    } else {
        Some(expanded)
    }
}

fn cmake_condition_matches(condition: Option<&serde_json::Value>) -> bool {
    use serde_json::Value;
    match condition {
        None | Some(Value::Null) => true,
        Some(Value::Bool(enabled)) => *enabled,
        Some(Value::Object(object)) => {
            match object.get("type").and_then(|kind| kind.as_str()) {
                Some("const") => object.get("value").and_then(|value| value.as_bool()).unwrap_or(false),
                Some("equals") | Some("notEquals") => {
                    let Some(lhs) = object.get("lhs").and_then(|v| v.as_str()).and_then(expand_cmake_host_macro) else {
                        return false;
                    };
                    let Some(rhs) = object.get("rhs").and_then(|v| v.as_str()).and_then(expand_cmake_host_macro) else {
                        return false;
                    };
                    if object.get("type").and_then(|v| v.as_str()) == Some("equals") { lhs == rhs } else { lhs != rhs }
                }
                Some("allOf") => object.get("conditions").and_then(|v| v.as_array())
                    .map(|items| items.iter().all(|item| cmake_condition_matches(Some(item))))
                    .unwrap_or(false),
                Some("anyOf") => object.get("conditions").and_then(|v| v.as_array())
                    .map(|items| items.iter().any(|item| cmake_condition_matches(Some(item))))
                    .unwrap_or(false),
                Some("not") => object.get("condition").map(|item| !cmake_condition_matches(Some(item))).unwrap_or(false),
                _ => false,
            }
        }
        _ => false,
    }
}

fn discover_cmake_presets(root: &Path, is_qt: bool) -> Vec<BuildSuggestion> {
    let documents = cmake_preset_documents(root);
    let (configure, _) = cmake_preset_definitions(&documents, "configurePresets");
    let (build, order) = cmake_preset_definitions(&documents, "buildPresets");
    let mut results = Vec::new();
    for name in order {
        if results.len() >= MAX_CMAKE_PRESETS {
            break;
        }
        let Some(preset) = build.get(&name) else { continue };
        if preset.get("hidden").and_then(|v| v.as_bool()) == Some(true)
            || !cmake_condition_matches(inherited_preset_field(&build, &name, "condition", 0))
        {
            continue;
        }
        let Some(configure_name) = inherited_preset_field(&build, &name, "configurePreset", 0)
            .and_then(|value| value.as_str()) else { continue };
        let Some(configure_preset) = configure.get(configure_name) else { continue };
        if configure_preset.get("hidden").and_then(|v| v.as_bool()) == Some(true)
            || !cmake_condition_matches(inherited_preset_field(&configure, configure_name, "condition", 0))
        {
            continue;
        }
        let title = preset.get("displayName").and_then(|v| v.as_str())
            .filter(|title| !title.trim().is_empty() && title.len() <= 120)
            .unwrap_or(&name);
        results.push(BuildSuggestion {
            id: format!("cmake-preset-{name}"),
            name: format!("{} · {title}", if is_qt { "Qt / CMake" } else { "CMake" }),
            kind: "build".into(),
            tool: if is_qt { "Qt / CMake" } else { "CMake" }.into(),
            description: format!(
                "Project-defined build preset '{name}' (configure: '{configure_name}'). Generator, build directory, toolchain and Qt paths are owned by this worktree's CMake presets."
            ),
            supported: true,
            steps: vec![
                step("Configure", "cmake", &["--preset", configure_name]),
                step("Compile", "cmake", &["--build", "--preset", &name]),
            ],
        });
    }
    results
}

fn cmake_file_uses_qt(path: &Path) -> bool {
    if !fs::metadata(path).map(|meta| meta.len() <= 131_072).unwrap_or(false) {
        return false;
    }
    fs::read_to_string(path).map(|source|
        source.contains("find_package(Qt") || source.contains("QT_VERSION_MAJOR")
            || source.contains("Qt6::") || source.contains("Qt5::")
    ).unwrap_or(false)
}

fn is_qt_cmake_project(root: &Path) -> bool {
    if cmake_file_uses_qt(&root.join("CMakeLists.txt")) {
        return true;
    }
    // Common Qt repositories include cmake/Qt*.cmake from the root file.
    fs::read_dir(root.join("cmake")).ok().map(|entries| {
        entries.flatten().take(24).any(|entry| {
            entry.file_type().map(|kind| kind.is_file()).unwrap_or(false)
                && entry.path().extension().and_then(|ext| ext.to_str()) == Some("cmake")
                && cmake_file_uses_qt(&entry.path())
        })
    }).unwrap_or(false)
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

    let has_cmake = root.join("CMakeLists.txt").is_file();
    let is_qt = has_cmake && is_qt_cmake_project(root);
    if has_cmake {
        // Project-defined presets come first; generic fallback is listed last.
        found.extend(discover_cmake_presets(root, is_qt));
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

    if has_cmake {
        found.push(BuildSuggestion {
            id: "cmake-configure-build".into(),
            name: if is_qt { "Qt / CMake · Generic build" } else { "CMake · Generic build" }.into(),
            kind: "build".into(),
            tool: if is_qt { "Qt / CMake" } else { "CMake" }.into(),
            description: "Generic fallback: configure into this worktree's build/auto, then compile. Prefer project-defined CMake presets to honor generator, Qt paths, toolchain and targets.".into(),
            supported: true,
            steps: vec![
                step("Configure", "cmake", &["-S", ".", "-B", DEFAULT_CMAKE_BUILD_DIR]),
                step("Compile", "cmake", &["--build", DEFAULT_CMAKE_BUILD_DIR, "--config", "Release"]),
            ],
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
    fn generic_cmake_fallback_uses_a_project_local_not_product_named_build_directory() {
        let first = fixture();
        let second = fixture();
        for root in [&first, &second] {
            fs::write(root.join("CMakeLists.txt"), "project(Independent CXX)").unwrap();
            let builds = discover(root);
            assert_eq!(builds.len(), 1);
            let recipe = &builds[0];
            assert_eq!(recipe.id, "cmake-configure-build");
            assert!(recipe.description.contains("this worktree's build/auto"));
            assert_eq!(recipe.steps[0].args, vec!["-S", ".", "-B", "build/auto"]);
            assert_eq!(recipe.steps[1].args, vec!["--build", "build/auto", "--config", "Release"]);
            assert!(!recipe.description.contains("build/virtuallab"));
            assert!(!root.join("build").exists(), "discovery must not configure the project");
        }
        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
    }

    #[test]
    fn project_cmake_presets_are_first_and_filter_inapplicable_or_hidden_builds() {
        let root = fixture();
        fs::write(root.join("CMakeLists.txt"), "project(OtherProject CXX)").unwrap();
        let project_presets = serde_json::json!({
            "version": 3,
            "configurePresets": [
                {"name": "base", "hidden": true, "generator": "Ninja",
                 "binaryDir": "${sourceDir}/build/${presetName}"},
                {"name": "native-release", "inherits": "base",
                 "condition": {"type": "equals", "lhs": "${hostSystemName}",
                               "rhs": cmake_host_system_name()}},
                {"name": "other-platform", "inherits": "base",
                 "condition": {"type": "equals", "lhs": "${hostSystemName}", "rhs": "NoSuchHost"}}
            ],
            "buildPresets": [
                {"name": "native-release", "configurePreset": "native-release"},
                {"name": "other-platform", "configurePreset": "other-platform"},
                {"name": "hidden-build", "hidden": true, "configurePreset": "native-release"}
            ]
        });
        fs::write(root.join("CMakePresets.json"), project_presets.to_string()).unwrap();
        let user_presets = serde_json::json!({
            "version": 3,
            "configurePresets": [{"name": "user-release", "generator": "Ninja",
                                  "binaryDir": "${sourceDir}/build/user"}],
            "buildPresets": [
                {"name": "parent-user", "hidden": true, "configurePreset": "user-release"},
                {"name": "child-user", "inherits": "parent-user"}
            ]
        });
        fs::write(root.join("CMakeUserPresets.json"), user_presets.to_string()).unwrap();

        let suggestions = discover(&root);
        assert_eq!(suggestions.len(), 3);
        assert_eq!(suggestions[0].id, "cmake-preset-native-release");
        assert_eq!(suggestions[0].steps[0].args, vec!["--preset", "native-release"]);
        assert_eq!(suggestions[0].steps[1].args, vec!["--build", "--preset", "native-release"]);
        assert_eq!(suggestions[1].id, "cmake-preset-child-user");
        assert_eq!(suggestions[1].steps[0].args, vec!["--preset", "user-release"]);
        assert_eq!(suggestions[1].steps[1].args, vec!["--build", "--preset", "child-user"]);
        assert_eq!(suggestions[2].id, "cmake-configure-build");
        assert!(!root.join("build").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn qt_in_an_included_cmake_file_is_identified_without_another_repository() {
        let root = fixture();
        fs::create_dir(root.join("cmake")).unwrap();
        fs::write(root.join("CMakeLists.txt"), "include(cmake/ProjectQt.cmake)").unwrap();
        fs::write(root.join("cmake/ProjectQt.cmake"), "find_package(Qt6 REQUIRED COMPONENTS Widgets)").unwrap();
        let suggestions = discover(&root);
        assert_eq!(suggestions[0].tool, "Qt / CMake");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keil_projects_take_priority_over_generic_cmake_fallback() {
        let root = fixture();
        fs::write(root.join("CMakeLists.txt"), "project(Firmware C)").unwrap();
        fs::write(root.join("Firmware.uvprojx"), "<Project/>").unwrap();
        let suggestions = discover(&root);
        assert_eq!(suggestions[0].name, "Keil · Firmware.uvprojx");
        assert_eq!(suggestions[1].id, "cmake-configure-build");
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
