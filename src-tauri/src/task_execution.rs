//! Bounded, non-replaying task execution. Tasks attach to registered workspaces.

// BEGIN PURE COORDINATOR
mod bounded {
    use std::{
        collections::{HashMap, HashSet, VecDeque},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
    };
    #[derive(Clone)]
    pub(super) struct Queued {
        pub task_id: String,
        pub attempt_id: String,
        pub executable_path: Option<String>,
        // Nonexclusive target ownership moves into the worker, including any
        // independently spawned observer, until all native cleanup is observed.
        pub _workspace_activity: Arc<crate::workspace_lifecycle::RepositoryActivity>,
    }
    #[derive(Default)]
    struct Inner {
        closed: bool,
        queue: VecDeque<Queued>,
        running: HashMap<String, Running>,
        operations: HashSet<String>,
    }
    struct Running {
        cancel: Arc<AtomicBool>,
        verification_run: Option<String>,
    }
    #[derive(Clone, Default)]
    pub(crate) struct TaskExecution(Arc<Mutex<Inner>>);
    pub(crate) struct ExecutionSlot {
        execution: TaskExecution,
        task_id: String,
        cancel: Arc<AtomicBool>,
    }
    pub(super) struct Operation {
        execution: TaskExecution,
        task_id: String,
    }
    impl TaskExecution {
        /// Close admission before process-manager shutdown. Durable queued attempts
        /// remain untouched and are recovered as interrupted on the next launch.
        pub(crate) fn shutdown(&self) {
            let mut inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
            inner.closed = true;
            for running in inner.running.values() {
                running.cancel.store(true, Ordering::Release);
            }
        }
        pub(crate) fn is_closed(&self) -> bool {
            self.0.lock().map(|inner| inner.closed).unwrap_or(true)
        }
        fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
            self.0
                .lock()
                .map_err(|_| "Task execution coordinator lock poisoned".into())
        }
        fn insert_slot(&self, inner: &mut Inner, id: &str) -> ExecutionSlot {
            let cancel = Arc::new(AtomicBool::new(false));
            inner.running.insert(
                id.into(),
                Running {
                    cancel: cancel.clone(),
                    verification_run: None,
                },
            );
            ExecutionSlot {
                execution: self.clone(),
                task_id: id.into(),
                cancel,
            }
        }
        pub(crate) fn claim(&self, task_id: &str) -> Result<ExecutionSlot, String> {
            let mut inner = self.lock()?;
            if inner.closed {
                return Err("Task execution is shutting down".into());
            }
            if task_id.is_empty()
                || inner.operations.contains(task_id)
                || inner.running.contains_key(task_id)
                || inner.queue.iter().any(|entry| entry.task_id == task_id)
            {
                return Err("Task already has pending or running work".into());
            }
            if inner.running.len() >= 2 {
                return Err("Both task execution slots are occupied".into());
            }
            Ok(self.insert_slot(&mut inner, task_id))
        }
        pub(super) fn enqueue<T>(
            &self,
            entry: Queued,
            persist: impl FnOnce() -> Result<T, String>,
        ) -> Result<T, String> {
            let mut inner = self.lock()?;
            if inner.closed {
                return Err("Task execution is shutting down".into());
            }
            if inner.running.contains_key(&entry.task_id)
                || inner.queue.iter().any(|e| e.task_id == entry.task_id)
            {
                return Err("Task is already queued or running".into());
            }
            if inner.queue.len() >= 32 {
                return Err("Task queue is full (32)".into());
            }
            let result = persist()?;
            inner.queue.push_back(entry);
            Ok(result)
        }
        pub(super) fn queued_ids(&self) -> Result<Vec<String>, String> {
            // Pump snapshots must not extend a cancelled task's workspace lease.
            Ok(self.lock()?.queue.iter().map(|entry| entry.task_id.clone()).collect())
        }
        pub(super) fn dispatch(
            &self,
            id: &str,
            persist: impl FnOnce(&Queued) -> Result<(), String>,
        ) -> Result<Option<(Queued, ExecutionSlot)>, String> {
            let mut inner = self.lock()?;
            if inner.closed {
                return Err("Task execution is shutting down".into());
            }
            if inner.running.len() >= 2
                || inner.operations.contains(id)
                || inner.running.contains_key(id)
            {
                return Ok(None);
            }
            let Some(index) = inner.queue.iter().position(|entry| entry.task_id == id) else {
                return Ok(None);
            };
            persist(&inner.queue[index])?;
            let entry = inner
                .queue
                .remove(index)
                .expect("queue index held under lock");
            let slot = self.insert_slot(&mut inner, id);
            Ok(Some((entry, slot)))
        }
        pub(super) fn cancel<T>(
            &self,
            id: &str,
            persist: impl FnOnce(bool) -> Result<T, String>,
        ) -> Result<T, String> {
            let mut inner = self.lock()?;
            let running = inner.running.contains_key(id);
            let result = persist(running)?;
            // Persistence comes first. A failed stopping write cannot silently kill a writer.
            if let Some(run) = inner.running.get(id) {
                run.cancel.store(true, Ordering::Release);
            }
            let removed = inner.queue.iter().position(|entry| entry.task_id == id)
                .and_then(|index| inner.queue.remove(index));
            // Workspace ownership has its own mutex. Release it outside the
            // coordinator lock, and only after cancellation reached storage.
            drop(inner);
            drop(removed);
            Ok(result)
        }
        pub(super) fn operation(&self, id: &str) -> Result<Operation, String> {
            let mut inner = self.lock()?;
            if inner.closed {
                return Err("Task execution is shutting down".into());
            }
            if !inner.operations.insert(id.into()) {
                return Err("Task command already in progress".into());
            }
            Ok(Operation {
                execution: self.clone(),
                task_id: id.into(),
            })
        }
        /// Bind the exact native verification run before the controller invokes it.
        pub(crate) fn bind_verification_run(
            &self,
            task_id: &str,
            run_id: &str,
        ) -> Result<(), String> {
            let mut inner = self.lock()?;
            if inner.closed {
                return Err("Task execution is shutting down".into());
            }
            let run = inner
                .running
                .get_mut(task_id)
                .ok_or("Task has no execution slot")?;
            if run
                .verification_run
                .as_deref()
                .is_some_and(|id| id != run_id)
            {
                return Err("Task already owns a different verification run".into());
            }
            run.verification_run = Some(run_id.into());
            Ok(())
        }
        pub(super) fn verification_run(&self, task_id: &str) -> Option<String> {
            self.0
                .lock()
                .ok()?
                .running
                .get(task_id)?
                .verification_run
                .clone()
        }
        pub(crate) fn cancellation_requested(&self, task_id: &str) -> Result<bool, String> {
            Ok(self
                .lock()?
                .running
                .get(task_id)
                .is_some_and(|run| run.cancel.load(Ordering::Acquire)))
        }
    }
    impl ExecutionSlot {
        pub(crate) fn is_cancelled(&self) -> bool {
            self.cancel.load(Ordering::Acquire)
        }
    }
    impl Drop for ExecutionSlot {
        fn drop(&mut self) {
            // Drop is called only after the owner has observed all writer processes stop.
            let mut inner = self
                .execution
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            inner.running.remove(&self.task_id);
        }
    }
    impl Drop for Operation {
        fn drop(&mut self) {
            self.execution
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .operations
                .remove(&self.task_id);
        }
    }
    pub(super) fn release_then(slot: &mut Option<ExecutionSlot>, wake: impl FnOnce()) {
        drop(slot.take());
        wake();
    }
    pub(super) fn bounded_version(value: &str) -> Option<String> {
        if value.is_empty() || value.chars().any(char::is_control) {
            return None;
        }
        Some(
            value
                .chars()
                .scan(0usize, |bytes, ch| {
                    *bytes += ch.len_utf8();
                    (*bytes <= 256).then_some(ch)
                })
                .collect(),
        )
    }
    pub(super) fn completion_status(
        expected: (&str, &str, &str),
        observed: (&str, &str, &str),
        status: &str,
    ) -> Option<bool> {
        (expected == observed).then_some(status == "completed")
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn queue_admission_retains_target_across_failed_dispatch_and_cancel() {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("vl-task-lease-{}-{nonce}", std::process::id()));
            let target = root.join("sibling task 工作区");
            std::fs::create_dir_all(target.join(".git")).unwrap();
            let lifecycle = crate::workspace_lifecycle::WorkspaceLifecycle::default();
            let preparing = lifecycle.begin_repository_activity(target.to_str().unwrap()).unwrap();
            let execution = TaskExecution::default();
            let queued = Queued {
                task_id: "protected".into(), attempt_id: "attempt".into(), executable_path: None,
                _workspace_activity: preparing.clone(),
            };
            execution.enqueue(queued, || {
                assert!(lifecycle.begin_removal(target.to_str().unwrap()).is_err());
                Ok(())
            }).unwrap();
            drop(preparing);
            assert!(execution.dispatch("protected", |_| Err("disk full".into())).is_err());
            assert!(lifecycle.begin_removal(target.to_str().unwrap()).is_err(),
                "the queue must retain the target after preparation and failed dispatch");
            assert!(execution.cancel("protected", |_| Err::<(), _>("disk full".into())).is_err());
            assert!(lifecycle.begin_removal(target.to_str().unwrap()).is_err());
            execution.cancel("protected", |_| Ok(())).unwrap();
            assert!(lifecycle.begin_removal(target.to_str().unwrap()).is_ok());
            std::fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn completion_requires_exact_workspace_thread_turn_and_observed_success() {
            let expected = ("/work/task", "thread-one", "turn-one");
            assert_eq!(
                completion_status(
                    expected,
                    ("/work/other", "thread-one", "turn-one"),
                    "completed"
                ),
                None
            );
            assert_eq!(
                completion_status(
                    expected,
                    ("/work/task", "thread-two", "turn-one"),
                    "completed"
                ),
                None
            );
            assert_eq!(
                completion_status(
                    expected,
                    ("/work/task", "thread-one", "turn-two"),
                    "completed"
                ),
                None
            );
            for status in [
                "failed",
                "cancelled",
                "interrupted",
                "process_exit",
                "inProgress",
                "",
            ] {
                assert_eq!(completion_status(expected, expected, status), Some(false));
            }
            assert_eq!(
                completion_status(expected, expected, "completed"),
                Some(true)
            );
        }
        #[test]
        fn cancelling_one_task_never_cancels_another_slot() {
            let execution = TaskExecution::default();
            let first = execution.claim("first").unwrap();
            let second = execution.claim("second").unwrap();
            execution.cancel("first", |_| Ok(())).unwrap();
            assert!(first.is_cancelled());
            assert!(!second.is_cancelled());
            assert!(execution.claim("third").is_err());
        }
        #[test]
        fn racing_claims_never_admit_more_than_two_writers() {
            let execution = TaskExecution::default();
            let start = std::sync::Arc::new(std::sync::Barrier::new(9));
            let mut workers = Vec::new();
            for id in 0..8 {
                let execution = execution.clone();
                let start = start.clone();
                workers.push(std::thread::spawn(move || {
                    start.wait();
                    execution.claim(&format!("writer-{id}"))
                }));
            }
            start.wait();
            let results: Vec<_> = workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect();
            assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 2);
            assert!(execution.claim("ninth").is_err());
            drop(results);
            assert!(execution.claim("ninth").is_ok());
        }
        #[test]
        fn shutdown_cancels_writers_without_releasing_slots_or_replaying_queue() {
            let execution = TaskExecution::default();
            execution.enqueue(entry("waiting"), || Ok(())).unwrap();
            let first = execution.claim("first").unwrap();
            let second = execution.claim("second").unwrap();
            execution.shutdown();
            assert!(execution.is_closed());
            assert!(first.is_cancelled());
            assert!(second.is_cancelled());
            assert_eq!(execution.queued_ids().unwrap()[0], "waiting");
            execution
                .cancel("first", |running| {
                    assert!(running);
                    Ok(())
                })
                .unwrap();
            assert!(execution.claim("third").is_err());
            assert!(execution.operation("new-command").is_err());
            let mut persisted = false;
            assert!(execution
                .enqueue(entry("new-task"), || {
                    persisted = true;
                    Ok(())
                })
                .is_err());
            assert!(!persisted);
            assert!(execution
                .dispatch("waiting", |_| {
                    persisted = true;
                    Ok(())
                })
                .is_err());
            assert!(!persisted);
            assert_eq!(execution.queued_ids().unwrap().len(), 1);
        }
        #[test]
        fn dispatch_waiting_at_shutdown_cannot_persist_a_start() {
            let execution = TaskExecution::default();
            execution.enqueue(entry("waiting"), || Ok(())).unwrap();
            let ready = std::sync::Arc::new(std::sync::Barrier::new(2));
            let raced = execution.clone();
            let start = ready.clone();
            let persisted = std::sync::Arc::new(AtomicBool::new(false));
            let called = persisted.clone();
            let worker = std::thread::spawn(move || {
                start.wait();
                raced
                    .dispatch("waiting", |_| {
                        called.store(true, Ordering::Release);
                        Ok(())
                    })
                    .is_err()
            });
            execution.shutdown();
            ready.wait();
            assert!(worker.join().unwrap());
            assert!(!persisted.load(Ordering::Acquire));
            assert_eq!(execution.queued_ids().unwrap().len(), 1);
        }
        #[test]
        fn version_identity_rejects_raw_output_and_bounds_utf8() {
            assert_eq!(bounded_version(""), None);
            assert_eq!(bounded_version("codex-cli 1.0\nraw output"), None);
            assert_eq!(
                bounded_version("codex-cli 1.0"),
                Some("codex-cli 1.0".into())
            );
            assert_eq!(bounded_version(&"x".repeat(300)).unwrap().len(), 256);
            let unicode = bounded_version(&"版".repeat(100)).unwrap();
            assert_eq!(unicode.len(), 255);
            assert_eq!(unicode.chars().count(), 85);
        }
        #[test]
        fn manual_release_wakes_queue_only_after_freeing_capacity() {
            let execution = TaskExecution::default();
            let mut first = Some(execution.claim("manual-one").unwrap());
            let second = execution.claim("manual-two").unwrap();
            execution.enqueue(entry("eligible"), || Ok(())).unwrap();
            assert!(execution
                .dispatch("eligible", |_| Ok(()))
                .unwrap()
                .is_none());
            execution.cancel("manual-one", |_| Ok(())).unwrap();
            assert!(first.as_ref().unwrap().is_cancelled());
            let mut dispatched = None;
            release_then(&mut first, || {
                dispatched = execution.dispatch("eligible", |_| Ok(())).unwrap();
            });
            assert!(first.is_none());
            let (_, running) =
                dispatched.expect("release must make capacity available before waking dispatcher");
            assert!(execution.claim("manual-two").is_err());
            drop(running);
            drop(second);
        }
        #[test]
        fn cancellation_uses_only_the_exact_run_bound_to_its_slot() {
            let execution = TaskExecution::default();
            let first = execution.claim("first").unwrap();
            let _second = execution.claim("second").unwrap();
            execution
                .bind_verification_run("first", "run-first")
                .unwrap();
            execution
                .bind_verification_run("second", "run-second")
                .unwrap();
            assert!(execution
                .bind_verification_run("first", "run-second")
                .is_err());
            execution.cancel("first", |_| Ok(())).unwrap();
            assert_eq!(
                execution.verification_run("first").as_deref(),
                Some("run-first")
            );
            assert_eq!(
                execution.verification_run("second").as_deref(),
                Some("run-second")
            );
            assert!(!execution.cancellation_requested("second").unwrap());
            drop(first);
            assert!(execution.verification_run("first").is_none());
            assert_eq!(
                execution.verification_run("second").as_deref(),
                Some("run-second")
            );
        }
        fn entry(id: &str) -> Queued {
            Queued {
                task_id: id.into(),
                attempt_id: format!("attempt-{id}"),
                executable_path: None,
                _workspace_activity: crate::workspace_lifecycle::WorkspaceLifecycle::default()
                    .begin_repository_activity(std::env::temp_dir().to_str().unwrap()).unwrap(),
            }
        }
        #[test]
        fn global_bound_and_task_ownership_include_manual_slots() {
            let execution = TaskExecution::default();
            let first = execution.claim("first").unwrap();
            assert!(execution.clone().claim("first").is_err());
            let second = execution.claim("second").unwrap();
            assert!(execution.claim("third").is_err());
            drop(first);
            assert!(execution.claim("third").is_ok());
            drop(second);
        }
        #[test]
        fn queue_is_bounded_and_failed_persistence_does_not_admit_work() {
            let execution = TaskExecution::default();
            assert!(execution
                .enqueue(entry("failed"), || Err::<(), _>("disk full".into()))
                .is_err());
            assert!(execution.queued_ids().unwrap().is_empty());
            for i in 0..32 {
                execution
                    .enqueue(entry(&format!("task-{i}")), || Ok(()))
                    .unwrap();
            }
            let mut called = false;
            assert!(execution
                .enqueue(entry("overflow"), || {
                    called = true;
                    Ok(())
                })
                .is_err());
            assert!(!called);
            assert!(execution.enqueue(entry("task-0"), || Ok(())).is_err());
        }
        #[test]
        fn cancellation_persists_before_signal_and_retains_slot_until_observed_stop() {
            let execution = TaskExecution::default();
            let first = execution.claim("first").unwrap();
            let _second = execution.claim("second").unwrap();
            assert!(execution
                .cancel("first", |_| Err::<(), _>("disk full".into()))
                .is_err());
            assert!(!first.is_cancelled());
            execution
                .cancel("first", |running| {
                    assert!(running);
                    assert!(!first.is_cancelled());
                    Ok(())
                })
                .unwrap();
            assert!(first.is_cancelled());
            assert!(execution.claim("third").is_err());
            drop(first); // caller has now observed its process tree stop
            assert!(execution.claim("third").is_ok());
        }
        #[test]
        fn queued_cancellation_and_dispatch_are_atomic_with_durability() {
            let execution = TaskExecution::default();
            execution.enqueue(entry("one"), || Ok(())).unwrap();
            assert!(execution.claim("one").is_err());
            assert!(execution
                .dispatch("one", |_| Err("disk full".into()))
                .is_err());
            assert_eq!(execution.queued_ids().unwrap().len(), 1);
            assert!(execution
                .cancel("one", |_| Err::<(), _>("disk full".into()))
                .is_err());
            assert_eq!(execution.queued_ids().unwrap().len(), 1);
            execution
                .cancel("one", |running| {
                    assert!(!running);
                    Ok(())
                })
                .unwrap();
            assert!(execution.dispatch("one", |_| Ok(())).unwrap().is_none());
            assert!(execution.claim("one").is_ok());
        }
        #[test]
        fn preparation_guard_rejects_duplicate_and_competing_manual_work() {
            let execution = TaskExecution::default();
            let guard = execution.operation("one").unwrap();
            assert!(execution.operation("one").is_err());
            assert!(execution.claim("one").is_err());
            assert!(execution.operation("two").is_ok());
            drop(guard);
            assert!(execution.claim("one").is_ok());
        }
        #[test]
        fn blocked_queue_entry_does_not_prevent_an_eligible_task_dispatch() {
            let execution = TaskExecution::default();
            execution.enqueue(entry("blocked"), || Ok(())).unwrap();
            execution.enqueue(entry("eligible"), || Ok(())).unwrap();
            let (queued, slot) = execution.dispatch("eligible", |_| Ok(())).unwrap().unwrap();
            assert_eq!(queued.attempt_id, "attempt-eligible");
            assert_eq!(execution.queued_ids().unwrap()[0], "blocked");
            assert!(execution.claim("eligible").is_err());
            drop(slot);
            assert!(execution.claim("eligible").is_ok());
        }
    }
}
// END PURE COORDINATOR

