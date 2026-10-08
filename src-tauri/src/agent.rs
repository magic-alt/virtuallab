use crate::process::background_command;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

const RPC_TIMEOUT: Duration = Duration::from_secs(20);
type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;
type SharedStdin = Arc<Mutex<ChildStdin>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHarnessCapabilities {
    harness: String,
    available: bool,
    version: Option<String>,
    detail: String,
    features: AgentHarnessFeatures,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentHarnessFeatures {
    persistent_threads: bool,
    turns: bool,
    steering: bool,
    interrupt: bool,
    structured_events: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionBinding {
    workspace_root: String,
    harness: String,
    thread_id: String,
    created_at_ms: u128,
    updated_at_ms: u128,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionStartRequest {
    workspace_root: String,
    harness: String,
    thread_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnStartRequest {
    workspace_root: String,
    thread_id: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnStartResult {
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnControlRequest {
    workspace_root: String,
    thread_id: String,
    turn_id: String,
    text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEvent {
    event_type: String,
    workspace_root: String,
    thread_id: Option<String>,
    turn_id: Option<String>,
    method: Option<String>,
    payload: Option<Value>,
    timestamp_ms: u128,
}

impl AgentEvent {
    fn notification(root: &str, method: &str, payload: Value) -> Self {
        let (thread_id, turn_id) = extract_ids(&payload);
        Self {
            event_type: "agent.notification".into(),
            workspace_root: root.into(),
            thread_id,
            turn_id,
            method: Some(method.into()),
            payload: Some(payload),
            timestamp_ms: now_ms(),
        }
    }

    fn server_request(root: &str, method: &str, payload: Value) -> Self {
        let (thread_id, turn_id) = extract_ids(&payload);
        Self {
            event_type: "agent.server_request_rejected".into(),
            workspace_root: root.into(),
            thread_id,
            turn_id,
            method: Some(method.into()),
            payload: Some(payload),
            timestamp_ms: now_ms(),
        }
    }

    fn lifecycle(kind: &str, root: &str, thread_id: Option<String>) -> Self {
        Self {
            event_type: kind.into(),
            workspace_root: root.into(),
            thread_id,
            turn_id: None,
            method: None,
            payload: None,
            timestamp_ms: now_ms(),
        }
    }

    fn diagnostic(kind: &str, root: &str, detail: String) -> Self {
        Self {
            event_type: kind.into(),
            workspace_root: root.into(),
            thread_id: None,
            turn_id: None,
            method: None,
            payload: Some(json!({ "detail": detail })),
            timestamp_ms: now_ms(),
        }
    }
}

struct CodexProcess {
    stdin: SharedStdin,
    child: Mutex<Child>,
    pending: Pending,
    next_id: AtomicU64,
}

impl CodexProcess {
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().map_err(lock_error)?.insert(id, tx);
        if let Err(error) = self.write(rpc_request(id, method, params)) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }
        match rx.recv_timeout(RPC_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(format!("Codex request '{method}' timed out"))
            }
            Err(_) => Err(format!("Codex request '{method}' response channel closed")),
        }
    }

    fn notify(&self, method: &str) -> Result<(), String> {
        self.write(rpc_notification(method))
    }

    fn write(&self, value: Value) -> Result<(), String> {
        write_message(&self.stdin, &value)
    }

    fn is_running(&self) -> Result<bool, String> {
        let mut child = self.child.lock().map_err(lock_error)?;
        child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|error| format!("Failed to inspect Codex app-server: {error}"))
    }

    fn stop(&self) -> Result<(), String> {
        self.child
            .lock()
            .map_err(lock_error)?
            .kill()
            .map_err(|error| format!("Failed to stop Codex app-server: {error}"))
    }
}

struct AgentRuntime {
    process: Arc<CodexProcess>,
    binding: AgentSessionBinding,
}

#[derive(Clone, Default)]
pub struct AgentManager {
    runtimes: Arc<Mutex<HashMap<String, Arc<AgentRuntime>>>>,
}

#[tauri::command]
pub fn agent_harness_capabilities(harness: String) -> Result<AgentHarnessCapabilities, String> {
    if harness != "codex" {
        return Err(format!("Unsupported agent harness: {harness}"));
    }
    let features = AgentHarnessFeatures {
        persistent_threads: true,
        turns: true,
        steering: true,
        interrupt: true,
        structured_events: true,
    };
    match codex_command().arg("--version").output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let version = if stdout.is_empty() { stderr } else { stdout };
            Ok(AgentHarnessCapabilities {
                harness,
                available: true,
                version: (!version.is_empty()).then_some(version),
                detail: "Codex CLI available; VirtualLab uses app-server stdio JSON-RPC.".into(),
                features,
            })
        }
        Ok(output) => Ok(AgentHarnessCapabilities {
            harness,
            available: false,
            version: None,
            detail: format!("Codex '--version' exited with {:?}.", output.status.code()),
            features,
        }),
        Err(error) => Ok(AgentHarnessCapabilities {
            harness,
            available: false,
            version: None,
            detail: format!("Codex CLI unavailable: {error}"),
            features,
        }),
    }
}

#[tauri::command]
pub async fn agent_session_start(
    app: AppHandle,
    state: State<'_, AgentManager>,
    request: AgentSessionStartRequest,
) -> Result<AgentSessionBinding, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start_session(app, manager, request))
        .await
        .map_err(|error| format!("Agent session task failed: {error}"))?
}

