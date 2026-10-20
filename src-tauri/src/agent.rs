use crate::bounded_lines::{bounded_lines, MAX_AGENT_LINE_BYTES};
use crate::managed_process::ManagedChild as Child;
use crate::agent_ownership::AgentOwnership;
use crate::workspace_lifecycle::{WorkspaceLifecycle, WorkspaceReservation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Write},
    process::{ ChildStdin, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const RPC_TIMEOUT: Duration = Duration::from_secs(20);

/// Commit privacy-filtered lifecycle metadata before notifying the frontend.
fn emit(app: &AppHandle, event: AgentEvent) {
    crate::agent_journal::emit_agent_event(app, None, event);
}
type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;
type SharedStdin = Arc<Mutex<ChildStdin>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHarnessCapabilities {
    harness: String,
    available: bool,
    version: Option<String>,
    executable_path: Option<String>,
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
    pub(crate) workspace_root: String,
    pub(crate) harness: String,
    pub(crate) thread_id: String,
    pub(crate) created_at_ms: u128,
    pub(crate) updated_at_ms: u128,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionStartRequest {
    pub(crate) workspace_root: String,
    pub(crate) harness: String,
    pub(crate) thread_id: Option<String>,
    pub(crate) executable_path: Option<String>,
    #[serde(default)]
    pub(crate) require_fresh: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnStartRequest {
    pub(crate) workspace_root: String,
    pub(crate) thread_id: String,
    pub(crate) text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnStartResult {
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnControlRequest {
    pub(crate) workspace_root: String,
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
    pub(crate) text: Option<String>,
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
    _reservation: Mutex<Option<WorkspaceReservation>>,
}

impl CodexProcess {
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        // The same deadline covers pipe backpressure and the response wait.
        let deadline = Instant::now() + RPC_TIMEOUT;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().map_err(lock_error)?.insert(id, tx);
        if let Err(error) = self.write_until(rpc_request(id, method, params), deadline) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
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
        self.write_until(value, Instant::now() + RPC_TIMEOUT)
    }

    fn write_until(&self, value: Value, deadline: Instant) -> Result<(), String> {
        let stdin = self.stdin.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        let writer = thread::Builder::new()
            .name("agent-rpc-write".into())
            .spawn(move || {
                let _ = tx.send(write_message(&stdin, &value));
            })
            .map_err(|_| "Cannot start Codex RPC writer")?;
        let outcome = match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(outcome) => outcome,
            Err(_) => {
                // A timed-out future does not stop a blocking pipe writer. Kill
                // the owned tree, then join the writer before returning to the
                // caller that owns the task's execution slot.
                while self.stop().is_err() {
                    thread::sleep(Duration::from_millis(20));
                }
                Err("Codex RPC stdin write timed out; provider stopped".into())
            }
        };
        writer.join().map_err(|_| "Codex RPC writer failed")?;
        outcome
    }

    fn is_running(&self) -> Result<bool, String> {
        let mut child = self.child.lock().map_err(lock_error)?;
        child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|error| format!("Failed to inspect Codex app-server: {error}"))
    }

    fn stop(&self) -> Result<(), String> {
        crate::process::terminate_tree(&mut *self.child.lock().map_err(lock_error)?)?;
        // Tree exit closes every inherited reader. Observe any blocked stdin
        // writer releasing its lock before permitting another workspace writer.
        drop(self.stdin.lock().map_err(lock_error)?);
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("Codex app-server stopped".into()));
            }
        }
        // A synchronous, confirmed stop permits immediate candidate sealing.
        // Errors leave the claim intact for the runtime/monitor to retry.
        self._reservation.lock().map_err(lock_error)?.take();
        Ok(())
    }
}

struct AgentRuntime {
    process: Arc<CodexProcess>,
    binding: AgentSessionBinding,
    executable_path: String,
}

#[derive(Clone, Default)]
pub struct AgentManager {
    runtimes: Arc<Mutex<HashMap<String, Arc<AgentRuntime>>>>,
    lifecycle: Arc<Mutex<()>>,
    completions: CompletionObservers,
    reports: ReportObservers,
}

/// Provider execution outcome only; never verification or delivery readiness.
#[derive(Debug, Clone)]
pub(crate) struct AgentTurnCompletion {
    pub(crate) workspace_root: String,
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
    pub(crate) status: String,
    pub(crate) final_output: Option<String>,
    pub(crate) output_truncated: bool,
    pub(crate) error: Option<String>,
}
type CompletionObservers = Arc<Mutex<Vec<(String, mpsc::Sender<AgentTurnCompletion>)>>>;

#[derive(Clone, Default)]
struct ReportObservers(Arc<Mutex<Vec<ReportObserver>>>);
struct ReportObserver {
    workspace_key: String,
    sender: mpsc::SyncSender<crate::task_reports::ReportNotification>,
    truncated: Arc<AtomicBool>,
}
pub(crate) struct ReportSubscription {
    pub(crate) receiver: mpsc::Receiver<crate::task_reports::ReportNotification>,
    truncated: Arc<AtomicBool>,
}
impl ReportSubscription {
    pub(crate) fn take_truncated(&self) -> bool { self.truncated.swap(false, Ordering::AcqRel) }
}
impl ReportObservers {
    fn subscribe(&self, root: &str) -> Result<ReportSubscription, String> {
        let (sender, receiver) = mpsc::sync_channel(64);
        let truncated = Arc::new(AtomicBool::new(false));
        self.0.lock().map_err(lock_error)?.push(ReportObserver { workspace_key: workspace_key(root), sender, truncated: truncated.clone() });
        Ok(ReportSubscription { receiver, truncated })
    }
    fn publish(&self, event: crate::task_reports::ReportNotification) {
        // Archive only user-facing activity. Reasoning and arbitrary provider
        // protocol payloads do not enter the task report channel.
        let allowed = match event.method.as_str() {
            "item/started" | "item/completed" => matches!(event.payload.pointer("/item/type").and_then(Value::as_str), Some("agentMessage" | "commandExecution" | "fileChange")),
            "item/agentMessage/delta" | "item/commandExecution/outputDelta" | "error" | "turn/failed" | "virtuallab/serverRequestRejected" => true,
            _ => false,
        };
        if !allowed { return; }
        if let Ok(mut observers) = self.0.lock() {
            observers.retain(|observer| {
                if observer.workspace_key != workspace_key(&event.workspace_root) { return true; }
                match observer.sender.try_send(event.clone()) {
                    Ok(()) => true,
                    Err(mpsc::TrySendError::Full(_)) => { observer.truncated.store(true, Ordering::Release); true }
                    Err(mpsc::TrySendError::Disconnected(_)) => false,
                }
            });
        }
    }
}