use crate::{
    agent::{AgentManager, AgentSessionStartRequest, AgentTurnStartRequest},
    task_runtime::{prerequisites, publish},
    tasks::{new_id, now_ms, TaskAttempt, TaskManager, TaskRecord},
    verification::VerificationManager,
    workspace_lifecycle::{RepositoryActivity, WorkspaceLifecycle},
};
use bounded::Queued;
pub(crate) use bounded::{ExecutionSlot, TaskExecution};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

/// The controller keeps this guard through observed native shutdown on every
/// success, failure and cancellation path. Waking always follows slot release.
pub(crate) struct ManualExecutionSlot {
    slot: Option<ExecutionSlot>,
    _activity: Arc<RepositoryActivity>,
    _workspace_activity: Arc<RepositoryActivity>,
    app: AppHandle,
}
impl TaskExecution {
    pub(crate) fn claim_manual(
        &self,
        app: AppHandle,
        task_id: &str,
    ) -> Result<ManualExecutionSlot, String> {
        let task = app.state::<TaskManager>().get(task_id)?;
        let activity = app.state::<WorkspaceLifecycle>().begin_repository_activity(&task.repository_root)?;
        let workspace_activity = retain_task_workspace(&task, app.state::<WorkspaceLifecycle>().inner())?;
        Ok(ManualExecutionSlot {
            slot: Some(self.claim(task_id)?),
            _activity: activity,
            _workspace_activity: workspace_activity,
            app,
        })
    }
}
impl Drop for ManualExecutionSlot {
    fn drop(&mut self) {
        let execution = self.app.state::<TaskExecution>().inner().clone();
        bounded::release_then(&mut self.slot, || execution.pump(self.app.clone()));
    }
}

const TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const OBSERVE_INTERVAL: Duration = Duration::from_millis(100);

/// Starts at the trusted session binding, independently of any turn RPC. Its
/// Drop also stops/joins, so a caller cannot discard a still-running observer.
pub(crate) struct ProviderStopObserver {
    finished: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}
