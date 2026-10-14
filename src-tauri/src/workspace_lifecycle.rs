//! Native worktree lifecycle reservations. The UI is not an authority for
//! whether a process may start in a directory being removed/unregistered.
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct LifecycleState {
    starting: HashMap<String, usize>,
    retiring: HashSet<String>,
    detached: HashSet<String>,
}

#[derive(Clone, Default)]
pub struct WorkspaceLifecycle {
    state: Arc<Mutex<LifecycleState>>,
}

fn identity(path: &str) -> String {
    crate::workspace_identity::key(path)
}

fn overlaps(a: &str, b: &str) -> bool {
    crate::workspace_identity::contains_key(a, b)
        || crate::workspace_identity::contains_key(b, a)
}

/// Blocks removal while an OS/process reservation is still being installed.
pub struct StartupLease {
    state: Arc<Mutex<LifecycleState>>,
    path: String,
}
impl Drop for StartupLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(count) = state.starting.get_mut(&self.path) {
                *count = count.saturating_sub(1);
                if *count == 0 { state.starting.remove(&self.path); }
            }
        }
    }
}

/// Prevents new native work under these paths while existing owner checks
/// run, then either commits the permanent UI detach or automatically rolls
/// back (e.g. failed confirmation, active PTY, Git error).
pub struct RetirementLease {
    state: Arc<Mutex<LifecycleState>>,
    paths: Vec<String>,
    committed: bool,
}
impl RetirementLease {
    pub fn commit_detach(&mut self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "Workspace lifecycle lock poisoned")?;
        for path in &self.paths {
            state.retiring.remove(path);
            state.detached.insert(path.clone());
        }
        self.committed = true;
        Ok(())
    }
}
impl Drop for RetirementLease {
    fn drop(&mut self) {
        if !self.committed {
            if let Ok(mut state) = self.state.lock() {
                for path in &self.paths { state.retiring.remove(path); }
            }
        }
    }
}

impl WorkspaceLifecycle {
    pub fn begin_start(&self, path: &str) -> Result<StartupLease, String> {
        let path = identity(path);
        let mut state = self.state.lock().map_err(|_| "Workspace lifecycle lock poisoned")?;
        if state.retiring.iter().any(|root| overlaps(root, &path))
            || state.detached.iter().any(|root| crate::workspace_identity::contains_key(root, &path)) {
            return Err("Workspace is being removed or was detached. Re-add the repository before starting native work.".into());
        }
        *state.starting.entry(path.clone()).or_default() += 1;
        Ok(StartupLease { state: self.state.clone(), path })
    }

    pub fn begin_retirement(&self, roots: &[String]) -> Result<RetirementLease, String> {
        if roots.is_empty() { return Err("Cannot retire an empty worktree inventory".into()); }
        let mut paths = roots.iter().map(|p| identity(p)).collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        let mut state = self.state.lock().map_err(|_| "Workspace lifecycle lock poisoned")?;
        for path in &paths {
            if state.retiring.iter().any(|root| overlaps(root, path)) || state.detached.contains(path) {
                return Err("Workspace is already being removed or detached".into());
            }
            if state.starting.iter().any(|(root, count)| *count > 0 && overlaps(root, path)) {
                return Err("Workspace has a native process startup in progress. Retry after it finishes.".into());
            }
        }
        state.retiring.extend(paths.iter().cloned());
        Ok(RetirementLease { state: self.state.clone(), paths, committed: false })
    }