#[derive(Default)]
struct TurnSummary { streamed: String, completed: Option<String>, truncated: bool }
#[derive(Default)]
struct TurnSummaries(HashMap<(String, String), TurnSummary>);
impl TurnSummaries {
    fn observe(&mut self, event: &crate::task_reports::ReportNotification) {
        if !matches!(event.method.as_str(), "item/agentMessage/delta" | "item/completed") { return; }
        let (Some(thread), Some(turn)) = (&event.thread_id, &event.turn_id) else { return; };
        let key = (thread.clone(), turn.clone());
        if self.0.len() >= 16 && !self.0.contains_key(&key) {
            if let Some(oldest) = self.0.keys().next().cloned() { self.0.remove(&oldest); }
        }
        let summary = self.0.entry(key).or_default();
        if event.method == "item/completed" {
            if let Some(text) = crate::task_reports::completed_assistant_text(&event.payload) {
                let (text, clipped) = crate::task_reports::bounded_text(&text, crate::task_reports::MAX_SUMMARY_BYTES);
                summary.completed = Some(text);
                summary.truncated = clipped;
            }
        } else if let Some(delta) = event.payload.get("delta").and_then(Value::as_str).or_else(|| event.payload.pointer("/delta/text").and_then(Value::as_str)) {
            let (text, clipped) = crate::task_reports::bounded_text(delta, crate::task_reports::MAX_SUMMARY_BYTES.saturating_sub(summary.streamed.len()));
            summary.streamed.push_str(&text);
            summary.truncated |= clipped;
        }
    }
    fn take(&mut self, thread: &str, turn: &str) -> (Option<String>, bool) {
        let Some(summary) = self.0.remove(&(thread.into(), turn.into())) else { return (None, false); };
        if summary.completed.is_some() { (summary.completed, summary.truncated) }
        else { ((!summary.streamed.is_empty()).then_some(summary.streamed), true) }
    }
}

fn observe_notification(root: &str, method: &str, payload: &Value, completions: &CompletionObservers, reports: &ReportObservers, summaries: &mut TurnSummaries) {
    let (thread_id, turn_id) = extract_ids(payload);
    let event = crate::task_reports::ReportNotification { workspace_root: root.into(), thread_id, turn_id, method: method.into(), payload: payload.clone(), timestamp_ms: crate::tasks::now_ms() };
    summaries.observe(&event);
    reports.publish(event);
    if let Some(mut completion) = turn_completion(root, method, payload) {
        (completion.final_output, completion.output_truncated) = summaries.take(&completion.thread_id, &completion.turn_id);
        if let Ok(mut observers) = completions.lock() {
            observers.retain(|(key, observer)| *key != workspace_key(root) || observer.send(completion.clone()).is_ok());
        }
    }
}

fn turn_completion(root: &str, method: &str, payload: &Value) -> Option<AgentTurnCompletion> {
    if method != "turn/completed" { return None; }
    let thread_id = payload.get("threadId")?.as_str()?.to_string();
    let turn = payload.get("turn")?;
    let turn_id = turn.get("id")?.as_str()?.to_string();
    let status = turn.get("status")?.as_str()?;
    if thread_id.is_empty() || turn_id.is_empty() || !matches!(status, "completed" | "failed" | "interrupted") { return None; }
    let error = turn.pointer("/error/message").and_then(Value::as_str)
        .map(|message| crate::task_reports::bounded_text(message, 4096).0);
    Some(AgentTurnCompletion { workspace_root: root.into(), thread_id, turn_id, status: status.into(), final_output: None, output_truncated: false, error })
}

impl AgentManager {
    // These operations are called while the manager lifecycle mutex is held.
    fn existing_for_start(&self, root: &str, require_fresh: bool) -> Result<Option<Arc<AgentRuntime>>, String> {
        let existing = self.runtimes.lock().map_err(lock_error)?.get(&workspace_key(root)).cloned();
        if require_fresh && existing.is_some() {
            return Err("Task execution requires a fresh agent session; stop the attached runtime first.".into());
        }
        Ok(existing)
    }

    fn process_exit_event(&self, root: &str, process: &Arc<CodexProcess>) -> AgentEvent {
        let thread_id = self.runtimes.lock().ok().and_then(|runtimes| {
            runtimes.get(&workspace_key(root))
                .filter(|runtime| Arc::ptr_eq(&runtime.process, process))
                .map(|runtime| runtime.binding.thread_id.clone())
        });
        // Failed initialization or an old monitor may have no current binding.
        // Preserve that unknown identity instead of borrowing a replacement's.
        AgentEvent::lifecycle("agent.process_exited", root, thread_id)
    }

    fn stop_runtime(&self, root: &str, expected_thread_id: Option<&str>) -> Result<Option<AgentSessionBinding>, String> {
        let runtime = self.runtimes.lock().map_err(lock_error)?.get(&workspace_key(root)).cloned();
        if let Some(runtime) = runtime {
            if expected_thread_id.is_some_and(|expected| expected != runtime.binding.thread_id) {
                return Err("Agent thread binding changed; refusing to stop a replacement runtime.".into());
            }
            runtime.process.stop()?;
            self.runtimes.lock().map_err(lock_error)?.remove(&workspace_key(root));
            return Ok(Some(runtime.binding.clone()));
        }
        Ok(None)
    }

    /// Subscribe before starting a turn, then match workspace/thread/turn IDs.
    /// The task receives only its workspace's terminal outcome and bounded final
    /// assistant text. No prompt, environment, reasoning or raw payload is copied.
    pub(crate) fn subscribe_completions(&self, root: &str) -> Result<mpsc::Receiver<AgentTurnCompletion>, String> {
        let (tx, rx) = mpsc::channel();
        self.completions.lock().map_err(lock_error)?.push((workspace_key(root), tx));
        Ok(rx)
    }
    pub(crate) fn subscribe_reports(&self, root: &str) -> Result<ReportSubscription, String> { self.reports.subscribe(root) }
    pub(crate) fn is_running_bound(&self, root: &str, thread: &str) -> Result<bool, String> {
        let runtime = self.runtimes.lock().map_err(lock_error)?.get(&workspace_key(root)).cloned();
        match runtime { Some(runtime) if runtime.binding.thread_id == thread => runtime.process.is_running(), _ => Ok(false) }
    }
    /// Conservative gate for worktree removal: a registered runtime must be
    /// explicitly stopped before its worktree can be deleted.
    pub fn owns_workspace(&self, path: &str) -> Result<bool, String> {
        Ok(self.runtimes.lock().map_err(lock_error)?
            .contains_key(&workspace_key(path)))
    }
}

const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const VERSION_PROBE_STDOUT_LIMIT: usize = 16 * 1024;

fn recognized_codex_version(bytes: &[u8]) -> Result<String, String> {
    let line = std::str::from_utf8(bytes)
        .map_err(|_| "Codex version probe returned invalid encoding")?
        .trim();
    let version = line
        .strip_prefix("codex-cli ")
        .or_else(|| line.strip_prefix("codex "))
        .ok_or("Codex version probe did not return a recognizable identity")?;
    // Only one bounded version token is metadata. Never retain arbitrary output,
    // diagnostics, multiline payloads or environment values as a version string.
    if line.len() > 256
        || version.is_empty()
        || !version.as_bytes()[0].is_ascii_digit()
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-' | b'_'))
    {
        return Err("Codex version probe did not return a bounded version token".into());
    }
    Ok(line.to_owned())
}

fn stop_version_probe(child: &mut Child) {
    // The query deadline never authorizes dropping ownership of a still-live
    // tree. Retain the caller (and its task slot) if OS shutdown is unconfirmed.
    while crate::process::terminate_tree(child).is_err() {
        thread::sleep(Duration::from_millis(20));
    }
}

