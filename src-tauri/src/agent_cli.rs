//! Local CLI harness bridge. Structured NDJSON, no shell/PTY scraping.
//! CLI sessions are ephemeral; provider session IDs are fed back as binding events.
//! This is NOT a hardware authorization or sandbox boundary.
use crate::managed_process::ManagedChild as Child;
use crate::agent_ownership::AgentOwnership;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    process::{ Command, Stdio},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCapabilities {
    harness: String,
    available: bool,
    version: Option<String>,
    detail: String,
    features: CliFeatures,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliFeatures {
    persistent_threads: bool,
    turns: bool,
    steering: bool,
    interrupt: bool,
    structured_events: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliBinding {
    workspace_root: String,
    harness: String,
    thread_id: String,
    created_at_ms: u128,
    updated_at_ms: u128,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStart {
    workspace_root: String,
    harness: String,
    thread_id: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTurn {
    workspace_root: String,
    thread_id: String,
    text: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInterrupt {
    workspace_root: String,
    thread_id: String,
    turn_id: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTurnResult {
    thread_id: String,
    turn_id: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliEvent {
    event_type: String,
    workspace_root: String,
    thread_id: Option<String>,
    turn_id: Option<String>,
    method: Option<String>,
    payload: Option<Value>,
    timestamp_ms: u128,
}
struct CliSession {
    binding: Mutex<CliBinding>,
    active: Mutex<Option<(String, Arc<Mutex<Child>>)>>,
    turn_counter: AtomicU64,
    stopped: AtomicBool,
}
#[derive(Clone, Default)]
pub struct CliAgentManager {
    sessions: Arc<Mutex<HashMap<String, Arc<CliSession>>>>,
}
fn key(root: &str) -> String {
    root.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}
fn now() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}
fn err_lock<T>(_: std::sync::PoisonError<T>) -> String {
    "Agent CLI runtime lock poisoned".into()
}
fn binary(harness: &str) -> Result<&'static str, String> {
    match harness {
        "claude" => Ok("claude"),
        "opencode" => Ok("opencode"),
        other => Err(format!("Unsupported CLI harness: {other}")),
    }
}
fn cli_command(harness: &str) -> Result<Command, String> {
    // Keep prompts as regular arguments; Rust handles Windows batch escaping.
    Ok(crate::execution::process_command(binary(harness)?))
}
fn emit(app: &AppHandle, kind: &str, binding: &CliBinding, turn: Option<&str>, payload: Option<Value>) {
    let _ = app.emit("agent://event", CliEvent {
        event_type: kind.into(),
        workspace_root: binding.workspace_root.clone(),
        thread_id: Some(binding.thread_id.clone()),
        turn_id: turn.map(ToOwned::to_owned),
        method: None,
        payload,
        timestamp_ms: now(),
    });
}
#[tauri::command]
pub fn agent_cli_capabilities(harness: String) -> Result<CliCapabilities, String> {
    let features = CliFeatures {
        persistent_threads: true, turns: true, steering: false,
        interrupt: true, structured_events: true,
    };
    let output = cli_command(&harness)?.arg("--version").output();
    match output {
        Ok(value) if value.status.success() => Ok(CliCapabilities {
            harness, available: true,
            version: Some(String::from_utf8_lossy(&value.stdout).trim().chars().take(120).collect()),
            detail: "Native CLI detected; non-interactive structured events, no automated approvals.".into(),
            features,
        }),
        Ok(_) => Ok(CliCapabilities {
            harness, available: false, version: None,
            detail: "CLI version check failed.".into(), features,
        }),
        Err(error) => Ok(CliCapabilities {
            harness, available: false, version: None,
            detail: format!("Native CLI unavailable: {error}"), features,
        }),
    }
}
#[tauri::command]
pub fn agent_cli_session_start(
    app: AppHandle,
    state: State<'_, CliAgentManager>,
    owner: State<'_, AgentOwnership>,
    request: CliStart,
) -> Result<CliBinding, String> {
    binary(&request.harness)?;
    let root = request.workspace_root.trim();
    if root.is_empty() || !std::path::Path::new(root).is_dir() {
        return Err("Agent workspace must be an existing directory.".into());
    }
    let workspace_key = key(root);
    let mut map = state.sessions.lock().map_err(err_lock)?;
    if app.state::<crate::run_registry::RunRegistry>().is_closed() { return Err("Application is shutting down".into()); }
    if let Some(existing) = map.get(&workspace_key) {
        let binding = existing.binding.lock().map_err(err_lock)?.clone();
        if binding.harness != request.harness {
            return Err("Stop the attached agent before changing harnesses.".into());
        }
        if request.thread_id.as_deref().is_some_and(|id| id != binding.thread_id) {
            return Err("Active session does not match stored binding.".into());
        }
        return Ok(binding);
    }
    owner.claim(root, &request.harness)?;
    let stamp = now();
    let binding = CliBinding {
        workspace_root: root.into(), harness: request.harness,
        thread_id: request.thread_id.filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| format!("pending-{}-{stamp}", std::process::id())),
        created_at_ms: stamp, updated_at_ms: stamp,
    };
    map.insert(workspace_key, Arc::new(CliSession {
        binding: Mutex::new(binding.clone()),
        active: Mutex::new(None),
        turn_counter: AtomicU64::new(1),
        stopped: AtomicBool::new(false),
    }));
    Ok(binding)
}
fn session(manager: &CliAgentManager, root: &str, thread_id: &str) -> Result<Arc<CliSession>, String> {
    let item = manager.sessions.lock().map_err(err_lock)?
        .get(&key(root)).cloned().ok_or("No attached CLI agent session.")?;
    if item.binding.lock().map_err(err_lock)?.thread_id != thread_id {
        return Err("CLI thread does not match workspace session.".into());
    }
    Ok(item)
}
fn provider_session_id(value: &Value) -> Option<&str> {
    // Claude emits session_id; OpenCode emits sessionID in message/part events.
    value.get("session_id").or_else(|| value.get("sessionID"))
        .or_else(|| value.get("sessionId"))
        .or_else(|| value.get("part").and_then(|part| part.get("sessionID")))
        .or_else(|| value.get("properties").and_then(|p| p.get("sessionID")))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}
fn process_stdout(app: AppHandle, session: Arc<CliSession>, turn_id: String, stdout: impl std::io::Read + Send + 'static) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.len() > 128 * 1024 { continue; }
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if let Some(id) = provider_session_id(&value) {
                    let updated = {
                        let mut binding = match session.binding.lock() {
                            Ok(binding) => binding,
                            Err(_) => return,
                        };
                        if binding.thread_id != id {
                            binding.thread_id = id.to_string();
                            binding.updated_at_ms = now();
                            Some(binding.clone())
                        } else { None }
                    };
                    if let Some(binding) = updated {
                        emit(&app, "agent.session_binding", &binding, Some(&turn_id),
                            Some(json!({"binding": binding})));
                    }
                }
                if let Ok(binding) = session.binding.lock() {
                    emit(&app, "agent.notification", &binding, Some(&turn_id),
                        Some(json!({"method": format!("{}/event", binding.harness), "data": value})));
                }
            }
        }
    })
}
fn process_stderr(app: AppHandle, session: Arc<CliSession>, turn_id: String, stderr: impl std::io::Read + Send + 'static) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(binding) = session.binding.lock() {
                if !line.trim().is_empty() {
                    emit(&app, "agent.stderr", &binding, Some(&turn_id),
                        Some(json!({"detail": line.chars().take(1024).collect::<String>()})));
                }
            }
        }
    })
}
#[tauri::command]
pub async fn agent_cli_turn_start(
    app: AppHandle,
    state: State<'_, CliAgentManager>,
    request: CliTurn,
) -> Result<CliTurnResult, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let text = request.text.trim();
        if text.is_empty() || text.len() > 200_000 {
            return Err("Agent prompt must be between 1 and 200000 bytes.".into());
        }
        let entry = session(&manager, &request.workspace_root, &request.thread_id)?;
        let binding = entry.binding.lock().map_err(err_lock)?.clone();
        let mut active = entry.active.lock().map_err(err_lock)?;
        if app.state::<crate::run_registry::RunRegistry>().is_closed() { return Err("Application is shutting down".into()); }
        if entry.stopped.load(Ordering::SeqCst) { return Err("CLI session has been stopped".into()); }
        if active.is_some() { return Err("This workspace already has an active CLI turn.".into()); }
        let mut command = cli_command(&binding.harness)?;
        if binding.harness == "claude" {
            command.args(["-p", "--verbose", "--output-format", "stream-json",
                "--permission-mode", "plan"]);
            if !binding.thread_id.starts_with("pending-") {
                command.arg("--resume").arg(&binding.thread_id);
            }
            command.arg(text);
        } else {
            command.args(["run", "--format", "json", "--agent", "plan"]);
            if !binding.thread_id.starts_with("pending-") {
                command.arg("--session").arg(&binding.thread_id);
            }
            command.arg(text);
        }
        crate::process::configure_process_tree(&mut command);
        command.current_dir(&binding.workspace_root)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = crate::managed_process::spawn(&mut command).map_err(|error| format!("Failed to start {}: {error}", binding.harness))?;
        let stdout = child.stdout.take().ok_or("CLI stdout pipe unavailable")?;
        let stderr = child.stderr.take().ok_or("CLI stderr pipe unavailable")?;
        let turn_id = format!("cli-{}-{}", now(), entry.turn_counter.fetch_add(1, Ordering::Relaxed));
        let process = Arc::new(Mutex::new(child));
        *active = Some((turn_id.clone(), process.clone()));
        drop(active);
        emit(&app, "agent.turn_started", &binding, Some(&turn_id), None);
        let stdout_thread = process_stdout(app.clone(), entry.clone(), turn_id.clone(), stdout);
        let stderr_thread = process_stderr(app.clone(), entry.clone(), turn_id.clone(), stderr);
        let watcher_turn = turn_id.clone();
        thread::spawn(move || {
            loop {
                let status = process.lock().ok().and_then(|mut child| child.try_wait().ok()).flatten();
                if let Some(status) = status {
                    let mut reported = false;
                    loop {
                        let cleanup = process.lock().map_err(err_lock)
                            .and_then(|mut child| child.terminate_remaining().map_err(|e| e.to_string()));
                        match cleanup {
                            Ok(()) => break,
                            Err(error) => {
                                if !reported {
                                    if let Ok(binding) = entry.binding.lock() {
                                        emit(&app, "agent.protocol_error", &binding, Some(&watcher_turn), Some(json!({"detail": format!("Cleanup not confirmed: {error}")})));
                                    }
                                    reported = true;
                                }
                                thread::sleep(Duration::from_millis(120));
                            }
                        }
                    }
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    if let Ok(mut current) = entry.active.lock() {
                        if current.as_ref().is_some_and(|(id, _)| id == &watcher_turn) { *current = None; }
                    }
                    if let Ok(binding) = entry.binding.lock() {
                        emit(&app, "agent.turn_completed", &binding, Some(&watcher_turn),
                            Some(json!({"status": if status.success() { "completed" } else { "failed" },
                                "exitCode": status.code()})));
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(80));
            }
        });
        Ok(CliTurnResult { thread_id: binding.thread_id, turn_id })
    }).await.map_err(|error| format!("Agent CLI task failed: {error}"))?
}
#[tauri::command]
pub fn agent_cli_turn_interrupt(state: State<'_, CliAgentManager>, request: CliInterrupt) -> Result<(), String> {
    let entry = session(&state, &request.workspace_root, &request.thread_id)?;
    let active = entry.active.lock().map_err(err_lock)?;
    let (_, child) = active.as_ref().filter(|(id, _)| id == &request.turn_id)
        .ok_or("No matching running turn.")?;
    let result = crate::process::terminate_tree(&mut *child.lock().map_err(err_lock)?);
    result
}
#[tauri::command]
pub fn agent_cli_session_stop(state: State<'_, CliAgentManager>, owner: State<'_, AgentOwnership>, workspace_root: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(err_lock)?;
    if let Some(entry) = sessions.get(&key(&workspace_root)).cloned() {
        let mut active = entry.active.lock().map_err(err_lock)?;
        entry.stopped.store(true, Ordering::SeqCst);
        if let Some((_, child)) = active.as_ref() {
            crate::process::terminate_tree(&mut *child.lock().map_err(err_lock)?)?;
        }
        *active = None;
        sessions.remove(&key(&workspace_root));
        if let Ok(binding) = entry.binding.lock() { owner.release(&workspace_root, &binding.harness); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_known_executables_allowed() {
        assert!(binary("claude").is_ok());
        assert!(binary("opencode").is_ok());
        assert!(binary("powershell").is_err());
    }
    #[test]
    fn parses_provider_session_identity() {
        assert_eq!(provider_session_id(&json!({"session_id":"abc"})), Some("abc"));
        assert_eq!(provider_session_id(&json!({"part":{"sessionID":"def"}})), Some("def"));
        assert_eq!(provider_session_id(&json!({"nonsense":"xyz"})), None);
    }
}

impl CliAgentManager {
    pub fn shutdown(&self) {
        if let Ok(sessions) = self.sessions.lock() {
            for session in sessions.values() {
                session.stopped.store(true, Ordering::SeqCst);
                if let Ok(active) = session.active.lock() {
                    if let Some((_, child)) = active.as_ref() {
                        if let Ok(mut child) = child.lock() { let _ = crate::process::terminate_tree(&mut child); }
                    }
                }
            }
        }
    }
}
