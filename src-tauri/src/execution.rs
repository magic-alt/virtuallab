use crate::process::background_command;
use crate::output_decode::Utf8StreamDecoder;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use crate::managed_process::ManagedChild as Child;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::run_registry::RunRegistry;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    id: String,
    data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchEvent {
    event_type: String,
    id: String,
    stream: Option<String>,
    data: Option<String>,
    exit_code: Option<i32>,
    path: Option<String>,
    timestamp_ms: u128,
}

impl WorkbenchEvent {
    pub fn new(event_type: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            event_type: event_type.into(),
            id: id.into(),
            stream: None,
            data: None,
            exit_code: None,
            path: None,
            timestamp_ms: now_ms(),
        }
    }

    pub fn stream(mut self, stream: impl Into<String>, data: impl Into<String>) -> Self {
        self.stream = Some(stream.into());
        self.data = Some(data.into());
        self
    }

    pub fn exit_code(mut self, exit_code: Option<i32>) -> Self {
        self.exit_code = exit_code;
        self
    }

    pub fn path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
}

struct TerminalSession {
    #[cfg(unix)]
    process: crate::terminal_process::TerminalProcess,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl TerminalSession {
    fn terminate(&mut self) -> Result<(), String> {
        #[cfg(unix)] {
            // Do not try_wait first: the unreaped session leader prevents SID reuse.
            self.process.terminate()?;
        }
        #[cfg(windows)] {
            if self.child.try_wait().map_err(|e| e.to_string())?.is_none() {
                if let Some(pid) = self.child.process_id() { crate::process::terminate_pid(pid)?; }
                self.child.kill().map_err(|e| e.to_string())?;
            }
        }
        self.child.wait().map_err(|e| format!("Failed to reap terminal: {e}"))?;
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<TerminalSession>>>>>,
    reservations: Arc<Mutex<HashMap<String, bool>>>,
}

#[derive(Clone, Default)]
pub struct ProcessManager {
    children: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSpec {
    presentation: Option<crate::run_registry::RunPresentation>,
    id: String,
    cwd: String,
    program: String,
    args: Vec<String>,
}

#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    state: State<'_, TerminalManager>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = state.inner().clone();
    {
        let mut pending = manager.reservations.lock().map_err(|_| "Terminal reservation lock poisoned")?;
        if app.state::<RunRegistry>().is_closed() { return Err("Application is shutting down".into()); }
        if pending.contains_key(&id) { return Err("Terminal session already exists".into()); }
        if pending.len() >= 8 { return Err("Terminal session limit (8) reached".into()); }
        pending.insert(id.clone(), false);
    }
    let cleanup = manager.clone();
    let cleanup_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        terminal_spawn_blocking(app, manager, id, cwd, cols, rows)
    }).await.map_err(|error| format!("Terminal startup task failed: {error}"))
        .and_then(|result| result);
    if result.is_err() {
        // A cleanup failure retains ownership and its reservation for retry.
        if let Ok(sessions) = cleanup.sessions.lock() {
            if !sessions.contains_key(&cleanup_id) {
                if let Ok(mut pending) = cleanup.reservations.lock() { pending.remove(&cleanup_id); }
            }
        }
    }
    result
}