fn probe_codex_version(executable: &str) -> Result<String, String> {
    use std::{io::Read, time::Instant};
    let deadline = Instant::now() + VERSION_PROBE_TIMEOUT;
    let mut command = crate::execution::process_command(executable);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = crate::managed_process::spawn(&mut command)
        .map_err(|error| format!(
            "Codex version probe could not start (kind={:?}, code={:?})",
            error.kind(), error.raw_os_error(),
        ))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            stop_version_probe(&mut child);
            return Err("Codex version probe stdout is unavailable".into());
        }
    };
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = (|| -> Result<Vec<u8>, &'static str> {
            let mut stdout = stdout;
            let mut bytes = Vec::with_capacity(VERSION_PROBE_STDOUT_LIMIT);
            let mut chunk = [0u8; 2048];
            loop {
                let count = stdout
                    .read(&mut chunk)
                    .map_err(|_| "Codex version probe stdout could not be read")?;
                if count == 0 {
                    return Ok(bytes);
                }
                if bytes.len() + count > VERSION_PROBE_STDOUT_LIMIT {
                    return Err("Codex version probe stdout exceeds 16 KiB");
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
        })();
        let _ = tx.send(result);
    });
    let mut output = None;
    let outcome: Result<Vec<u8>, String> = loop {
        if output.is_none() {
            match rx.try_recv() {
                Ok(Ok(bytes)) => output = Some(bytes),
                Ok(Err(error)) => break Err(error.into()),
                Err(mpsc::TryRecvError::Disconnected) => {
                    break Err("Codex version probe stdout observer disconnected".into())
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                break Err("Codex version probe exited unsuccessfully".into())
            }
            Ok(Some(_)) if output.is_some() => break Ok(output.take().unwrap_or_default()),
            Err(_) => break Err("Codex version probe exit could not be observed".into()),
            _ => {}
        }
        if Instant::now() >= deadline {
            break Err("Codex version probe timed out".into());
        }
        thread::sleep(Duration::from_millis(10));
    };
    // Success, oversized output, invalid protocol and timeout all observe tree
    // shutdown before returning. Stderr goes to null and never enters metadata.
    stop_version_probe(&mut child);
    recognized_codex_version(&outcome?)
}

