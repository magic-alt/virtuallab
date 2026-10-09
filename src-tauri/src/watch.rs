use crate::execution::WorkbenchEvent;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const WATCH_EMIT_MIN_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone, Default)]
pub struct WatchManager {
    watchers: Arc<Mutex<HashMap<String, (u64, Option<RecommendedWatcher>)>>>,
    generation: Arc<AtomicU64>,
}

#[tauri::command]
pub async fn watch_start(
    app: AppHandle,
    state: State<'_, WatchManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    let manager = state.inner().clone();
    let (generation, previous) = {
        let mut slots = manager.watchers.lock().map_err(|_| "Watch manager lock poisoned")?;
        if app.state::<crate::run_registry::RunRegistry>().is_closed() { return Err("Application is shutting down".into()); }
        let generation = manager.generation.fetch_add(1, Ordering::SeqCst);
        (generation, slots.insert(id.clone(), (generation, None)))
    };
    tauri::async_runtime::spawn_blocking(move || {
        drop(previous);
        let result = watch_start_blocking(app, manager.clone(), id.clone(), path, generation);
        if result.is_err() {
            let removed = {
                let mut slots = manager.watchers.lock().map_err(|_| "Watch manager lock poisoned")?;
                if slots.get(&id).is_some_and(|(current, _)| *current == generation) { slots.remove(&id) } else { None }
            };
            drop(removed);
        }
        result
    }).await.map_err(|error| format!("Filesystem watcher startup task failed: {error}"))?
}

fn watch_start_blocking(
    app: AppHandle,
    state: WatchManager,
    id: String,
    path: String,
    generation: u64,
) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("Watch path does not exist: {path}"));
    }

    let app_for_events = app.clone();
    let id_for_events = id.clone();
    let slots = state.watchers.clone();
    let last_emit = Arc::new(Mutex::new(None::<Instant>));
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            if !slots.lock().map(|slots| slots.get(&id_for_events)
                .is_some_and(|(current, _)| *current == generation)).unwrap_or(false) { return; }
            let Ok(event) = result else {
                return;
            };
            // Read/access notifications are not source changes. On some
            // platforms Git status scans can otherwise feed the watcher and
            // repeatedly trigger more Git scans.
            if !should_refresh_for_event(&event.kind) {
                return;
            }

            let Some(changed) = event.paths.into_iter().find(|path| !is_ignored_path(path)) else {
                return;
            };

            let now = Instant::now();
            let should_emit = last_emit
                .lock()
                .map(|mut last| {
                    if emit_due(*last, now) {
                        *last = Some(now);
                        true
                    } else {
                        false
                    }
                })
                .unwrap_or(false);

            if should_emit {
                let _ = app_for_events.emit(
                    "workbench://event",
                    WorkbenchEvent::new("fs.changed", id_for_events.clone())
                        .path(changed.to_string_lossy().to_string()),
                );
            }
        },
        Config::default(),
    )
    .map_err(|error| format!("Failed to create filesystem watcher: {error}"))?;

    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|error| format!("Failed to watch workspace: {error}"))?;

    if !install_watcher(&state, &id, generation, watcher)? { return Ok(()); }

    let _ = app.emit(
        "workbench://event",
        WorkbenchEvent::new("fs.watch_started", id).path(path),
    );
    Ok(())
}

#[tauri::command]
pub async fn watch_stop(state: State<'_, WatchManager>, id: String) -> Result<(), String> {
    // Invalidate in invocation order, before scheduling potentially slow teardown.
    let watcher = state.watchers.lock().map_err(|_| "Watch manager lock poisoned")?.remove(&id);
    tauri::async_runtime::spawn_blocking(move || drop(watcher)).await
        .map_err(|error| format!("Filesystem watcher stop task failed: {error}"))?;
    Ok(())
}

fn install_watcher(state: &WatchManager, id: &str, generation: u64, watcher: RecommendedWatcher) -> Result<bool, String> {
    let mut slots = state.watchers.lock().map_err(|_| "Watch manager lock poisoned")?;
    if !slots.get(id).is_some_and(|(current, _)| *current == generation) {
        drop(slots);
        drop(watcher);
        return Ok(false);
    }
    let previous = slots.insert(id.into(), (generation, Some(watcher)));
    drop(slots);
    drop(previous);
    Ok(true)
}

fn should_refresh_for_event(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_))
}

fn emit_due(last: Option<Instant>, now: Instant) -> bool {
    last.map(|instant| now.saturating_duration_since(instant) >= WATCH_EMIT_MIN_INTERVAL)
        .unwrap_or(true)
}

fn is_ignored_path(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component.as_os_str().to_string_lossy().as_ref(),
            ".git" | "node_modules" | "target" | "dist" | ".virtuallab"
        )
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    fn watcher() -> RecommendedWatcher {
        RecommendedWatcher::new(|_: notify::Result<notify::Event>| {}, Config::default()).unwrap()
    }
    #[test]
    fn stopped_startup_cannot_reinstall_a_watcher() {
        let state = WatchManager::default();
        state.watchers.lock().unwrap().insert("workspace".into(), (1, None));
        state.watchers.lock().unwrap().remove("workspace");
        assert!(!install_watcher(&state, "workspace", 1, watcher()).unwrap());
        assert!(state.watchers.lock().unwrap().is_empty());
    }
    #[test]
    fn late_older_startup_cannot_replace_newer_watcher() {
        let state = WatchManager::default();
        state.watchers.lock().unwrap().insert("workspace".into(), (2, None));
        assert!(!install_watcher(&state, "workspace", 1, watcher()).unwrap());
        assert!(install_watcher(&state, "workspace", 2, watcher()).unwrap());
        assert_eq!(state.watchers.lock().unwrap().get("workspace").unwrap().0, 2);
    }
    #[test]
    fn watcher_events_are_rate_limited() {
        let now = Instant::now();
        assert!(emit_due(None, now));
        assert!(!emit_due(Some(now), now + Duration::from_millis(50)));
        assert!(emit_due(
            Some(now),
            now + WATCH_EMIT_MIN_INTERVAL + Duration::from_millis(1),
        ));
    }

    #[test]
    fn git_inspection_access_events_do_not_trigger_recursive_rescans() {
        use notify::event::{AccessKind, ModifyKind};
        assert!(!should_refresh_for_event(&EventKind::Access(AccessKind::Any)));
        assert!(!should_refresh_for_event(&EventKind::Any));
        assert!(should_refresh_for_event(&EventKind::Modify(ModifyKind::Any)));
        assert!(should_refresh_for_event(&EventKind::Create(notify::event::CreateKind::Any)));
        assert!(should_refresh_for_event(&EventKind::Remove(notify::event::RemoveKind::Any)));
    }

    #[test]
    fn generated_directories_are_ignored() {
        for path in [
            "repo/.git/index",
            "repo/node_modules/pkg/file.js",
            "repo/target/debug/app",
            "repo/dist/index.html",
            "repo/.virtuallab/state.json",
        ] {
            assert!(is_ignored_path(Path::new(path)), "{path} should be ignored");
        }
        assert!(!is_ignored_path(Path::new("repo/src/main.tsx")));
    }
}

impl WatchManager {
    pub fn shutdown(&self) {
        let watchers = self.watchers.lock().map(|mut slots| std::mem::take(&mut *slots));
        drop(watchers);
    }
}