impl ProviderStopObserver {
    pub(crate) fn start(
        should_stop: impl Fn() -> bool + Send + 'static,
        mut stop: impl FnMut() -> bool + Send + 'static,
        timeout: Duration,
    ) -> Result<Self, String> {
        let finished = Arc::new(AtomicBool::new(false));
        let observed = finished.clone();
        let deadline = Instant::now() + timeout;
        let handle = std::thread::Builder::new()
            .name("task-provider-stop".into())
            .spawn(move || {
                while !observed.load(Ordering::Acquire)
                    && !should_stop()
                    && Instant::now() < deadline
                {
                    std::thread::sleep(OBSERVE_INTERVAL);
                }
                // Failed signalling is not an observed stop. Retain this guard
                // and the caller's slot until the exact native stop succeeds.
                while !stop() {
                    std::thread::sleep(OBSERVE_INTERVAL);
                }
            })
            .map_err(|_| "Cannot start provider stop observer")?;
        Ok(Self {
            finished,
            handle: Some(handle),
        })
    }
    pub(crate) fn finish(mut self) -> Result<(), String> {
        self.finished.store(true, Ordering::Release);
        self.handle
            .take()
            .expect("observer owned")
            .join()
            .map_err(|_| "Provider stop observer failed; manual reconciliation required".into())
    }
}
impl Drop for ProviderStopObserver {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn stop_bound_provider(app: &AppHandle, root: &str, thread: &str) -> bool {
    crate::agent::agent_session_stop_bound(
        app.clone(),
        app.state::<AgentManager>(),
        root.into(),
        thread.into(),
    )
    .is_ok()
        && app.state::<AgentManager>().owns_workspace(root) == Ok(false)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareWorkspaceRequest {
    pub(crate) task_id: String,
    pub(crate) branch: String,
    pub(crate) target_path: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartRequest {
    pub(crate) task_id: String,
    pub(crate) executable_path: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskLaunchRequest {
    request_id: String,
    plan: crate::tasks::TaskPlanRequest,
    executable_path: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskLaunchResult {
    task: TaskRecord,
    launch_error: Option<String>,
}

/// One explicit user action owns acceptance, preparation and queue admission.
/// Once accepted, every failure returns the retained task; uncertain Git work is
/// never deleted, retried or replayed by repeating an IPC request.
#[tauri::command]
pub(crate) async fn task_launch(app: AppHandle, request: TaskLaunchRequest) -> Result<TaskLaunchResult, crate::tasks::TaskLaunchRejection> {
    let manager = app.state::<TaskManager>().inner().clone();
    let _activity = app.state::<WorkspaceLifecycle>().begin_repository_activity(&request.plan.repository_root)
        .map_err(|error| crate::tasks::TaskLaunchRejection::unknown(&request.request_id, error))?;
    let accept_manager = manager.clone();
    let request_id = request.request_id.clone();
    let executable = request.executable_path.clone();
    let accepted = tauri::async_runtime::spawn_blocking(move || accept_manager.accept_launch(&request_id, request.plan, executable.as_deref()))
        .await.map_err(|_| crate::tasks::TaskLaunchRejection::unknown(&request.request_id, "Native task acceptance worker failed; the request may already be saved"))??;
    if !accepted.created { return Ok(TaskLaunchResult { task: accepted.task, launch_error: accepted.launch_error }); }
    publish(&app, &manager);
    let task_id = accepted.task.id.clone();
    let outcome = async {
        let (_prepared, _workspace_activity) = prepare_workspace_retained(app.clone(), PrepareWorkspaceRequest { task_id: task_id.clone(), branch: format!("task/{task_id}"), target_path: None }).await?;
        // Keep the creation lease until enqueue has acquired its own target
        // activity. A separate path-based acquisition after prepare is too late.
        task_start(app.clone(), StartRequest { task_id: task_id.clone(), executable_path: request.executable_path })
    }.await;
    let mut launch_error = outcome.err().map(|error| crate::task_reports::bounded_text(&error, 4096).0);
    if let Err(error) = manager.finish_launch(&request.request_id, launch_error.clone()) {
        launch_error = Some(crate::task_reports::bounded_text(&format!("{}Launch outcome could not be saved: {error}. Inspect the retained task; do not recreate it.", launch_error.as_ref().map(|error| format!("{error}\n")).unwrap_or_default()), 4096).0);
    }
    let task = match manager.get(&task_id) {
        Ok(task) => task,
        Err(error) => {
            launch_error = Some(crate::task_reports::bounded_text(&format!("Retained task {task_id} could not be refreshed: {error}"), 4096).0);
            accepted.task
        }
    };
    Ok(TaskLaunchResult { task, launch_error })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelRequest {
    pub(crate) task_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparationIntent {
    schema_version: u32,
    task_id: String,
    repository_root: String,
    base_sha: String,
    branch: String,
    target_path: Option<String>,
    created_at_ms: u64,
    #[serde(default)]
    failure_observed: bool,
}

fn default_preparation_target(repository: &Path, branch: &str) -> Result<PathBuf, String> {
    let slug: String = branch
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    Ok(repository
        .parent()
        .ok_or("Repository has no worktree parent")?
        .join(".virtuallab-workspaces")
        .join(
            repository
                .file_name()
                .ok_or("Repository name unavailable")?,
        )
        .join(slug))
}

/// Check the original spelling before Path components or filesystem operations:
/// Windows verbatim paths do not parse forward slashes like ordinary paths.
/// Git positional paths use ordinary drive/UNC syntax, preserving case/Unicode.
fn preparation_git_spelling(value: &str, windows: bool) -> Result<String, String> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("Worktree target must be a bounded literal path".into());
    }
    let segments = || value.split(|ch| ch == '/' || (windows && ch == '\\'));
    if segments().any(|part| part == ".." || part.eq_ignore_ascii_case(".git")) {
        return Err(
            "Worktree target must stay outside Git internals without parent traversal".into(),
        );
    }
    if !windows {
        return Ok(value.to_owned());
    }
    // Removing the verbatim namespace must not turn a literal trailing dot or
    // space into a different Win32 directory. Refuse such unrepresentable paths.
    if segments().any(|part| part.ends_with('.') || part.ends_with(' ')) {
        return Err("Worktree target has an ambiguous Windows path component".into());
    }
    let slashed = value.replace('\\', "/");
    if let Some(unc) = slashed.strip_prefix("//?/UNC/") {
        return Ok(format!("//{unc}"));
    }
    if let Some(drive) = slashed.strip_prefix("//?/") {
        let bytes = drive.as_bytes();
        if bytes.first().is_some_and(u8::is_ascii_alphabetic)
            && bytes.get(1) == Some(&b':')
            && bytes.get(2) == Some(&b'/')
        {
            return Ok(drive.to_owned());
        }
        return Err("Worktree target requires a regular drive or UNC path".into());
    }
    if slashed.starts_with("//./") {
        return Err("Worktree target cannot use a Windows device namespace".into());
    }
    Ok(slashed)
}

/// Resolve an absent path through its nearest existing ancestor without mkdir.
/// Reject dangling links, parent traversal, Git internals and non-directory parents.
fn preparation_target(path: &Path, require_absent: bool) -> Result<PathBuf, String> {
    let spelling = preparation_git_spelling(
        path.to_str().ok_or("Worktree target must be Unicode")?,
        cfg!(windows),
    )?;
    let path = Path::new(&spelling);
    if !path.is_absolute()
        || path
            .to_str()
            .is_none_or(|value| value.len() > 4096 || value.chars().any(char::is_control))
        || path.components().any(|part| {
            matches!(part, std::path::Component::ParentDir)
                || part.as_os_str().eq_ignore_ascii_case(".git")
        })
    {
        return Err("Worktree target must be a bounded absolute path outside Git internals, without parent traversal".into());
    }
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if require_absent {
                return Err("Worktree target already exists; choose a new target".into());
            }
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err("Prepared target must be a directory, not a symlink".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot inspect worktree target: {error}")),
    }
    let mut ancestor = path;
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .ok_or("Cannot resolve target parent")?
                        .to_os_string(),
                );
                ancestor = ancestor.parent().ok_or("Cannot resolve target parent")?;
            }
            Err(error) => return Err(format!("Cannot inspect target parent: {error}")),
        }
    }
    let mut canonical = fs::canonicalize(ancestor)
        .map_err(|error| format!("Cannot resolve target parent: {error}"))?;
    if !canonical.is_dir() {
        return Err("Worktree target parent is not a directory".into());
    }
    for part in missing.into_iter().rev() {
        canonical.push(part);
    }
    if canonical
        .components()
        .any(|part| part.as_os_str().eq_ignore_ascii_case(".git"))
    {
        return Err("Worktree target resolves inside Git internals".into());
    }
    // canonicalize reintroduces a verbatim prefix on Windows. Convert again
    // before storing/passing a positional path to the typed Git adapter.
    Ok(PathBuf::from(preparation_git_spelling(
        canonical
            .to_str()
            .ok_or("Worktree target must be Unicode")?,
        cfg!(windows),
    )?))
}

fn validate_branch(root: &Path, branch: &str) -> Result<(), String> {
    if branch.is_empty() || branch.len() > 256 || branch.chars().any(char::is_control) {
        return Err("Task branch must be a bounded literal branch name".into());
    }
    if crate::task_inputs::git(root, &["check-ref-format", "--branch", branch])?.trim() != branch {
        return Err("Task branch cannot expand a previous-checkout expression".into());
    }
    Ok(())
}
fn branch_exists(root: &Path, branch: &str) -> Result<bool, String> {
    let reference = format!("refs/heads/{branch}");
    Ok(
        crate::task_inputs::git(root, &["for-each-ref", "--format=%(refname)", &reference])?
            .lines()
            .any(|line| line == reference),
    )
}

fn validate_preparation(
    task: &TaskRecord,
    request: &PrepareWorkspaceRequest,
) -> Result<PrepareWorkspaceRequest, String> {
    if request.task_id != task.id {
        return Err("Preparation task identity changed".into());
    }
    let root = repository(task)?;
    let branch = request.branch.trim();
    validate_branch(&root, branch)?;
    if branch_exists(&root, branch)? {
        return Err("Task branch already exists; choose a new branch".into());
    }
    let target = match request.target_path.as_deref() {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => default_preparation_target(&root, branch)?,
    };
    let target = preparation_target(&target, true)?;
    let listing = crate::task_inputs::git(&root, &["worktree", "list", "--porcelain", "-z"])?;
    if listing
        .split('\0')
        .filter_map(|line| line.strip_prefix("worktree "))
        .any(|path| {
            crate::workspace_identity::key(path)
                == crate::workspace_identity::key(&target.to_string_lossy())
        })
    {
        return Err("Task target already has a repository registration; reconcile it first".into());
    }
    Ok(PrepareWorkspaceRequest {
        task_id: task.id.clone(),
        branch: branch.into(),
        target_path: Some(target.to_string_lossy().into_owned()),
    })
}

fn controlled_paths(task: &TaskRecord) -> Result<(Vec<String>, Vec<String>), String> {
    let (sources, mut outputs) = match task.profile.as_ref() {
        Some(profile) => (
            crate::task_evidence::profile_paths(profile, "sourcePaths")?,
            crate::task_evidence::profile_paths(profile, "outputPaths")?,
        ),
        None => (Vec::new(), Vec::new()),
    };
    if !outputs.iter().any(|path| path == ".virtuallab/evidence") {
        outputs.push(".virtuallab/evidence".into());
    }
    for path in &sources {
        crate::task_inputs::safe_relative(path, true)?;
    }
    for path in &outputs {
        crate::task_inputs::safe_relative(path, false)?;
    }
    Ok((sources, outputs))
}

fn preparation_path(manager: &TaskManager, id: &str) -> Result<PathBuf, String> {
    // Never let a command ID become an arbitrary app-data path.
    if id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid task identity".into());
    }
    Ok(manager
        .storage_dir()
        .join("task-preparations")
        .join(format!("{id}.json")))
}

fn persist_preparation(
    manager: &TaskManager,
    task: &TaskRecord,
    request: &PrepareWorkspaceRequest,
) -> Result<(), String> {
    let path = preparation_path(manager, &task.id)?;
    let parent = path.parent().ok_or("Preparation directory missing")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create preparation intent directory")?;
    let bytes = serde_json::to_vec(&PreparationIntent {
        schema_version: 1,
        task_id: task.id.clone(),
        repository_root: task.repository_root.clone(),
        base_sha: task.base_sha.clone(),
        branch: request.branch.clone(),
        target_path: request.target_path.clone(),
        created_at_ms: now_ms(),
        failure_observed: false,
    })
    .map_err(|_| "Cannot encode preparation intent")?;
    // An intent survives crashes and all mutation/persistence failures. A second
    // explicit prepare is refused until a human reconciles it; nothing is replayed.
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path)
        .map_err(|_| "Preparation intent already exists or cannot be persisted; manual reconciliation required")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Preparation intent persistence uncertain; manual reconciliation required")?;
    drop(file);
    sync_preparation_directory(&path)?;
    #[cfg(unix)]
    fs::File::open(manager.storage_dir())
        .and_then(|directory| directory.sync_all())
        .map_err(|_| {
            "Preparation directory persistence uncertain; manual reconciliation required"
        })?;
    Ok(())
}

