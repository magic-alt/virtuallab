//! Atomic workspace writer/removal reservations. This is not an OS sandbox.
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Default, Debug)]
pub struct WorkspaceLifecycle(Arc<Mutex<LifecycleState>>);

#[derive(Default, Debug)]
struct LifecycleState {
    claims: HashMap<PathBuf, WriterClaim>,
    terminals: HashMap<PathBuf, usize>,
    detached: HashSet<PathBuf>,
    activities: HashMap<PathBuf, usize>,
}

#[derive(Debug)]
struct WriterClaim {
    owner: String,
    blocks_terminals: bool,
}

/// Nonexclusive task lifetime; nested native writers retain their own exclusive
/// reservations. Arc ownership follows independently spawned task observers.
pub(crate) struct RepositoryActivity {
    lifecycle: WorkspaceLifecycle,
    key: PathBuf,
}

impl Drop for RepositoryActivity {
    fn drop(&mut self) {
        let mut state = self.lifecycle.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(count) = state.activities.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 { state.activities.remove(&self.key); }
        }
    }
}

impl LifecycleState {
    fn require_attached(&self, key: &Path) -> Result<(), String> {
        if self.detached.iter().any(|root| key.starts_with(root)) {
            return Err("Repository was removed from the workbench. Re-add it before starting native work.".into());
        }
        Ok(())
    }
}

/// A non-cloneable writer reservation or nonexclusive terminal lease. Keep it until process-tree
/// exit is observed; requesting cancellation does not release ownership.
#[derive(Debug)]
pub struct WorkspaceReservation {
    lifecycle: WorkspaceLifecycle,
    key: PathBuf,
    terminal: bool,
    released: Arc<std::sync::atomic::AtomicBool>,
}

fn identity(root: &str) -> Result<PathBuf, String> {
    if root.is_empty() {
        return Err("Workspace path must not be empty".into());
    }
    let mut path = std::fs::canonicalize(Path::new(root))
        .map_err(|error| format!("Cannot resolve workspace {root}: {error}"))?;
    if !path.is_dir() {
        return Err("Workspace must be an existing directory".into());
    }
    // Processes and terminals may start in a subdirectory of their worktree.
    // The nearest Git marker identifies that workspace, including linked
    // worktrees (.git is a file). Non-repository directories stay independent.
    if let Some(workspace) = path
        .ancestors()
        .find(|ancestor| ancestor.join(".git").exists())
    {
        path = workspace.to_path_buf();
    }
    #[cfg(windows)]
    let path = PathBuf::from(path.to_string_lossy().to_lowercase());
    Ok(path)
}

impl WorkspaceLifecycle {
    pub(crate) fn resolve_identity(root: &str) -> Result<PathBuf, String> { identity(root) }

    /// Query terminal removal protection without following a replacement path.
    pub(crate) fn try_has_terminals_identity(&self, root: &Path) -> Result<Option<bool>, String> {
        match self.0.try_lock() {
            Ok(claims) => Ok(Some(claims.terminals.contains_key(root))),
            Err(std::sync::TryLockError::WouldBlock) => Ok(None),
            Err(std::sync::TryLockError::Poisoned(_)) => Err("Workspace lifecycle lock poisoned".into()),
        }
    }

    pub fn reserve(&self, root: &str, owner: &str) -> Result<WorkspaceReservation, String> {
        self.reserve_writer(root, owner, false)
    }

    fn reserve_writer(&self, root: &str, owner: &str, blocks_terminals: bool) -> Result<WorkspaceReservation, String> {
        if owner.trim().is_empty() {
            return Err("Workspace owner must not be empty".into());
        }
        let mut claims = self
            .0
            .lock()
            .map_err(|_| "Workspace lifecycle lock poisoned")?;
        // Resolve while holding the same mutex used by removal/start. If a
        // removal completed, missing paths fail closed instead of acquiring a
        // second identity for a dangling alias.
        let key = identity(root)?;
        claims.require_attached(&key)?;
        if blocks_terminals && claims.terminals.contains_key(&key) {
            return Err("Workspace is reserved by terminal; wait for observed completion.".into());
        }
        if let Some(current) = claims.claims.get(&key) {
            let current = &current.owner;
            return Err(format!(
                "Workspace is reserved by {current}; wait for observed completion."
            ));
        }
        claims.claims.insert(key.clone(), WriterClaim { owner: owner.to_owned(), blocks_terminals });
        Ok(WorkspaceReservation {
            lifecycle: self.clone(),
            key,
            terminal: false,
            released: Arc::default(),
        })
    }