fn terminal_spawn_blocking(
    app: AppHandle,
    state: TerminalManager,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("Terminal working directory does not exist: {cwd}"));
    }

    let mut sessions = state.sessions.lock().map_err(|_| "Terminal manager lock poisoned")?;
    if sessions.contains_key(&id) { return Err("Terminal session already exists".into()); }
    if sessions.len() >= 8 { return Err("Terminal session limit (8) reached".into()); }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to open PTY: {error}"))?;

    let (shell, shell_args) = default_shell();
    let mut command = CommandBuilder::new(shell);
    for arg in shell_args {
        command.arg(arg);
    }
    command.cwd(&cwd);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to clone PTY reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to open PTY writer: {error}"))?;

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to start terminal shell: {error}"))?;

    #[allow(unused_mut)] // Unix capture failure must kill and reap the child.
    let mut child = child;
    #[cfg(unix)]
    let process = match child.process_id().ok_or_else(|| "Terminal has no process ID".to_string())
        .and_then(crate::terminal_process::TerminalProcess::capture) {
        Ok(process) => process,
        Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); }
    };
    let cancelled = app.state::<RunRegistry>().is_closed() || state.reservations.lock()
        .map_err(|_| "Terminal reservation lock poisoned")?.get(&id).copied().unwrap_or(true);
    let session = Arc::new(Mutex::new(TerminalSession {
        #[cfg(unix)]
        process,
        master: pair.master, writer, child,
    }));
    let startup_cleanup = if cancelled { session.lock().map_err(|_| "Terminal session lock poisoned")?.terminate() } else { Ok(()) };

    sessions.insert(id.clone(), session.clone());
    drop(sessions);

    #[cfg(unix)] {
        // A background job can hold the PTY open after the shell exits, so EOF
        // alone is insufficient. Never reap the leader in this monitor.
        let weak_session = Arc::downgrade(&session);
        let monitor_app = app.clone();
        let monitor_id = id.clone();
        thread::spawn(move || {
            let mut reported = false;
            loop {
                let Some(session) = weak_session.upgrade() else { break; };
                let result = session.lock().map_err(|_| "Terminal session lock poisoned".to_string())
                    .and_then(|mut session| {
                        if session.process.leader_exited()? { session.terminate().map(|_| true) }
                        else { Ok(false) }
                    });
                match result {
                    Ok(true) => break,
                    Ok(false) => {},
                    Err(error) if !reported => {
                        let _ = monitor_app.emit("workbench://event",
                            WorkbenchEvent::new("terminal.cleanup_failed", &monitor_id).stream("stderr", error));
                        reported = true;
                    },
                    Err(_) => {},
                }
                drop(session);
                thread::sleep(Duration::from_millis(250));
            }
        });
    }

    let sessions = state.sessions.clone();
    let reservations = state.reservations.clone();
    let app_for_reader = app.clone();
    let id_for_reader = id.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let _ = app_for_reader.emit(
                        "terminal://output",
                        TerminalOutput {
                            id: id_for_reader.clone(),
                            data: buffer[..read].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }

        let mut reported = false;
        loop {
            let result = session.lock().map_err(|_| "Terminal session lock poisoned".into())
                .and_then(|mut session| session.terminate());
            match result {
                Ok(()) => break,
                Err(error) => {
                    if !reported {
                        let _ = app_for_reader.emit("workbench://event",
                            WorkbenchEvent::new("terminal.cleanup_failed", &id_for_reader).stream("stderr", error));
                        reported = true;
                    }
                    thread::sleep(Duration::from_millis(250));
                }
            }
        }
        if let Ok(mut map) = sessions.lock() {
            // An old reader must not erase a newly created session with the same ID.
            if map.get(&id_for_reader).is_some_and(|current| Arc::ptr_eq(current, &session)) {
                map.remove(&id_for_reader);
                if let Ok(mut pending) = reservations.lock() { pending.remove(&id_for_reader); }
            }
        }
        let _ = app_for_reader.emit(
            "workbench://event",
            WorkbenchEvent::new("terminal.exited", id_for_reader),
        );
    });

    if cancelled { startup_cleanup?; return Err("Terminal startup cancelled".into()); }
    let _ = emit_event(&app, WorkbenchEvent::new("terminal.started", id).path(cwd));

    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalManager>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = terminal_session(&state, &id)?;
    let mut session = session
        .lock()
        .map_err(|_| "Terminal session lock poisoned".to_string())?;
    session
        .writer
        .write_all(&data)
        .map_err(|error| format!("Failed to write terminal input: {error}"))?;
    session
        .writer
        .flush()
        .map_err(|error| format!("Failed to flush terminal input: {error}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = terminal_session(&state, &id)?;
    let session = session
        .lock()
        .map_err(|_| "Terminal session lock poisoned".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to resize terminal: {error}"))
}

#[tauri::command]
pub fn terminal_stop(
    app: AppHandle,
    state: State<'_, TerminalManager>,
    id: String,
) -> Result<(), String> {
    if let Some(cancelled) = state.reservations.lock().map_err(|_| "Terminal reservation lock poisoned")?.get_mut(&id) { *cancelled = true; }
    let session = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Terminal manager lock poisoned".to_string())?;
        sessions.get(&id).cloned()
    };

    if let Some(session) = session {
        let mut session = session
            .lock()
            .map_err(|_| "Terminal session lock poisoned".to_string())?;
        session.terminate()?;
    }

    let _ = emit_event(&app,
        WorkbenchEvent::new("terminal.stopped", id),
    );
    Ok(())
}

#[tauri::command]
pub async fn process_spawn(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    spec: ProcessSpec,
) -> Result<(), String> {
    let root = std::fs::canonicalize(&spec.cwd).map_err(|e| format!("Cannot resolve process workspace: {e}"))?;
    let mut spec = spec;
    spec.cwd = root.to_string_lossy().into_owned();
    app.state::<RunRegistry>().begin(&spec.id, &spec.cwd, &spec.program, false, spec.presentation.clone())?;
    let id = spec.id.clone();
    let registry_app = app.clone();
    let manager = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || process_spawn_blocking(app, manager, spec))
        .await.map_err(|error| format!("Process startup task failed: {error}"))
        .and_then(|result| result);
    if let Err(error) = &result { registry_app.state::<RunRegistry>().fail(&id, error); }
    result
}