#[tauri::command]
pub fn agent_harness_capabilities(harness: String, executable_path: Option<String>) -> Result<AgentHarnessCapabilities, String> {
    if harness != "codex" && harness != "deepseek" {
        return Err(format!("Unsupported agent harness: {harness}"));
    }
    if harness == "deepseek" && std::env::var("DEEPSEEK_API_KEY").map_or(true, |key| key.trim().is_empty()) {
        return Ok(AgentHarnessCapabilities { harness, available: false, version: None, executable_path: None, detail: "DEEPSEEK_API_KEY is not set; configure the official DeepSeek Codex model catalog locally.".into(), features: AgentHarnessFeatures { persistent_threads: true, turns: true, steering: true, interrupt: true, structured_events: true } });
    }
    let features = AgentHarnessFeatures {
        persistent_threads: true,
        turns: true,
        steering: true,
        interrupt: true,
        structured_events: true,
    };
    // Report the exact binary we probe, then pin it for app-server startup.
    // A desktop app can inherit an older PATH than a newly opened shell.
    let executable = selected_codex_executable(executable_path.as_deref())?;
    let reported_path = std::path::Path::new(&executable).is_absolute().then_some(executable.clone());
    match probe_codex_version(&executable) {
        Ok(version) => Ok(AgentHarnessCapabilities {
            harness: harness.clone(), available: true, version: Some(version), executable_path: reported_path,
            detail: if harness == "deepseek" { "DeepSeek provider via Codex Responses app-server; requires DEEPSEEK_API_KEY and a local Codex model catalog.".into() } else { "Codex CLI available; VirtualLab uses app-server stdio JSON-RPC.".into() },
            features,
        }),
        Err(detail) => Ok(AgentHarnessCapabilities {
            harness, available: false, version: None, executable_path: reported_path, detail, features,
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
    let owner = app.state::<AgentOwnership>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = manager.lifecycle.clone();
        let _lifecycle = lifecycle.lock().map_err(lock_error)?;
        if app.state::<crate::run_registry::RunRegistry>().is_closed() { return Err("Application is shutting down".into()); }
        manager.existing_for_start(request.workspace_root.trim(), request.require_fresh)?;
        owner.claim(&request.workspace_root, &request.harness)?;
        let root = request.workspace_root.clone();
        let kind = request.harness.clone();
        let result = start_session(app, manager.clone(), request);
        if result.is_err() {
            let attached = manager.runtimes.lock().map_err(lock_error)?.get(&workspace_key(&root)).cloned();
            if !attached.is_some_and(|runtime| runtime.binding.harness == kind && runtime.process.is_running().unwrap_or(true)) {
                owner.release(&root, &kind);
            }
        }
        result
    })
        .await
        .map_err(|error| format!("Agent session task failed: {error}"))?
}

fn start_session(
    app: AppHandle,
    manager: AgentManager,
    request: AgentSessionStartRequest,
) -> Result<AgentSessionBinding, String> {
    if request.harness != "codex" && request.harness != "deepseek" {
        return Err(format!("Unsupported agent harness: {}", request.harness));
    }
    let root = request.workspace_root.trim();
    if root.is_empty() || !std::path::Path::new(root).is_dir() {
        return Err(format!("Agent workspace is not a directory: {}", request.workspace_root));
    }
    let key = workspace_key(root);
    let selected_executable = selected_codex_executable(request.executable_path.as_deref())?;
    let existing = manager.existing_for_start(root, request.require_fresh)?;
    if let Some(existing) = existing {
        if existing.process.is_running()? {
            if request
                .thread_id
                .as_deref()
                .is_some_and(|thread| thread != existing.binding.thread_id)
            {
                return Err("Workspace already has a different active agent thread.".into());
            }
            if existing.binding.harness != request.harness { return Err("Stop the current harness before switching providers.".into()); }
            let same_executable = if cfg!(windows) {
                existing.executable_path.eq_ignore_ascii_case(&selected_executable)
            } else {
                existing.executable_path == selected_executable
            };
            if !same_executable {
                return Err("Codex executable changed while this workspace runtime is active. Stop runtime, then attach again.".into());
            }
            return Ok(existing.binding.clone());
        }
        existing.process.stop()?;
        manager.runtimes.lock().map_err(lock_error)?.remove(&key);
    }

    let reservation = app.state::<WorkspaceLifecycle>().reserve(root, &format!("agent {}", request.harness))?;
    let process = spawn_codex(&app, root, &request.harness, &selected_executable, reservation, manager.completions.clone(), manager.reports.clone())?;
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
                "excludeTurns": true,
                "model": if request.harness == "deepseek" { Some("deepseek-flash") } else { None },
                "modelProvider": if request.harness == "deepseek" { Some("deepseek") } else { None }
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
                "serviceName": "virtuallab",
                "model": if request.harness == "deepseek" { Some("deepseek-flash") } else { None },
                "modelProvider": if request.harness == "deepseek" { Some("deepseek") } else { None }
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
    let thread_id = match nested_id(&result, "thread") {
        Some(id) => id,
        None => { let _ = process.stop(); return Err("Codex response missing thread.id".into()); }
    };
    let timestamp = now_ms();
    let binding = AgentSessionBinding {
        workspace_root: root.into(),
        harness: request.harness.clone(),
        thread_id: thread_id.clone(),
        created_at_ms: timestamp,
        updated_at_ms: timestamp,
    };
    manager.runtimes.lock().map_err(lock_error)?.insert(
        key,
        Arc::new(AgentRuntime {
            process,
            binding: binding.clone(),
            executable_path: selected_executable,
        }),
    );
    crate::agent_journal::emit_agent_event(&app, Some(&request.harness),
        AgentEvent::lifecycle("agent.session_started", root, Some(thread_id)),
    );
    Ok(binding)
}

#[tauri::command]
pub async fn agent_turn_start(
    app: AppHandle,
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
        let turn_id = nested_id(&result, "turn")
            .ok_or_else(|| "Codex response missing turn.id".to_string())?;
        crate::agent_journal::emit_agent_event(&app, Some(&runtime.binding.harness), AgentEvent {
            event_type: "agent.turn_started".into(),
            workspace_root: request.workspace_root.clone(),
            thread_id: Some(runtime.binding.thread_id.clone()),
            turn_id: Some(turn_id.clone()),
            method: None, payload: None, timestamp_ms: now_ms(),
        });
        Ok(AgentTurnStartResult {
            thread_id: runtime.binding.thread_id.clone(),
            turn_id,
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
    stop_session(app, state, workspace_root, None)
}

pub(crate) fn agent_session_stop_bound(
    app: AppHandle,
    state: State<'_, AgentManager>,
    workspace_root: String,
    expected_thread_id: String,
) -> Result<(), String> {
    stop_session(app, state, workspace_root, Some(&expected_thread_id))
}

fn stop_session(
    app: AppHandle,
    state: State<'_, AgentManager>,
    workspace_root: String,
    expected_thread_id: Option<&str>,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().map_err(lock_error)?;
    if let Some(binding) = state.stop_runtime(&workspace_root, expected_thread_id)? {
        crate::agent_journal::emit_agent_event(&app, Some(&binding.harness),
            AgentEvent::lifecycle("agent.session_stopped", &workspace_root, Some(binding.thread_id)));
    }
    app.state::<AgentOwnership>().release(&workspace_root, "codex");
    app.state::<AgentOwnership>().release(&workspace_root, "deepseek");
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

fn spawn_codex(app: &AppHandle, root: &str, harness: &str, executable_path: &str, reservation: WorkspaceReservation, completions: CompletionObservers, reports: ReportObservers) -> Result<Arc<CodexProcess>, String> {
    let mut command = crate::execution::process_command(executable_path);
    command.arg("app-server").arg("--listen").arg("stdio://");
    if harness == "deepseek" {
        if std::env::var("DEEPSEEK_API_KEY").map_or(true, |key| key.trim().is_empty()) {
            return Err("DEEPSEEK_API_KEY is required for DeepSeek; no credentials are stored by VirtualLab.".into());
        }
        // No tokens on argv, disk, or in the JSON-RPC stream. Codex reads the key from the environment.
        for entry in [
            "model_provider=\"deepseek\"",
            "model=\"deepseek-flash\"",
            "model_providers.deepseek.name=\"DeepSeek\"",
            "model_providers.deepseek.base_url=\"https://api.deepseek.com\"",
            "model_providers.deepseek.env_key=\"DEEPSEEK_API_KEY\"",
            "model_providers.deepseek.wire_api=\"responses\"",
            "model_providers.deepseek.requires_openai_auth=false",
            "model_providers.deepseek.supports_websockets=false",
        ] { command.arg("-c").arg(entry); }
    }
    crate::process::configure_process_tree(&mut command);
    command
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::managed_process::spawn(&mut command)
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
        completions,
        reports,
    );
    spawn_stderr(app.clone(), root.into(), stderr);
    let process = Arc::new(CodexProcess {
        _reservation: Mutex::new(Some(reservation)),
        stdin,
        child: Mutex::new(child),
        pending,
        next_id: AtomicU64::new(1),
    });
    // Keep the process and claim alive through failed initialization, stdout
    // closure, stop errors and descendant cleanup, not merely through spawn.
    let observed = process.clone();
    let monitor_app = app.clone();
    let monitor_root = root.to_string();
    thread::spawn(move || {
        loop {
            let exited = observed.child.lock().map_err(lock_error).and_then(|mut child| {
                match child.try_wait().map_err(|error| error.to_string())? {
                    Some(_) => child.terminate_remaining().map(|_| true).map_err(|error| error.to_string()),
                    None => Ok(false),
                }
            });
            if matches!(exited, Ok(true)) { break; }
            if exited.is_err() { let _ = observed.stop(); }
            thread::sleep(Duration::from_millis(120));
        }
        // Serialize with attach/stop: an old monitor must not clear the new
        // session's UI turn after a confirmed stop released its reservation.
        let manager = monitor_app.state::<AgentManager>();
        let _lifecycle = manager.lifecycle.lock().unwrap_or_else(|error| error.into_inner());
        if observed._reservation.lock().map(|claim| claim.is_some()).unwrap_or(false) {
            emit(&monitor_app, manager.process_exit_event(&monitor_root, &observed));
        }
    });
    Ok(process)
}

fn spawn_stdout<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    root: String,
    stdout: R,
    pending: Pending,
    stdin: SharedStdin,
    completions: CompletionObservers,
    reports: ReportObservers,
) {
    thread::spawn(move || {
        let mut summaries = TurnSummaries::default();
        for line in bounded_lines(stdout, MAX_AGENT_LINE_BYTES) {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    emit(&app,
                        AgentEvent::diagnostic("agent.protocol_error", &root, error.to_string()),
                    );
                    if error.kind() == std::io::ErrorKind::InvalidData { continue; }
                    break;
                }
            };
            let message: Value = match serde_json::from_str(&line) {
                Ok(message) => message,
                Err(error) => {
                    emit(&app,
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
                    observe_notification(&root, "virtuallab/serverRequestRejected", &payload, &completions, &reports, &mut summaries);
                    emit(&app,
                        AgentEvent::server_request(&root, method, payload),
                    );
                    if let Err(error) = write_message(
                        &stdin,
                        &rpc_rejection(
                            request_id,
                            "VirtualLab foundation adapter rejects server-initiated requests",
                        ),
                    ) {
                        emit(&app,
                            AgentEvent::diagnostic("agent.protocol_error", &root, error),
                        );
                    }
                    continue;
                }
                observe_notification(&root, method, &payload, &completions, &reports, &mut summaries);
                emit(&app,
                    AgentEvent::notification(&root, method, payload),
                );
            }
        }
        if let Ok(mut pending) = pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("Codex app-server stdout closed".into()));
            }
        }
        // EOF is a protocol event, not proof of process-tree exit.
        emit(&app, AgentEvent::lifecycle("agent.stdout_closed", &root, None));
    });
}