fn read_preparation(manager: &TaskManager, id: &str) -> Result<PreparationIntent, String> {
    let path = preparation_path(manager, id)?;
    let meta = fs::symlink_metadata(&path)
        .map_err(|_| "No retained preparation intent; use explicit preparation")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 16 * 1024 {
        return Err(
            "Preparation intent is not a bounded regular file; manual reconciliation required"
                .into(),
        );
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 {
        return Err("Preparation intent exceeds its bound".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        "Preparation intent is incompatible or corrupt; manual reconciliation required".into()
    })
}

fn mark_preparation_failed(manager: &TaskManager, id: &str) -> Result<(), String> {
    let mut intent = read_preparation(manager, id)?;
    intent.failure_observed = true;
    let path = preparation_path(manager, id)?;
    let temporary = path.with_file_name(format!("{id}.outcome-{}.json", new_id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(&intent).map_err(|e| e.to_string())?)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
    sync_preparation_directory(&path)
}

fn sync_preparation_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(path.parent().ok_or("Preparation directory missing")?)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn reconcile_preparation(
    manager: &TaskManager,
    task: &TaskRecord,
    lifecycle: &WorkspaceLifecycle,
) -> Result<TaskRecord, String> {
    if task.workspace_root.is_some() || !task.attempts.is_empty() {
        return Err("Task is already bound or has execution history".into());
    }
    let root = repository(task)?;
    let _repository =
        lifecycle.reserve(&root.to_string_lossy(), "task workspace reconciliation")?;
    let intent = read_preparation(manager, &task.id)?;
    if intent.schema_version != 1
        || intent.task_id != task.id
        || intent.base_sha != task.base_sha
        || crate::workspace_identity::key(&intent.repository_root)
            != crate::workspace_identity::key(&task.repository_root)
    {
        return Err("Retained intent does not match the approved task repository and base".into());
    }
    validate_branch(&root, &intent.branch)?;
    let recorded_target = intent
        .target_path
        .as_deref()
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| default_preparation_target(&root, &intent.branch))?;
    let target = preparation_target(&recorded_target, false)?;
    let recorded_spelling = PathBuf::from(preparation_git_spelling(
        recorded_target
            .to_str()
            .ok_or("Retained target must be Unicode")?,
        cfg!(windows),
    )?);
    if target != recorded_spelling {
        return Err(
            "Retained target parent identity changed; manual reconciliation required".into(),
        );
    }
    let exists = match fs::symlink_metadata(&target) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Cannot observe retained target: {error}")),
    };
    let _target = if exists {
        lifecycle.reserve(&target.to_string_lossy(), "task workspace binding")?
    } else {
        lifecycle.reserve_creation(&target.to_string_lossy(), "task intent retirement")?
    };
    let listing = crate::task_inputs::git(&root, &["worktree", "list", "--porcelain", "-z"])?;
    let target_key = crate::workspace_identity::key(&target.to_string_lossy());
    let reference = format!("refs/heads/{}", intent.branch);
    let mut target_registered = false;
    let mut branch_registered = false;
    for entry in listing.split("\0\0") {
        for line in entry.split('\0') {
            if let Some(path) = line.strip_prefix("worktree ") {
                target_registered |= crate::workspace_identity::key(path) == target_key;
            }
            if line.strip_prefix("branch ") == Some(reference.as_str()) {
                branch_registered = true;
            }
        }
    }
    if exists {
        if !target_registered {
            return Err("Retained target exists but is not registered in the selected repository; no binding or cleanup performed".into());
        }
        let actual = crate::task_inputs::registered_workspace(&root, &target)?;
        if actual == root {
            return Err("Task cannot bind the selected repository's primary worktree".into());
        }
        if crate::workspace_identity::key(
            crate::task_inputs::git(&actual, &["rev-parse", "--show-toplevel"])?.trim(),
        ) != crate::workspace_identity::key(&actual.to_string_lossy())
            || crate::task_inputs::git(&actual, &["symbolic-ref", "--quiet", "HEAD"])?.trim()
                != reference
            || crate::task_inputs::git(&actual, &["rev-parse", "HEAD"])?.trim() != intent.base_sha
        {
            return Err("Prepared workspace branch, root or HEAD differs from retained intent; manual reconciliation required".into());
        }
        manager.update(&task.id,|record| {
            if record.revision!=task.revision || record.workspace_root.is_some() || !record.attempts.is_empty(){return Err("Task changed during reconciliation".into());}
            record.workspace_root=Some(actual.to_string_lossy().into_owned());Ok(())
        }).map_err(|_|"Workspace observed but binding could not persist; retained intent requires reconciliation".into())
    } else {
        if !intent.failure_observed {
            return Err(
                "Preparation outcome is unknown; absence alone cannot retire an unobserved intent"
                    .into(),
            );
        }
        if target_registered || branch_registered || branch_exists(&root, &intent.branch)? {
            return Err("Retained target or branch still has repository state; intent preserved for manual reconciliation".into());
        }
        let path = preparation_path(manager, &task.id)?;
        let retired = path.with_file_name(format!("{}.retired-{}.json", task.id, new_id()));
        if fs::symlink_metadata(&retired).is_ok() {
            return Err("Intent retirement destination already exists".into());
        }
        // Only metadata moves. Git, target files and branch refs are never removed.
        fs::rename(&path, &retired).map_err(|e| format!("Cannot retire retained intent: {e}"))?;
        sync_preparation_directory(&retired)?;
        manager.update(&task.id, |record| {
            if record.revision != task.revision
                || record.workspace_root.is_some()
                || !record.attempts.is_empty()
            {
                return Err("Task changed during intent retirement".into());
            }
            Ok(())
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReconcileWorkspaceRequest {
    pub(crate) task_id: String,
}

/// Explicit observation/metadata retirement only; never creates or replays Git work.
#[tauri::command]
pub(crate) async fn task_reconcile_workspace(
    app: AppHandle,
    request: ReconcileWorkspaceRequest,
) -> Result<TaskRecord, String> {
    let execution = app.state::<TaskExecution>().inner().clone();
    let operation = execution.operation(&request.task_id)?;
    let manager = app.state::<TaskManager>().inner().clone();
    let task = manager.get(&request.task_id)?;
    let lifecycle = app.state::<WorkspaceLifecycle>().inner().clone();
    let activity = lifecycle.begin_repository_activity(&task.repository_root)?;
    let worker_manager = manager.clone();
    let updated = tauri::async_runtime::spawn_blocking(move || {
        let _activity = activity;
        reconcile_preparation(&worker_manager, &task, &lifecycle)
    })
    .await
    .map_err(|_| "Workspace reconciliation observer failed")??;
    publish(&app, &manager);
    drop(operation);
    execution.pump(app);
    Ok(updated)
}

fn repository(task: &TaskRecord) -> Result<PathBuf, String> {
    let root = fs::canonicalize(&task.repository_root)
        .map_err(|_| "Selected task repository is unavailable")?;
    let actual = crate::task_inputs::git(&root, &["rev-parse", "--show-toplevel"])?;
    if crate::workspace_identity::key(actual.trim())
        != crate::workspace_identity::key(&root.to_string_lossy())
    {
        return Err("Task repository must be a repository root".into());
    }
    let base = format!("{}^{{commit}}", task.base_sha);
    if crate::task_inputs::git(&root, &["rev-parse", "--verify", &base])?.trim() != task.base_sha {
        return Err("Task base must be the fixed approved commit".into());
    }
    Ok(root)
}

fn workspace(task: &TaskRecord) -> Result<PathBuf, String> {
    let repository = repository(task)?;
    let root = crate::task_inputs::registered_workspace(
        &repository,
        Path::new(
            task.workspace_root
                .as_deref()
                .ok_or("Explicitly prepare a task workspace first")?,
        ),
    )?;
    if crate::workspace_identity::key(&root.to_string_lossy())
        == crate::workspace_identity::key(&repository.to_string_lossy())
    {
        return Err("Task execution requires its own registered worktree".into());
    }
    Ok(root)
}

fn retain_task_workspace(task: &TaskRecord, lifecycle: &WorkspaceLifecycle) -> Result<Arc<RepositoryActivity>, String> {
    let target = task.workspace_root.as_deref().ok_or("Explicitly prepare a task workspace first")?;
    // Acquire before registration/preflight IO; native removal uses this same
    // mutex and cannot invalidate the target after admission has won the race.
    let activity = lifecycle.begin_repository_activity(target)?;
    workspace(task)?;
    Ok(activity)
}

fn active(state: &str) -> bool {
    matches!(state, "queued" | "running" | "stopping")
}

#[tauri::command]
pub(crate) async fn task_prepare_workspace(
    app: AppHandle,
    request: PrepareWorkspaceRequest,
) -> Result<TaskRecord, String> {
    // A manual preparation action ends here. With no attempt or running writer,
    // the workspace remains eligible for a later explicit cleanup operation.
    prepare_workspace_retained(app, request).await.map(|(task, _activity)| task)
}

async fn prepare_workspace_retained(
    app: AppHandle,
    request: PrepareWorkspaceRequest,
) -> Result<(TaskRecord, Arc<RepositoryActivity>), String> {
    let execution = app.state::<TaskExecution>().inner().clone();
    let operation = execution.operation(&request.task_id)?;
    let manager = app.state::<TaskManager>().inner().clone();
    let task = manager.get(&request.task_id)?;
    let _activity = app.state::<WorkspaceLifecycle>().begin_repository_activity(&task.repository_root)?;
    if task.workspace_root.is_some() || !task.attempts.is_empty() {
        return Err(
            "Task already has a workspace or execution history; manual reconciliation required"
                .into(),
        );
    }
    let request = validate_preparation(&task, &request)?;
    // Intent must reach stable storage before create_worktree can mutate Git.
    persist_preparation(&manager, &task, &request)?;
    if let Err(error) = manager.update(&task.id, |record| {
        if record.revision != task.revision || record.workspace_root.is_some() {
            return Err("Task changed before preparation".into());
        }
        Ok(())
    }) {
        let _ = mark_preparation_failed(&manager, &task.id);
        return Err(format!("Task persistence failed before worktree creation; reconcile the retained intent: {error}"));
    }
    publish(&app, &manager);
    let expected_target = request
        .target_path
        .clone()
        .ok_or("Validated target missing")?;
    let created = crate::git::create_task_worktree(
        app.clone(),
        task.repository_root.clone(),
        request.branch,
        Some(task.base_sha.clone()),
        Some(expected_target.clone()),
    )
    .await;
    let (created, workspace_activity) = match created {
        Ok(created) => created,
        Err(error) => {
            let _ = mark_preparation_failed(&manager, &task.id);
            return Err(format!("Worktree creation failed; explicitly reconcile retained intent before retry (no cleanup or replay): {error}"));
        }
    };
    let created = serde_json::to_value(created)
        .map_err(|_| "Worktree may exist but result encoding failed; reconcile retained intent")?;
    if created["path"].as_str() != Some(expected_target.as_str()) {
        return Err(
            "Worktree result differs from retained target; explicit reconciliation required".into(),
        );
    }
    // The shared observation path verifies exact branch/base/registration and only binds.
    let fresh = manager.get(&task.id)?;
    let updated =
        reconcile_preparation(&manager, &fresh, app.state::<WorkspaceLifecycle>().inner())?;
    publish(&app, &manager);
    drop(operation);
    execution.pump(app);
    Ok((updated, workspace_activity))
}

fn enqueue(app: &AppHandle, request: StartRequest, retry: bool) -> Result<TaskRecord, String> {
    let execution = app.state::<TaskExecution>().inner().clone();
    let operation = execution.operation(&request.task_id)?;
    let manager = app.state::<TaskManager>().inner().clone();
    let task = manager.get(&request.task_id)?;
    let _activity = app.state::<WorkspaceLifecycle>().begin_repository_activity(&task.repository_root)?;
    if task.kind != "implementation" {
        return Err("Integration requires native preview and explicit confirmation".into());
    }
    let workspace_activity = retain_task_workspace(&task, app.state::<WorkspaceLifecycle>().inner())?;
    if task
        .attempts
        .last()
        .is_some_and(|attempt| active(&attempt.state))
    {
        return Err(
            "Task has active or recovered work; reconcile it before another attempt".into(),
        );
    }
    if retry != !task.attempts.is_empty() {
        return Err("Use start for a first attempt and retry for a new attempt".into());
    }
    let attempt_id = new_id();
    let updated = execution.enqueue(
        Queued {
            task_id: task.id.clone(),
            attempt_id: attempt_id.clone(),
            executable_path: request.executable_path,
            _workspace_activity: workspace_activity,
        },
        || {
            app.state::<crate::task_reports::TaskReports>().initialize(&manager.storage_dir(), &task.id, &attempt_id)?;
            manager.update(&task.id, |record| {
                if record.revision != task.revision {
                    return Err("Task changed before enqueue".into());
                }
                record.review = None;
                record.acceptance = None;
                record.attempts.push(TaskAttempt {
                    id: attempt_id,
                    state: "queued".into(),
                    phase: "implementation".into(),
                    candidate_sha: None,
                    failure: None,
                    started_at_ms: now_ms(),
                    ended_at_ms: None,
                    evidence: None,
                    execution: None,
                });
                Ok(())
            })
        },
    )?;
    publish(app, &manager);
    drop(operation);
    execution.pump(app.clone());
    Ok(updated)
}

#[tauri::command]
pub(crate) fn task_start(app: AppHandle, request: StartRequest) -> Result<TaskRecord, String> {
    enqueue(&app, request, false)
}
#[tauri::command]
pub(crate) fn task_retry(app: AppHandle, request: StartRequest) -> Result<TaskRecord, String> {
    enqueue(&app, request, true)
}

#[tauri::command]
pub(crate) fn task_cancel(app: AppHandle, request: CancelRequest) -> Result<TaskRecord, String> {
    let execution = app.state::<TaskExecution>().inner().clone();
    let operation = execution.operation(&request.task_id)?;
    let manager = app.state::<TaskManager>().inner().clone();
    let updated = execution.cancel(&request.task_id, |running| {
        manager.update(&request.task_id, |record| {
            let attempt = record
                .attempts
                .last_mut()
                .ok_or("Task has no attempt to cancel")?;
            if !active(&attempt.state) {
                return Err("Task attempt is already terminal".into());
            }
            if running {
                attempt.state = "stopping".into();
            } else {
                attempt.state = "cancelled".into();
                attempt.ended_at_ms = Some(now_ms());
                attempt.failure = Some("Cancelled before dispatch; no provider was started".into());
            }
            Ok(())
        })
    })?;
    publish(&app, &manager);
    // Exact task -> native run binding. A monitor also retries this call across
    // verification startup, so a cancellation arriving just before registration wins.
    if let Some(run_id) = execution.verification_run(&request.task_id) {
        let _ =
            crate::verification::verification_cancel(app.state::<VerificationManager>(), run_id);
    }
    if let Some(attempt) = updated.attempts.last() {
        let _ = crate::task_reports::update(&app, &updated.id, &attempt.id, |report| report.finish(&attempt.state, attempt.failure.as_deref()));
    }
    drop(operation);
    execution.pump(app);
    Ok(updated)
}

impl TaskExecution {
    /// Call after commands and after *dropping* a manual verify/integration slot.
    /// Only this process's in-memory queue is scanned: never replay persisted attempts.
    pub(crate) fn pump(&self, app: AppHandle) {
        if self.is_closed() {
            return;
        }
        let execution = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if execution.is_closed() {
                return;
            }
            let manager = app.state::<TaskManager>().inner().clone();
            let Ok(queue) = execution.queued_ids() else {
                return;
            };
            for task_id in queue {
                let Ok(task) = manager.get(&task_id) else {
                    continue;
                };
                if task.kind != "implementation" { continue; }
                let Ok(activity) = app.state::<WorkspaceLifecycle>().begin_repository_activity(&task.repository_root) else {
                    continue; // Detached queues stay pending until explicit re-import/cancel.
                };
                if prerequisites(&app, &task).is_err() { continue; }
                let dispatched = execution.dispatch(&task_id, |queued| {
                    manager.update(&queued.task_id, |record| {
                        let attempt = record.attempts.last_mut().ok_or("Attempt missing")?;
                        if attempt.id != queued.attempt_id || attempt.state != "queued" {
                            return Err("Queued attempt changed".into());
                        }
                        attempt.state = "running".into();
                        Ok(())
                    })?;
                    Ok(())
                });
                if let Ok(Some((queued, slot))) = dispatched {
                    publish(&app, &manager);
                    let worker_app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _activity = activity;
                        worker(worker_app, queued, slot).await;
                    });
                }
            }
        });
    }
}

