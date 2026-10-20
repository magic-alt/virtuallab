//! Task-owned, bounded user-facing execution reports; separate from agent metadata.
//! Only an explicitly launched task subscribes. Reasoning, environment values and
//! arbitrary protocol payloads are not archived. AgentJournal stays metadata-only.
use crate::tasks::{new_id, now_ms, TaskAttempt, TaskManager};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const MAX_SUMMARY_BYTES: usize = 64 * 1024;
const MAX_ENTRY_BYTES: usize = 16 * 1024;
const MAX_LOG_BYTES: usize = 128 * 1024;
const MAX_ENTRIES: usize = 200;
const MAX_PROBLEMS: usize = 32;
// The summary, log and problem text remain below 224 KiB combined, leaving
// room for worst-case JSON escaping and metadata inside the 512 KiB file cap.
const MAX_PROBLEM_BYTES: usize = 32 * 1024;
const MAX_REPORT_BYTES: u64 = 512 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct ReportNotification {
    pub(crate) workspace_root: String,
    pub(crate) thread_id: Option<String>,
    pub(crate) turn_id: Option<String>,
    pub(crate) method: String,
    pub(crate) payload: Value,
    pub(crate) timestamp_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReportEntry {
    sequence: u64,
    timestamp_ms: u64,
    kind: String,
    text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReportProblem {
    source: String,
    message: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskAttemptReport {
    schema_version: u32,
    task_id: String,
    attempt_id: String,
    pub(crate) status: String,
    pub(crate) summary: Option<String>,
    entries: Vec<ReportEntry>,
    problems: Vec<ReportProblem>,
    pub(crate) truncated: bool,
    updated_at_ms: u64,
}

/// Byte limits must not split Unicode. Drop terminal control characters while
/// preserving plain multiline text. The caller reports any clipping explicitly.
pub(crate) fn bounded_text(text: &str, limit: usize) -> (String, bool) {
    let mut output = String::new();
    let mut truncated = false;
    for ch in text.chars() {
        if ch.is_control() && !matches!(ch, '\n' | '\r' | '\t') { continue; }
        if output.len() + ch.len_utf8() > limit { truncated = true; break; }
        output.push(ch);
    }
    (output, truncated)
}

pub(crate) fn completed_assistant_text(payload: &Value) -> Option<String> {
    let item = payload.get("item")?;
    if item.get("type")?.as_str()? != "agentMessage" { return None; }
    if let Some(text) = item.get("text").and_then(Value::as_str) { return Some(text.into()); }
    let content = item.get("content")?.as_array()?;
    let mut answer = String::new();
    for part in content {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            let remaining = MAX_SUMMARY_BYTES.saturating_add(4).saturating_sub(answer.len());
            answer.push_str(&bounded_text(text, remaining).0);
            if answer.len() > MAX_SUMMARY_BYTES { break; }
        }
    }
    (!answer.is_empty()).then_some(answer)
}

impl TaskAttemptReport {
    fn new(task_id: &str, attempt_id: &str) -> Self {
        Self { schema_version: 1, task_id: task_id.into(), attempt_id: attempt_id.into(), status: "queued".into(),
            summary: None, entries: vec![], problems: vec![], truncated: false, updated_at_ms: now_ms() }
    }
    pub(crate) fn entry(&mut self, kind: &str, text: &str, coalesce: bool) {
        if text.is_empty() { return; }
        let (text, truncated) = bounded_text(text, MAX_ENTRY_BYTES);
        self.truncated |= truncated;
        let sequence = self.entries.last().map_or(1, |entry| entry.sequence.saturating_add(1));
        let timestamp = now_ms().max(self.updated_at_ms);
        if coalesce && self.entries.last().is_some_and(|entry| entry.kind == kind && entry.text.len() + text.len() <= MAX_ENTRY_BYTES) {
            let last = self.entries.last_mut().unwrap();
            last.text.push_str(&text);
            last.sequence = sequence;
            last.timestamp_ms = timestamp;
        } else {
            self.entries.push(ReportEntry { sequence, timestamp_ms: timestamp, kind: kind.into(), text });
        }
        while self.entries.len() > MAX_ENTRIES || self.entries.iter().map(|entry| entry.text.len()).sum::<usize>() > MAX_LOG_BYTES {
            self.entries.remove(0);
            self.truncated = true;
        }
        self.updated_at_ms = timestamp;
    }
    pub(crate) fn set_summary(&mut self, text: &str) {
        if text.trim().is_empty() { return; }
        let (summary, truncated) = bounded_text(text, MAX_SUMMARY_BYTES);
        self.summary = Some(summary);
        self.truncated |= truncated;
        self.updated_at_ms = now_ms().max(self.updated_at_ms);
    }
    pub(crate) fn problem(&mut self, source: &str, message: &str) {
        let (message, truncated) = bounded_text(message, 4096);
        self.truncated |= truncated;
        if message.is_empty() || self.problems.iter().any(|problem| problem.source == source && problem.message == message) { return; }
        self.entry("problem", &message, false);
        self.problems.push(ReportProblem { source: source.into(), message });
        while self.problems.len() > MAX_PROBLEMS || self.problems.iter().map(|problem| problem.message.len()).sum::<usize>() > MAX_PROBLEM_BYTES {
            self.problems.remove(0);
            self.truncated = true;
        }
    }
    pub(crate) fn finish(&mut self, status: &str, failure: Option<&str>) {
        if let Some(failure) = failure { self.problem("native", failure); }
        if self.status != status { self.entry("status", &format!("Task execution: {status}"), false); }
        self.status = status.into();
    }
    pub(crate) fn observe(&mut self, expected: (&str, &str, &str), event: &ReportNotification) -> bool {
        if crate::workspace_identity::key(&event.workspace_root) != crate::workspace_identity::key(expected.0)
            || event.thread_id.as_deref() != Some(expected.1) || event.turn_id.as_deref() != Some(expected.2) { return false; }
        let payload = &event.payload;
        let delta = || payload.get("delta").and_then(Value::as_str)
            .or_else(|| payload.pointer("/delta/text").and_then(Value::as_str));
        match event.method.as_str() {
            "item/agentMessage/delta" => {
                let Some(text) = delta() else { return false; };
                self.entry("assistant", text, true);
            }
            "item/commandExecution/outputDelta" => {
                let Some(text) = delta() else { return false; };
                self.entry("command", text, true);
            }
            "item/started" | "item/completed" => {
                let Some(item) = payload.get("item") else { return false; };
                match item.get("type").and_then(Value::as_str) {
                    Some("agentMessage") if event.method == "item/completed" => {
                        let Some(text) = completed_assistant_text(payload) else { return false; };
                        self.set_summary(&text);
                        self.entry("assistant", &text, false);
                    }
                    Some("commandExecution") => {
                        if event.method == "item/started" {
                            if let Some(command) = item.get("command").and_then(Value::as_str) { self.entry("command", &format!("$ {command}\n"), false); }
                        } else {
                            if let Some(output) = item.get("aggregatedOutput").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                                self.entry("command", output, false);
                            }
                            if let Some(code) = item.get("exitCode").and_then(Value::as_i64) {
                                let message = format!("Command exited with code {code}");
                                self.entry("status", &message, false);
                                if code != 0 { self.problem("provider", &message); }
                            }
                        }
                    }
                    Some("fileChange") if event.method == "item/completed" => {
                        if let Some(changes) = item.get("changes").and_then(Value::as_array) {
                            for change in changes.iter().take(128) {
                                if let Some(path) = change.get("path").and_then(Value::as_str) { self.entry("fileChange", path, false); }
                            }
                            self.truncated |= changes.len() > 128;
                        }
                    }
                    _ => return false,
                }
            }
            "error" | "turn/failed" => {
                let message = payload.pointer("/error/message").or_else(|| payload.get("message")).and_then(Value::as_str)
                    .unwrap_or("Codex reported a provider error without a message");
                self.problem("provider", message);
            }
            "virtuallab/serverRequestRejected" => {
                self.problem("provider", "Codex requested approval or interactive input. The native adapter rejected the unsupported request; execution may require manual attention.");
            }
            _ => return false,
        }
        self.updated_at_ms = self.updated_at_ms.max(event.timestamp_ms);
        true
    }
}

#[derive(Default)]
pub(crate) struct TaskReports(Mutex<()>);

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
fn report_path(directory: &Path, task: &str, attempt: &str) -> Result<PathBuf, String> {
    if !directory.is_absolute() || !valid_id(task) || !valid_id(attempt) { return Err("Invalid task report identity".into()); }
    let store = directory.join("task-reports");
    match fs::symlink_metadata(&store) {
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => return Err("Task report directory must be a regular directory".into()),
        Ok(_) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err("Cannot inspect task report directory".into()),
    }
    Ok(store.join(format!("{task}.{attempt}.json")))
}
fn read_report(path: &Path, task: &str, attempt: &str) -> Result<Option<TaskAttemptReport>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_REPORT_BYTES => return Err("Task report is not a bounded regular file".into()),
        Ok(_) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect task report".into()),
    }
    let mut bytes = Vec::new();
    File::open(path).map_err(|_| "Cannot read task report")?.take(MAX_REPORT_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "Cannot read task report")?;
    if bytes.len() as u64 > MAX_REPORT_BYTES { return Err("Task report exceeds its bound".into()); }
    let report: TaskAttemptReport = serde_json::from_slice(&bytes).map_err(|_| "Task report is corrupt or incompatible; original retained")?;
    if report.schema_version != 1 || report.task_id != task || report.attempt_id != attempt
        || report.entries.len() > MAX_ENTRIES || report.problems.len() > MAX_PROBLEMS
        || report.summary.as_ref().is_some_and(|text| text.len() > MAX_SUMMARY_BYTES)
        || report.entries.iter().any(|entry| entry.text.len() > MAX_ENTRY_BYTES || !matches!(entry.kind.as_str(), "assistant" | "command" | "fileChange" | "status" | "problem"))
        || report.entries.iter().map(|entry| entry.text.len()).sum::<usize>() > MAX_LOG_BYTES
        || report.problems.iter().any(|problem| problem.message.len() > 4096 || !matches!(problem.source.as_str(), "native" | "provider" | "verification"))
        || report.problems.iter().map(|problem| problem.message.len()).sum::<usize>() > MAX_PROBLEM_BYTES
        || !matches!(report.status.as_str(), "queued" | "running" | "stopping" | "succeeded" | "failed" | "cancelled" | "interrupted") {
        return Err("Task report failed structural validation; original retained".into());
    }
    Ok(Some(report))
}
fn save_report(path: &Path, report: &TaskAttemptReport) -> Result<(), String> {
    let directory = path.parent().ok_or("Task report directory missing")?;
    fs::create_dir_all(directory).map_err(|_| "Cannot create task report directory")?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|_| "Cannot secure task report directory")?; }
    if fs::symlink_metadata(path).is_ok_and(|meta| !meta.is_file() || meta.file_type().is_symlink()) { return Err("Task report must remain a regular file".into()); }
    let bytes = serde_json::to_vec(report).map_err(|_| "Cannot encode task report")?;
    if bytes.len() as u64 > MAX_REPORT_BYTES { return Err("Task report exceeds its storage bound".into()); }
    let temporary = directory.join(format!(".report-{}.tmp", new_id()));
    let result = (|| {
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temporary).map_err(|_| "Cannot create task report snapshot")?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "Cannot persist task report snapshot")?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| "Cannot commit task report snapshot")?;
        #[cfg(unix)] { let _ = File::open(directory).and_then(|file| file.sync_all()); }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
}
impl TaskReports {
    pub(crate) fn initialize(&self, directory: &Path, task: &str, attempt: &str) -> Result<(), String> {
        let _guard = self.0.lock().map_err(|_| "Task report lock poisoned")?;
        let path = report_path(directory, task, attempt)?;
        if read_report(&path, task, attempt)?.is_some() { return Err("Task report already exists; refusing to replace history".into()); }
        let mut report = TaskAttemptReport::new(task, attempt);
        report.entry("status", "Task accepted into the native execution queue", false);
        save_report(&path, &report)
    }
    pub(crate) fn read(&self, directory: &Path, task: &str, attempt: &str) -> Result<Option<TaskAttemptReport>, String> {
        let _guard = self.0.lock().map_err(|_| "Task report lock poisoned")?;
        read_report(&report_path(directory, task, attempt)?, task, attempt)
    }
    pub(crate) fn update(&self, directory: &Path, task: &str, attempt: &str, apply: impl FnOnce(&mut TaskAttemptReport)) -> Result<TaskAttemptReport, String> {
        let _guard = self.0.lock().map_err(|_| "Task report lock poisoned")?;
        let path = report_path(directory, task, attempt)?;
        let mut report = read_report(&path, task, attempt)?.ok_or("Task report was not initialized")?;
        apply(&mut report);
        save_report(&path, &report)?;
        Ok(report)
    }
    fn synchronize(&self, directory: &Path, task: &str, attempt: &TaskAttempt) -> Result<Option<TaskAttemptReport>, String> {
        let _guard = self.0.lock().map_err(|_| "Task report lock poisoned")?;
        let path = report_path(directory, task, &attempt.id)?;
        let Some(mut report) = read_report(&path, task, &attempt.id)? else { return Ok(None); };
        if report.status != attempt.state || attempt.failure.as_ref().is_some_and(|failure| !report.problems.iter().any(|problem| problem.source == "native" && problem.message == *failure)) {
            report.finish(&attempt.state, attempt.failure.as_deref());
            save_report(&path, &report)?;
        }
        Ok(Some(report))
    }
    pub(crate) fn recover(&self, manager: &TaskManager) {
        if let Ok(tasks) = manager.all() {
            for task in tasks { for attempt in task.attempts { let _ = self.synchronize(&manager.storage_dir(), &task.id, &attempt); } }
        }
    }
}