fn spawn_stderr<R: std::io::Read + Send + 'static>(app: AppHandle, root: String, stderr: R) {
    thread::spawn(move || {
        for line in bounded_lines(stderr, MAX_AGENT_LINE_BYTES).map(|line| line.unwrap_or_else(|error| format!("Agent stderr record rejected: {error}"))) {
            if !line.trim().is_empty() {
                emit(&app,
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
    crate::workspace_identity::key(path)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// An operator-chosen Codex executable is an absolute, existing local launcher;
/// it is never interpreted by a shell or substituted with an arbitrary command.
fn selected_codex_executable(override_path: Option<&str>) -> Result<String, String> {
    if let Some(value) = override_path.map(str::trim).filter(|value| !value.is_empty()) {
        let path = std::path::Path::new(value);
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("").to_ascii_lowercase();
        #[cfg(windows)]
        let valid_name = ["codex.exe", "codex.cmd", "codex.bat", "codex.com"].contains(&name.as_str());
        #[cfg(not(windows))]
        let valid_name = name == "codex";
        if !path.is_absolute() || !path.is_file() || !valid_name {
            return Err("Choose an existing absolute Codex launcher path (codex.exe/codex.cmd on Windows, codex on Unix).".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if path.metadata().map_err(|error| error.to_string())?.permissions().mode() & 0o111 == 0 {
                return Err("Selected Codex launcher is not executable.".into());
            }
        }
        return Ok(value.into());
    }

    #[cfg(windows)]
    {
        // Match the launcher selected by the existing background subprocess API.
        return Ok(crate::execution::resolve_windows_program("codex").unwrap_or_else(|| "codex".into()));
    }
    #[cfg(target_os = "macos")]
    {
        // Finder/Dock may omit Homebrew/Volta/npm PATH entries.
        return Ok(crate::process::macos_cli_path("codex")
            .map(|path| path.to_string_lossy().into_owned()).unwrap_or_else(|| "codex".into()));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let directories: Vec<std::path::PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect()).unwrap_or_default();
        return Ok(crate::cli_path::find_executable(std::path::Path::new("codex"), &directories)
            .map(|path| path.to_string_lossy().into_owned()).unwrap_or_else(|| "codex".into()));
    }
}
impl AgentManager {
    pub fn shutdown(&self) {
        let _lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(runtimes) = self.runtimes.lock() {
            for runtime in runtimes.values() { let _ = runtime.process.stop(); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct VersionFixture {
        root: std::path::PathBuf,
        executable: std::path::PathBuf,
    }
    impl VersionFixture {
        fn new(body: &str) -> Self {
            Self::with_shell(body, None)
        }
        fn with_shell(body: &str, shell: Option<&str>) -> Self {
            let root = std::env::temp_dir().join(format!(
                "vl-version-probe-{}-{}",
                std::process::id(),
                crate::tasks::new_id()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let script = format!("if(process.argv.length!==3||process.argv[2]!=='--version')process.exit(64);\nrequire('fs').writeFileSync(require('path').join(__dirname,'parent.pid'),String(process.pid));\n{body}\n");
            #[cfg(unix)]
            let executable = {
                use std::os::unix::fs::PermissionsExt;
                let file = root.join("codex");
                let launcher = if let Some(body) = shell {
                    // Fixed-output cases test the probe, not Node startup. Write
                    // the executable once; do not reopen/rewrite a published one.
                    format!("#!/bin/sh\n[ \"$#\" -eq 1 ] && [ \"$1\" = '--version' ] || exit 64\nprintf '%s' \"$$\" > \"${{0%/*}}/parent.pid\"\n{body}\n")
                } else {
                    #[cfg(target_os = "macos")]
                    let node =
                        crate::process::macos_cli_path("node").expect("Node fixture interpreter");
                    #[cfg(not(target_os = "macos"))]
                    let node = {
                        let directories: Vec<_> =
                            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                                .collect();
                        crate::cli_path::find_executable(std::path::Path::new("node"), &directories)
                            .expect("Node fixture interpreter")
                    };
                    let node = std::fs::canonicalize(node).unwrap();
                    let quoted_node =
                        format!("'{}'", node.to_string_lossy().replace('\'', "'\\''"));
                    std::fs::write(root.join("fixture.cjs"), &script).unwrap();
                    format!("#!/bin/sh\nexec {quoted_node} \"${{0%/*}}/fixture.cjs\" \"$@\"\n")
                };
                std::fs::write(&file, launcher).unwrap();
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
                file
            };
            #[cfg(windows)]
            let executable = {
                let _ = shell;
                std::fs::write(root.join("fixture.cjs"), script).unwrap();
                let file = root.join("codex.cmd");
                std::fs::write(&file, "@echo off\r\nnode \"%~dp0fixture.cjs\" %*\r\n").unwrap();
                file
            };
            Self { root, executable }
        }
        fn assert_stopped(&self) {
            #[cfg(unix)]
            {
                let pid = std::fs::read_to_string(self.root.join("parent.pid"))
                    .unwrap()
                    .parse::<u32>()
                    .unwrap();
                assert!(
                    crate::process::group_exited(pid).unwrap(),
                    "probe must observe complete process-group shutdown"
                );
            }
        }
    }
    impl Drop for VersionFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn version_probe_spawn_error_reports_only_kind_and_code() {
        let path =
            std::env::temp_dir().join(format!("private-launcher-{}", crate::tasks::new_id()));
        let error = probe_codex_version(path.to_str().unwrap()).unwrap_err();
        assert!(error.contains("kind=NotFound"), "{error}");
        #[cfg(unix)]
        assert!(error.contains("code=Some(2)"), "{error}");
        assert!(!error.contains("private-launcher"));
        assert!(!error.contains(&path.to_string_lossy().into_owned()));
    }

    #[cfg(unix)]
    #[test]
    fn version_fixture_pins_node_outside_child_path() {
        use std::io::Read;
        let fixture = VersionFixture::new("process.stdout.write('codex-cli 1.2.3');");
        let mut command = crate::execution::process_command(fixture.executable.to_str().unwrap());
        command
            .arg("--version")
            .env("PATH", &fixture.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = crate::managed_process::spawn(&mut command).unwrap();
        let mut output = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        let status = child.wait().unwrap();
        child.terminate_remaining().unwrap();
        assert!(
            status.success(),
            "fixture must not depend on the child's PATH"
        );
        assert_eq!(output, "codex-cli 1.2.3");
        fixture.assert_stopped();
    }

    #[test]
    fn version_probe_accepts_codex_identity_and_discards_stderr() {
        let fixture = VersionFixture::with_shell(
            "process.stderr.write('discard-private-stderr');process.stdout.write('codex-cli 1.2.3\\n');",
            Some("printf '%s' 'discard-private-stderr' >&2; printf 'codex-cli 1.2.3\\n'"),
        );
        assert_eq!(
            probe_codex_version(fixture.executable.to_str().unwrap()).unwrap(),
            "codex-cli 1.2.3"
        );
        fixture.assert_stopped();
    }
    #[test]
    fn version_probe_times_out_and_stops_hanging_descendants() {
        let fixture = VersionFixture::new("require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});setInterval(()=>{},1000);");
        let start = std::time::Instant::now();
        assert!(probe_codex_version(fixture.executable.to_str().unwrap()).is_err());
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "version query and confirmed cleanup must finish promptly"
        );
        fixture.assert_stopped();
    }
    #[test]
    fn version_probe_rejects_oversized_output_and_cleans_up() {
        let fixture = VersionFixture::new(
            "process.stdout.write('codex-cli 1.2.3 '+ 'x'.repeat(16384));setInterval(()=>{},1000);",
        );
        let start = std::time::Instant::now();
        assert!(probe_codex_version(fixture.executable.to_str().unwrap()).is_err());
        assert!(start.elapsed() < Duration::from_secs(5));
        fixture.assert_stopped();
    }
    #[test]
    fn version_probe_rejects_unrecognized_or_multiline_output() {
        // Parser rejection must not pass merely because process startup timed
        // out under suite load. These bytes are the actual observed output.
        for output in [
            b"unrelated-tool 1.2.3".as_slice(),
            b"codex-cli 1.2.3\nraw-payload".as_slice(),
            b"".as_slice(),
            b"codex-cli 1.2.3 private-payload".as_slice(),
            b"codex-cli \xff".as_slice(),
        ] {
            assert!(recognized_codex_version(output).is_err());
        }
        let oversized_version = format!("codex-cli {}", "1".repeat(256));
        assert!(recognized_codex_version(oversized_version.as_bytes()).is_err());
    }

    #[test]
    fn version_probe_rejects_unsuccessful_exit() {
        let fixture = VersionFixture::with_shell(
            "process.stdout.write('codex-cli 1.2.3');process.exitCode=9;",
            Some("printf '%s' 'codex-cli 1.2.3'; exit 9"),
        );
        assert_eq!(
            probe_codex_version(fixture.executable.to_str().unwrap()),
            Err("Codex version probe exited unsuccessfully".into())
        );
        fixture.assert_stopped();
    }

    #[test]
    fn version_probe_capabilities_keep_path_and_sanitize_unavailable_metadata() {
        for (body, shell, available) in [
            ("process.stdout.write('codex-cli 1.2.3');process.stderr.write('discard-private-stderr');", "printf '%s' 'codex-cli 1.2.3'; printf '%s' 'discard-private-stderr' >&2", true),
            ("process.stdout.write('unrelated-private-output');process.stderr.write('discard-private-stderr');", "printf '%s' 'unrelated-private-output'; printf '%s' 'discard-private-stderr' >&2", false),
        ] {
            let fixture = VersionFixture::with_shell(body, Some(shell));
            let capability = agent_harness_capabilities("codex".into(), Some(fixture.executable.to_string_lossy().into_owned())).unwrap();
            assert_eq!(capability.available, available, "{}", capability.detail);
            assert_eq!(capability.executable_path.as_deref(), fixture.executable.to_str());
            assert_eq!(capability.version.as_deref(), available.then_some("codex-cli 1.2.3"));
            let metadata = serde_json::to_string(&capability).unwrap();
            assert!(!metadata.contains("discard-private-stderr"));
            assert!(!metadata.contains("unrelated-private-output"));
            fixture.assert_stopped();
        }
    }

    fn runtime_fixture(label: &str) -> (std::path::PathBuf, WorkspaceLifecycle, AgentManager, Arc<AgentRuntime>) {
        let root = std::env::temp_dir().join(format!("virtuallab-agent-{label}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        let lifecycle = WorkspaceLifecycle::default();
        let claim = lifecycle.reserve(root.to_str().unwrap(), "agent").unwrap();
        let mut command = crate::execution::process_command("node");
        command.args(["-e", "setInterval(()=>{},1000)"]).stdin(Stdio::piped());
        let mut child = crate::managed_process::spawn(&mut command).unwrap();
        let process = Arc::new(CodexProcess {
            _reservation: Mutex::new(Some(claim)),
            stdin: Arc::new(Mutex::new(child.stdin.take().unwrap())),
            child: Mutex::new(child), pending: Arc::new(Mutex::new(HashMap::new())), next_id: AtomicU64::new(1),
        });
        let runtime = Arc::new(AgentRuntime { process, executable_path: "codex".into(),
            binding: AgentSessionBinding { workspace_root: root.to_string_lossy().into_owned(), harness: "codex".into(),
                thread_id: "current-thread".into(), created_at_ms: now_ms(), updated_at_ms: now_ms() } });
        let manager = AgentManager::default();
        manager.runtimes.lock().unwrap().insert(workspace_key(root.to_str().unwrap()), runtime.clone());
        (root, lifecycle, manager, runtime)
    }

    // Real app-server fixture: complete native initialization/thread RPCs, then
    // stop reading stdin while a descendant retains its inherited read end.
    struct BackpressureFixture {
        root: std::path::PathBuf,
        manager: AgentManager,
        lifecycle: WorkspaceLifecycle,
        runtime: Arc<AgentRuntime>,
        reader: Option<thread::JoinHandle<()>>,
    }
    impl BackpressureFixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("vl-agent-backpressure-{}", crate::tasks::new_id()));
            std::fs::create_dir_all(&root).unwrap();
            let lifecycle = WorkspaceLifecycle::default();
            let claim = lifecycle.reserve(root.to_str().unwrap(), "agent").unwrap();
            let script = r#"
const fs=require('fs');
function read(){let s='', b=Buffer.alloc(1);while(fs.readSync(0,b,0,1,null)){if(b[0]===10)return JSON.parse(s);s+=b.toString();}process.exit(65);}
function reply(q,result){fs.writeSync(1,JSON.stringify({id:q.id,result})+'\n');}
let q=read();if(q.method!=='initialize')process.exit(66);reply(q,{});
q=read();if(q.method!=='initialized')process.exit(67);
q=read();if(q.method!=='thread/start')process.exit(68);
require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:[0,'ignore','ignore']});
reply(q,{thread:{id:'blocked-thread'}});setInterval(()=>{},1000);
"#;
            let mut command = crate::execution::process_command("node");
            command
                .args(["-e", script])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            let mut child = crate::managed_process::spawn(&mut command).unwrap();
            let stdout = child.stdout.take().unwrap();
            let process = Arc::new(CodexProcess {
                _reservation: Mutex::new(Some(claim)),
                stdin: Arc::new(Mutex::new(child.stdin.take().unwrap())),
                child: Mutex::new(child),
                pending: Arc::new(Mutex::new(HashMap::new())),
                next_id: AtomicU64::new(1),
            });
            let pending = process.pending.clone();
            let reader = thread::spawn(move || {
                for line in bounded_lines(stdout, MAX_AGENT_LINE_BYTES) {
                    let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
                    let id = message["id"].as_u64().unwrap();
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(Ok(message["result"].clone()));
                    }
                }
                for (_, tx) in pending.lock().unwrap().drain() {
                    let _ = tx.send(Err("fixture stdout closed".into()));
                }
            });
            initialize_codex(&process).unwrap();
            let result = process
                .request("thread/start", json!({"cwd":root}))
                .unwrap();
            let binding = AgentSessionBinding {
                workspace_root: root.to_string_lossy().into_owned(),
                harness: "codex".into(),
                thread_id: nested_id(&result, "thread").unwrap(),
                created_at_ms: now_ms(),
                updated_at_ms: now_ms(),
            };
            let runtime = Arc::new(AgentRuntime {
                process,
                binding,
                executable_path: "node fixture".into(),
            });
            let manager = AgentManager::default();
            manager
                .runtimes
                .lock()
                .unwrap()
                .insert(workspace_key(root.to_str().unwrap()), runtime.clone());
            Self {
                root,
                manager,
                lifecycle,
                runtime,
                reader: Some(reader),
            }
        }
    }
    impl Drop for BackpressureFixture {
        fn drop(&mut self) {
            let _ = self.runtime.process.stop();
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn backpressure_rpc_obeys_deadline_and_joins_writer_before_return() {
        let fixture = BackpressureFixture::new();
        let process = fixture.runtime.process.clone();
        let (tx, rx) = mpsc::channel();
        let writer = thread::spawn(move || {
            let outcome = process.request(
                "turn/start",
                json!({"input":[{"type":"text","text":"x".repeat(140000)}]}),
            );
            let _ = tx.send(outcome);
        });
        let result = rx.recv_timeout(RPC_TIMEOUT + Duration::from_secs(3));
        let returned_stopped = result.is_ok() && !fixture.runtime.process.is_running().unwrap();
        let returned_without_writer =
            result.is_ok() && fixture.runtime.process.stdin.try_lock().is_ok();
        // Always reap the fixture even on the red regression, then join the
        // actual blocked request instead of detaching a still-live writer.
        fixture.runtime.process.stop().unwrap();
        writer.join().unwrap();
        assert!(
            result.is_ok(),
            "RPC stdin write bypassed the complete request deadline"
        );
        assert!(result.unwrap().is_err());
        assert!(
            returned_stopped && returned_without_writer,
            "deadline must stop the tree and finish its writer before returning"
        );
        assert!(fixture.runtime.process.stdin.try_lock().is_ok());
        assert!(!fixture.runtime.process.is_running().unwrap());
        assert!(fixture
            .lifecycle
            .reserve(fixture.root.to_str().unwrap(), "seal")
            .is_ok());
    }

    #[test]
    fn backpressure_cancel_stops_exact_provider_and_retains_slot_until_writer_join() {
        use crate::task_execution::{ProviderStopObserver, TaskExecution};
        let fixture = BackpressureFixture::new();
        let unrelated = BackpressureFixture::new();
        fixture.manager.runtimes.lock().unwrap().insert(
            workspace_key(unrelated.root.to_str().unwrap()),
            unrelated.runtime.clone(),
        );
        let execution = TaskExecution::default();
        let slot = execution.claim("blocked-task").unwrap();
        let _other_slot = execution.claim("other-task").unwrap();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observe_cancel = cancelled.clone();
        let manager = fixture.manager.clone();
        let root = fixture.runtime.binding.workspace_root.clone();
        let thread_id = fixture.runtime.binding.thread_id.clone();
        let observer = ProviderStopObserver::start(
            move || observe_cancel.load(Ordering::Acquire),
            move || {
                let _lifecycle = manager.lifecycle.lock().unwrap();
                manager.stop_runtime(&root, Some(&thread_id)).is_ok()
                    && manager.owns_workspace(&root) == Ok(false)
            },
            Duration::from_secs(30),
        )
        .unwrap();
        let process = fixture.runtime.process.clone();
        let (tx, rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let writer = thread::spawn(move || {
            let outcome = process.request(
                "turn/start",
                json!({"input":[{"type":"text","text":"x".repeat(140000)}]}),
            );
            let _ = tx.send(outcome);
            let _ = release_rx.recv();
            drop(slot);
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while fixture.runtime.process.stdin.try_lock().is_ok() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let writer_was_blocked = fixture.runtime.process.stdin.try_lock().is_err();
        let capacity_held_before_cancel = execution.claim("third-task").is_err();
        let start = Instant::now();
        cancelled.store(true, Ordering::Release);
        let outcome = rx.recv_timeout(Duration::from_secs(3));
        // Unconditionally clean up/join before assertions, including a failed
        // regression, so the test cannot leave an occupied slot or live writer.
        fixture.runtime.process.stop().unwrap();
        observer.finish().unwrap();
        let capacity_held_until_join = execution.claim("third-task").is_err();
        let stdin_released = fixture.runtime.process.stdin.try_lock().is_ok();
        let elapsed = start.elapsed();
        release_tx.send(()).unwrap();
        writer.join().unwrap();
        assert!(
            writer_was_blocked,
            "fixture must actually saturate the stdin pipe"
        );
        assert!(capacity_held_before_cancel && capacity_held_until_join);
        assert!(
            outcome.is_ok(),
            "cancel must wake a blocked RPC independently of its await"
        );
        assert!(outcome.unwrap().is_err());
        assert!(elapsed < Duration::from_secs(3));
        assert!(stdin_released);
        assert!(!fixture.runtime.process.is_running().unwrap());
        assert!(!fixture
            .manager
            .owns_workspace(fixture.root.to_str().unwrap())
            .unwrap());
        assert!(fixture
            .lifecycle
            .reserve(fixture.root.to_str().unwrap(), "seal")
            .is_ok());
        assert!(execution.claim("third-task").is_ok());
        assert!(unrelated.runtime.process.is_running().unwrap());
        assert!(fixture
            .manager
            .owns_workspace(unrelated.root.to_str().unwrap())
            .unwrap());
        assert!(unrelated
            .manager
            .owns_workspace(unrelated.root.to_str().unwrap())
            .unwrap());
    }

    #[test]
    fn legacy_session_start_defaults_to_allowing_reattach() {
        let request: AgentSessionStartRequest = serde_json::from_value(json!({"workspaceRoot":"/workspace", "harness":"codex"})).unwrap();
        assert!(!request.require_fresh);
        let request: AgentSessionStartRequest = serde_json::from_value(json!({"workspaceRoot":"/workspace", "harness":"codex", "requireFresh":true})).unwrap();
        assert!(request.require_fresh);
    }

    #[test]
    fn fresh_start_rejects_registered_runtime_without_touching_its_process_or_claim() {
        let (root, lifecycle, manager, runtime) = runtime_fixture("fresh");
        let _serialized = manager.lifecycle.lock().unwrap();
        let path = root.to_str().unwrap();
        assert!(manager.existing_for_start(path, true).is_err());
        assert!(manager.existing_for_start(path, false).unwrap().is_some());
        assert!(runtime.process.is_running().unwrap());
        assert!(lifecycle.begin_removal(path).is_err());
        manager.stop_runtime(path, None).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bound_stop_rejects_changed_thread_without_signalling_the_current_process() {
        let (root, lifecycle, manager, runtime) = runtime_fixture("bound-mismatch");
        let _serialized = manager.lifecycle.lock().unwrap();
        let path = root.to_str().unwrap();
        assert!(manager.stop_runtime(path, Some("previous-thread")).is_err());
        assert!(runtime.process.is_running().unwrap());
        assert!(lifecycle.begin_removal(path).is_err());
        assert!(manager.runtimes.lock().unwrap().contains_key(&workspace_key(path)));
        manager.stop_runtime(path, Some("current-thread")).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bound_stop_removes_exact_runtime_and_absent_runtime_is_successful() {
        let (root, lifecycle, manager, runtime) = runtime_fixture("bound-match");
        let _serialized = manager.lifecycle.lock().unwrap();
        let path = root.to_str().unwrap();
        assert_eq!(manager.stop_runtime(path, Some("current-thread")).unwrap().unwrap().thread_id, "current-thread");
        assert!(!runtime.process.is_running().unwrap());
        assert!(lifecycle.reserve(path, "candidate sealing").is_ok());
        assert!(manager.stop_runtime(path, Some("current-thread")).unwrap().is_none());
        assert!(manager.existing_for_start(path, true).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn process_exit_reports_the_observed_current_thread() {
        let (root, _, manager, runtime) = runtime_fixture("exit-current");
        let _serialized = manager.lifecycle.lock().unwrap();
        let event = manager.process_exit_event(root.to_str().unwrap(), &runtime.process);
        runtime.process.stop().unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(event.event_type, "agent.process_exited");
        assert_eq!(event.workspace_root, root.to_string_lossy());
        assert_eq!(event.thread_id.as_deref(), Some("current-thread"));
    }

    #[test]
    fn process_exit_never_attributes_an_old_process_to_a_replacement_binding() {
        let (root, _, manager, runtime) = runtime_fixture("exit-old");
        let (replacement_root, _, _, replacement) = runtime_fixture("exit-replacement");
        let _serialized = manager.lifecycle.lock().unwrap();
        let path = root.to_str().unwrap();
        manager.runtimes.lock().unwrap().insert(workspace_key(path), replacement.clone());
        let replaced = manager.process_exit_event(path, &runtime.process);
        manager.runtimes.lock().unwrap().remove(&workspace_key(path));
        let unregistered = manager.process_exit_event(path, &runtime.process);
        runtime.process.stop().unwrap();
        replacement.process.stop().unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(replacement_root).unwrap();
        assert_eq!(replaced.event_type, "agent.process_exited");
        assert_eq!(replaced.workspace_root, root.to_string_lossy());
        assert!(replaced.thread_id.is_none());
        assert!(unregistered.thread_id.is_none());
    }

    #[test]
    fn confirmed_agent_stop_releases_reservation_before_return() {
        let root = std::env::temp_dir().join(format!("virtuallab-agent-stop-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        let lifecycle = WorkspaceLifecycle::default();
        let claim = lifecycle.reserve(root.to_str().unwrap(), "agent").unwrap();
        let mut command = crate::execution::process_command("node");
        command.args(["-e", "setInterval(()=>{},1000)"]).stdin(Stdio::piped());
        let mut child = crate::managed_process::spawn(&mut command).unwrap();
        let process = CodexProcess {
            _reservation: Mutex::new(Some(claim)),
            stdin: Arc::new(Mutex::new(child.stdin.take().unwrap())),
            child: Mutex::new(child), pending: Arc::new(Mutex::new(HashMap::new())), next_id: AtomicU64::new(1),
        };
        assert!(lifecycle.begin_removal(root.to_str().unwrap()).is_err());
        process.stop().unwrap();
        // Sealing can reserve synchronously; it need not race a polling timer.
        assert!(lifecycle.reserve(root.to_str().unwrap(), "candidate sealing").is_ok());
        drop(process);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_completion_carries_only_exact_turn_identity_and_outcome() {
        let completion = turn_completion("/workspace", "turn/completed", &json!({
            "threadId": "thread-7", "turn": {"id": "turn-9", "status": "completed", "items": [{"secret":"not retained"}]}
        })).unwrap();
        assert_eq!(completion.workspace_root, "/workspace");
        assert_eq!(completion.thread_id, "thread-7");
        assert_eq!(completion.turn_id, "turn-9");
        assert_eq!(completion.status, "completed");
    }
    #[test]
    fn rapid_turn_completion_retains_the_final_answer_before_the_caller_receives_start() {
        let manager = AgentManager::default();
        let completions = manager.subscribe_completions("/workspace").unwrap();
        let outputs = manager.subscribe_reports("/workspace").unwrap();
        let mut summaries = TurnSummaries::default();
        observe_notification("/workspace", "item/completed", &json!({
            "threadId":"thread", "turnId":"turn", "item":{"type":"agentMessage","text":"Finished before start RPC returned"}
        }), &manager.completions, &manager.reports, &mut summaries);
        observe_notification("/workspace", "turn/completed", &json!({
            "threadId":"thread", "turn":{"id":"turn","status":"completed"}
        }), &manager.completions, &manager.reports, &mut summaries);
        let completion = completions.recv_timeout(Duration::from_millis(10)).unwrap();
        assert_eq!(completion.final_output.as_deref(), Some("Finished before start RPC returned"));
        assert_eq!(completion.turn_id, "turn");
        assert!(outputs.receiver.try_recv().is_ok());
    }
    #[test]
    fn saturated_report_stream_is_bounded_and_cannot_drop_the_final_summary_or_cross_roots() {
        let manager = AgentManager::default();
        let completions = manager.subscribe_completions("/workspace").unwrap();
        let outputs = manager.subscribe_reports("/workspace").unwrap();
        let foreign = manager.subscribe_reports("/other").unwrap();
        let mut summaries = TurnSummaries::default();
        for _ in 0..100 {
            observe_notification("/workspace", "item/agentMessage/delta", &json!({"threadId":"thread","turnId":"turn","delta":"中🔧"}), &manager.completions, &manager.reports, &mut summaries);
        }
        observe_notification("/workspace", "item/completed", &json!({"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","text":"Exact final response"}}), &manager.completions, &manager.reports, &mut summaries);
        observe_notification("/workspace", "turn/completed", &json!({"threadId":"thread","turn":{"id":"turn","status":"failed","error":{"message":"Provider quota exhausted"}}}), &manager.completions, &manager.reports, &mut summaries);
        let final_event = completions.recv_timeout(Duration::from_millis(10)).unwrap();
        assert_eq!(final_event.final_output.as_deref(), Some("Exact final response"));
        assert_eq!(final_event.error.as_deref(), Some("Provider quota exhausted"));
        assert!(outputs.take_truncated());
        assert!(outputs.receiver.try_iter().count() <= 64);
        assert!(foreign.receiver.try_recv().is_err());
    }
    #[test]
    fn native_completion_rejects_nonterminal_or_unbound_notifications() {
        assert!(turn_completion("/workspace", "turn/started", &json!({"threadId":"thread", "turn":{"id":"turn", "status":"completed"}})).is_none());
        assert!(turn_completion("/workspace", "turn/completed", &json!({"turn":{"id":"turn", "status":"completed"}})).is_none());
        assert!(turn_completion("/workspace", "turn/completed", &json!({"threadId":"thread", "turn":{"id":"turn", "status":"inProgress"}})).is_none());
    }
    #[test]
    fn custom_codex_path_requires_real_codex_launcher() {
        assert!(selected_codex_executable(Some("git")).is_err());
        assert!(selected_codex_executable(Some("/does/not/exist/codex")).is_err());
        let filename = if cfg!(windows) { "codex.cmd" } else { "codex" };
        let root = std::env::temp_dir().join(format!("virtuallab-codex-path-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let launcher = root.join(filename);
        std::fs::write(&launcher, "fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(selected_codex_executable(launcher.to_str()).unwrap(), launcher.to_str().unwrap());
        assert!(selected_codex_executable(root.to_str()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

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
        #[cfg(windows)]
        assert_eq!(workspace_key("D:\\Project\\VirtualLab\\"), "d:/project/virtuallab");
        #[cfg(unix)]
        assert_eq!(workspace_key("D:\\Project\\VirtualLab\\"), "D:\\Project\\VirtualLab\\");
    }
}