fn update_attempt(
    app: &AppHandle,
    queued: &Queued,
    apply: impl FnOnce(&mut TaskAttempt) -> Result<(), String>,
) -> Result<TaskRecord, String> {
    let manager = app.state::<TaskManager>().inner().clone();
    let updated = manager.update(&queued.task_id, |record| {
        let attempt = record.attempts.last_mut().ok_or("Attempt missing")?;
        if attempt.id != queued.attempt_id {
            return Err("Task attempt changed".into());
        }
        apply(attempt)
    })?;
    publish(app, &manager);
    Ok(updated)
}

fn validate_scope(
    root: &Path,
    base: &str,
    candidate: &str,
    scope: &[String],
) -> Result<(), String> {
    if scope.is_empty() {
        return Err("Task requires an approved file scope".into());
    }
    for path in scope {
        crate::task_inputs::safe_relative(path, true)?;
    }
    crate::task_inputs::git(root, &["merge-base", "--is-ancestor", base, candidate])?;
    let changed = crate::task_inputs::git(
        root,
        &[
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            base,
            candidate,
            "--",
        ],
    )?;
    for path in changed.split('\0').filter(|path| !path.is_empty()) {
        crate::task_inputs::safe_relative(path, false)?;
        if !scope.iter().any(|prefix| {
            prefix == "."
                || path == prefix
                || path.starts_with(&format!("{}/", prefix.trim_end_matches('/')))
        }) {
            return Err("Candidate changes files outside the approved scope".into());
        }
    }
    Ok(())
}

fn goal(task: &TaskRecord, sources: &[String]) -> String {
    format!("Implement the approved task in this worktree.\nTitle: {}\nGoal: {}\nApproved file scope: {}\nFixed prerequisite candidate commits (read-only context): {}\n\nStay within that scope, but never read or edit Git metadata (.git) or environment-secret files (.env and .env.*); the root scope is not permission to access secrets. Do not commit, stage, reset, clean, checkout, merge, rebase or otherwise change Git history/index. Native inspects your retained changes after you stop and seals a local candidate only when the task authorizes it. Do not fetch, pull, push, mutate remotes, open or merge PRs, perform destructive operations, publish, release, flash firmware, enable motors or power stages, or perform physical/hardware operations. Do not use or resume another workspace's agent thread. Work only in the current worktree. Report completion honestly; provider completion does not establish verification or delivery readiness.\n\nWrite the final response with these sections: 完成结果 / 发现的问题 / 验证结果 / 未解决事项. Describe actual changes, observed problems, commands you ran and their outcomes, and any remaining work. If no problem was found, say so; do not invent findings. Distinguish your own checks from native formal verification. Never claim a check ran, passed, or was accepted without observing it.",
        task.title, task.goal, task.scope.join(", "), sources.join(", "))
}

fn drain_provider_report(app: &AppHandle, queued: &Queued, expected: (&str, &str, &str), reports: &crate::agent::ReportSubscription) -> Result<(), String> {
    let events: Vec<_> = reports.receiver.try_iter().take(64).collect();
    let truncated = reports.take_truncated();
    if events.is_empty() && !truncated { return Ok(()); }
    crate::task_reports::update(app, &queued.task_id, &queued.attempt_id, |report| {
        for event in events { report.observe(expected, &event); }
        report.truncated |= truncated;
    })
}

async fn run_provider(
    app: &AppHandle,
    queued: &Queued,
    task: &TaskRecord,
    root: &str,
    sources: &[String],
) -> Result<(), String> {
    let agents = app.state::<AgentManager>().inner().clone();
    if agents.owns_workspace(root)? {
        return Err(
            "Task workspace already has an agent; explicitly stop it before execution".into(),
        );
    }
    if app.state::<TaskExecution>().is_closed()
        || app
            .state::<TaskExecution>()
            .cancellation_requested(&task.id)?
    {
        return Err("Task execution is stopping".into());
    }
    let selected_path = queued.executable_path.clone();
    let capabilities = tauri::async_runtime::spawn_blocking(move || {
        crate::agent::agent_harness_capabilities("codex".into(), selected_path)
    })
    .await
    .map_err(|_| "Native CLI observation failed")??;
    let capabilities =
        serde_json::to_value(capabilities).map_err(|_| "Cannot encode native CLI observation")?;
    if capabilities["available"] != true || capabilities["harness"] != "codex" {
        return Err(format!("Selected Codex CLI is unavailable: {}", capabilities["detail"].as_str().unwrap_or("Native version probe did not succeed")));
    }
    let executable_path = capabilities["executablePath"].as_str()
        .filter(|path|Path::new(path).is_absolute())
        .ok_or("Native observation did not resolve an absolute CLI path; select the launcher explicitly")?.to_string();
    let version = capabilities["version"]
        .as_str()
        .and_then(bounded::bounded_version);
    update_attempt(app, queued, |attempt| {
        if attempt.state != "running" {
            return Err("Task cancellation requested".into());
        }
        attempt.execution = Some(json!({
            "harness":"codex", "executablePath":executable_path, "version":version,
            "threadId":null, "turnId":null,
        }));
        Ok(())
    })?;
    if app.state::<TaskExecution>().is_closed()
        || app
            .state::<TaskExecution>()
            .cancellation_requested(&task.id)?
    {
        return Err("Task execution is stopping".into());
    }
    // Subscribe BEFORE session/turn startup: very short turns must not be missed.
    let completions = agents.subscribe_completions(root)?;
    let reports = agents.subscribe_reports(root)?;
    let binding = crate::agent::agent_session_start(
        app.clone(),
        app.state::<AgentManager>(),
        AgentSessionStartRequest {
            workspace_root: root.into(),
            harness: "codex".into(),
            thread_id: None,
            executable_path: Some(executable_path),
            // Native must reject an existing runtime atomically under its lifecycle lock.
            require_fresh: true,
        },
    )
    .await;
    let binding = match binding {
        Ok(binding) => binding,
        Err(error) => {
            let observe_app = app.clone();
            let observe_root = root.to_string();
            // Startup can fail after spawning a process. With no trusted binding
            // we must not stop an unrelated session; retain capacity until native
            // managers have observed that workspace's writers release ownership.
            tauri::async_runtime::spawn_blocking(move || loop {
                if observe_app
                    .state::<AgentManager>()
                    .owns_workspace(&observe_root)
                    == Ok(false)
                    && observe_app
                        .state::<WorkspaceLifecycle>()
                        .is_reserved(&observe_root)
                        == Ok(false)
                {
                    break;
                }
                std::thread::sleep(OBSERVE_INTERVAL);
            })
            .await
            .map_err(|_| "Provider startup shutdown observer failed")?;
            return Err(format!("Fresh provider startup failed; workspace retained for reconciliation: {error}"));
        }
    };
    let root = root.to_string();
    let thread = binding.thread_id.clone();
    let trusted_binding = binding.workspace_root == root && binding.harness == "codex";
    let observer = if trusted_binding {
        let execution = app.state::<TaskExecution>().inner().clone();
        let task_id = task.id.clone();
        let stop_app = app.clone();
        let stop_root = root.clone();
        let stop_thread = thread.clone();
        ProviderStopObserver::start(
            move || {
                execution.is_closed() || execution.cancellation_requested(&task_id).unwrap_or(true)
            },
            move || stop_bound_provider(&stop_app, &stop_root, &stop_thread),
            TURN_TIMEOUT,
        )
    } else {
        Err("Provider returned a mismatched task binding".into())
    };
    let outcome = async {
        observer.as_ref().map_err(Clone::clone)?;
        update_attempt(app, queued, |attempt| {
            let execution = attempt
                .execution
                .as_mut()
                .ok_or("CLI observation missing")?;
            execution["threadId"] = json!(binding.thread_id);
            Ok(())
        })?;
        if app
            .state::<TaskExecution>()
            .cancellation_requested(&task.id)?
        {
            return Err("Task cancellation requested".into());
        }
        let turn = crate::agent::agent_turn_start(
            app.clone(),
            app.state::<AgentManager>(),
            AgentTurnStartRequest {
                workspace_root: root.clone(),
                thread_id: thread.clone(),
                text: goal(task, sources),
            },
        )
        .await?;
        if turn.thread_id != thread {
            return Err("Provider returned a mismatched thread".into());
        }
        update_attempt(app, queued, |attempt| {
            let execution = attempt
                .execution
                .as_mut()
                .ok_or("CLI observation missing")?;
            execution["turnId"] = json!(turn.turn_id);
            Ok(())
        })?;
        let observe_app = app.clone();
        let observe_root = root.clone();
        let observe_thread = thread.clone();
        let task_id = task.id.clone();
        let turn_id = turn.turn_id;
        let observe_queued = queued.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let deadline = Instant::now() + TURN_TIMEOUT;
            loop {
                let expected = (observe_root.as_str(), observe_thread.as_str(), turn_id.as_str());
                drain_provider_report(&observe_app, &observe_queued, expected, &reports)?;
                if observe_app
                    .state::<TaskExecution>()
                    .cancellation_requested(&task_id)?
                {
                    return Err("Task cancellation requested".into());
                }
                if Instant::now() >= deadline {
                    return Err("Provider turn exceeded the 30 minute bound".into());
                }
                match completions.recv_timeout(OBSERVE_INTERVAL) {
                    Ok(event) => {
                        if let Some(success) = bounded::completion_status(
                            (&observe_root, &observe_thread, &turn_id),
                            (&event.workspace_root, &event.thread_id, &event.turn_id),
                            &event.status,
                        ) {
                            // The stdout producer queues activity before completion.
                            // Drain again so a rapid final answer cannot lag the task.
                            drain_provider_report(&observe_app, &observe_queued, expected, &reports)?;
                            crate::task_reports::update(&observe_app, &observe_queued.task_id, &observe_queued.attempt_id, |report| {
                                if let Some(answer) = &event.final_output { report.set_summary(answer); }
                                report.truncated |= event.output_truncated;
                                if let Some(error) = &event.error { report.problem("provider", error); }
                                report.entry("status", &format!("Codex turn: {}; observing native provider shutdown", event.status), false);
                            })?;
                            return if success {
                                Ok(())
                            } else {
                                Err(event.error.unwrap_or_else(|| format!("Provider turn ended with status {}", event.status)))
                            };
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if !agents.is_running_bound(&observe_root, &observe_thread)? {
                            return Err("Codex process exited or lost its exact session binding before a completed turn was observed".into());
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("Provider completion observer disconnected".into())
                    }
                }
            }
        })
        .await
        .map_err(|_| "Provider completion observer failed")?
    }
    .await;
    // Await the original turn call before joining the independent stop guard.
    // We never timeout/drop that future while its blocking writer is still live.
    let stop_observation: Result<(), String> = match observer {
        Ok(observer) => match tauri::async_runtime::spawn_blocking(move || observer.finish()).await
        {
            Ok(result) => result,
            Err(_) => Err("Provider stop join failed".into()),
        },
        Err(error) => Err(error),
    };
    if stop_observation.is_err() {
        // An observer startup/join error is not proof of tree exit either.
        // Keep the original slot through an independent exact-stop fallback.
        let stop_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            while !stop_bound_provider(&stop_app, &root, &thread) {
                std::thread::sleep(OBSERVE_INTERVAL);
            }
        })
        .await
        .map_err(|_| "Provider stop observation failed")?;
    }
    stop_observation?;
    outcome
}

