use super::{model::*, validation};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) const MAX_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const MAX_TASKS: usize = 4096;
pub(super) const MAX_EVENTS: usize = 100_000;
pub(super) const MAX_QUEUED: usize = 32;
pub(super) const MAX_DECISIONS: usize = 100_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Generation {
    pub(super) schema_version: u32,
    pub(super) tasks: Vec<TaskRecord>,
    pub(super) events: Vec<TaskEvent>,
    #[serde(default)]
    pub(super) decision_history: Vec<TaskDecision>,
}
impl Default for Generation {
    fn default() -> Self {
        Self {
            schema_version: 1,
            tasks: vec![],
            events: vec![],
            decision_history: vec![],
        }
    }
}
#[derive(Clone)]
pub(crate) struct TaskManager {
    path: Arc<PathBuf>,
    state: Arc<Mutex<Generation>>,
    unavailable_error: Option<Arc<String>>,
}
impl TaskManager {
    /// The controller owns one manager per app-data store. Do not open a second
    /// writer for the same path; clone this manager for asynchronous workers.
    pub(crate) fn open(path: PathBuf) -> Result<Self, String> {
        if !path.is_absolute() || path.file_name().is_none() {
            return Err("Task store must be an absolute JSON file path.".into());
        }
        let loaded = match fs::symlink_metadata(&path) {
            Ok(meta) => {
                if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_BYTES {
                    return Err(
                        "Task store is not a bounded regular file; explicit repair required."
                            .into(),
                    );
                }
                let mut bytes = Vec::new();
                File::open(&path)
                    .map_err(io_error)?
                    .take(MAX_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(io_error)?;
                if bytes.len() as u64 > MAX_BYTES {
                    return Err("Task store exceeds size limit.".into());
                }
                serde_json::from_slice::<Generation>(&bytes).map_err(|_| {
                    "Corrupt/incompatible task store; explicit repair required.".to_string()
                })?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let empty = Generation::default();
                persist(&path, &empty)?;
                empty
            }
            Err(e) => return Err(io_error(e)),
        };
        validate_persisted_bindings(&loaded)?;
        validation::generation(&loaded)?;
        let manager = Self {
            path: Arc::new(path),
            state: Arc::new(Mutex::new(loaded)),
            unavailable_error: None,
        };
        manager.recover()?;
        Ok(manager)
    }

    /// Preserve the startup failure while the rest of the workbench remains
    /// available. No query, recovery or mutation may access this empty backing
    /// value, and this constructor performs no filesystem operations.
    pub(crate) fn unavailable(path: PathBuf, error: String) -> Self {
        Self {
            path: Arc::new(path),
            state: Arc::new(Mutex::new(Generation::default())),
            unavailable_error: Some(Arc::new(error)),
        }
    }

    pub(crate) fn storage_dir(&self) -> PathBuf {
        self.path
            .parent()
            .unwrap_or(self.path.as_path())
            .to_path_buf()
    }
    fn lock(&self) -> Result<MutexGuard<'_, Generation>, String> {
        if let Some(error) = &self.unavailable_error {
            return Err(error.as_ref().clone());
        }
        self.state
            .lock()
            .map_err(|_| "Task manager lock poisoned.".into())
    }
    /// Scheduler-only native snapshot. Frontend listing must use list().
    pub(crate) fn all(&self) -> Result<Vec<TaskRecord>, String> {
        Ok(self.lock()?.tasks.clone())
    }
    pub(crate) fn list(&self, roots: &[String]) -> Result<Vec<TaskRecord>, String> {
        let state = self.lock()?;
        if roots.len() > 256 {
            return Err("Too many repository filters.".into());
        }
        let identities = roots
            .iter()
            .map(|r| validation::canonical_root(r))
            .collect::<Result<HashSet<_>, _>>()?;
        Ok(state
            .tasks
            .iter()
            .filter(|t| {
                // Canonicalize natively on every query so aliases cannot widen filters.
                validation::canonical_root(&t.repository_root)
                    .is_ok_and(|r| identities.contains(&r))
            })
            .cloned()
            .collect())
    }
    pub(crate) fn get(&self, id: &str) -> Result<TaskRecord, String> {
        let state = self.lock()?;
        validation::id(id)?;
        state
            .tasks
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| "Task not found.".into())
    }
    pub(crate) fn events(&self, after: u64) -> Result<Vec<TaskEvent>, String> {
        Ok(self
            .lock()?
            .events
            .iter()
            .filter(|e| e.seq > after)
            .cloned()
            .collect())
    }
    /// Archived snapshots followed by current revision-bound human decisions.
    /// Export callers must apply their own privacy policy to notes and paths.
    pub(crate) fn decisions(&self, task_id: &str) -> Result<Vec<serde_json::Value>, String> {
        let state = self.lock()?;
        validation::id(task_id)?;
        let task = state
            .tasks
            .iter()
            .find(|t| t.id == task_id)
            .ok_or("Task not found.")?;
        let mut decisions: Vec<_> = state
            .decision_history
            .iter()
            .filter(|d| d.task_id() == task_id)
            .cloned()
            .collect();
        if let Some(record) = &task.review {
            decisions.push(TaskDecision::Review {
                task_id: task_id.into(),
                record: record.clone(),
            });
        }
        if let Some(record) = &task.acceptance {
            decisions.push(TaskDecision::Acceptance {
                task_id: task_id.into(),
                record: record.clone(),
            });
        }
        decisions
            .into_iter()
            .map(|d| {
                serde_json::to_value(d).map_err(|_| "Cannot encode human decision history.".into())
            })
            .collect()
    }
    pub(crate) fn update(
        &self,
        id: &str,
        f: impl FnOnce(&mut TaskRecord) -> Result<(), String>,
    ) -> Result<TaskRecord, String> {
        self.record(id, None, "task.updated", f)
    }
    /// Atomically bind a target mutation to the observed dependency revisions.
    /// Include every direct dependency; additional observed transitive dependencies
    /// are allowed within the same repository. The closure must not reenter this manager.
    pub(crate) fn update_with_dependency_revisions(
        &self,
        id: &str,
        expected: &[(String, u64)],
        mutate: impl FnOnce(&mut TaskRecord) -> Result<(), String>,
    ) -> Result<TaskRecord, String> {
        let mut state = self.lock()?;
        validation::id(id)?;
        if expected.len() > MAX_TASKS {
            return Err("Dependency snapshot exceeds store capacity.".into());
        }
        let target = state
            .tasks
            .iter()
            .find(|t| t.id == id)
            .ok_or("Task not found.")?;
        let mut observed = HashSet::new();
        for (dependency_id, revision) in expected {
            validation::id(dependency_id)?;
            if !observed.insert(dependency_id.as_str()) {
                return Err("Duplicate dependency snapshot.".into());
            }
            let dependency = state
                .tasks
                .iter()
                .find(|t| t.id == *dependency_id)
                .ok_or("Observed dependency no longer exists.")?;
            if dependency.repository_root != target.repository_root
                || dependency.revision != *revision
            {
                return Err(
                    "Dependency changed; refresh readiness before recording the decision.".into(),
                );
            }
        }
        if target
            .dependencies
            .iter()
            .any(|dependency| !observed.contains(dependency.as_str()))
        {
            return Err("Dependency snapshot is incomplete; refresh readiness before recording the decision.".into());
        }
        self.record_in_generation(&mut state, id, None, "task.updated", mutate)
    }
    /// Structural event names are validated; no provider payload can be appended.
    /// A closure error, validation error or persistence error leaves state intact.
    pub(crate) fn record(
        &self,
        id: &str,
        attempt_id: Option<&str>,
        kind: &str,
        f: impl FnOnce(&mut TaskRecord) -> Result<(), String>,
    ) -> Result<TaskRecord, String> {
        let mut state = self.lock()?;
        self.record_in_generation(&mut state, id, attempt_id, kind, f)
    }

    fn record_in_generation(
        &self,
        state: &mut Generation,
        id: &str,
        attempt_id: Option<&str>,
        kind: &str,
        f: impl FnOnce(&mut TaskRecord) -> Result<(), String>,
    ) -> Result<TaskRecord, String> {
        validation::id(id)?;
        validation::event_kind(kind)?;
        let mut next = state.clone();
        let task = next
            .tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or("Task not found.")?;
        let previous = task.clone();
        f(task)?;
        validation::mutation(&previous, task)?;
        task.revision = previous
            .revision
            .checked_add(1)
            .ok_or("Task revision exhausted.")?;
        task.updated_at_ms = now_ms().max(previous.updated_at_ms);
        let result = task.clone();
        // Archive the prior human records in the SAME generation as the task
        // mutation and its event. Failed validation/save cannot lose or duplicate
        // decisions, and setting the same decision is not a new historical record.
        if previous.review != result.review {
            if let Some(record) = previous.review {
                next.decision_history.push(TaskDecision::Review {
                    task_id: id.into(),
                    record,
                });
            }
        }
        if previous.acceptance != result.acceptance {
            if let Some(record) = previous.acceptance {
                next.decision_history.push(TaskDecision::Acceptance {
                    task_id: id.into(),
                    record,
                });
            }
        }
        append_event(&mut next, id, attempt_id, kind)?;
        validation::generation(&next)?;
        persist(&self.path, &next)?;
        *state = next;
        Ok(result)
    }
    pub(crate) fn accept_plan(&self, request: TaskPlanRequest) -> Result<Vec<TaskRecord>, String> {
        let mut state = self.lock()?;
        if request.tasks.is_empty() || request.tasks.len() > 128 {
            return Err("A plan requires 1–128 tasks.".into());
        }
        validation::sha(&request.expected_head_sha)?;
        let root =
            validation::repository_head(&request.repository_root, &request.expected_head_sha)?;
        if state.tasks.len() + request.tasks.len() > MAX_TASKS {
            return Err("Task storage capacity reached; explicit archive required.".into());
        }
        let mut keys = HashMap::new();
        for draft in &request.tasks {
            validation::draft(draft, &root)?;
            // Keys cannot shadow existing task IDs: dependency resolution is unambiguous.
            if state.tasks.iter().any(|t| t.id == draft.key)
                || keys.insert(draft.key.clone(), new_id()).is_some()
            {
                return Err("Duplicate or ambiguous task plan key.".into());
            }
        }
        let mut records = Vec::new();
        let timestamp = now_ms();
        for draft in request.tasks {
            let mut dependencies = Vec::new();
            for key in &draft.dependency_keys {
                let dependency = if let Some(id) = keys.get(key) {
                    id.clone()
                } else {
                    let existing = state
                        .tasks
                        .iter()
                        .find(|t| t.id == *key)
                        .ok_or("Dependency not found.")?;
                    if existing.repository_root != root {
                        return Err("Dependencies cannot cross repositories.".into());
                    }
                    existing.id.clone()
                };
                if dependencies.contains(&dependency) {
                    return Err("Duplicate dependency.".into());
                }
                dependencies.push(dependency);
            }
            records.push(TaskRecord {
                id: keys[&draft.key].clone(),
                repository_root: root.clone(),
                title: draft.title,
                goal: draft.goal,
                scope: draft.scope,
                base_sha: request.expected_head_sha.clone(),
                kind: draft.kind,
                dependencies,
                profile: draft.profile,
                auto_commit: draft.auto_commit,
                revision: 1,
                workspace_root: None,
                attempts: vec![],
                review: None,
                acceptance: None,
                created_at_ms: timestamp,
                updated_at_ms: timestamp,
            });
        }
        let mut next = state.clone();
        next.tasks.extend(records.clone());
        for task in &records {
            append_event(&mut next, &task.id, None, "plan.accepted")?;
        }
        validation::generation(&next)?;
        // Recheck HEAD immediately before saving; acceptance itself never mutates Git.
        validation::repository_head(&root, &request.expected_head_sha)?;
        persist(&self.path, &next)?;
        *state = next;
        Ok(records)
    }
    fn recover(&self) -> Result<(), String> {
        let mut state = self.lock()?;
        let mut next = state.clone();
        let timestamp = now_ms();
        let mut interrupted = Vec::new();
        for task in &mut next.tasks {
            let mut changed = false;
            for attempt in &mut task.attempts {
                if matches!(attempt.state.as_str(), "queued" | "running" | "stopping") {
                    attempt.state = "interrupted".into();
                    attempt.failure =
                        Some("Application restarted; explicit start or retry required.".into());
                    attempt.ended_at_ms = Some(timestamp.max(attempt.started_at_ms));
                    interrupted.push((task.id.clone(), attempt.id.clone()));
                    changed = true;
                }
            }
            if changed {
                task.revision = task
                    .revision
                    .checked_add(1)
                    .ok_or("Task revision exhausted.")?;
                task.updated_at_ms = timestamp.max(task.updated_at_ms);
            }
        }
        if interrupted.is_empty() {
            return Ok(());
        }
        for (task, attempt) in interrupted {
            append_event(&mut next, &task, Some(&attempt), "attempt.interrupted")?;
        }
        validation::generation(&next)?;
        persist(&self.path, &next)?;
        *state = next;
        Ok(())
    }
}
fn append_event(
    state: &mut Generation,
    task_id: &str,
    attempt_id: Option<&str>,
    kind: &str,
) -> Result<(), String> {
    if state.events.len() >= MAX_EVENTS {
        return Err(
            "Task event capacity reached; explicit archive required (lineage preserved).".into(),
        );
    }
    let seq = state.events.last().map_or(Ok(1), |e| {
        e.seq.checked_add(1).ok_or("Event sequence exhausted.")
    })?;
    state.events.push(TaskEvent {
        schema_version: 1,
        event_id: new_id(),
        seq,
        task_id: task_id.into(),
        attempt_id: attempt_id.map(str::to_owned),
        kind: kind.into(),
        timestamp_ms: now_ms(),
    });
    Ok(())
}
fn persist(path: &Path, state: &Generation) -> Result<(), String> {
    validate_persisted_bindings(state)?;
    let bytes = bounded_json(state, MAX_BYTES as usize)?;
    let parent = path.parent().ok_or("Task store parent required.")?;
    fs::create_dir_all(parent).map_err(io_error)?;
    // Refuse symlink/directory replacement, including after open.
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
            return Err("Task store must be a regular file.".into())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_error(e)),
    }
    let temporary = parent.join(format!(".tasks-{}.tmp", new_id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(io_error)?;
        file.write_all(&bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        #[cfg(unix)]
        let directory = {
            let f = File::open(parent).map_err(io_error)?;
            f.sync_all().map_err(io_error)?;
            f
        };
        // This is the commit point: never unlink the previous generation first.
        fs::rename(&temporary, path).map_err(io_error)?;
        // A post-commit directory sync cannot be reported as a rolled-back save.
        // The file is already committed; attempt the durability barrier best effort.
        #[cfg(unix)]
        {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
/// Missing pairs are historical schema-1 decisions. Present pairs identify one
/// exact observed run/toolchain; the controller owns current-run applicability.
/// Optional manifest digests bind fresh evidence to its entire external manifest.
/// Missing historical digests remain unknown, never reconstructed by this store.
/// Validate before any save and on reopen, including archived human records.
fn validate_persisted_bindings(state: &Generation) -> Result<(), String> {
    fn sha256(digest: &str) -> Result<(), String> {
        if digest.len() != 64 {
            return Err("Persisted binding digest must be SHA-256.".into());
        }
        validation::sha(digest)
    }
    fn pair(run_id: Option<&str>, toolchain_digest: Option<&str>) -> Result<(), String> {
        match (run_id, toolchain_digest) {
            (None, None) => Ok(()),
            (Some(run_id), Some(digest)) => {
                validation::id(run_id)?;
                sha256(digest)
            }
            _ => Err("Decision run ID and toolchain digest must be paired.".into()),
        }
    }
    for task in &state.tasks {
        for attempt in &task.attempts {
            if let Some(digest) = attempt
                .evidence
                .as_ref()
                .and_then(|e| e.manifest_digest.as_deref())
            {
                sha256(digest)?;
            }
        }
        if let Some(review) = &task.review {
            pair(review.run_id.as_deref(), review.toolchain_digest.as_deref())?;
        }
        if let Some(acceptance) = &task.acceptance {
            pair(
                acceptance.run_id.as_deref(),
                acceptance.toolchain_digest.as_deref(),
            )?;
        }
    }
    for decision in &state.decision_history {
        match decision {
            TaskDecision::Review { record, .. } => {
                pair(record.run_id.as_deref(), record.toolchain_digest.as_deref())?
            }
            TaskDecision::Acceptance { record, .. } => {
                pair(record.run_id.as_deref(), record.toolchain_digest.as_deref())?
            }
        }
    }
    Ok(())
}

fn io_error(_: std::io::Error) -> String {
    "Task store I/O failed; previous generation retained if save did not commit.".into()
}

/// Bound allocation while encoding, rather than allocating an unbounded JSON
/// generation and discovering the limit only afterwards.
pub(super) fn bounded_json(value: &impl Serialize, limit: usize) -> Result<Vec<u8>, String> {
    struct Buffer {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl Write for Buffer {
        fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
            if input.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Task JSON size limit exceeded",
                ));
            }
            self.bytes.extend_from_slice(input);
            Ok(input.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Buffer {
        bytes: Vec::with_capacity(limit.min(4096)),
        limit,
    };
    serde_json::to_writer(&mut output, value)
        .map_err(|_| "Structural task JSON exceeds its size limit; explicit archive or smaller profile required.".to_string())?;
    Ok(output.bytes)
}
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
pub(crate) fn new_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "t-{nanos:x}-{:x}-{:x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
