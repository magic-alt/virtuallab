//! Bounded, native, privacy-first V0.6 agent lifecycle metadata journal.
//! Never persist raw prompts, model messages, tool output or stderr.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const SCHEMA: u32 = 1;
const SEGMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RESULTS: usize = 300;
const CURRENT: &str = "agent-metadata-v1.jsonl";
const PREVIOUS: &str = "agent-metadata-v1.previous.jsonl";

#[derive(Default)]
pub struct AgentJournal(Mutex<()>);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentJournalEntry {
    schema_version: u32,
    sequence: u64,
    event_id: String,
    workspace_id: String,
    harness: String,
    thread_key: Option<String>,
    turn_key: Option<String>,
    event_kind: String,
    outcome: String,
    timestamp_ms: u64,
    visibility: String,
    redaction_status: String,
}

fn hash(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes())) }
fn workspace_id(root: &str) -> String { hash(&crate::workspace_identity::key(root)) }
fn id_key(value: Option<&str>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty() && s.len() <= 512).map(hash)
}

/// Persist only fixed structural names and enumerated statuses.
/// Never write provider-supplied method names or payloads to disk.
fn metadata(event: &Value, harness: Option<&str>) -> Option<AgentJournalEntry> {
    let (kind, outcome) = match event.get("eventType")?.as_str()? {
        "agent.session_started" => ("session.started", "started"),
        "agent.session_stopped" => ("session.stopped", "stopped"),
        "agent.session_binding" => ("session.binding_changed", "observed"),
        "agent.process_exited" => ("process.exited", "exited"),
        "agent.turn_started" => ("turn.started", "started"),
        "agent.turn_completed" => (
            "turn.completed",
            match event.pointer("/payload/status").and_then(Value::as_str) {
                Some("completed") => "completed",
                Some("failed") => "failed",
                Some("cancelled") => "cancelled",
                _ => "unknown",
            },
        ),
        "agent.protocol_error" => ("protocol.error", "error"),
        "agent.server_request_rejected" => ("permission.request_rejected", "denied"),
        "agent.notification" => match event.get("method").and_then(Value::as_str) {
            Some("turn/started") => ("turn.started", "started"),
            Some("turn/completed") => ("turn.completed", "unknown"),
            Some("turn/failed") => ("turn.completed", "failed"),
            Some("turn/interrupted") => ("turn.completed", "cancelled"),
            Some("thread/started") => ("session.thread_started", "observed"),
            _ => return None,
        },
        _ => return None,
    };
    let root = event.get("workspaceRoot")?.as_str()?;
    if root.trim().is_empty() { return None; }
    Some(AgentJournalEntry {
        schema_version: SCHEMA, sequence: 0, event_id: String::new(),
        workspace_id: workspace_id(root),
        harness: match harness { Some("codex") => "codex", Some("deepseek") => "deepseek",
            Some("claude") => "claude", Some("opencode") => "opencode", _ => "unknown" }.into(),
        thread_key: id_key(event.get("threadId").and_then(Value::as_str)),
        turn_key: id_key(event.get("turnId").and_then(Value::as_str)),
        event_kind: kind.into(), outcome: outcome.into(),
        timestamp_ms: event.get("timestampMs").and_then(Value::as_u64).unwrap_or_default(),
        visibility: "metadata_only".into(), redaction_status: "payload_omitted".into(),
    })
}

/// Ignores the torn last record. Never silently skips an invalid interior record.
fn read_entries(path: &Path) -> Result<(Vec<AgentJournalEntry>, u64), String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok((vec![], 0)),
        Err(err) => return Err(format!("Journal read failed: {err}")),
    };
    let mut entries = Vec::<AgentJournalEntry>::new();
    let mut offset = 0u64;
    let mut lines = bytes.split_inclusive(|byte| *byte == b'\n').peekable();
    while let Some(line) = lines.next() {
        if !line.ends_with(b"\n") { break; }
        match serde_json::from_slice::<AgentJournalEntry>(&line[..line.len() - 1]) {
            Ok(entry) if entry.schema_version == SCHEMA &&
                entries.last().is_none_or(|prev| entry.sequence > prev.sequence) => {
                    entries.push(entry);
                    offset += line.len() as u64;
                }
            _ if lines.peek().is_none() => break,
            _ => return Err("Corrupt/incompatible interior journal entry; explicit repair required".into()),
        }
    }
    Ok((entries, offset))
}

