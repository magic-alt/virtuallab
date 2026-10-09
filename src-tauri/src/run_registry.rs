//! Native, bounded run history. Views attach to workspace state, never own it.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::VecDeque, sync::{Mutex, atomic::{AtomicBool, Ordering}}};
use tauri::State;

const OUTPUT_BYTES: usize = 180_000;
const HISTORY_LIMIT: usize = 100;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPresentation {
    pub profile_id: String,
    pub profile_name: String,
    pub profile_kind: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRun {
    pub id: String,
    pub cwd: String,
    pub label: String,
    pub presentation: Option<RunPresentation>,
    pub is_workflow: bool,
    pub status: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub step_name: Option<String>,
    pub revision: u64,
}
#[derive(Default)]
pub struct RunRegistry(Mutex<VecDeque<NativeRun>>, AtomicBool);
fn workspace_key(path: &str) -> String {
    let path = path.replace('\\', "/").trim_end_matches('/').to_owned();
    if cfg!(windows) { path.to_lowercase() } else { path }
}
impl RunRegistry {
    pub fn begin(&self, id: &str, cwd: &str, label: &str, workflow: bool, presentation: Option<RunPresentation>) -> Result<(), String> {
        if id.trim().is_empty() || id.len() > 160 { return Err("Invalid run ID".into()); }
        if presentation.as_ref().is_some_and(|p| p.profile_id.len() > 160 || p.profile_name.len() > 512
            || !matches!(p.profile_kind.as_str(), "build" | "test" | "package" | "deploy")) {
            return Err("Invalid run presentation".into());
        }
        let mut runs = self.0.lock().map_err(|_| "Run registry lock poisoned")?;
        if self.1.load(Ordering::SeqCst) { return Err("Application is shutting down".into()); }
        if runs.iter().any(|run| run.id == id) { return Err("Run ID already exists".into()); }
        if runs.iter().any(|run| workspace_key(&run.cwd) == workspace_key(cwd)
            && matches!(run.status.as_str(), "running" | "stopping")) {
            return Err("Workspace already has an active run".into());
        }
        if runs.len() >= HISTORY_LIMIT {
            let index = runs.iter().position(|run| !matches!(run.status.as_str(), "running" | "stopping"))
                .ok_or("Run registry capacity reached")?;
            runs.remove(index);
        }
        runs.push_back(NativeRun { id: id.into(), cwd: cwd.into(), label: label.into(),
            presentation, is_workflow: workflow, status: "running".into(), output: String::new(),
            exit_code: None, step_name: None, revision: 0 });
        Ok(())
    }
    pub fn record(&self, event: Value) {
        let Some(id) = event.get("id").and_then(Value::as_str) else { return };
        let Ok(mut runs) = self.0.lock() else { return };
        let Some(run) = runs.iter_mut().find(|run| run.id == id) else { return };
        run.revision += 1;
        let kind = event.get("eventType").and_then(Value::as_str).unwrap_or("");
        if let Some(text) = event.get("data").and_then(Value::as_str) {
            run.output.push_str(text);
            if run.output.len() > OUTPUT_BYTES {
                let mut start = run.output.len() - OUTPUT_BYTES;
                while !run.output.is_char_boundary(start) { start += 1; }
                run.output.drain(..start);
            }
        }
        if kind == "build.step_started" {
            run.step_name = event.get("stepName").and_then(Value::as_str).map(str::to_owned);
        }
        if kind.ends_with("stop_requested") && run.status == "running" { run.status = "stopping".into(); }
        if kind == "process.exited" || kind == "build.finished" {
            run.exit_code = event.get("exitCode").and_then(Value::as_i64).map(|n| n as i32);
            run.status = if run.status == "stopping" || event.get("result").and_then(Value::as_str) == Some("stopped") {
                "stopped"
            } else if run.exit_code == Some(0) { "passed" } else { "failed" }.into();
        }
    }
    pub fn is_closed(&self) -> bool { self.1.load(Ordering::SeqCst) }
    pub fn close(&self) {
        if let Ok(mut runs) = self.0.lock() {
            self.1.store(true, Ordering::SeqCst);
            for run in runs.iter_mut().filter(|run| run.status == "running") { run.status = "stopping".into(); }
        }
    }
    pub fn is_stopping(&self, id: &str) -> bool {
        if self.1.load(Ordering::SeqCst) { return true; }
        self.0.lock().map(|runs| runs.iter().any(|run| run.id == id && run.status == "stopping")).unwrap_or(true)
    }
    pub fn fail(&self, id: &str, error: &str) {
        self.record(serde_json::json!({ "id": id, "eventType": "process.error", "data": error }));
        self.record(serde_json::json!({ "id": id, "eventType": "process.exited", "exitCode": -1 }));
    }
    fn list(&self, cwd: &str) -> Result<Vec<NativeRun>, String> {
        Ok(self.0.lock().map_err(|_| "Run registry lock poisoned")?.iter()
            .filter(|run| workspace_key(&run.cwd) == workspace_key(cwd)).cloned().collect())
    }
}
#[tauri::command]
pub fn list_runs(state: State<'_, RunRegistry>, cwd: String) -> Result<Vec<NativeRun>, String> {
    let root = std::fs::canonicalize(cwd).map_err(|e| format!("Cannot resolve run workspace: {e}"))?;
    state.list(&root.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn competing_workers_cannot_reserve_the_same_workspace() {
        let registry = std::sync::Arc::new(RunRegistry::default());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8).map(|n| {
            let registry = registry.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                registry.begin(&format!("run-{n}"), "/repo", "Build", false, None).is_ok()
            })
        }).collect();
        assert_eq!(workers.into_iter().filter_map(|worker| worker.join().ok()).filter(|ok| *ok).count(), 1);
        registry.close();
        assert!(registry.begin("other", "/other", "Build", false, None).is_err());
    }
    #[test]
    fn reserves_workspace_and_id_until_observed_exit() {
        let registry = RunRegistry::default();
        registry.begin("one", "/repo", "Build", false, None).unwrap();
        assert!(registry.begin("one", "/other", "Build", false, None).is_err());
        assert!(registry.begin("two", "/repo/", "Build", true, None).is_err());
        registry.record(serde_json::json!({"id":"one", "eventType":"process.stop_requested"}));
        assert_eq!(registry.list("/repo").unwrap()[0].status, "stopping");
        assert!(registry.begin("two", "/repo", "Build", true, None).is_err());
        registry.record(serde_json::json!({"id":"one", "eventType":"process.exited", "exitCode":1}));
        assert_eq!(registry.list("/repo").unwrap()[0].status, "stopped");
        registry.begin("two", "/repo", "Build", true, None).unwrap();
    }
    #[test]
    fn retains_utf8_tail_and_isolates_workspaces() {
        let registry = RunRegistry::default();
        registry.begin("one", "/repo", "Build", false, None).unwrap();
        registry.record(serde_json::json!({"id":"one", "eventType":"process.output", "data":"中文".repeat(40000)}));
        let runs = registry.list("/repo").unwrap();
        assert!(runs[0].output.len() <= OUTPUT_BYTES);
        assert!(runs[0].output.ends_with("中文"));
        assert!(registry.list("/other").unwrap().is_empty());
    }
}
