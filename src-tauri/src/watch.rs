use crate::execution::WorkbenchEvent;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

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
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            if let Ok(event) = result {
                for changed in event.paths {
                    if is_ignored_path(&changed) {
                        continue;
                    }
                    let _ = app_for_events.emit(
                        "workbench://event",
                        WorkbenchEvent::new("fs.changed", id_for_events.clone())
                            .path(changed.to_string_lossy().to_string()),
                    );
                }
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