    /// A terminal is an interactive attachment, not a scheduled workspace writer.
    /// Its lease protects removal while allowing Git, Run and other terminals.
    pub(crate) fn reserve_terminal(&self, root: &str) -> Result<WorkspaceReservation, String> {
        let mut state = self.0.lock().map_err(|_| "Workspace lifecycle lock poisoned")?;
        let key = identity(root)?;
        state.require_attached(&key)?;
        // Before a new worktree has its .git marker, identity() may resolve its
        // cwd to the parent worktree. Check the actual directory as well.
        let directory = std::fs::canonicalize(root).map_err(|error| format!("Cannot resolve terminal directory: {error}"))?;
        #[cfg(windows)]
        let directory = PathBuf::from(directory.to_string_lossy().to_lowercase());
        if let Some((_, claim)) = state.claims.iter().find(|(claimed, claim)| claim.blocks_terminals && directory.starts_with(claimed)) {
            return Err(format!("Workspace is reserved by {}; wait for observed completion.", claim.owner));
        }
        *state.terminals.entry(key.clone()).or_default() += 1;
        Ok(WorkspaceReservation { lifecycle: self.clone(), key, terminal: true, released: Arc::default() })
    }

    /// Reserve a not-yet-created worktree target before mkdir/Git registration.
    pub fn reserve_creation(
        &self,
        root: &str,
        owner: &str,
    ) -> Result<WorkspaceReservation, String> {
        if root.is_empty() || owner.trim().is_empty() {
            return Err("Creation path and owner must not be empty".into());
        }
        let mut claims = self
            .0
            .lock()
            .map_err(|_| "Workspace lifecycle lock poisoned")?;
        let path = Path::new(root);
        if path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
        {
            return Err("Worktree creation path must not contain parent traversal".into());
        }
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|error| error.to_string())?
                .join(path)
        };
        if std::fs::symlink_metadata(&path).is_ok() {
            return Err("Worktree creation target already exists".into());
        }
        let mut ancestor = path.as_path();
        let mut missing = Vec::new();
        while std::fs::symlink_metadata(ancestor).is_err() {
            missing.push(
                ancestor
                    .file_name()
                    .ok_or("Cannot resolve creation parent")?
                    .to_owned(),
            );
            ancestor = ancestor.parent().ok_or("Cannot resolve creation parent")?;
        }
        let mut key = std::fs::canonicalize(ancestor).map_err(|error| error.to_string())?;
        if !key.is_dir() {
            return Err("Worktree creation parent must be a directory".into());
        }
        for part in missing.into_iter().rev() {
            key.push(part);
        }
        #[cfg(windows)]
        let key = PathBuf::from(key.to_string_lossy().to_lowercase());
        claims.require_attached(&key)?;
        if let Some(current) = claims.claims.get(&key) {
            return Err(format!("Workspace is reserved by {}", current.owner));
        }
        if claims.terminals.contains_key(&key) {
            return Err("Workspace is reserved by terminal; wait for observed completion.".into());
        }
        claims.claims.insert(key.clone(), WriterClaim { owner: owner.to_owned(), blocks_terminals: true });
        Ok(WorkspaceReservation {
            lifecycle: self.clone(),
            key,
            terminal: false,
            released: Arc::default(),
        })
    }

    pub(crate) fn begin_repository_activity(&self, root: &str) -> Result<Arc<RepositoryActivity>, String> {
        let mut state = self.0.lock().map_err(|_| "Workspace lifecycle lock poisoned")?;
        let key = identity(root)?;
        state.require_attached(&key)?;
        *state.activities.entry(key.clone()).or_default() += 1;
        Ok(Arc::new(RepositoryActivity { lifecycle: self.clone(), key }))
    }

    /// All-or-nothing detach under the existing writer/startup mutex. The
    /// second Git inventory read runs while new native starts/creation are
    /// excluded; failure must leave every workspace attached and runnable.
    pub fn detach_repository(
        &self,
        roots: &[String],
        validate_inventory: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        if roots.is_empty() {
            return Err("Cannot remove a repository with no registered worktrees".into());
        }
        let mut state = self.0.lock().map_err(|_| "Workspace lifecycle lock poisoned")?;
        let keys = roots.iter().map(|root| identity(root)).collect::<Result<Vec<_>, _>>()?;
        for key in &keys {
            if state.terminals.keys().any(|active| active.starts_with(key) || key.starts_with(active)) {
                return Err("Workspace is reserved by terminal; stop native work and wait for observed completion before removing the repository.".into());
            }
            if state.activities.keys().any(|active| active.starts_with(key) || key.starts_with(active)) {
                return Err("Repository has an active task operation; cancel or wait for completion before removing it.".into());
            }
            if let Some((_, owner)) = state.claims.iter()
                .find(|(claimed, _)| claimed.starts_with(key) || key.starts_with(claimed)) {
                let owner = &owner.owner;
                return Err(format!("Workspace is reserved by {owner}; stop native work and wait for observed completion before removing the repository."));
            }
        }
        validate_inventory()?;
        state.detached.extend(keys);
        Ok(())
    }

    /// Only an explicit validated re-import restores native startup rights.
    pub fn restore_repository(&self, roots: &[String]) -> Result<(), String> {
        if roots.is_empty() {
            return Err("Cannot restore an empty repository worktree inventory".into());
        }
        let mut state = self.0.lock().map_err(|_| "Workspace lifecycle lock poisoned")?;
        let keys = roots.iter().map(|root| identity(root)).collect::<Result<Vec<_>, _>>()?;
        for key in keys { state.detached.remove(&key); }
        Ok(())
    }

    pub fn begin_removal(&self, root: &str) -> Result<WorkspaceReservation, String> {
        self.reserve_writer(root, "worktree removal", true)
    }

    pub fn is_reserved(&self, root: &str) -> Result<bool, String> {
        let claims = self
            .0
            .lock()
            .map_err(|_| "Workspace lifecycle lock poisoned")?;
        // Scheduler/provider recovery observes controlled writers only.
        Ok(claims.claims.contains_key(&identity(root)?))
    }
}