fn start_session(
    app: AppHandle,
    manager: AgentManager,
    request: AgentSessionStartRequest,
) -> Result<AgentSessionBinding, String> {
    if request.harness != "codex" {
        return Err(format!("Unsupported agent harness: {}", request.harness));
    }
    let root = request.workspace_root.trim();
    if root.is_empty() || !std::path::Path::new(root).is_dir() {
        return Err(format!("Agent workspace is not a directory: {}", request.workspace_root));
    }
    let key = workspace_key(root);
    let existing = manager
        .runtimes
        .lock()
        .map_err(lock_error)?
        .get(&key)
        .cloned();
    if let Some(existing) = existing {
        if existing.process.is_running()? {
            if request
                .thread_id
                .as_deref()
                .is_some_and(|thread| thread != existing.binding.thread_id)
            {
                return Err("Workspace already has a different active Codex thread.".into());
            }
            return Ok(existing.binding.clone());
        }
        manager.runtimes.lock().map_err(lock_error)?.remove(&key);
    }

    let process = spawn_codex(&app, root)?;
    if let Err(error) = initialize_codex(&process) {
        let _ = process.stop();
        return Err(error);
    }
    let result = if let Some(thread_id) = request.thread_id.as_deref() {
        process.request(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "cwd": root,
                "sandbox": "workspace-write",
                "approvalPolicy": "never",
                "excludeTurns": true
            }),
        )
    } else {
        process.request(
            "thread/start",
            json!({
                "cwd": root,
                "sandbox": "workspace-write",
                "approvalPolicy": "never",
                "ephemeral": false,
                "serviceName": "virtuallab"
            }),
        )
    };
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            let _ = process.stop();
            return Err(error);
        }
    };
    let thread_id = nested_id(&result, "thread")
        .ok_or_else(|| "Codex response missing thread.id".to_string())?;
    let timestamp = now_ms();
    let binding = AgentSessionBinding {
        workspace_root: root.into(),
        harness: "codex".into(),
        thread_id: thread_id.clone(),
        created_at_ms: timestamp,
        updated_at_ms: timestamp,
    };
    manager.runtimes.lock().map_err(lock_error)?.insert(
        key,
        Arc::new(AgentRuntime {
            process,
            binding: binding.clone(),
        }),
    );
    let _ = app.emit(
        "agent://event",
        AgentEvent::lifecycle("agent.session_started", root, Some(thread_id)),
    );
    Ok(binding)
}

#[tauri::command]
pub async fn agent_turn_start(
    state: State<'_, AgentManager>,
    request: AgentTurnStartRequest,
) -> Result<AgentTurnStartResult, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if request.text.trim().is_empty() {
            return Err("Agent turn text must not be empty".into());
        }
        let runtime = runtime(&manager, &request.workspace_root, &request.thread_id)?;
        let result = runtime.process.request(
            "turn/start",
            json!({
                "threadId": request.thread_id,
                "input": [{ "type": "text", "text": request.text, "text_elements": [] }]
            }),
        )?;
        Ok(AgentTurnStartResult {
            thread_id: runtime.binding.thread_id.clone(),
            turn_id: nested_id(&result, "turn")
                .ok_or_else(|| "Codex response missing turn.id".to_string())?,
        })
    })
    .await
    .map_err(|error| format!("Agent turn task failed: {error}"))?
}

