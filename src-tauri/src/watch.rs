use crate::execution::WorkbenchEvent;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
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
    let git_directories = resolve_git_directories(Path::new(&path));
    // Use separate rate limits for source files, the Git index, and refs.
    let last_emit = Arc::new(Mutex::new(HashMap::<&'static str, Instant>::new()));
    let metadata_for_events = git_directories.clone();
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

            // Watch Git metadata separately from source edits: `.git/index`
            // changes status, while HEAD/refs/worktrees change the inventory.
            // Git logs, lock files and objects must not trigger rescans.
            let mut relevant = event.paths.into_iter()
                .filter_map(|path| classify_watch_path(&path, &metadata_for_events)
                    .map(|kind| (kind, path)))
                .collect::<Vec<_>>();
            relevant.sort_by_key(|(kind, _)| match *kind {
                "git.changed" => 0,
                "git.status_changed" => 1,
                _ => 2,
            });
            let Some((event_type, changed)) = relevant.into_iter().next() else {
                return;
            };

            let now = Instant::now();
            let should_emit = last_emit
                .lock()
                .map(|mut last| {
                    if emit_due(last.get(event_type).copied(), now) {
                        last.insert(event_type, now);
                        true
                    } else {
                        false
                    }
                })
                .unwrap_or(false);

            if should_emit {
                let _ = app_for_events.emit(
                    "workbench://event",
                    WorkbenchEvent::new(event_type, id_for_events.clone())
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

    // Linked worktrees keep their real HEAD/index and shared branch refs
    // outside the workspace. Watch only relevant Git folders, never the
    // objects directory recursively.
    let mut watched = HashSet::new();
    for directory in &git_directories {
        let targets = [
            (directory.to_path_buf(), RecursiveMode::NonRecursive),
            (directory.join("refs"), RecursiveMode::Recursive),
            (directory.join("worktrees"), RecursiveMode::NonRecursive),
        ];
        for (target, mode) in targets {
            if !target.is_dir() || target.starts_with(Path::new(&path)) ||
                !watched.insert(target.clone()) {
                continue;
            }
            watcher.watch(&target, mode)
                .map_err(|error| format!("Failed to watch Git metadata at {}: {error}", target.display()))?;
        }
    }

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

/// A linked worktree contains a .git pointer instead of its own Git directory.
/// Its refs may also live in a distinct shared `commondir`.
fn resolve_git_directories(worktree: &Path) -> Vec<PathBuf> {
    let dotgit = worktree.join(".git");
    let git_dir = if dotgit.is_dir() {
        dotgit
    } else {
        let Ok(pointer) = std::fs::read_to_string(&dotgit) else { return Vec::new(); };
        let Some(target) = pointer.lines().find_map(|line| line.strip_prefix("gitdir: ")) else {
            return Vec::new();
        };
        let target = Path::new(target.trim());
        let path = if target.is_absolute() { target.to_path_buf() } else { worktree.join(target) };
        path.canonicalize().unwrap_or(path)
    };
    if !git_dir.is_dir() { return Vec::new(); }

    let mut roots = vec![git_dir.clone()];
    if let Ok(text) = std::fs::read_to_string(git_dir.join("commondir")) {
        let relative = Path::new(text.trim());
        let shared = if relative.is_absolute() {
            relative.to_path_buf()
        } else {
            git_dir.join(relative)
        };
        let shared = shared.canonicalize().unwrap_or(shared);
        if shared.is_dir() && shared != git_dir { roots.push(shared); }
    }
    roots
}

fn git_metadata_event(relative: &Path) -> Option<&'static str> {
    let parts = relative.components().filter_map(|part| match part {
        std::path::Component::Normal(name) => name.to_str(),
        _ => None,
    }).collect::<Vec<_>>();
    if parts.last().is_some_and(|name| name.ends_with(".lock")) { return None; }
    match parts.as_slice() {
        ["index"] | ["worktrees", _, "index"] => Some("git.status_changed"),
        ["HEAD"] | ["packed-refs"] | ["config"] |
        ["refs", "heads", ..] | ["refs", "remotes", ..] |
        ["worktrees"] | ["worktrees", _] | ["worktrees", _, "HEAD"] |
        ["worktrees", _, "gitdir"] | ["worktrees", _, "commondir"] => Some("git.changed"),
        _ => None,
    }
}

fn classify_watch_path(path: &Path, git_directories: &[PathBuf]) -> Option<&'static str> {
    for dir in git_directories {
        if let Ok(relative) = path.strip_prefix(dir) {
            return git_metadata_event(relative);
        }
    }
    if is_ignored_path(path) { None } else { Some("fs.changed") }
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
    fn git_metadata_events_are_classified_without_git_status_feedback() {
        let git = PathBuf::from("/repo/.git");
        let directories = vec![git.clone()];
        let classify = |relative: &str| classify_watch_path(&git.join(relative), &directories);
        assert_eq!(classify("HEAD"), Some("git.changed"));
        assert_eq!(classify("refs/heads/main"), Some("git.changed"));
        assert_eq!(classify("refs/remotes/origin/feat/a"), Some("git.changed"));
        assert_eq!(classify("packed-refs"), Some("git.changed"));
        assert_eq!(classify("worktrees/branch-a/HEAD"), Some("git.changed"));
        assert_eq!(classify("index"), Some("git.status_changed"));
        assert_eq!(classify("worktrees/branch-a/index"), Some("git.status_changed"));
        assert_eq!(classify("index.lock"), None);
        assert_eq!(classify("objects/aa/1234"), None);
        assert_eq!(classify("logs/HEAD"), None);
        assert_eq!(classify_watch_path(Path::new("/repo/src/main.rs"), &directories), Some("fs.changed"));
        assert_eq!(classify_watch_path(Path::new("/repo/dist/bundle.js"), &directories), None);
    }

    #[test]
    fn linked_worktree_watches_its_external_gitdir_and_shared_refs() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let sandbox = std::env::temp_dir().join(format!(
            "virtuallab-watch-linked-{}-{nonce}", std::process::id(),
        ));
        let linked = sandbox.join("linked");
        let common = sandbox.join("primary").join(".git");
        let worktree_git = common.join("worktrees").join("linked");
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::create_dir_all(common.join("refs").join("heads")).unwrap();
        std::fs::create_dir_all(&worktree_git).unwrap();
        std::fs::write(linked.join(".git"), format!("gitdir: {}", worktree_git.display())).unwrap();
        std::fs::write(worktree_git.join("commondir"), "../..").unwrap();

        let roots = resolve_git_directories(&linked);
        assert_eq!(roots.len(), 2);
        assert!(roots.contains(&worktree_git.canonicalize().unwrap()));
        assert!(roots.contains(&common.canonicalize().unwrap()));
        assert_eq!(classify_watch_path(&worktree_git.canonicalize().unwrap().join("HEAD"), &roots),
            Some("git.changed"));
        assert_eq!(classify_watch_path(&common.canonicalize().unwrap().join("refs/heads/new"), &roots),
            Some("git.changed"));
        std::fs::remove_dir_all(sandbox).unwrap();
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