fn process_spawn_blocking(
    app: AppHandle,
    state: ProcessManager,
    spec: ProcessSpec,
) -> Result<(), String> {
    if spec.program.trim().is_empty() {
        return Err("Process program must not be empty".to_string());
    }
    if !std::path::Path::new(&spec.cwd).is_dir() {
        return Err(format!("Process working directory does not exist: {}", spec.cwd));
    }

    let mut map = state.children.lock().map_err(|_| "Process manager lock poisoned")?;
    if map.contains_key(&spec.id) { return Err("Process id is already running".into()); }

    let mut command = process_command(spec.program.trim());
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    crate::process::configure_process_tree(&mut command);
    let mut child = crate::managed_process::spawn(&mut command)
        .map_err(|error| format!("Failed to start {}: {error}", spec.program))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));

    map.insert(spec.id.clone(), child.clone());
    drop(map);

    if app.state::<RunRegistry>().is_stopping(&spec.id) {
        let _ = crate::process::terminate_tree(&mut *child.lock().map_err(|_| "Process child lock poisoned")?);
    }
    let mut readers = Vec::new();
    if let Some(stdout) = stdout {
        readers.push(spawn_stream_reader(app.clone(), spec.id.clone(), "stdout", stdout));
    }
    if let Some(stderr) = stderr {
        readers.push(spawn_stream_reader(app.clone(), spec.id.clone(), "stderr", stderr));
    }

    let app_for_monitor = app.clone();
    let id_for_monitor = spec.id.clone();
    let children = state.children.clone();
    thread::spawn(move || {
        let mut cleanup_reported = false;
        loop {
        let status = {
            let mut child = match child.lock() {
                Ok(child) => child,
                Err(_) => break,
            };
            child.try_wait()
        };

        match status {
            Ok(Some(status)) => {
                let cleanup = child.lock().map_err(|_| "Process child lock poisoned".to_string())
                    .and_then(|mut child| child.terminate_remaining().map_err(|e| e.to_string()));
                if let Err(error) = cleanup {
                    if !cleanup_reported {
                        let _ = emit_event(&app_for_monitor, WorkbenchEvent::new("process.stop_requested", id_for_monitor.clone()));
                        let _ = emit_event(&app_for_monitor, WorkbenchEvent::new("process.error", id_for_monitor.clone()).stream("system", error));
                        cleanup_reported = true;
                    }
                    thread::sleep(Duration::from_millis(120));
                    continue;
                }
                // Output must be drained before the exit event reaches the UI.
                for reader in readers.drain(..) { let _ = reader.join(); }
                if let Ok(mut map) = children.lock() {
                    map.remove(&id_for_monitor);
                }
                let _ = emit_event(&app_for_monitor,
                    WorkbenchEvent::new("process.exited", id_for_monitor.clone())
                        .exit_code(status.code()),
                );
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(120)),
            Err(error) => {
                let _ = emit_event(&app_for_monitor,
                    WorkbenchEvent::new("process.error", id_for_monitor.clone())
                        .stream("system", error.to_string()),
                );
                let _ = emit_event(&app_for_monitor, WorkbenchEvent::new("process.stop_requested", id_for_monitor.clone()));
                if let Ok(mut child) = child.lock() { let _ = crate::process::terminate_tree(&mut child); }
                thread::sleep(Duration::from_millis(120));
            }
        }
        }
    });

    let _ = emit_event(&app,
        WorkbenchEvent::new("process.started", spec.id).path(spec.cwd),
    );

    Ok(())
}

#[tauri::command]
pub fn process_stop(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    id: String,
) -> Result<(), String> {
    let _ = emit_event(&app, WorkbenchEvent::new("process.stop_requested", id.clone()));
    let child = {
        state
            .children
            .lock()
            .map_err(|_| "Process manager lock poisoned".to_string())?
            .get(&id)
            .cloned()
    };

    if let Some(child) = child {
        crate::process::terminate_tree(&mut *child.lock().map_err(|_| "Process child lock poisoned")?)?;
    }

    Ok(())
}

fn terminal_session(
    state: &State<'_, TerminalManager>,
    id: &str,
) -> Result<Arc<Mutex<TerminalSession>>, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "Terminal manager lock poisoned".to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "Terminal session is not running".to_string())
}

fn spawn_stream_reader<R>(app: AppHandle, id: String, stream: &'static str, reader: R) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = std::io::BufReader::new(reader);
        let mut decoder = Utf8StreamDecoder::default();
        let mut buffer = [0u8; 4096];
        let emit_data = |data: String| {
            if data.is_empty() { return; }
            let _ = emit_event(&app,
                WorkbenchEvent::new("process.output", id.clone()).stream(stream, data),
            );
        };
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => emit_data(decoder.push(&buffer[..read])),
                Err(error) => {
                    let _ = emit_event(&app,
                        WorkbenchEvent::new("process.error", id.clone())
                            .stream("system", error.to_string()),
                    );
                    break;
                }
            }
        }
        emit_data(decoder.finish());
    })
}