#[tauri::command]
pub async fn agent_turn_steer(
    state: State<'_, AgentManager>,
    request: AgentTurnControlRequest,
) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let text = request
            .text
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| "Agent steer text must not be empty".to_string())?;
        let runtime = runtime(&manager, &request.workspace_root, &request.thread_id)?;
        runtime.process.request(
            "turn/steer",
            json!({
                "threadId": request.thread_id,
                "expectedTurnId": request.turn_id,
                "input": [{ "type": "text", "text": text, "text_elements": [] }]
            }),
        )?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Agent steer task failed: {error}"))?
}

#[tauri::command]
pub async fn agent_turn_interrupt(
    state: State<'_, AgentManager>,
    request: AgentTurnControlRequest,
) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = runtime(&manager, &request.workspace_root, &request.thread_id)?;
        runtime.process.request(
            "turn/interrupt",
            json!({ "threadId": request.thread_id, "turnId": request.turn_id }),
        )?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Agent interrupt task failed: {error}"))?
}

#[tauri::command]
pub fn agent_session_stop(
    app: AppHandle,
    state: State<'_, AgentManager>,
    workspace_root: String,
) -> Result<(), String> {
    if let Some(runtime) = state
        .runtimes
        .lock()
        .map_err(lock_error)?
        .remove(&workspace_key(&workspace_root))
    {
        runtime.process.stop()?;
        let _ = app.emit(
            "agent://event",
            AgentEvent::lifecycle(
                "agent.session_stopped",
                &workspace_root,
                Some(runtime.binding.thread_id.clone()),
            ),
        );
    }
    Ok(())
}

fn runtime(
    manager: &AgentManager,
    root: &str,
    thread_id: &str,
) -> Result<Arc<AgentRuntime>, String> {
    let runtime = manager
        .runtimes
        .lock()
        .map_err(lock_error)?
        .get(&workspace_key(root))
        .cloned()
        .ok_or_else(|| "No active agent session is attached to this workspace".to_string())?;
    if runtime.binding.thread_id != thread_id {
        return Err("Requested thread does not match the workspace binding".into());
    }
    Ok(runtime)
}

fn initialize_codex(process: &CodexProcess) -> Result<(), String> {
    process.request(
        "initialize",
        json!({
            "clientInfo": {
                "name": "virtuallab",
                "title": "VirtualLab",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": null
        }),
    )?;
    process.notify("initialized")
}

fn spawn_codex(app: &AppHandle, root: &str) -> Result<Arc<CodexProcess>, String> {
    let mut child = codex_command()
        .arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start Codex app-server: {error}"))?;
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or_else(|| "Codex stdin unavailable".to_string())?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex stderr unavailable".to_string())?;
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    spawn_stdout(
        app.clone(),
        root.into(),
        stdout,
        pending.clone(),
        stdin.clone(),
    );
    spawn_stderr(app.clone(), root.into(), stderr);
    Ok(Arc::new(CodexProcess {
        stdin,
        child: Mutex::new(child),
        pending,
        next_id: AtomicU64::new(1),
    }))
}

fn spawn_stdout<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    root: String,
    stdout: R,
    pending: Pending,
    stdin: SharedStdin,
) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = app.emit(
                        "agent://event",
                        AgentEvent::diagnostic("agent.protocol_error", &root, error.to_string()),
                    );
                    break;
                }
            };
            let message: Value = match serde_json::from_str(&line) {
                Ok(message) => message,
                Err(error) => {
                    let _ = app.emit(
                        "agent://event",
                        AgentEvent::diagnostic(
                            "agent.protocol_error",
                            &root,
                            format!("Invalid Codex JSON-RPC: {error}"),
                        ),
                    );
                    continue;
                }
            };
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if message.get("result").is_some() || message.get("error").is_some() {
                    if let Some(sender) = pending.lock().ok().and_then(|mut map| map.remove(&id)) {
                        let result = message
                            .get("error")
                            .map(|error| Err(rpc_error(error)))
                            .unwrap_or_else(|| Ok(message.get("result").cloned().unwrap_or_default()));
                        let _ = sender.send(result);
                    }
                    continue;
                }
            }
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                let payload = message.get("params").cloned().unwrap_or_default();
                if let Some(request_id) = message.get("id").cloned() {
                    let _ = app.emit(
                        "agent://event",
                        AgentEvent::server_request(&root, method, payload),
                    );
                    if let Err(error) = write_message(
                        &stdin,
                        &rpc_rejection(
                            request_id,
                            "VirtualLab foundation adapter rejects server-initiated requests",
                        ),
                    ) {
                        let _ = app.emit(
                            "agent://event",
                            AgentEvent::diagnostic("agent.protocol_error", &root, error),
                        );
                    }
                    continue;
                }
                let _ = app.emit(
                    "agent://event",
                    AgentEvent::notification(&root, method, payload),
                );
            }
        }
        if let Ok(mut pending) = pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("Codex app-server stdout closed".into()));
            }
        }
        let _ = app.emit(
            "agent://event",
            AgentEvent::lifecycle("agent.process_exited", &root, None),
        );
    });
}