    /// Called only after Git has validated the same repository inventory.
    /// A re-import unblocks paths detached in this running application.
    pub fn restore_repository(&self, roots: &[String]) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "Workspace lifecycle lock poisoned")?;
        for path in roots {
            let key = identity(path);
            if state.retiring.iter().any(|root| overlaps(root, &key)) {
                return Err("Cannot re-import a repository during an incomplete worktree removal".into());
            }
        }
        for path in roots { state.detached.remove(&identity(path)); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retirement_worker_keeps_lease_after_waiter_cancellation() {
        use std::{sync::mpsc, time::Duration};
        let state = WorkspaceLifecycle::default();
        let worker_state = state.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (finish_tx, finish_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let waiter = tauri::async_runtime::spawn(async move {
            tauri::async_runtime::spawn_blocking(move || {
                let lease = worker_state.begin_retirement(&["/repo/worktree".into()]).unwrap();
                started_tx.send(()).unwrap();
                let _ = finish_rx.recv_timeout(Duration::from_secs(5));
                drop(lease);
                done_tx.send(()).unwrap();
            }).await
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        waiter.abort();
        assert!(tauri::async_runtime::block_on(waiter).is_err());
        let blocked = state.begin_start("/repo/worktree/build").is_err();
        finish_tx.send(()).unwrap();
        done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(blocked, "Cancelling a waiter must not unlock a running worker");
        assert!(state.begin_start("/repo/worktree/build").is_ok());
    }

    #[test]
    fn descendant_startup_blocks_parent_retirement_without_blocking_siblings() {
        let state = WorkspaceLifecycle::default();
        let _start = state.begin_start("/repo/worktree/build/output").unwrap();
        assert!(state.begin_retirement(&["/repo/worktree".into()]).is_err());
        assert!(state.begin_retirement(&["/repo/worktree-other".into()]).is_ok());
    }

    #[test]
    fn retirement_and_detach_block_descendant_starts_until_restore() {
        let state = WorkspaceLifecycle::default();
        let roots = vec!["/repo/worktree".into()];
        let mut retirement = state.begin_retirement(&roots).unwrap();
        assert!(state.begin_start("/repo/worktree/build").is_err());
        assert!(state.begin_start("/repo/worktree-other/build").is_ok());
        retirement.commit_detach().unwrap();
        drop(retirement);
        assert!(state.begin_start("/repo/worktree/build").is_err());
        state.restore_repository(&roots).unwrap();
        assert!(state.begin_start("/repo/worktree/build").is_ok());
    }

    #[test]
    fn overlapping_retirements_cannot_release_each_others_reservation() {
        let state = WorkspaceLifecycle::default();
        let _retirement = state.begin_retirement(&["/repo/worktree/build".into()]).unwrap();
        assert!(state.begin_retirement(&["/repo/worktree".into()]).is_err());
        assert!(state.restore_repository(&["/repo/worktree".into()]).is_err());
    }

    #[test]
    fn start_and_delete_reservations_are_mutually_exclusive() {
        let state = WorkspaceLifecycle::default();
        let start = state.begin_start("/repo/worktree").unwrap();
        assert!(state.begin_retirement(&["/repo/worktree".into()]).is_err());
        drop(start);
        let retiring = state.begin_retirement(&["/repo/worktree".into()]).unwrap();
        assert!(state.begin_start("/repo/worktree").is_err());
        drop(retiring);
        assert!(state.begin_start("/repo/worktree").is_ok());
    }

    #[test]
    fn failed_repository_detach_rolls_back_every_workspace() {
        let state = WorkspaceLifecycle::default();
        let roots = vec!["/repo/a".into(), "/repo/b".into()];
        let running = state.begin_start("/repo/b").unwrap();
        assert!(state.begin_retirement(&roots).is_err());
        assert!(state.begin_start("/repo/a").is_ok(), "Retirement must be atomic");
        drop(running);
        let _guard = state.begin_retirement(&roots).unwrap();
        assert!(state.begin_start("/repo/a").is_err());
        assert!(state.begin_start("/repo/b").is_err());
    }

    #[test]
    fn committed_detach_blocks_future_work_until_repo_reimport() {
        let state = WorkspaceLifecycle::default();
        let roots = vec!["/repo/a".into(), "/repo/b".into()];
        let mut lease = state.begin_retirement(&roots).unwrap();
        lease.commit_detach().unwrap();
        drop(lease);
        assert!(state.begin_start("/repo/a").is_err());
        assert!(state.begin_start("/repo/b").is_err());
        state.restore_repository(&roots).unwrap();
        assert!(state.begin_start("/repo/a").is_ok());
        assert!(state.begin_start("/repo/b").is_ok());
    }

    #[test]
    fn path_identity_follows_host_case_rules() {
        let state = WorkspaceLifecycle::default();
        #[cfg(unix)] {
            let _guard = state.begin_start("/repo/Alpha").unwrap();
            assert!(state.begin_retirement(&["/repo/alpha".into()]).is_ok());
            assert!(state.begin_retirement(&["/repo/Alpha".into()]).is_err());
        }
        #[cfg(windows)] {
            let _guard = state.begin_start("C:\\Repos\\Feature").unwrap();
            assert!(state.begin_retirement(&["c:/repos/feature".into()]).is_err());
        }
    }
}