fn segments(dir: &Path) -> (PathBuf, PathBuf) {
    (dir.join(CURRENT), dir.join(PREVIOUS))
}

fn append_at(dir: &Path, mut entry: AgentJournalEntry, capacity: u64) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Create journal directory: {e}"))?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Secure journal directory: {e}"))?;
    }
    let (current, previous) = segments(dir);
    let (older, _) = read_entries(&previous)?;
    let (newer, valid_bytes) = read_entries(&current)?;
    entry.sequence = older.last().into_iter().chain(newer.last())
        .map(|item| item.sequence).max().unwrap_or(0).saturating_add(1);
    entry.event_id = format!("agent-event-v1-{}", entry.sequence);
    let mut record = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
    record.push(b'\n');
    if record.len() as u64 > capacity { return Err("Journal entry exceeds segment limit".into()); }
    let rotate = valid_bytes + record.len() as u64 > capacity;
    if rotate {
        if previous.exists() { fs::remove_file(&previous).map_err(|e| e.to_string())?; }
        if current.exists() {
            let old = OpenOptions::new().write(true).open(&current).map_err(|e| e.to_string())?;
            old.set_len(valid_bytes).map_err(|e| e.to_string())?;
            old.sync_all().map_err(|e| e.to_string())?;
            drop(old); // Windows rename requires the file handle to be closed.
            fs::rename(&current, &previous).map_err(|e| e.to_string())?;
        }
    }
    if !rotate && current.exists() {
        // On Windows FILE_APPEND_DATA does not grant the SetEndOfFile right.
        // Repair the torn tail with a write-capable handle, then close it
        // before opening the append-only handle for the next event.
        let repair = OpenOptions::new().write(true).open(&current)
            .map_err(|e| format!("Open journal for repair: {e}"))?;
        repair.set_len(valid_bytes).map_err(|e| format!("Repair journal tail: {e}"))?;
        repair.sync_data().map_err(|e| format!("Sync journal repair: {e}"))?;
        drop(repair);
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&current)
        .map_err(|e| format!("Open journal: {e}"))?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&current, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Secure journal file: {e}"))?;
    }
    file.write_all(&record).map_err(|e| format!("Append journal: {e}"))?;
    file.sync_data().map_err(|e| format!("Sync journal: {e}"))?;
    Ok(())
}


/// A previously recorded start is never considered proof of a live worker.
/// A new native process instance starts with no registered runtime; unmatched
/// turns are sealed as unverified and never automatically dispatched.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredTurn {
    turn_key: String,
    state: String,
    last_sequence: u64,
    harness: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecoverySnapshot {
    workspace_id: String,
    native_session_registered: bool,
    turns: Vec<RecoveredTurn>,
    retained_events: usize,
}