fn spawn_stderr<R: std::io::Read + Send + 'static>(app: AppHandle, root: String, stderr: R) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = app.emit(
                    "agent://event",
                    AgentEvent::diagnostic("agent.stderr", &root, line),
                );
            }
        }
    });
}

fn nested_id(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .get("id")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn extract_ids(value: &Value) -> (Option<String>, Option<String>) {
    let id = |camel: &str, nested: &str| {
        value
            .get(camel)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| nested_id(value, nested))
    };
    (id("threadId", "thread"), id("turnId", "turn"))
}

fn rpc_request(id: u64, method: &str, params: Value) -> Value {
    json!({ "id": id, "method": method, "params": params })
}

fn rpc_notification(method: &str) -> Value {
    json!({ "method": method })
}

fn rpc_rejection(id: Value, message: &str) -> Value {
    json!({
        "id": id,
        "error": {
            "code": -32601,
            "message": message
        }
    })
}

fn write_message(stdin: &SharedStdin, value: &Value) -> Result<(), String> {
    let mut stdin = stdin.lock().map_err(lock_error)?;
    serde_json::to_writer(&mut *stdin, value)
        .map_err(|error| format!("Failed to encode Codex RPC: {error}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Failed to write Codex RPC: {error}"))
}

fn rpc_error(value: &Value) -> String {
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown JSON-RPC error");
    value
        .get("code")
        .and_then(Value::as_i64)
        .map(|code| format!("Codex JSON-RPC error {code}: {message}"))
        .unwrap_or_else(|| format!("Codex JSON-RPC error: {message}"))
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "Agent runtime lock poisoned".into()
}

fn workspace_key(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(target_os = "windows")]
fn codex_command() -> Command {
    let resolved = background_command("where")
        .arg("codex")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
        })
        .unwrap_or_else(|| "codex".into());
    if resolved.to_ascii_lowercase().ends_with(".cmd")
        || resolved.to_ascii_lowercase().ends_with(".bat")
    {
        let mut command = background_command("cmd.exe");
        command.arg("/d").arg("/s").arg("/c").arg(resolved);
        command
    } else {
        background_command(resolved)
    }
}

#[cfg(not(target_os = "windows"))]
fn codex_command() -> Command {
    background_command("codex")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_wire_messages_omit_jsonrpc_version_field() {
        let request = rpc_request(7, "thread/start", json!({ "cwd": "/tmp" }));
        let notification = rpc_notification("initialized");
        assert_eq!(request.get("id").and_then(Value::as_u64), Some(7));
        assert!(request.get("jsonrpc").is_none());
        assert!(notification.get("jsonrpc").is_none());
    }

    #[test]
    fn server_request_rejection_preserves_string_id() {
        let rejected = rpc_rejection(json!("approval-1"), "unsupported");
        assert_eq!(rejected.get("id").and_then(Value::as_str), Some("approval-1"));
        assert_eq!(
            rejected
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(Value::as_i64),
            Some(-32601)
        );
    }

    #[test]
    fn extracts_notification_ids() {
        let payload = json!({ "thread": {"id":"thr"}, "turn": {"id":"turn"} });
        assert_eq!(extract_ids(&payload), (Some("thr".into()), Some("turn".into())));
    }

    #[test]
    fn normalizes_workspace_key() {
        assert_eq!(workspace_key("D:\\Project\\VirtualLab\\"), "d:/project/virtuallab");
    }
}
