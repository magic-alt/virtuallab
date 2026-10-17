//! Atomic workspace writer/removal reservations. This is not an OS sandbox.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Default, Debug)]
pub struct WorkspaceLifecycle(Arc<Mutex<HashMap<PathBuf, String>>>);

/// A unique, non-cloneable claim. Keep it in the runtime until process-tree
/// exit is observed; requesting cancellation does not release ownership.
#[derive(Debug)]
pub struct WorkspaceReservation {
    lifecycle: WorkspaceLifecycle,
    key: PathBuf,
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
    pub fn reserve(&self, root: &str, owner: &str) -> Result<WorkspaceReservation, String> {
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
        if let Some(current) = claims.get(&key) {
            return Err(format!(
                "Workspace is reserved by {current}; wait for observed completion."
            ));
        }
        claims.insert(key.clone(), owner.to_owned());
        Ok(WorkspaceReservation {
            lifecycle: self.clone(),
            key,
        })
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
        if let Some(current) = claims.get(&key) {
            return Err(format!("Workspace is reserved by {current}"));
        }
        claims.insert(key.clone(), owner.to_owned());
        Ok(WorkspaceReservation {
            lifecycle: self.clone(),
            key,
        })
    }

    pub fn begin_removal(&self, root: &str) -> Result<WorkspaceReservation, String> {
        self.reserve(root, "worktree removal")
    }

    pub fn is_reserved(&self, root: &str) -> Result<bool, String> {
        let claims = self
            .0
            .lock()
            .map_err(|_| "Workspace lifecycle lock poisoned")?;
        Ok(claims.contains_key(&identity(root)?))
    }
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
        claims.remove(&self.key);
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
        let startup = service.reserve(path, "terminal startup").unwrap();
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
            .reserve(root.join("other").to_str().unwrap(), "terminal")
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
        assert!(service.reserve(path, "terminal").is_err());
        assert!(service.begin_removal(path).is_err());
        drop(claim);
        assert!(service.reserve(path, "terminal").is_ok());
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