fn replay_turns(entries: &[AgentJournalEntry], owner: &str) -> Vec<RecoveredTurn> {
    let mut rows = entries.iter().filter(|row| row.workspace_id == owner).collect::<Vec<_>>();
    rows.sort_by_key(|row| row.sequence);
    let mut states = std::collections::BTreeMap::<String, RecoveredTurn>::new();
    for row in rows {
        match row.event_kind.as_str() {
            "turn.started" => {
                if let Some(key) = &row.turn_key {
                    // The app-server may emit a started notification as well
                    // as the native RPC acknowledgement. Replays are idempotent.
                    states.entry(key.clone()).or_insert_with(|| RecoveredTurn {
                        turn_key: key.clone(), state: "in_flight_unverified".into(),
                        last_sequence: row.sequence, harness: row.harness.clone(),
                    });
                }
            }
            "turn.completed" | "recovery.unverified" => {
                if let Some(key) = &row.turn_key {
                    let state = if row.event_kind == "recovery.unverified" { "unverified" }
                        else { match row.outcome.as_str() {
                            "completed" => "completed", "failed" => "failed",
                            "cancelled" => "cancelled", _ => "unverified",
                        }};
                    states.insert(key.clone(), RecoveredTurn {
                        turn_key: key.clone(), state: state.into(),
                        last_sequence: row.sequence, harness: row.harness.clone(),
                    });
                }
            }
            "process.exited" | "session.stopped" => {
                // Existing Codex process-exit events do not contain turn IDs:
                // close any still-open turns conservatively, never as PASS.
                for turn in states.values_mut() {
                    if turn.state == "in_flight_unverified" {
                        turn.state = "unverified".into();
                        turn.last_sequence = row.sequence;
                    }
                }
            }
            _ => {}
        }
    }
    states.into_values().collect()
}

fn all_entries(dir: &Path) -> Result<Vec<AgentJournalEntry>, String> {
    let (current, previous) = segments(dir);
    let (mut rows, _) = read_entries(&previous)?;
    rows.extend(read_entries(&current)?.0);
    rows.sort_by_key(|row| row.sequence);
    rows.dedup_by_key(|row| row.sequence);
    Ok(rows)
}

fn reconcile_at(dir: &Path, root: &str, native_session_registered: bool) -> Result<AgentRecoverySnapshot, String> {
    let owner = workspace_id(root);
    let mut rows = all_entries(dir)?;
    if !native_session_registered {
        for turn in replay_turns(&rows, &owner).iter()
            .filter(|turn| turn.state == "in_flight_unverified") {
            // Exactly one durable recovery marker per retained unfinished
            // turn. The subsequent scan sees it and does not append again.
            append_at(dir, AgentJournalEntry {
                schema_version: SCHEMA, sequence: 0, event_id: String::new(),
                workspace_id: owner.clone(), harness: turn.harness.clone(),
                thread_key: None, turn_key: Some(turn.turn_key.clone()),
                event_kind: "recovery.unverified".into(), outcome: "unverified".into(),
                timestamp_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                visibility: "metadata_only".into(), redaction_status: "payload_omitted".into(),
            }, SEGMENT_BYTES)?;
        }
        rows = all_entries(dir)?;
    }
    let retained_events = rows.iter().filter(|row| row.workspace_id == owner).count();
    Ok(AgentRecoverySnapshot {
        workspace_id: owner.clone(), native_session_registered,
        turns: replay_turns(&rows, &owner), retained_events,
    })
}

impl AgentJournal {
    fn directory(app: &AppHandle) -> Result<PathBuf, String> {
        app.path().app_data_dir().map(|base| base.join("agent-journal"))
            .map_err(|e| format!("Resolve app data directory: {e}"))
    }
    fn recovery(&self, app: &AppHandle, root: &str, native_registered: bool) -> Result<AgentRecoverySnapshot, String> {
        if !Path::new(root).is_dir() { return Err("Journal workspace directory not found".into()); }
        let _guard = self.0.lock().map_err(|_| "Journal lock poisoned")?;
        reconcile_at(&Self::directory(app)?, root, native_registered)
    }