/// Existing slot only. Controller can also use this for manual verification and
/// confirmed integration; this function never claims another coordinator slot.
pub(crate) async fn verify_in_slot(app: AppHandle, task_id: String) -> Result<TaskRecord, String> {
    if app.state::<TaskExecution>().is_closed()
        || app
            .state::<TaskExecution>()
            .cancellation_requested(&task_id)?
    {
        return Err("Task execution is stopping before verification".into());
    }
    // Capture the immutable workspace before starting a writer, so a failed
    // post-run store read cannot bypass shutdown observation.
    let root = app
        .state::<TaskManager>()
        .get(&task_id)?
        .workspace_root
        .ok_or("Task workspace missing before verification")?;
    let (tx, rx) = mpsc::channel();
    let verify_app = app.clone();
    let verify_id = task_id.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = crate::task_runtime::verify_task_internal(verify_app, verify_id).await;
        let _ = tx.send(outcome);
    });
    tauri::async_runtime::spawn_blocking(move || {
        let mut observed_run = None;
        let outcome = loop {
            if let Some(run) = app.state::<TaskExecution>().verification_run(&task_id) {
                observed_run = Some(run);
            }
            if app
                .state::<TaskExecution>()
                .cancellation_requested(&task_id)
                .unwrap_or(true)
            {
                if let Some(run_id) = observed_run.as_ref() {
                    let _ = crate::verification::verification_cancel(
                        app.state::<VerificationManager>(),
                        run_id.clone(),
                    );
                }
            }
            match rx.recv_timeout(OBSERVE_INTERVAL) {
                Ok(outcome) => break outcome,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err("Verification observer disconnected".into())
                }
            }
        };
        // Native verification owns its lifecycle reservation through observed tree
        // shutdown. A crashed worker keeps it reserved; retain this slot as well.
        loop {
            match app.state::<VerificationManager>().owns_workspace(&root) {
                Ok(false) => break,
                Ok(true) | Err(_) => {
                    if app
                        .state::<TaskExecution>()
                        .cancellation_requested(&task_id)
                        .unwrap_or(true)
                    {
                        if let Some(run_id) = observed_run.as_ref() {
                            let _ = crate::verification::verification_cancel(
                                app.state::<VerificationManager>(),
                                run_id.clone(),
                            );
                        }
                    }
                    std::thread::sleep(OBSERVE_INTERVAL);
                }
            }
        }
        outcome
    })
    .await
    .map_err(|_| "Verification observation failed")?
}

fn seal_task_candidate(
    root: &Path,
    expected_head: &str,
    task: &TaskRecord,
) -> Result<String, String> {
    let (sources, outputs) = controlled_paths(task)?;
    let candidate = if task.auto_commit {
        crate::task_inputs::seal_candidate_with_policy(
            root,
            expected_head,
            &task.scope,
            &format!("Task {}: approved candidate", task.id),
            &sources,
            &outputs,
        )?
    } else {
        let identity = crate::task_inputs::source_identity(root, &sources, &outputs)?;
        if !identity.clean {
            return Err("autoCommit is disabled; a committed clean candidate is required".into());
        }
        identity.head_sha
    };
    validate_scope(root, &task.base_sha, &candidate, &task.scope)?;
    Ok(candidate)
}

fn provider_candidate(root: &Path, expected_head: &str, task: &TaskRecord) -> Result<Option<String>, String> {
    if task.auto_commit { return seal_task_candidate(root, expected_head, task).map(Some); }
    let (sources, outputs) = controlled_paths(task)?;
    let observed = crate::task_inputs::retained_candidate(root, expected_head, &task.scope, &sources, &outputs)?;
    validate_scope(root, &task.base_sha, &observed.head_sha, &task.scope)?;
    Ok(observed.clean.then_some(observed.head_sha))
}

fn should_verify_provider(task: &TaskRecord, candidate: Option<&str>) -> bool {
    task.profile.is_some() && candidate.is_some()
}

async fn implement(app: &AppHandle, queued: &Queued, slot: &ExecutionSlot) -> Result<(), String> {
    let task = app.state::<TaskManager>().get(&queued.task_id)?;
    let root = workspace(&task)?;
    let sources = prerequisites(app, &task)?;
    crate::task_reports::update(app, &queued.task_id, &queued.attempt_id, |report| {
        report.finish("running", None);
        report.entry("status", "Starting the supervised Codex app-server session in the task worktree", false);
    })?;
    if slot.is_cancelled() {
        return Err("Task cancellation requested".into());
    }
    let expected_head = {
        let _reservation = app
            .state::<WorkspaceLifecycle>()
            .reserve(&root.to_string_lossy(), "task execution preflight")?;
        let (source_paths, output_paths) = controlled_paths(&task)?;
        let before = crate::task_inputs::source_identity(&root, &source_paths, &output_paths)?;
        if !before.clean {
            return Err(
                "Task workspace has uncommitted changes; explicit reconciliation required".into(),
            );
        }
        validate_scope(&root, &task.base_sha, &before.head_sha, &task.scope)?;
        before.head_sha
    };
    run_provider(app, queued, &task, &root.to_string_lossy(), &sources).await?;
    if slot.is_cancelled() {
        return Err("Task cancellation requested".into());
    }
    update_attempt(app, queued, |attempt| {
        if attempt.state != "running" {
            return Err("Task is stopping".into());
        }
        attempt.phase = if task.auto_commit { "sealing" } else { "review" }.into();
        Ok(())
    })?;
    let seal_app = app.clone();
    let seal_task = task.clone();
    let seal_id = task.id.clone();
    let candidate = tauri::async_runtime::spawn_blocking(move || {
        let _reservation = seal_app
            .state::<WorkspaceLifecycle>()
            .reserve(&root.to_string_lossy(), "task native candidate sealing")?;
        if seal_app
            .state::<TaskExecution>()
            .cancellation_requested(&seal_id)?
        {
            return Err("Task cancellation requested".into());
        }
        if prerequisites(&seal_app, &seal_task)? != sources {
            return Err("Fixed prerequisite candidates changed during execution".into());
        }
        // Recheck immediately before the Git adapter, after dependency observation:
        // an exit request while the provider was completing cannot authorize a seal.
        if seal_app.state::<TaskExecution>().is_closed()
            || seal_app
                .state::<TaskExecution>()
                .cancellation_requested(&seal_id)?
        {
            return Err("Task execution stopped before native sealing".into());
        }
        let candidate = provider_candidate(&root, &expected_head, &seal_task)?;
        Ok::<_, String>(candidate)
    })
    .await
    .map_err(|_| "Candidate sealing worker failed; manual reconciliation required")??;
    update_attempt(app, queued, |attempt| {
        // Preserve a successfully observed commit even if cancellation won during sealing.
        attempt.candidate_sha = candidate.clone();
        if attempt.state != "stopping" {
            attempt.phase = if should_verify_provider(&task, candidate.as_deref()) { "verification" } else { "review" }.into();
        }
        Ok(())
    })?;
    if slot.is_cancelled() {
        return Err("Task cancellation requested".into());
    }
    if should_verify_provider(&task, candidate.as_deref()) {
        verify_in_slot(app.clone(), task.id).await?;
    } else {
        crate::task_reports::update(app, &queued.task_id, &queued.attempt_id, |report| {
            report.entry("status", if candidate.is_none() {
                "Codex execution completed. Changes are retained without an automatic commit. Formal verification requires a clean committed candidate; this result is unverified and awaits review."
            } else {
                "Codex execution completed. No formal verification profile is configured; this result is unverified and awaits review."
            }, false);
            report.finish("succeeded", None);
        })?;
        update_attempt(app, queued, |attempt| {
            if attempt.state != "running" { return Err("Task is stopping before completion".into()); }
            attempt.state = "succeeded".into();
            attempt.phase = "review".into();
            attempt.ended_at_ms = Some(now_ms());
            attempt.failure = None;
            Ok(())
        })?;
    }
    Ok(())
}

