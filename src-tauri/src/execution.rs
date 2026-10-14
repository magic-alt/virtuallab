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

#[cfg(all(test, windows))]
#[path = "terminal_qualification.rs"]
mod qualification;

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

type TerminalWriter = Arc<Mutex<Box<dyn Write + Send>>>;

// The native reader services ConPTY's initial cursor query even when the UI is
// unmounted or Stop holds the session lock. Each new terminal starts at (1,1).
// Later application cursor queries still reach xterm with the original bytes.
fn read_terminal_output(reader: &mut dyn Read, _writer: &TerminalWriter, mut emit: impl FnMut(&[u8])) -> std::io::Result<()> {
    let mut buffer = [0u8; 8192];
    #[cfg(windows)]
    let mut startup_query = crate::conpty_handshake::StartupCursorQuery::default();
    loop {
        let size = reader.read(&mut buffer)?;
        if size == 0 { return Ok(()); }
        #[cfg(windows)] {
            let (bytes, reply) = startup_query.push(&buffer[..size]);
            if reply {
                let mut writer = _writer.lock().map_err(|_| std::io::Error::other("Terminal writer lock poisoned"))?;
                writer.write_all(b"\x1b[1;1R")?;
                writer.flush()?;
            }
            if !bytes.is_empty() { emit(&bytes); }
        }
        #[cfg(not(windows))]
        emit(&buffer[..size]);
    }
}