    fn purge(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.0.lock().map_err(|_| "Journal lock poisoned")?;
        let (current, previous) = segments(&Self::directory(app)?);
        for file in [current, previous] {
            if let Err(error) = fs::remove_file(file) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("Could not purge agent metadata journal: {error}"));
                }
            }
        }
        Ok(())
    }

    fn record(&self, app: &AppHandle, event: &Value, harness: Option<&str>) -> Result<(), String> {
        let Some(entry) = metadata(event, harness) else { return Ok(()); };
        let _guard = self.0.lock().map_err(|_| "Journal lock poisoned")?;
        append_at(&Self::directory(app)?, entry, SEGMENT_BYTES)
    }
    fn recent(&self, app: &AppHandle, root: &str, limit: usize) -> Result<Vec<AgentJournalEntry>, String> {
        if !Path::new(root).is_dir() { return Err("Journal workspace directory not found".into()); }
        let _guard = self.0.lock().map_err(|_| "Journal lock poisoned")?;
        let (current, previous) = segments(&Self::directory(app)?);
        let (mut older, _) = read_entries(&previous)?;
        older.extend(read_entries(&current)?.0);
        let id = workspace_id(root);
        let mut entries: Vec<_> = older.into_iter().filter(|row| row.workspace_id == id).collect();
        entries.sort_by_key(|row| row.sequence);
        entries.dedup_by_key(|row| row.sequence);
        let size = entries.len();
        Ok(entries.into_iter().skip(size.saturating_sub(limit.clamp(1, MAX_RESULTS))).collect())
    }
}

/// Called directly from native producer threads. The browser cannot inject rows.
pub fn emit_agent_event<E: Serialize + Clone>(app: &AppHandle, harness: Option<&str>, event: E) {
    if let Ok(value) = serde_json::to_value(&event) {
        if app.state::<AgentJournal>().record(app, &value, harness).is_err() {
            let _ = app.emit("agent://event", serde_json::json!({
                "eventType": "agent.journal_write_failed",
                "workspaceRoot": value.get("workspaceRoot"),
                "timestampMs": value.get("timestampMs"),
                "payload": {"detail": "Lifecycle metadata could not be saved"}
            }));
        }
    }
    let _ = app.emit("agent://event", event);
}

#[tauri::command]
pub fn agent_journal_recent(
    app: AppHandle,
    journal: State<'_, AgentJournal>,
    workspace_root: String,
    limit: Option<usize>,
) -> Result<Vec<AgentJournalEntry>, String> {
    journal.recent(&app, &workspace_root, limit.unwrap_or(MAX_RESULTS))
}

#[tauri::command]
pub fn agent_journal_recover(
    app: AppHandle,
    journal: State<'_, AgentJournal>,
    workspace_root: String,
) -> Result<AgentRecoverySnapshot, String> {
    // Active native ownership prevents an in-flight event from being sealed
    // while its current-session worker may still be emitting results.
    let registered = app.state::<crate::agent::AgentManager>().owns_workspace(&workspace_root)?
        || app.state::<crate::agent_cli::CliAgentManager>().owns_workspace(&workspace_root)?;
    journal.recovery(&app, &workspace_root, registered)
}

