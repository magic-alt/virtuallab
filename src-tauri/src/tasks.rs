//! Durable task service. No repository mutations or readiness decisions live here.
//! open() takes the app-data JSON FILE path; clones share one serialized writer.
//! Runtime emits the persisted structural event after update()/record() succeeds.
#[path = "tasks/model.rs"]
mod model;
#[path = "tasks/store.rs"]
mod store;
#[path = "tasks/validation.rs"]
mod validation;
pub(crate) use model::*;
pub(crate) use store::{new_id, now_ms, TaskManager};

use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub(crate) fn task_list(
    manager: State<'_, TaskManager>,
    repository_roots: Vec<String>,
) -> Result<Vec<TaskRecord>, String> {
    manager.list(&repository_roots)
}
#[tauri::command]
pub(crate) fn task_get(
    manager: State<'_, TaskManager>,
    task_id: String,
) -> Result<TaskRecord, String> {
    manager.get(&task_id)
}
#[tauri::command]
pub(crate) fn task_events(
    manager: State<'_, TaskManager>,
    after_seq: u64,
) -> Result<Vec<TaskEvent>, String> {
    manager.events(after_seq)
}
#[tauri::command]
pub(crate) fn task_accept_plan(
    app: AppHandle,
    manager: State<'_, TaskManager>,
    request: TaskPlanRequest,
) -> Result<Vec<TaskRecord>, String> {
    let records = manager.accept_plan(request)?;
    // Only durable events are emitted. Sequence deduplication handles concurrent updates.
    let ids: std::collections::HashSet<_> = records.iter().map(|t| t.id.as_str()).collect();
    for event in manager
        .events(0)?
        .into_iter()
        .filter(|e| e.kind == "plan.accepted" && ids.contains(e.task_id.as_str()))
    {
        let _ = app.emit("task://event", &event);
    }
    Ok(records)
}

#[cfg(test)]
#[path = "tasks/tests.rs"]
mod tests;

/// Configuration-only validation; task acceptance still checks repository containment.
pub(crate) fn validate_profile_definition(value: &serde_json::Value) -> Result<(), String> { validation::profile(value, None) }