pub(crate) fn update(app: &AppHandle, task_id: &str, attempt_id: &str, apply: impl FnOnce(&mut TaskAttemptReport)) -> Result<(), String> {
    let directory = app.state::<TaskManager>().storage_dir();
    let report = app.state::<TaskReports>().update(&directory, task_id, attempt_id, apply)?;
    let _ = app.emit("task://report", serde_json::json!({"taskId":task_id,"attemptId":attempt_id,"sequence":report.entries.last().map_or(0, |entry| entry.sequence)}));
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskAttemptReportRequest { task_id: String, attempt_id: String }

#[tauri::command]
pub(crate) async fn task_attempt_report(app: AppHandle, request: TaskAttemptReportRequest) -> Result<Option<TaskAttemptReport>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<TaskManager>();
        let task = manager.get(&request.task_id)?;
        let attempt = task.attempts.iter().find(|attempt| attempt.id == request.attempt_id).ok_or("Task attempt not found")?;
        app.state::<TaskReports>().synchronize(&manager.storage_dir(), &task.id, attempt)
    }).await.map_err(|_| "Task report reader failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn notification(thread: &str, turn: &str, method: &str, payload: Value) -> ReportNotification {
        ReportNotification {
            workspace_root: "/workspace".into(), thread_id: Some(thread.into()), turn_id: Some(turn.into()),
            method: method.into(), payload, timestamp_ms: 10,
        }
    }

    #[test]
    fn reports_capture_only_the_exact_bound_turn_and_prefer_the_final_assistant_message() {
        let mut report = TaskAttemptReport::new("task", "attempt");
        let expected = ("/workspace", "thread", "turn");
        assert!(!report.observe(expected, &notification("other", "turn", "item/agentMessage/delta", json!({"delta":"wrong thread"}))));
        assert!(!report.observe(expected, &notification("thread", "other", "item/agentMessage/delta", json!({"delta":"wrong turn"}))));
        let mut foreign = notification("thread", "turn", "item/agentMessage/delta", json!({"delta":"wrong workspace"}));
        foreign.workspace_root = "/other".into();
        assert!(!report.observe(expected, &foreign));
        assert!(report.observe(expected, &notification("thread", "turn", "item/agentMessage/delta", json!({"delta":"in progress"}))));
        assert!(report.observe(expected, &notification("thread", "turn", "item/completed", json!({"item":{"type":"agentMessage","text":"完成结果\nFixed.\n发现的问题\nNone observed."}}))));
        assert_eq!(report.summary.as_deref(), Some("完成结果\nFixed.\n发现的问题\nNone observed."));
        assert!(report.problems.is_empty());
        assert!(!serde_json::to_string(&report).unwrap().contains("wrong"));
    }

    #[test]
    fn report_log_captures_command_output_and_real_provider_problems() {
        let mut report = TaskAttemptReport::new("task", "attempt");
        let expected = ("/workspace", "thread", "turn");
        report.observe(expected, &notification("thread", "turn", "item/started", json!({"item":{"type":"commandExecution","command":"cargo test"}})));
        report.observe(expected, &notification("thread", "turn", "item/commandExecution/outputDelta", json!({"delta":"test example ... FAILED\n"})));
        report.observe(expected, &notification("thread", "turn", "error", json!({"error":{"message":"Authentication expired"}})));
        assert!(report.entries.iter().any(|entry| entry.kind == "command" && entry.text.contains("FAILED")));
        assert!(report.problems.iter().any(|problem| problem.source == "provider" && problem.message == "Authentication expired"));
        assert_eq!(report.status, "queued", "provider text must not manufacture native success");
    }

    #[test]
    fn report_bounds_multibyte_summary_log_and_problem_payloads() {
        let mut report = TaskAttemptReport::new("task", "attempt");
        let huge = "中文🔧".repeat(40_000);
        report.set_summary(&huge);
        for _ in 0..400 { report.entry("command", &huge, false); }
        report.problem("native", &huge);
        assert!(report.truncated);
        assert!(report.summary.as_ref().unwrap().len() <= MAX_SUMMARY_BYTES);
        assert!(report.entries.len() <= MAX_ENTRIES);
        assert!(report.entries.iter().map(|entry| entry.text.len()).sum::<usize>() <= MAX_LOG_BYTES);
        assert!(serde_json::to_vec(&report).unwrap().len() <= MAX_REPORT_BYTES as usize);
        assert!(std::str::from_utf8(report.summary.as_ref().unwrap().as_bytes()).is_ok());
    }

    #[test]
    fn report_json_escaping_still_fits_the_durable_storage_bound() {
        let directory = std::env::temp_dir().join(format!("vl-report-escaping-{}", crate::tasks::new_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let reports = TaskReports::default();
        reports.initialize(&directory, "task", "attempt").unwrap();
        let escaped = "\"\\\n\r\t".repeat(MAX_SUMMARY_BYTES);
        let report = reports.update(&directory, "task", "attempt", |report| {
            report.set_summary(&escaped);
            for index in 0..MAX_PROBLEMS { report.problem("provider", &format!("{index} {escaped}")); }
            for _ in 0..MAX_ENTRIES { report.entry("command", &escaped, false); }
        }).unwrap();
        assert!(report.truncated);
        assert!(serde_json::to_vec(&report).unwrap().len() <= MAX_REPORT_BYTES as usize);
        assert!(reports.read(&directory, "task", "attempt").unwrap().is_some());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn report_store_preserves_completed_output_across_reopen_and_refuses_symlinks() {
        let directory = std::env::temp_dir().join(format!("vl-task-report-{}", crate::tasks::new_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let reports = TaskReports::default();
        reports.initialize(&directory, "task", "attempt").unwrap();
        reports.update(&directory, "task", "attempt", |report| {
            report.set_summary("Completed final output");
            report.finish("failed", Some("Native source changed during verification"));
        }).unwrap();
        let reopened = TaskReports::default().read(&directory, "task", "attempt").unwrap().unwrap();
        assert_eq!(reopened.status, "failed");
        assert_eq!(reopened.summary.as_deref(), Some("Completed final output"));
        assert!(reopened.problems.iter().any(|problem| problem.message.contains("source changed")));
        assert!(reports.read(&directory, "task", "historical").unwrap().is_none());
        assert!(reports.read(&directory, "../escape", "attempt").is_err());
        #[cfg(unix)] {
            let path = report_path(&directory, "task", "attempt").unwrap();
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(directory.join("outside"), &path).unwrap();
            assert!(reports.read(&directory, "task", "attempt").is_err());
            assert!(reports.update(&directory, "task", "attempt", |_| {}).is_err());
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn restart_reconciles_active_report_to_interrupted_without_losing_output_or_replaying() {
        let directory = std::env::temp_dir().join(format!("vl-report-recovery-{}", crate::tasks::new_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("tasks-v1.json");
        std::fs::write(&path, serde_json::to_vec(&json!({"schemaVersion":1,"events":[{"schemaVersion":1,"eventId":"created","seq":1,"taskId":"task","attemptId":null,"kind":"plan.accepted","timestampMs":1}],"tasks":[{
            "id":"task","repositoryRoot":directory.to_string_lossy(),"title":"Task","goal":"Implement","scope":["src"],"baseSha":"a".repeat(40),"kind":"implementation","dependencies":[],"profile":null,"autoCommit":false,"revision":1,"workspaceRoot":null,"review":null,"acceptance":null,"createdAtMs":1,"updatedAtMs":1,
            "attempts":[{"id":"attempt","state":"running","phase":"implementation","candidateSha":null,"failure":null,"startedAtMs":1,"endedAtMs":null,"evidence":null}]
        }]})).unwrap()).unwrap();
        let reports = TaskReports::default();
        reports.initialize(&directory, "task", "attempt").unwrap();
        reports.update(&directory, "task", "attempt", |report| { report.set_summary("Last observed assistant output"); report.finish("running", None); }).unwrap();
        let recovered = TaskManager::open(path).unwrap();
        reports.recover(&recovered);
        let report = reports.read(&directory, "task", "attempt").unwrap().unwrap();
        assert_eq!(report.status, "interrupted");
        assert_eq!(report.summary.as_deref(), Some("Last observed assistant output"));
        assert!(report.problems.iter().any(|problem| problem.message.contains("Application restarted")));
        assert_eq!(recovered.get("task").unwrap().attempts.len(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