#[tauri::command]
pub fn agent_journal_purge_all(
    app: AppHandle,
    journal: State<'_, AgentJournal>,
) -> Result<(), String> {
    // Requires an explicit, native confirmation in the frontend; no path from
    // user input is accepted, and only VirtualLab-owned journal files are removed.
    journal.purge(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(name: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("virtuallab-journal-{name}-{}-{stamp}", std::process::id()))
    }
    fn input(root: &str, token: &str) -> Value {
        json!({"eventType":"agent.turn_started", "workspaceRoot":root,
            "threadId":token,"turnId":token,"timestampMs":123,
            "payload":{"prompt":"SECRET_CONTENT_123","delta":"SECRET_CONTENT_123"}})
    }

    #[test]
    fn forced_restart_recovery_marks_unfinished_turn_once_and_never_resumes() {
        let dir = temp("restart");
        append_at(&dir, metadata(&input("/fixture/repo", "pending-secret"), Some("codex")).unwrap(), SEGMENT_BYTES).unwrap();
        let first = reconcile_at(&dir, "/fixture/repo", false).unwrap();
        assert_eq!(first.turns.len(), 1);
        assert_eq!(first.turns[0].state, "unverified");
        let next = reconcile_at(&dir, "/fixture/repo", false).unwrap();
        assert_eq!(next.retained_events, first.retained_events);
        let data = fs::read_to_string(segments(&dir).0).unwrap();
        assert!(!data.contains("pending-secret"));
        assert!(!data.contains("SECRET_CONTENT_123"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn active_native_session_does_not_mark_in_flight_turn_as_crashed() {
        let dir = temp("attached");
        append_at(&dir, metadata(&input("/repo/x", "turn1"), Some("claude")).unwrap(), SEGMENT_BYTES).unwrap();
        let active = reconcile_at(&dir, "/repo/x", true).unwrap();
        assert_eq!(active.turns[0].state, "in_flight_unverified");
        assert_eq!(active.retained_events, 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn known_completion_and_exit_are_not_replayed_as_running() {
        let dir = temp("complete");
        append_at(&dir, metadata(&input("/repo", "turn1"), Some("codex")).unwrap(), SEGMENT_BYTES).unwrap();
        let completed = serde_json::json!({
            "eventType":"agent.turn_completed","workspaceRoot":"/repo",
            "turnId":"turn1","timestampMs":124,
            "payload":{"status":"completed","secret":"DO_NOT_WRITE"}
        });
        append_at(&dir, metadata(&completed, Some("codex")).unwrap(), SEGMENT_BYTES).unwrap();
        let result = reconcile_at(&dir, "/repo", false).unwrap();
        assert_eq!(result.turns[0].state, "completed");
        assert_eq!(result.retained_events, 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn case_distinct_workspaces_reconcile_independently() {
        let dir = temp("isolation");
        append_at(&dir, metadata(&input("/repo/Alpha", "one"), None).unwrap(), SEGMENT_BYTES).unwrap();
        append_at(&dir, metadata(&input("/repo/alpha", "two"), None).unwrap(), SEGMENT_BYTES).unwrap();
        #[cfg(unix)] {
            assert_eq!(reconcile_at(&dir, "/repo/Alpha", false).unwrap().turns.len(), 1);
            assert_eq!(reconcile_at(&dir, "/repo/alpha", false).unwrap().turns.len(), 1);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn never_persists_secret_payloads_or_raw_identifiers() {
        let row = metadata(&input("/repo/alpha", "private-thread"), Some("codex")).unwrap();
        let serialized = serde_json::to_string(&row).unwrap();
        assert!(!serialized.contains("SECRET_CONTENT_123"));
        assert!(!serialized.contains("private-thread"));
        assert!(!serialized.contains("/repo/alpha"));
        assert!(metadata(&json!({"eventType":"agent.stderr","workspaceRoot":"/repo/alpha",
            "payload":{"detail":"SECRET_CONTENT_123"}}), None).is_none());
    }

    #[test]
    fn rotation_keeps_sequence_and_workspaces_separate() {
        let dir = temp("rotation");
        for i in 0..8 {
            let root = if i % 2 == 0 { "/repo/Alpha" } else { "/repo/alpha" };
            append_at(&dir, metadata(&input(root, &format!("thread-{i}")), None).unwrap(), 850).unwrap();
        }
        let (current, previous) = segments(&dir);
        let mut items = read_entries(&previous).unwrap().0;
        items.extend(read_entries(&current).unwrap().0);
        assert!(items.windows(2).all(|p| p[0].sequence < p[1].sequence));
        assert!(items.iter().all(|r| r.visibility == "metadata_only"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn torn_last_record_is_recovered_on_next_append() {
        let dir = temp("torn");
        append_at(&dir, metadata(&input("/repo", "a"), None).unwrap(), SEGMENT_BYTES).unwrap();
        let (current, _) = segments(&dir);
        OpenOptions::new().append(true).open(&current).unwrap().write_all(b"{unfinished").unwrap();
        append_at(&dir, metadata(&input("/repo", "b"), None).unwrap(), SEGMENT_BYTES).unwrap();
        let (items, bytes) = read_entries(&current).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(bytes, fs::metadata(&current).unwrap().len());
        fs::remove_dir_all(dir).unwrap();
    }
}
