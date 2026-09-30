use crate::execution::WorkbenchEvent;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const WATCH_EMIT_MIN_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone, Default)]
pub struct WatchManager {
    watchers: Arc<Mutex<HashMap<String, RecommendedWatcher>>>,
}

#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    state: State<'_, WatchManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("Watch path does not exist: {path}"));
    }

    {
        let mut watchers = state
            .watchers
            .lock()
            .map_err(|_| "Watch manager lock poisoned".to_string())?;
        watchers.remove(&id);
    }

    let app_for_events = app.clone();
    let id_for_events = id.clone();
    let last_emit = Arc::new(Mutex::new(None::<Instant>));
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else {
                return;
            };

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

    state
        .watchers
        .lock()
        .map_err(|_| "Watch manager lock poisoned".to_string())?
        .insert(id.clone(), watcher);

    let _ = app.emit(
        "workbench://event",
        WorkbenchEvent::new("fs.watch_started", id).path(path),
    );
    Ok(())
}

#[tauri::command]
pub fn watch_stop(state: State<'_, WatchManager>, id: String) -> Result<(), String> {
    state
        .watchers
        .lock()
        .map_err(|_| "Watch manager lock poisoned".to_string())?
        .remove(&id);
    Ok(())
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
