use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

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
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<TerminalSession>>>>>,
}

#[derive(Clone, Default)]
pub struct ProcessManager {
    children: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSpec {
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
    tauri::async_runtime::spawn_blocking(move || {
        terminal_spawn_blocking(app, manager, id, cwd, cols, rows)
    })
    .await
    .map_err(|error| format!("Terminal startup task failed: {error}"))?
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

    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Terminal manager lock poisoned".to_string())?;
        if sessions.contains_key(&id) {
            return Err("Terminal session already exists".to_string());
        }
    }

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

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to start terminal shell: {error}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to clone PTY reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to open PTY writer: {error}"))?;

    let session = Arc::new(Mutex::new(TerminalSession {
        master: pair.master,
        writer,
        child,
    }));

    state
        .sessions
        .lock()
        .map_err(|_| "Terminal manager lock poisoned".to_string())?
        .insert(id.clone(), session);

    let sessions = state.sessions.clone();
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

        if let Ok(mut map) = sessions.lock() {
            map.remove(&id_for_reader);
        }
        let _ = app_for_reader.emit(
            "workbench://event",
            WorkbenchEvent::new("terminal.exited", id_for_reader),
        );
    });

    app.emit(
        "workbench://event",
        WorkbenchEvent::new("terminal.started", id).path(cwd),
    )
    .map_err(|error| format!("Failed to emit terminal event: {error}"))?;

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
    let session = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "Terminal manager lock poisoned".to_string())?;
        sessions.remove(&id)
    };

    if let Some(session) = session {
        let mut session = session
            .lock()
            .map_err(|_| "Terminal session lock poisoned".to_string())?;
        session
            .child
            .kill()
            .map_err(|error| format!("Failed to stop terminal: {error}"))?;
    }

    let _ = app.emit(
        "workbench://event",
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
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || process_spawn_blocking(app, manager, spec))
        .await
        .map_err(|error| format!("Process startup task failed: {error}"))?
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

    {
        let map = state
            .children
            .lock()
            .map_err(|_| "Process manager lock poisoned".to_string())?;
        if map.contains_key(&spec.id) {
            return Err("Process id is already running".to_string());
        }
    }

    let mut command = process_command(spec.program.trim());
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {}: {error}", spec.program))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));

    state
        .children
        .lock()
        .map_err(|_| "Process manager lock poisoned".to_string())?
        .insert(spec.id.clone(), child.clone());

    if let Some(stdout) = stdout {
        spawn_stream_reader(app.clone(), spec.id.clone(), "stdout", stdout);
    }
    if let Some(stderr) = stderr {
        spawn_stream_reader(app.clone(), spec.id.clone(), "stderr", stderr);
    }

    let app_for_monitor = app.clone();
    let id_for_monitor = spec.id.clone();
    let children = state.children.clone();
    thread::spawn(move || loop {
        let status = {
            let mut child = match child.lock() {
                Ok(child) => child,
                Err(_) => break,
            };
            child.try_wait()
        };

        match status {
            Ok(Some(status)) => {
                if let Ok(mut map) = children.lock() {
                    map.remove(&id_for_monitor);
                }
                let _ = app_for_monitor.emit(
                    "workbench://event",
                    WorkbenchEvent::new("process.exited", id_for_monitor.clone())
                        .exit_code(status.code()),
                );
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(120)),
            Err(error) => {
                let _ = app_for_monitor.emit(
                    "workbench://event",
                    WorkbenchEvent::new("process.error", id_for_monitor.clone())
                        .stream("system", error.to_string()),
                );
                break;
            }
        }
    });

    app.emit(
        "workbench://event",
        WorkbenchEvent::new("process.started", spec.id).path(spec.cwd),
    )
    .map_err(|error| format!("Failed to emit process event: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn process_stop(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    id: String,
) -> Result<(), String> {
    let child = {
        state
            .children
            .lock()
            .map_err(|_| "Process manager lock poisoned".to_string())?
            .get(&id)
            .cloned()
    };

    if let Some(child) = child {
        child
            .lock()
            .map_err(|_| "Process child lock poisoned".to_string())?
            .kill()
            .map_err(|error| format!("Failed to stop process: {error}"))?;
    }

    let _ = app.emit(
        "workbench://event",
        WorkbenchEvent::new("process.stop_requested", id),
    );
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

fn spawn_stream_reader<R>(app: AppHandle, id: String, stream: &'static str, reader: R)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = std::io::BufReader::new(reader);
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let data = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let _ = app.emit(
                        "workbench://event",
                        WorkbenchEvent::new("process.output", id.clone()).stream(stream, data),
                    );
                }
                Err(error) => {
                    let _ = app.emit(
                        "workbench://event",
                        WorkbenchEvent::new("process.error", id.clone())
                            .stream("system", error.to_string()),
                    );
                    break;
                }
            }
        }
    });
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
    Command::new("where")
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
fn process_command(program: &str) -> Command {
    let resolved = resolve_windows_program(program).unwrap_or_else(|| program.to_string());
    let lower = resolved.to_ascii_lowercase();

    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut command = Command::new("cmd.exe");
        command
            .arg("/d")
            .arg("/s")
            .arg("/c")
            .arg(resolved);
        command
    } else {
        Command::new(resolved)
    }
}

#[cfg(not(target_os = "windows"))]
fn process_command(program: &str) -> Command {
    Command::new(program)
}

#[cfg(target_os = "windows")]
fn resolve_windows_program(program: &str) -> Option<String> {
    let path = std::path::Path::new(program);
    if path.exists() {
        return Some(program.to_string());
    }

    let output = Command::new("where")
        .arg(program)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}


#[cfg(test)]
mod tests {
    use super::*;

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