struct TerminalSession {
    #[cfg(unix)]
    process: crate::terminal_process::TerminalProcess,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: TerminalWriter,
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
        // ConPTY retains the output pipe until its master is closed. Waiting
        // for EOF while the reader and manager retain this session is a cycle.
        // Close only after process cleanup succeeds; the reader drains output
        // concurrently and can now finish and release the native reservation.
        #[cfg(windows)]
        self.master.take();
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

fn configure_terminal_command(command: &mut CommandBuilder, cwd: &str) {
    command.cwd(cwd);
    // This PTY is rendered by xterm.js, regardless of the launching app's
    // environment. Finder/Dock may omit TERM; inherited TERM may describe a
    // different terminal. Both can break shell cursor movement and erasure.
    command.env("TERM", "xterm-256color");
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
    configure_terminal_command(&mut command, &cwd);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to clone PTY reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to open PTY writer: {error}"))?;
    let writer = Arc::new(Mutex::new(writer));
    let reader_writer = writer.clone();

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
        master: Some(pair.master), writer, child,
    }));
    let startup_cleanup = if cancelled { session.lock().map_err(|_| "Terminal session lock poisoned")?.terminate() } else { Ok(()) };

    sessions.insert(id.clone(), session.clone());
    drop(sessions);

    {
        // EOF alone is insufficient while the master remains owned. Unix
        // keeps the leader unreaped to pin the session identity; Windows uses
        // the owned process handle and closes ConPTY after observed exit.
        let weak_session = Arc::downgrade(&session);
        let monitor_app = app.clone();
        let monitor_id = id.clone();
        let monitor_reservations = state.reservations.clone();
        thread::spawn(move || {
            let mut reported = false;
            loop {
                let Some(session) = weak_session.upgrade() else { break; };
                let stop_requested = cancelled || monitor_reservations.lock()
                    .map(|pending| pending.get(&monitor_id).copied().unwrap_or(true)).unwrap_or(true);
                let result = session.lock().map_err(|_| "Terminal session lock poisoned".to_string())
                    .and_then(|mut session| {
                        #[cfg(unix)]
                        let cleanup_due = session.process.cleanup_due(stop_requested)?;
                        #[cfg(windows)]
                        let cleanup_due = stop_requested || session.child.try_wait().map_err(|e| e.to_string())?.is_some();
                        if cleanup_due { session.terminate().map(|_| true) }
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
        let _ = read_terminal_output(&mut *reader, &reader_writer, |bytes| {
            let _ = app_for_reader.emit("terminal://output", TerminalOutput {
                id: id_for_reader.clone(), data: bytes.to_vec(),
            });
        });

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
    let writer = {
        let session = session.lock().map_err(|_| "Terminal session lock poisoned".to_string())?;
        if session.master.is_none() { return Err("Terminal is stopped".into()); }
        session.writer.clone()
    };
    let mut writer = writer.lock().map_err(|_| "Terminal writer lock poisoned".to_string())?;
    writer
        .write_all(&data)
        .map_err(|error| format!("Failed to write terminal input: {error}"))?;
    writer
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
        .as_ref().ok_or("Terminal is stopped")?
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

/// Launch a native interactive shell *inside* the VirtualLab PTY. This is
/// intentionally not an external terminal emulator such as wt.exe or Terminal.app:
/// the existing xterm pane owns input, scrollback and session lifecycle.
fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        // PowerShell 7 when installed, the inbox Windows PowerShell otherwise.
        // Do not execute user profiles, which can block a terminal on startup.
        for program in ["pwsh.exe", "powershell.exe"] {
            if command_available(program) {
                return (
                    program.to_string(),
                    vec!["-NoLogo".to_string(), "-NoProfile".to_string()],
                );
            }
        }
        // Minimal/stripped Windows installations still have their command
        // processor. Prefer a valid OS-configured ComSpec to a hard-coded path.
        let comspec = std::env::var_os("ComSpec")
            .filter(|candidate| std::path::Path::new(candidate).is_file())
            .map(|candidate| candidate.to_string_lossy().into_owned())
            .unwrap_or_else(|| "cmd.exe".to_string());
        return (comspec, Vec::new());
    }

    #[cfg(unix)]
    {
        let configured = std::env::var("SHELL").ok();
        #[cfg(target_os = "macos")]
        let fallbacks = ["/bin/zsh", "/bin/bash", "/bin/sh"];
        #[cfg(not(target_os = "macos"))]
        let fallbacks = ["/bin/bash", "/bin/sh"];
        (select_unix_shell(configured.as_deref(), &fallbacks), Vec::new())
    }
}

/// Respect the OS user's configured login shell, and fall back to installed
/// platform shells when GUI launches do not provide SHELL (e.g. via Finder).
#[cfg(unix)]
fn select_unix_shell(configured: Option<&str>, fallbacks: &[&str]) -> String {
    configured
        .into_iter()
        .chain(fallbacks.iter().copied())
        .find(|candidate| {
            let path = std::path::Path::new(candidate);
            path.is_absolute() && path.is_file()
        })
        .unwrap_or("/bin/sh")
        .to_string()
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_terminal_backspace_erases_and_arrow_keys_edit_without_inherited_term() {
        assert_macos_terminal_editing(None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_terminal_backspace_erases_and_arrow_keys_edit_with_inherited_dumb_term() {
        assert_macos_terminal_editing(Some("dumb"));
    }

    #[cfg(target_os = "macos")]
    fn assert_macos_terminal_editing(inherited_term: Option<&str>) {
        use std::sync::mpsc;
        use std::time::Instant;

        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut command = CommandBuilder::new("/bin/zsh");
        command.args(["-f", "-i"]);
        command.env_remove("TERM"); // Finder/Dock launches need not supply TERM.
        if let Some(term) = inherited_term { command.env("TERM", term); }
        command.env("PS1", "VL_READY> ");
        command.env("RPS1", "");
        configure_terminal_command(&mut command, std::env::temp_dir().to_str().unwrap());
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let (tx, rx) = mpsc::channel();
        let reader_thread = thread::spawn(move || {
            let mut chunk = [0; 4096];
            while let Ok(size) = reader.read(&mut chunk) {
                if size == 0 || tx.send(chunk[..size].to_vec()).is_err() { break; }
            }
        });
        let collect_until = |needle: &[u8]| {
            let mut output = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(50)) {
                    output.extend_from_slice(&chunk);
                    if output.windows(needle.len()).any(|bytes| bytes == needle) { break; }
                }
            }
            output
        };
        let prompt = collect_until(b"VL_READY> ");
        // xterm sends DEL for Backspace. The shell must erase the cell as well
        // as moving the cursor; merely executing the shortened line is not enough.
        writer.write_all(b"abc\x7f").unwrap();
        writer.flush().unwrap();
        let editing = collect_until(b"\x08 \x08");
        writer.write_all(b"\x15print -r -- ac\x1b[Db\x1b[CZ\r").unwrap();
        writer.flush().unwrap();
        let result = collect_until(b"\r\nabcZ\r\n");
        let _ = child.kill();
        let _ = child.wait();
        drop(writer);
        drop(pair.master);
        reader_thread.join().unwrap();

        assert!(prompt.windows(10).any(|bytes| bytes == b"VL_READY> "), "shell prompt missing");
        assert!(editing.windows(3).any(|bytes| bytes == b"\x08 \x08"),
            "Backspace must visibly erase a character: {editing:?}");
        assert!(result.windows(8).any(|bytes| bytes == b"\r\nabcZ\r\n"),
            "left/right arrows must edit the command: {result:?}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_interactive_shell_skips_user_profiles() {
        let (shell, args) = default_shell();
        if shell.to_ascii_lowercase().contains("powershell") || shell.eq_ignore_ascii_case("pwsh.exe") {
            assert_eq!(args, vec!["-NoLogo".to_string(), "-NoProfile".to_string()]);
        } else {
            assert!(shell.to_ascii_lowercase().ends_with("cmd.exe"));
            assert!(args.is_empty(), "cmd.exe should start as an interactive shell");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_default_shell_accepts_commands_through_native_conpty() {
        use std::sync::mpsc;

        // ConPTY waits for a cursor position report (DSR, CSI 6n) before it
        // resumes shell I/O. This test acts as a minimal terminal emulator.
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("Windows ConPTY must open");
        let (shell, args) = default_shell();
        let mut command = CommandBuilder::new(shell);
        for arg in args {
            command.arg(arg);
        }
        let mut reader = pair.master.try_clone_reader().expect("PTY reader");
        let mut writer = pair.master.take_writer().expect("PTY writer");
        let mut child = pair.slave.spawn_command(command).expect("default Windows shell must start");
        drop(pair.slave);

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        if tx.send(chunk[..size].to_vec()).is_err() { break; }
                    }
                }
            }
        });

        let marker = b"VIRTUALLAB_CONPTY_ROUNDTRIP";
        let sent = writer.write_all(b"echo VIRTUALLAB_CONPTY_ROUNDTRIP\r")
            .and_then(|_| writer.flush());
        let mut output = Vec::new();
        let mut answered_dsr = 0usize;
        let mut observed = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(18);
        while sent.is_ok() && std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(250)) {
                output.extend_from_slice(&chunk);
                // The DSR escape sequence can cross a read boundary.
                let requests = output.windows(4).filter(|s| *s == b"\x1b[6n").count();
                while answered_dsr < requests {
                    writer.write_all(b"\x1b[1;1R").expect("DSR response");
                    writer.flush().expect("flush DSR response");
                    answered_dsr += 1;
                }

                // Don't mistake the echoed command line for successful
                // execution: its marker is preceded by "echo ".
                observed = output.windows(marker.len()).enumerate().any(|(index, bytes)| {
                    bytes == marker &&
                        (index < 5 || &output[index - 5..index] != b"echo ")
                });
                if observed || output.len() > 128 * 1024 { break; }
            }
        }
        if !observed {
            eprintln!(
                "ConPTY diagnostic: wrote={sent:?}, child={:?}, replied_dsr={answered_dsr}, output_bytes={}, sample={:?}",
                child.try_wait(),
                output.len(),
                String::from_utf8_lossy(&output).chars().take(1500).collect::<String>(),
            );
        }
        let _ = child.kill();
        let _ = child.wait();
        assert!(sent.is_ok() && observed, "Windows ConPTY shell did not echo the command result");
    }

    #[cfg(unix)]
    #[test]
    fn unix_shell_uses_valid_user_shell_then_installed_fallback() {
        assert_eq!(select_unix_shell(Some("/bin/sh"), &["/bin/bash"]), "/bin/sh");
        assert_eq!(select_unix_shell(Some(""), &["/bin/sh"]), "/bin/sh");
        assert_eq!(select_unix_shell(Some("/unlikely/virtuallab/missing-shell"), &["/bin/sh"]), "/bin/sh");
        assert_eq!(select_unix_shell(Some("sh -c echo unsafe"), &["/bin/sh"]), "/bin/sh");
        let (shell, args) = default_shell();
        assert!(std::path::Path::new(&shell).is_file(), "selected shell must exist: {shell}");
        assert!(args.is_empty());
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