fn default_shell() -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        if command_available("pwsh.exe") {
            return ("pwsh.exe".to_string(), vec!["-NoLogo".to_string()]);
        }
        return (
            "powershell.exe".to_string(),
            vec!["-NoLogo".to_string()],
        );
    }

    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        (shell, Vec::new())
    }
}

#[cfg(target_os = "windows")]
fn command_available(program: &str) -> bool {
    background_command("where")
        .arg(program)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(target_os = "windows")]
pub(crate) fn process_command(program: &str) -> Command {
    let resolved = resolve_windows_program(program).unwrap_or_else(|| program.to_string());
    // Rust's Windows Command adapter detects .cmd/.bat and supplies the
    // required outer quotes and batch argument escaping. A manual cmd /c
    // wrapper bypasses that protection and breaks spaces/metacharacters.
    background_command(resolved)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn process_command(program: &str) -> Command {
    background_command(program)
}

#[cfg(target_os = "windows")]
fn resolve_windows_program(program: &str) -> Option<String> {
    let path = std::path::Path::new(program);
    if path.is_file() && is_windows_launcher(program) {
        return Some(program.to_string());
    }

    let output = background_command("where")
        .arg(program)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    select_windows_launcher(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(any(windows, test))]
fn is_windows_launcher(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".exe", ".com", ".cmd", ".bat"].iter().any(|ext| lower.ends_with(ext))
}
#[cfg(any(windows, test))]
fn select_windows_launcher(output: &str) -> Option<String> {
    output.lines().map(str::trim).find(|line| is_windows_launcher(line)).map(str::to_owned)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn batch_launcher_preserves_space_paths_and_literal_arguments() {
        let root = std::env::temp_dir().join(format!("virtuallab launcher 中文 {}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let shim = root.join("launch.cmd");
        std::fs::write(root.join("args.cjs"), "console.log(JSON.stringify(process.argv.slice(2)))").unwrap();
        std::fs::write(&shim, "@echo off\r\nnode.exe \"%~dp0args.cjs\" %*\r\n").unwrap();
        let args = ["a b", "中文", "a&b", "a|b", "a>b", "100%", "say \"hello\"", "trailing\\"];
        let output = process_command(shim.to_str().unwrap()).args(args).output().unwrap();
        assert!(output.status.success(), "Batch fixture exited unsuccessfully");
        let actual: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(actual, args);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn windows_launchers_skip_posix_shims_and_preserve_spaces() {
        assert_eq!(select_windows_launcher("C:\\tools\\codex\nC:\\Program Files\\Codex\\codex.CMD\n"), Some("C:\\Program Files\\Codex\\codex.CMD".into()));
        assert!(select_windows_launcher("/usr/bin/codex\n").is_none());
        assert_eq!(select_windows_launcher("C:/tools/codex.exe"), Some("C:/tools/codex.exe".into()));
    }
    #[test]
    fn structured_event_builder_preserves_payload() {
        let event = WorkbenchEvent::new("process.output", "run-1")
            .stream("stdout", "ok")
            .exit_code(Some(0))
            .path("workspace");
        assert_eq!(event.event_type, "process.output");
        assert_eq!(event.id, "run-1");
        assert_eq!(event.stream.as_deref(), Some("stdout"));
        assert_eq!(event.data.as_deref(), Some("ok"));
        assert_eq!(event.exit_code, Some(0));
        assert_eq!(event.path.as_deref(), Some("workspace"));
    }

    #[test]
    fn default_shell_is_defined() {
        let (shell, _) = default_shell();
        assert!(!shell.trim().is_empty());
    }
}

fn emit_event(app: &AppHandle, event: WorkbenchEvent) -> tauri::Result<()> {
    if event.event_type.starts_with("process.") {
        if let Ok(value) = serde_json::to_value(&event) { app.state::<RunRegistry>().record(value); }
    }
    app.emit("workbench://event", event)
}
impl ProcessManager {
    pub fn shutdown(&self) {
        if let Ok(children) = self.children.lock() {
            for child in children.values() {
                if let Ok(mut child) = child.lock() { let _ = crate::process::terminate_tree(&mut child); }
            }
        }
    }
}
impl TerminalManager {
    pub fn shutdown(&self) {
        if let Ok(mut pending) = self.reservations.lock() { for cancelled in pending.values_mut() { *cancelled = true; } }
        if let Ok(sessions) = self.sessions.lock() {
            for session in sessions.values() {
                if let Ok(mut session) = session.lock() {
                    let _ = session.terminate();
                }
            }
        }
    }
}