async fn worker(app: AppHandle, queued: Queued, slot: ExecutionSlot) {
    let result = implement(&app, &queued, &slot).await;
    let cancelled = slot.is_cancelled();
    if result.is_err() || cancelled {
        // A task report is explicitly user-facing. Retain the actual bounded
        // native/provider reason, while the general AgentJournal remains metadata-only.
        let reason = crate::task_reports::bounded_text(&if cancelled {
            "Cancellation observed after native writers stopped; workspace retained".to_string()
        } else { result.err().unwrap_or_else(|| "Native execution ended without a result".into()) }, 4096).0;
        let state = if cancelled { "cancelled" } else { "failed" };
        let _ = crate::task_reports::update(&app, &queued.task_id, &queued.attempt_id, |report| report.finish(state, Some(&reason)));
        let _ = update_attempt(&app, &queued, |attempt| {
            attempt.state = state.into();
            attempt.failure = Some(reason);
            attempt.ended_at_ms = Some(now_ms());
            Ok(())
        });
    }
    if let Ok(task) = app.state::<TaskManager>().get(&queued.task_id) {
        if let Some(attempt) = task.attempts.last().filter(|attempt| attempt.id == queued.attempt_id) {
            let _ = crate::task_reports::update(&app, &queued.task_id, &queued.attempt_id, |report| report.finish(&attempt.state, attempt.failure.as_deref()));
        }
    }
    let execution = app.state::<TaskExecution>().inner().clone();
    // implement has observed provider/verification shutdown, and terminal
    // attempt/report writes above have finished. Release target before waking.
    drop(queued);
    drop(slot);
    execution.pump(app);
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use crate::tasks::{TaskDraft, TaskPlanRequest};

    fn prepare_cleanup_task(fixture: &Fixture, lifecycle: &WorkspaceLifecycle) -> (TaskRecord, String, Arc<RepositoryActivity>) {
        crate::task_inputs::git(&fixture.root, &["branch", "-M", "main"]).unwrap();
        let branch = format!("task/{}", fixture.task.id);
        let request = validate_preparation(&fixture.task, &PrepareWorkspaceRequest {
            task_id: fixture.task.id.clone(), branch: branch.clone(), target_path: None,
        }).unwrap();
        let target = Path::new(request.target_path.as_deref().unwrap());
        assert!(!target.starts_with(&fixture.root), "exercise the default sibling worktree");
        persist_preparation(&fixture.manager, &fixture.task, &request).unwrap();
        let (_, activity) = crate::git::create_task_worktree_blocking(
            fixture.task.repository_root.clone(), branch.clone(), Some(fixture.task.base_sha.clone()),
            request.target_path.clone(), lifecycle).unwrap();
        let task = reconcile_preparation(&fixture.manager, &fixture.task, lifecycle).unwrap();
        assert_cleanup_keeps_task(&task, &branch, lifecycle);
        (task, branch, activity)
    }

    fn assert_cleanup_keeps_task(task: &TaskRecord, branch: &str, lifecycle: &WorkspaceLifecycle) {
        let (preview, failures) = crate::git::execute_merged_cleanup_for_task_test(
            &task.repository_root, lifecycle).unwrap();
        assert!(preview["targets"].as_array().unwrap().iter().any(|target| target["branch"] == branch),
            "the clean queued task must be eligible in the Git preview");
        assert_eq!(failures.len(), 1, "{failures:?}");
        assert!(failures[0].contains("active task operation"), "{failures:?}");
        let target = Path::new(task.workspace_root.as_deref().unwrap());
        assert!(target.exists());
        assert_eq!(workspace(task).unwrap(), fs::canonicalize(target).unwrap());
        assert_eq!(crate::task_inputs::git(Path::new(&task.repository_root),
            &["rev-parse", &format!("refs/heads/{branch}")]).unwrap().trim(), task.base_sha);
    }

    #[test]
    fn queued_task_worktree_blocks_merged_cleanup_until_cancel_is_saved() {
        let fixture = Fixture::new();
        let lifecycle = WorkspaceLifecycle::default();
        let (task, branch, preparing) = prepare_cleanup_task(&fixture, &lifecycle);
        let _repository = lifecycle.begin_repository_activity(&task.repository_root).unwrap();
        let execution = TaskExecution::default();
        let _first = execution.claim("first").unwrap();
        let _second = execution.claim("second").unwrap();
        execution.enqueue(Queued {
            task_id: task.id.clone(), attempt_id: "queued-attempt".into(), executable_path: None,
            _workspace_activity: retain_task_workspace(&task, &lifecycle).unwrap(),
        }, || Ok(())).unwrap();
        drop(preparing);
        let snapshot = execution.queued_ids().unwrap();
        assert!(execution.dispatch(&task.id, |_| Ok(())).unwrap().is_none());
        assert_cleanup_keeps_task(&task, &branch, &lifecycle);
        assert!(execution.cancel(&task.id, |_| Err::<(), _>("disk full".into())).is_err());
        assert_cleanup_keeps_task(&task, &branch, &lifecycle);
        execution.cancel(&task.id, |running| { assert!(!running); Ok(()) }).unwrap();
        let (_, failures) = crate::git::execute_merged_cleanup_for_task_test(
            &task.repository_root, &lifecycle).unwrap();
        assert!(failures.is_empty(), "{failures:?}");
        assert!(!Path::new(task.workspace_root.as_deref().unwrap()).exists());
        assert!(crate::task_inputs::git(&fixture.root, &["rev-parse", "--verify",
            &format!("refs/heads/{branch}")]).is_err());
        assert_eq!(snapshot.len(), 1, "a stale queue snapshot must not pin cancelled workspaces");
    }

    #[test]
    fn dispatched_task_worktree_lease_outlives_writer_gaps_cancel_and_shutdown() {
        let fixture = Fixture::new();
        let lifecycle = WorkspaceLifecycle::default();
        let (task, branch, preparing) = prepare_cleanup_task(&fixture, &lifecycle);
        let execution = TaskExecution::default();
        execution.enqueue(Queued {
            task_id: task.id.clone(), attempt_id: "running-attempt".into(), executable_path: None,
            _workspace_activity: retain_task_workspace(&task, &lifecycle).unwrap(),
        }, || Ok(())).unwrap();
        drop(preparing);
        let (queued, slot) = execution.dispatch(&task.id, |_| Ok(())).unwrap().unwrap();
        let target = task.workspace_root.as_deref().unwrap();
        for owner in ["task preflight", "Codex session", "candidate sealing", "verification"] {
            let writer = lifecycle.reserve(target, owner).unwrap();
            drop(writer);
            assert!(!lifecycle.is_reserved(target).unwrap(), "task lifetime is not a writer");
            assert_cleanup_keeps_task(&task, &branch, &lifecycle);
        }
        execution.cancel(&task.id, |running| { assert!(running); Ok(()) }).unwrap();
        assert!(slot.is_cancelled());
        assert_cleanup_keeps_task(&task, &branch, &lifecycle);
        execution.shutdown();
        assert_cleanup_keeps_task(&task, &branch, &lifecycle);
        // Native writers have stopped, but final attempt/report persistence still
        // owns the queued entry. Only the worker's final release permits cleanup.
        drop(queued);
        drop(slot);
        let (_, failures) = crate::git::execute_merged_cleanup_for_task_test(
            &task.repository_root, &lifecycle).unwrap();
        assert!(failures.is_empty(), "{failures:?}");
        assert!(!Path::new(target).exists());
    }

    #[test]
    fn failed_queue_admission_releases_target_after_preparation_action_finishes() {
        let fixture = Fixture::new();
        let lifecycle = WorkspaceLifecycle::default();
        let (task, branch, preparing) = prepare_cleanup_task(&fixture, &lifecycle);
        let execution = TaskExecution::default();
        assert!(execution.enqueue(Queued {
            task_id: task.id.clone(), attempt_id: "failed-admission".into(), executable_path: None,
            _workspace_activity: retain_task_workspace(&task, &lifecycle).unwrap(),
        }, || Err::<(), _>("disk full".into())).is_err());
        assert!(execution.queued_ids().unwrap().is_empty());
        assert_cleanup_keeps_task(&task, &branch, &lifecycle);
        drop(preparing);
        let (_, failures) = crate::git::execute_merged_cleanup_for_task_test(
            &task.repository_root, &lifecycle).unwrap();
        assert!(failures.is_empty(), "{failures:?}");
        assert!(!Path::new(task.workspace_root.as_deref().unwrap()).exists());
    }

    #[test]
    fn provider_completion_without_auto_commit_retains_changes_without_a_candidate() {
        let fixture = Fixture::new();
        let mut task = fixture.task.clone();
        task.auto_commit = false;
        task.profile = None;
        fs::write(fixture.root.join("source.txt"), "completed local work").unwrap();
        let before_index = crate::task_inputs::git(&fixture.root, &["ls-files", "--stage", "-z"]).unwrap();
        assert_eq!(provider_candidate(&fixture.root, &task.base_sha, &task).unwrap(), None);
        assert_eq!(crate::task_inputs::git(&fixture.root, &["rev-parse", "HEAD"]).unwrap().trim(), task.base_sha);
        assert_eq!(crate::task_inputs::git(&fixture.root, &["ls-files", "--stage", "-z"]).unwrap(), before_index);
        assert_eq!(fs::read_to_string(fixture.root.join("source.txt")).unwrap(), "completed local work");
    }
    #[test]
    fn provider_without_profile_or_committed_candidate_finishes_for_review() {
        let fixture = Fixture::new();
        let mut task = fixture.task.clone();
        task.profile = None;
        assert!(!should_verify_provider(&task, Some(&task.base_sha)));
        task.profile = Some(json!({"id":"checks"}));
        assert!(!should_verify_provider(&task, None));
        assert!(should_verify_provider(&task, Some(&task.base_sha)));
    }
    #[test]
    fn uncommitted_provider_changes_still_require_the_approved_scope() {
        let fixture = Fixture::new();
        let mut task = fixture.task.clone();
        task.auto_commit = false;
        task.scope = vec!["allowed".into()];
        fs::write(fixture.root.join("source.txt"), "outside scope").unwrap();
        assert!(provider_candidate(&fixture.root, &task.base_sha, &task).is_err());
        assert_eq!(fs::read_to_string(fixture.root.join("source.txt")).unwrap(), "outside scope");
    }
    #[test]
    fn provider_stop_retry_keeps_capacity_until_native_stop_is_observed() {
        let execution = TaskExecution::default();
        let slot = execution.claim("provider").unwrap();
        let _other = execution.claim("other").unwrap();
        let observed_execution = execution.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let may_stop = stopped.clone();
        let (attempt_tx, attempt_rx) = mpsc::channel();
        let observer = ProviderStopObserver::start(
            move || {
                observed_execution
                    .cancellation_requested("provider")
                    .unwrap()
            },
            move || {
                let _ = attempt_tx.send(());
                may_stop.load(Ordering::Acquire)
            },
            Duration::from_secs(30),
        )
        .unwrap();
        execution.cancel("provider", |_| Ok(())).unwrap();
        let independent_stop = attempt_rx.recv_timeout(Duration::from_secs(1)).is_ok();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = observer.finish();
            drop(slot);
            let _ = done_tx.send(result);
        });
        let capacity_retained = execution.claim("third").is_err();
        let still_joining = matches!(
            done_rx.recv_timeout(Duration::from_millis(200)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        // Release the synthetic OS failure even when an assertion would fail.
        stopped.store(true, Ordering::Release);
        worker.join().unwrap();
        let finished = done_rx.recv_timeout(Duration::from_secs(1));
        assert!(
            independent_stop,
            "cancel observer must run independently of the worker"
        );
        assert!(
            capacity_retained && still_joining,
            "unconfirmed stop must retain capacity"
        );
        assert!(matches!(finished, Ok(Ok(()))));
        assert!(execution.claim("third").is_ok());
    }

    struct Fixture {
        dir: PathBuf,
        root: PathBuf,
        manager: TaskManager,
        task: TaskRecord,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("vl-execution-review-{}", new_id()));
            let root = dir.join("仓库 with spaces");
            fs::create_dir_all(&root).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let git = |args: &[&str]| crate::task_inputs::git(&root, args).unwrap();
            git(&["init", "-q"]);
            git(&["config", "core.autocrlf", "false"]);
            git(&["config", "user.name", "Fixture"]);
            git(&["config", "user.email", "fixture@invalid"]);
            fs::write(root.join("source.txt"), "base").unwrap();
            git(&["add", "--", "source.txt"]);
            git(&["commit", "-qm", "base"]);
            let head = git(&["rev-parse", "HEAD"]).trim().to_owned();
            let manager = TaskManager::open(dir.join("appdata/tasks.json")).unwrap();
            let task = manager
                .accept_plan(TaskPlanRequest {
                    repository_root: root.to_string_lossy().into_owned(),
                    expected_head_sha: head,
                    tasks: vec![TaskDraft {
                        key: "one".into(),
                        title: "Review fixture".into(),
                        goal: "Update source".into(),
                        scope: vec!["source.txt".into()],
                        kind: "implementation".into(),
                        dependency_keys: vec![],
                        profile: None,
                        auto_commit: true,
                    }],
                })
                .unwrap()
                .remove(0);
            Self {
                dir,
                root,
                manager,
                task,
            }
        }
        fn request(&self, branch: &str) -> PrepareWorkspaceRequest {
            PrepareWorkspaceRequest {
                task_id: self.task.id.clone(),
                branch: branch.into(),
                target_path: Some(self.dir.join("lane 工作").to_string_lossy().into_owned()),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    #[test]
    fn invalid_branch_and_existing_target_do_not_consume_preparation_intent() {
        let fixture = Fixture::new();
        assert!(validate_preparation(&fixture.task, &fixture.request("bad..branch")).is_err());
        assert!(!preparation_path(&fixture.manager, &fixture.task.id)
            .unwrap()
            .exists());
        let request = fixture.request("task-lane");
        let target = Path::new(request.target_path.as_ref().unwrap());
        fs::create_dir(target).unwrap();
        assert!(validate_preparation(&fixture.task, &request).is_err());
        assert!(!preparation_path(&fixture.manager, &fixture.task.id)
            .unwrap()
            .exists());
        fs::remove_dir(target).unwrap();
        let request = validate_preparation(&fixture.task, &request).unwrap();
        persist_preparation(&fixture.manager, &fixture.task, &request).unwrap();
        assert!(preparation_path(&fixture.manager, &fixture.task.id)
            .unwrap()
            .exists());
        let target = request.target_path.as_deref().unwrap();
        crate::task_inputs::git(
            &fixture.root,
            &[
                "worktree",
                "add",
                "-b",
                "task-lane",
                target,
                &fixture.task.base_sha,
            ],
        )
        .unwrap();
        let bound = reconcile_preparation(
            &fixture.manager,
            &fixture.task,
            &WorkspaceLifecycle::default(),
        )
        .unwrap();
        assert_eq!(
            crate::workspace_identity::key(bound.workspace_root.as_deref().unwrap()),
            crate::workspace_identity::key(target),
        );
    }
    #[test]
    fn reconciliation_binds_exact_observed_worktree_without_recreating_it() {
        let fixture = Fixture::new();
        let request = validate_preparation(&fixture.task, &fixture.request("task-lane")).unwrap();
        persist_preparation(&fixture.manager, &fixture.task, &request).unwrap();
        let target = request.target_path.as_deref().unwrap();
        crate::task_inputs::git(
            &fixture.root,
            &[
                "worktree",
                "add",
                "-b",
                "task-lane",
                target,
                &fixture.task.base_sha,
            ],
        )
        .unwrap();
        assert!(fixture
            .manager
            .get(&fixture.task.id)
            .unwrap()
            .workspace_root
            .is_none());
        let before =
            crate::task_inputs::git(&fixture.root, &["worktree", "list", "--porcelain", "-z"])
                .unwrap();
        let result = reconcile_preparation(
            &fixture.manager,
            &fixture.task,
            &WorkspaceLifecycle::default(),
        )
        .unwrap();
        assert_eq!(
            crate::workspace_identity::key(result.workspace_root.as_deref().unwrap()),
            crate::workspace_identity::key(target),
        );
        assert_eq!(
            crate::task_inputs::git(&fixture.root, &["worktree", "list", "--porcelain", "-z"])
                .unwrap(),
            before
        );
        assert!(preparation_path(&fixture.manager, &fixture.task.id)
            .unwrap()
            .exists());
    }
    #[test]
    fn reconciliation_never_binds_different_branch() {
        let fixture = Fixture::new();
        let request =
            validate_preparation(&fixture.task, &fixture.request("expected-lane")).unwrap();
        persist_preparation(&fixture.manager, &fixture.task, &request).unwrap();
        let target = request.target_path.as_deref().unwrap();
        crate::task_inputs::git(
            &fixture.root,
            &[
                "worktree",
                "add",
                "-b",
                "different-lane",
                target,
                &fixture.task.base_sha,
            ],
        )
        .unwrap();
        assert!(reconcile_preparation(
            &fixture.manager,
            &fixture.task,
            &WorkspaceLifecycle::default()
        )
        .is_err());
        assert!(fixture
            .manager
            .get(&fixture.task.id)
            .unwrap()
            .workspace_root
            .is_none());
        assert!(preparation_path(&fixture.manager, &fixture.task.id)
            .unwrap()
            .exists());
    }
    #[test]
    fn reconciliation_rejects_head_change_and_foreign_repository_intent() {
        let fixture = Fixture::new();
        let request = validate_preparation(&fixture.task, &fixture.request("task-lane")).unwrap();
        persist_preparation(&fixture.manager, &fixture.task, &request).unwrap();
        let target = Path::new(request.target_path.as_ref().unwrap());
        crate::task_inputs::git(
            &fixture.root,
            &[
                "worktree",
                "add",
                "-b",
                "task-lane",
                target.to_str().unwrap(),
                &fixture.task.base_sha,
            ],
        )
        .unwrap();
        fs::write(target.join("source.txt"), "changed after preparation").unwrap();
        crate::task_inputs::git(target, &["add", "--", "source.txt"]).unwrap();
        crate::task_inputs::git(target, &["commit", "-qm", "changed"]).unwrap();
        assert!(reconcile_preparation(
            &fixture.manager,
            &fixture.task,
            &WorkspaceLifecycle::default()
        )
        .is_err());
        assert!(fixture
            .manager
            .get(&fixture.task.id)
            .unwrap()
            .workspace_root
            .is_none());
        let foreign = Fixture::new();
        let mut intent = read_preparation(&fixture.manager, &fixture.task.id).unwrap();
        intent.repository_root = foreign.root.to_string_lossy().into_owned();
        fs::write(
            preparation_path(&fixture.manager, &fixture.task.id).unwrap(),
            serde_json::to_vec(&intent).unwrap(),
        )
        .unwrap();
        assert!(reconcile_preparation(
            &fixture.manager,
            &fixture.task,
            &WorkspaceLifecycle::default()
        )
        .is_err());
    }
    #[test]
    fn preparation_git_spelling_preserves_drive_unc_unicode_and_rejects_raw_traversal() {
        for (raw, expected) in [
            (r"\\?\C:\work tree\仓库\lane", "C:/work tree/仓库/lane"),
            (
                r"\\?\UNC\server\share\工作 lane",
                "//server/share/工作 lane",
            ),
            (r"D:\work tree\lane", "D:/work tree/lane"),
            (
                "//server/share/work tree/lane",
                "//server/share/work tree/lane",
            ),
        ] {
            assert_eq!(preparation_git_spelling(raw, true).unwrap(), expected);
        }
        for raw in [
            r"\\?\C:\repo\..\escape",
            r"\\?\C:\repo/../escape",
            r"\\?\UNC\server\share\repo/../escape",
            r"C:\repo\.GiT\lane",
            r"\\?\C:\repo/.git/lane",
            r"\\.\GLOBALROOT\lane",
            r"\\?\GLOBALROOT\lane",
            r"\\?\C:\repo\alias.\lane",
        ] {
            assert!(preparation_git_spelling(raw, true).is_err(), "{raw}");
        }
        assert_eq!(
            preparation_git_spelling("/tmp/仓库/lane", false).unwrap(),
            "/tmp/仓库/lane"
        );
        assert!(preparation_git_spelling("/tmp/repo/../escape", false).is_err());
    }

    #[test]
    fn target_validation_rejects_traversal_git_internals_and_dangling_links() {
        let fixture = Fixture::new();
        let mut request = fixture.request("task-lane");
        // Preserve raw separators and parent components in the request instead
        // of applying PathBuf::join's Windows verbatim rules in the fixture.
        request.target_path = Some(format!("{}/../escape", fixture.root.to_string_lossy()));
        assert!(validate_preparation(&fixture.task, &request).is_err());
        request.target_path = Some(
            fixture
                .root
                .join(".git/new-worktree")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(validate_preparation(&fixture.task, &request).is_err());
        #[cfg(unix)]
        {
            let dangling = fixture.dir.join("dangling");
            std::os::unix::fs::symlink(fixture.dir.join("absent"), &dangling).unwrap();
            request.target_path = Some(dangling.to_string_lossy().into_owned());
            assert!(validate_preparation(&fixture.task, &request).is_err());
        }
        assert!(!preparation_path(&fixture.manager, &fixture.task.id)
            .unwrap()
            .exists());
    }
    #[test]
    fn explicit_retirement_preserves_failed_intent_and_allows_new_preparation() {
        let fixture = Fixture::new();
        let request = validate_preparation(&fixture.task, &fixture.request("task-lane")).unwrap();
        persist_preparation(&fixture.manager, &fixture.task, &request).unwrap();
        assert!(
            reconcile_preparation(
                &fixture.manager,
                &fixture.task,
                &WorkspaceLifecycle::default()
            )
            .is_err(),
            "unknown absence must not retire intent"
        );
        mark_preparation_failed(&fixture.manager, &fixture.task.id).unwrap();
        let updated = reconcile_preparation(
            &fixture.manager,
            &fixture.task,
            &WorkspaceLifecycle::default(),
        )
        .unwrap();
        let active = preparation_path(&fixture.manager, &fixture.task.id).unwrap();
        assert!(!active.exists());
        let retired: Vec<_> = fs::read_dir(active.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".retired-")
            })
            .collect();
        assert_eq!(retired.len(), 1);
        let intent: PreparationIntent =
            serde_json::from_slice(&fs::read(&retired[0]).unwrap()).unwrap();
        assert!(intent.failure_observed);
        assert_eq!(intent.task_id, fixture.task.id);
        let next = validate_preparation(&updated, &fixture.request("corrected-lane")).unwrap();
        persist_preparation(&fixture.manager, &updated, &next).unwrap();
        assert!(active.exists());
        assert!(!Path::new(next.target_path.as_ref().unwrap()).exists());
    }
    #[test]
    fn retirement_refuses_existing_branch_registration_or_unregistered_target() {
        let fixture = Fixture::new();
        let request = validate_preparation(&fixture.task, &fixture.request("task-lane")).unwrap();
        persist_preparation(&fixture.manager, &fixture.task, &request).unwrap();
        mark_preparation_failed(&fixture.manager, &fixture.task.id).unwrap();
        crate::task_inputs::git(
            &fixture.root,
            &["branch", "task-lane", &fixture.task.base_sha],
        )
        .unwrap();
        assert!(reconcile_preparation(
            &fixture.manager,
            &fixture.task,
            &WorkspaceLifecycle::default()
        )
        .is_err());
        assert!(preparation_path(&fixture.manager, &fixture.task.id)
            .unwrap()
            .exists());
        let other = Fixture::new();
        let request = validate_preparation(&other.task, &other.request("task-lane")).unwrap();
        persist_preparation(&other.manager, &other.task, &request).unwrap();
        mark_preparation_failed(&other.manager, &other.task.id).unwrap();
        fs::create_dir(request.target_path.as_ref().unwrap()).unwrap();
        assert!(
            reconcile_preparation(&other.manager, &other.task, &WorkspaceLifecycle::default())
                .is_err()
        );
        assert!(preparation_path(&other.manager, &other.task.id)
            .unwrap()
            .exists());
    }
    #[test]
    fn candidate_policy_never_stages_verifier_evidence_or_declared_outputs() {
        let fixture = Fixture::new();
        let mut task = fixture.task.clone();
        task.profile = Some(json!({"sourcePaths":[],"outputPaths":["build"]}));
        fs::create_dir_all(fixture.root.join(".virtuallab/evidence/run")).unwrap();
        fs::create_dir(fixture.root.join("build")).unwrap();
        fs::write(
            fixture.root.join(".virtuallab/evidence/run/log"),
            "retained evidence",
        )
        .unwrap();
        fs::write(fixture.root.join("build/product"), "generated").unwrap();
        fs::write(fixture.root.join("source.txt"), "candidate").unwrap();
        let candidate = seal_task_candidate(&fixture.root, &task.base_sha, &task).unwrap();
        assert_ne!(candidate, task.base_sha);
        let files =
            crate::task_inputs::git(&fixture.root, &["ls-tree", "-r", "--name-only", "HEAD"])
                .unwrap();
        assert!(!files
            .lines()
            .any(|path| path.starts_with(".virtuallab/") || path.starts_with("build/")));
        assert_eq!(
            fs::read_to_string(fixture.root.join(".virtuallab/evidence/run/log")).unwrap(),
            "retained evidence"
        );
        let (sources, outputs) = controlled_paths(&task).unwrap();
        assert!(
            crate::task_inputs::source_identity(&fixture.root, &sources, &outputs)
                .unwrap()
                .clean
        );
    }
    #[test]
    fn retry_policy_ignores_owned_outputs_but_never_source_or_tracked_outputs() {
        let fixture = Fixture::new();
        let mut task = fixture.task.clone();
        task.profile = Some(json!({"sourcePaths":[],"outputPaths":["build"]}));
        fs::create_dir_all(fixture.root.join(".virtuallab/evidence/run")).unwrap();
        fs::create_dir(fixture.root.join("build")).unwrap();
        fs::write(
            fixture.root.join(".virtuallab/evidence/run/log"),
            "evidence",
        )
        .unwrap();
        fs::write(fixture.root.join("build/product"), "generated").unwrap();
        let (sources, outputs) = controlled_paths(&task).unwrap();
        assert!(
            crate::task_inputs::source_identity(&fixture.root, &sources, &outputs)
                .unwrap()
                .clean
        );
        fs::write(fixture.root.join("source.txt"), "dirty").unwrap();
        assert!(
            !crate::task_inputs::source_identity(&fixture.root, &sources, &outputs)
                .unwrap()
                .clean
        );
        task.profile = Some(json!({"outputPaths":["source.txt"]}));
        let (sources, outputs) = controlled_paths(&task).unwrap();
        assert!(crate::task_inputs::source_identity(&fixture.root, &sources, &outputs).is_err());
    }
}