impl WorkspaceReservation {
    /// Immutable owner identity, including terminals started below a worktree root.
    pub(crate) fn workspace_root(&self) -> &Path { &self.key }

    pub(crate) fn release_observer(&self) -> Arc<std::sync::atomic::AtomicBool> { self.released.clone() }
}

impl Drop for WorkspaceReservation {
    fn drop(&mut self) {
        // A poisoned service rejects new claims; recovering here only releases
        // this immutable identity and cannot make the service usable again.
        let mut claims = self
            .lifecycle
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.terminal {
            if let Some(count) = claims.terminals.get_mut(&self.key) {
                *count -= 1;
                if *count == 0 { claims.terminals.remove(&self.key); }
            }
        } else {
            claims.claims.remove(&self.key);
        }
        self.released.store(true, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{
            atomic::{AtomicU64, Ordering},
            Barrier,
        },
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };
    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
    fn fixture() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "virtuallab-lifecycle-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("other")).unwrap();
        root
    }
    #[test]
    fn nested_creation_blocks_terminal_start_before_git_marker_exists() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        fs::create_dir(root.join(".git")).unwrap();
        let target = root.join("future");
        let creation = service.reserve_creation(target.to_str().unwrap(), "creation").unwrap();
        fs::create_dir(&target).unwrap();
        assert!(service.reserve_terminal(target.to_str().unwrap()).is_err());
        assert!(service.reserve_terminal(root.to_str().unwrap()).is_ok());
        fs::create_dir(target.join(".git")).unwrap();
        drop(creation);
        assert!(service.reserve_terminal(target.to_str().unwrap()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminals_do_not_block_workspace_work_but_keep_removal_protected() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let path = root.to_str().unwrap();
        let first = service.reserve_terminal(path).unwrap();
        let second = service.reserve_terminal(path).expect("multiple terminals must coexist");
        assert!(!service.is_reserved(path).unwrap(), "shells must not block provider recovery");
        for owner in ["Git branch switch", "process", "build workflow", "agent codex", "verification"] {
            let writer = service.reserve(path, owner).expect("terminals must not block workspace work");
            assert!(service.reserve(path, "competing writer").is_err());
            let extra = service.reserve_terminal(path).expect("workspace work must not block terminals");
            drop(extra);
            drop(writer);
        }
        assert!(service.begin_removal(path).is_err());
        assert!(service.detach_repository(&[path.into()], || Ok(())).is_err());
        drop(first);
        assert!(service.begin_removal(path).is_err(), "second terminal must retain removal protection");
        let writer = service.reserve(path, "process").unwrap();
        drop(second);
        assert!(service.reserve(path, "agent").is_err(), "terminal exit must keep the writer claim");
        drop(writer);
        let removal = service.begin_removal(path).unwrap();
        assert!(service.reserve_terminal(path).is_err());
        drop(removal);
        service.detach_repository(&[path.into()], || Ok(())).unwrap();
        assert!(service.reserve_terminal(path).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repository_detach_is_atomic_and_preserves_active_sibling_owners() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let paths = vec![root.to_string_lossy().into_owned(), root.join("other").to_string_lossy().into_owned()];
        let owner = service.reserve_terminal(&paths[1]).unwrap();
        assert!(service.detach_repository(&paths, || Ok(())).is_err());
        assert!(service.reserve(&paths[0], "agent").is_ok());
        assert_eq!(service.try_has_terminals_identity(&identity(&paths[1]).unwrap()).unwrap(), Some(true));
        drop(owner);
        service.detach_repository(&paths, || Ok(())).unwrap();
        assert!(service.reserve(&paths[0], "agent").is_err());
        assert!(service.reserve(&paths[1], "build").is_err());
        assert!(service.reserve_creation(&root.join("future").to_string_lossy(), "creation").is_err());
        service.restore_repository(&paths).unwrap();
        assert!(service.reserve(&paths[0], "agent").is_ok());
        assert!(service.reserve(&paths[1], "build").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repository_detach_inventory_failure_leaves_all_paths_runnable() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let paths = vec![root.to_string_lossy().into_owned(), root.join("other").to_string_lossy().into_owned()];
        assert!(service.detach_repository(&paths, || Err("inventory changed".into())).is_err());
        assert!(service.reserve(&paths[0], "agent").is_ok());
        assert!(service.reserve(&paths[1], "terminal").is_ok());
        assert!(service.detach_repository(&[], || Ok(())).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repository_detach_blocks_nested_owners_and_preserves_unrelated_workspaces() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let child = root.join("other");
        let nested = child.join("nested");
        fs::create_dir_all(nested.join(".git")).unwrap();
        let paths = vec![child.to_string_lossy().into_owned()];
        let owner = service.reserve(&nested.to_string_lossy(), "nested owner").unwrap();
        assert!(service.detach_repository(&paths, || Ok(())).is_err());
        drop(owner);
        service.detach_repository(&paths, || Ok(())).unwrap();
        assert!(service.reserve(&nested.to_string_lossy(), "nested owner").is_err());
        assert!(service.reserve(&root.to_string_lossy(), "unrelated owner").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn simultaneous_repository_detach_and_start_have_exactly_one_winner() {
        let root = fixture();
        for _ in 0..32 {
            let service = WorkspaceLifecycle::default();
            let start = Arc::new(Barrier::new(2));
            let finish = Arc::new(Barrier::new(2));
            let worker_service = service.clone();
            let (worker_start, worker_finish, worker_root) = (start.clone(), finish.clone(), root.clone());
            let worker = thread::spawn(move || {
                worker_start.wait();
                let claim = worker_service.reserve(&worker_root.to_string_lossy(), "agent");
                worker_finish.wait();
                claim.is_ok()
            });
            start.wait();
            let detached = service.detach_repository(&[root.to_string_lossy().into_owned()], || Ok(())).is_ok();
            finish.wait();
            let started = worker.join().unwrap();
            assert_ne!(detached, started);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn detached_repository_alias_stays_blocked_until_explicit_restore() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let actual = root.join("other");
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&actual, &alias).unwrap();
        service.detach_repository(&[actual.to_string_lossy().into_owned()], || Ok(())).unwrap();
        assert!(service.reserve(&alias.join(".").to_string_lossy(), "agent").is_err());
        // Failed restoration cannot partially lift an existing detached mark.
        assert!(service.restore_repository(&[alias.to_string_lossy().into_owned(), root.join("missing").to_string_lossy().into_owned()]).is_err());
        assert!(service.reserve(&alias.to_string_lossy(), "agent").is_err());
        service.restore_repository(&[alias.to_string_lossy().into_owned()]).unwrap();
        assert!(service.reserve(&actual.to_string_lossy(), "agent").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repository_activity_blocks_detach_across_child_writer_gaps() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let path = root.to_string_lossy().into_owned();
        let activity = service.begin_repository_activity(&path).unwrap();
        let worker_activity = activity.clone();
        let writer = service.reserve(&path, "verification runner").unwrap();
        drop(writer);
        assert!(service.detach_repository(&[path.clone()], || Ok(())).is_err());
        drop(activity);
        assert!(service.detach_repository(&[path.clone()], || Ok(())).is_err());
        drop(worker_activity);
        service.detach_repository(&[path.clone()], || Ok(())).unwrap();
        assert!(service.begin_repository_activity(&path).is_err());
        service.restore_repository(&[path.clone()]).unwrap();
        assert!(service.begin_repository_activity(&path).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_shutdown_deadline_includes_waiting_for_the_lifecycle_lock() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let target = identity(root.to_str().unwrap()).unwrap();
        let held = service.0.lock().unwrap();
        let worker = service.clone();
        let (started, ready) = std::sync::mpsc::channel();
        let (send, receive) = std::sync::mpsc::channel();
        let job = thread::spawn(move || {
            started.send(()).unwrap();
            let result = crate::execution::TerminalManager::default().stop_workspace_terminals(
                &target, &worker, std::time::Duration::from_millis(30));
            let _ = send.send(result);
        });
        ready.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        let result = receive.recv_timeout(std::time::Duration::from_millis(200));
        drop(held);
        job.join().unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(matches!(result, Ok(Err(_))), "a held lifecycle lock must not outlive the shutdown deadline");
    }

    #[test]
    fn competing_starts_have_exactly_one_owner_even_with_same_owner_label() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let start = Arc::new(Barrier::new(9));
        let finish = Arc::new(Barrier::new(9));
        let jobs: Vec<_> = (0..8)
            .map(|_| {
                let (service, root, start, finish) =
                    (service.clone(), root.clone(), start.clone(), finish.clone());
                thread::spawn(move || {
                    start.wait();
                    let claim = service.reserve(root.to_str().unwrap(), "agent");
                    finish.wait();
                    claim
                })
            })
            .collect();
        start.wait();
        finish.wait();
        let results: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
        assert_eq!(
            results.iter().filter(|result| result.is_ok()).count(),
            1,
            "{results:?}"
        );
        drop(results);
        assert!(!service.is_reserved(root.to_str().unwrap()).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn simultaneous_start_and_removal_have_exactly_one_winner() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        for _ in 0..32 {
            let start = Arc::new(Barrier::new(3));
            let finish = Arc::new(Barrier::new(3));
            let jobs: Vec<_> = [false, true]
                .into_iter()
                .map(|remove| {
                    let (service, root, start, finish) =
                        (service.clone(), root.clone(), start.clone(), finish.clone());
                    thread::spawn(move || {
                        start.wait();
                        let claim = if remove {
                            service.begin_removal(root.to_str().unwrap())
                        } else {
                            service.reserve(root.to_str().unwrap(), "agent startup")
                        };
                        finish.wait();
                        claim
                    })
                })
                .collect();
            start.wait();
            finish.wait();
            let claims: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
            assert_eq!(claims.iter().filter(|claim| claim.is_ok()).count(), 1);
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn startup_and_removal_exclude_each_other_until_their_claim_drops() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let path = root.to_str().unwrap();
        let startup = service.reserve_terminal(path).unwrap();
        assert!(service.begin_removal(path).is_err());
        drop(startup);
        let removal = service.begin_removal(path).unwrap();
        assert!(service.reserve(path, "agent startup").is_err());
        drop(removal);
        assert!(service.reserve(path, "agent startup").is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stopping_retains_claim_until_observed_exit_releases_runtime_entry() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let path = root.to_str().unwrap();
        let runtime = Arc::new(service.reserve(path, "process").unwrap());
        let observer = runtime.clone();
        drop(runtime);
        assert!(service.is_reserved(path).unwrap());
        assert!(service.begin_removal(path).is_err());
        drop(observer);
        assert!(service.begin_removal(path).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn independent_workspaces_can_run_concurrently() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let _first = service.reserve(root.to_str().unwrap(), "build").unwrap();
        let _second = service
            .reserve(root.join("other").to_str().unwrap(), "build")
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_workspace_and_empty_owner_fail_closed() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        assert!(service
            .reserve(root.join("absent").to_str().unwrap(), "agent")
            .is_err());
        assert!(service.reserve(root.to_str().unwrap(), " ").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn subdirectory_writers_block_removal_of_their_git_worktree() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        fs::create_dir(root.join(".git")).unwrap();
        let _claim = service
            .reserve_terminal(root.join("other").to_str().unwrap())
            .unwrap();
        assert!(service.begin_removal(root.to_str().unwrap()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn creation_reserves_a_missing_target_through_registration() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let target = root.join("future/工作 tree");
        let path = target.to_str().unwrap();
        let claim = service.reserve_creation(path, "worktree creation").unwrap();
        assert!(service
            .reserve_creation(path, "competing creation")
            .is_err());
        fs::create_dir_all(&target).unwrap();
        assert!(service.reserve_terminal(path).is_err());
        assert!(service.begin_removal(path).is_err());
        drop(claim);
        assert!(service.reserve_terminal(path).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn creation_dot_alias_keeps_the_same_identity_when_target_appears() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let target = root.join("future");
        let dotted = target.join(".");
        let _claim = service
            .reserve_creation(dotted.to_str().unwrap(), "create")
            .unwrap();
        assert!(service
            .reserve_creation(target.to_str().unwrap(), "competing create")
            .is_err());
        fs::create_dir(&target).unwrap();
        assert!(service
            .reserve(target.to_str().unwrap(), "terminal startup")
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn creation_rejects_parent_traversal_and_existing_targets() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        assert!(service
            .reserve_creation(root.to_str().unwrap(), "create")
            .is_err());
        assert!(service
            .reserve_creation(root.join("absent/../escape").to_str().unwrap(), "create")
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlink_and_dot_aliases_share_the_same_claim() {
        let service = WorkspaceLifecycle::default();
        let root = fixture();
        let alias = root.join("alias");
        std::os::unix::fs::symlink(root.join("other"), &alias).unwrap();
        let _claim = service.reserve(alias.to_str().unwrap(), "agent").unwrap();
        assert!(service
            .reserve(root.join("other/.").to_str().unwrap(), "process")
            .is_err());
        assert!(service
            .begin_removal(root.join("other").to_str().unwrap())
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
