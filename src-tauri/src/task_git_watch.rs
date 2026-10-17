//! Git identity observation for normal and linked task worktrees.
//!
//! Resolve through the existing sanitized, read-only Git adapter, register every
//! target and revalidate the plan BEFORE sampling the run's initial inputs, then pass every notify result
//! to `invalidates`. Keep the caller's invalidation sticky for the entire Run.
//! Access notifications and lock-only activity are not identity changes. Atomic
//! replacement of an identity file (including index.lock -> index) is a change.
//! This module neither executes commands nor mutates repository state.
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Debug)]
pub(crate) struct WatchTarget {
    pub path: PathBuf,
    pub mode: RecursiveMode,
}

#[derive(Clone, Debug)]
pub(crate) struct GitWatchPlan {
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    exact: BTreeSet<PathBuf>,
    trees: BTreeSet<PathBuf>,
    targets: Vec<WatchTarget>,
}

impl GitWatchPlan {
    /// `git` receives only structured, read-only rev-parse argv. The caller must
    /// bind it to this workspace and use the repository-neutral sanitized adapter.
    pub(crate) fn resolve(
        workspace: &Path,
        mut git: impl FnMut(&[&str]) -> Result<String, String>,
    ) -> Result<Self, String> {
        let workspace = fs::canonicalize(workspace)
            .map_err(|e| format!("Git watch workspace unavailable: {e}"))?;
        let git_dir = resolved_path(&git(&["rev-parse", "--path-format=absolute", "--git-dir"])?)?;
        let common_dir = resolved_path(&git(&[
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ])?)?;
        if !git_dir.is_dir() || !common_dir.is_dir() {
            return Err("Git watch metadata roots must be existing directories".into());
        }
        let mut exact = BTreeSet::new();
        exact.insert(workspace.join(".git")); // linked-worktree pointer (or main metadata directory)
        for name in [
            "HEAD",
            "index",
            "config.worktree",
            "commondir",
            "gitdir",
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "BISECT_HEAD",
            "AUTO_MERGE",
        ] {
            exact.insert(git_dir.join(name));
        }
        for name in [
            "config",
            "packed-refs",
            "shallow",
            "info/grafts",
            "info/attributes",
            "objects/info/alternates",
            "objects/info/http-alternates",
        ] {
            exact.insert(common_dir.join(name));
        }
        // Git routes these differently when a linked worktree uses per-worktree config.
        for name in ["info/sparse-checkout", "shallow", "packed-refs"] {
            exact.insert(resolved_path(&git(&[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                name,
            ])?)?);
        }
        // Follow every loose symbolic-ref hop, not just the final branch. Packed
        // refs have no loose file today, but its future creation must be watched.
        let mut path = git_dir.join("HEAD");
        let mut visited = BTreeSet::new();
        for depth in 0..=16 {
            if depth == 16 || !visited.insert(path.clone()) {
                return Err("Git symbolic-ref chain is cyclic or exceeds the watch bound".into());
            }
            exact.insert(path.clone());
            let Some(text) = read_identity(&path)? else {
                break;
            };
            let Some(reference) = text.trim_end_matches(['\r', '\n']).strip_prefix("ref: ") else {
                break;
            };
            validate_ref(reference)?;
            path = resolved_path(&git(&[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                reference,
            ])?)?;
        }
        let trees = BTreeSet::from([
            common_dir.join("refs/replace"),
            common_dir.join("reftable"),
            git_dir.join("reftable"),
        ]);
        let mut targets = BTreeMap::<PathBuf, bool>::new();
        for path in &exact {
            // Creation of an intermediate directory invalidates immediately;
            // no recursive scan of the object database is necessary.
            let parent = path.parent().ok_or("Git identity path has no parent")?;
            targets.entry(existing_directory(parent)?).or_insert(false);
        }
        for path in &trees {
            let parent = path.parent().ok_or("Git ref tree has no parent")?;
            targets.entry(existing_directory(parent)?).or_insert(false);
            match fs::symlink_metadata(path) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                    targets.insert(path.clone(), true);
                }
                Ok(_) => return Err("Git identity tree must be a regular directory".into()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Cannot inspect Git identity tree: {e}")),
            }
        }
        // Split indexes can reference sharedindex.<hash> in either metadata root.
        for dir in [&git_dir, &common_dir] {
            targets.entry(dir.clone()).or_insert(false);
        }
        let targets = targets
            .into_iter()
            .map(|(path, recursive)| WatchTarget {
                path,
                mode: if recursive {
                    RecursiveMode::Recursive
                } else {
                    RecursiveMode::NonRecursive
                },
            })
            .collect();
        Ok(Self {
            git_dir,
            common_dir,
            exact,
            trees,
            targets,
        })
    }

    /// Close the resolve/register window. Call after all targets are registered
    /// and before the first source/provenance sample. A changed routing or symbolic
    /// ref chain requires a fresh plan, never silently extending an active Run.
    pub(crate) fn revalidate(
        &self,
        workspace: &Path,
        git: impl FnMut(&[&str]) -> Result<String, String>,
    ) -> Result<(), String> {
        let current = Self::resolve(workspace, git)?;
        if self.git_dir != current.git_dir
            || self.common_dir != current.common_dir
            || self.exact != current.exact
            || self.trees != current.trees
        {
            return Err(
                "Git identity routing changed during watch registration; resolve a fresh plan"
                    .into(),
            );
        }
        Ok(())
    }

    pub(crate) fn targets(&self) -> &[WatchTarget] {
        &self.targets
    }

    /// Errors, event-stream overflow/rescan, and unlocated mutation events fail
    /// closed. Inspect BOTH rename paths: a lock file renamed onto index is real.
    /// Other branches, objects, reflogs and lock-only events cannot invalidate.
    pub(crate) fn invalidates(&self, event: &notify::Result<Event>) -> bool {
        let Ok(event) = event else {
            return true;
        };
        if event.need_rescan() {
            return true;
        }
        if matches!(event.kind, EventKind::Access(_)) {
            return false;
        }
        if event.paths.is_empty() {
            return true;
        }
        let is_identity_ancestor = |path: &Path| {
            self.exact
                .iter()
                .chain(self.trees.iter())
                .any(|known| known.starts_with(path))
        };
        let is_lock = |path: &Path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".lock"))
        };
        event.paths.iter().any(|raw| {
            // inotify may deliver a queued Create/Modify after the lock was
            // removed. Do not stat/canonicalize a known lock-only path: deletion
            // between those syscalls is normal noise, not loss of observation.
            // A metadata root itself may be named *.lock; its descendants must
            // remain protected. Each rename path is evaluated independently.
            if is_lock(raw)
                && raw.is_absolute()
                && !raw
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
                && (raw.starts_with(&self.git_dir) || raw.starts_with(&self.common_dir))
                && !is_identity_ancestor(raw)
            {
                return false;
            }
            let Ok(path) = normalize_path(raw) else {
                return true;
            };
            let direct = self.exact.contains(&path)
                || self.trees.iter().any(|tree| path.starts_with(tree))
                || path
                    .parent()
                    .is_some_and(|parent| parent == self.git_dir || parent == self.common_dir)
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("sharedindex."));
            // Metadata timestamps/permissions alone are not content changes.
            if matches!(
                event.kind,
                EventKind::Modify(notify::event::ModifyKind::Metadata(_))
            ) {
                return false;
            }
            // Retain filtering after canonicalization for aliased paths, while
            // never ignoring deletion/rename of a real metadata ancestor.
            if is_lock(&path) && !is_identity_ancestor(&path) {
                return false;
            }
            if direct {
                return true;
            }
            // A newly created parent can hide later descendant writes from a
            // nonrecursive watcher. Windows reports creation as Create(Any), so
            // do not require a Folder hint. Removal/rename also breaks continuity.
            // Generic/coalesced directory changes must fail closed as well.
            if matches!(
                event.kind,
                EventKind::Create(_)
                    | EventKind::Remove(_)
                    | EventKind::Modify(notify::event::ModifyKind::Name(_))
                    | EventKind::Any
                    | EventKind::Other
            ) {
                return self
                    .exact
                    .iter()
                    .chain(self.trees.iter())
                    .any(|known| known.starts_with(&path));
            }
            false
        })
    }
}

fn resolved_path(output: &str) -> Result<PathBuf, String> {
    let value = output.trim_end_matches(['\r', '\n']);
    if value.is_empty() || value.len() > 16384 || value.chars().any(char::is_control) {
        return Err("Invalid Git watch identity path".into());
    }
    normalize_path(Path::new(value))
}

// Resolve existing ancestors rather than requiring the changed file to exist:
// remove/rename events and future loose refs must use the same canonical spelling.
fn normalize_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Git watch paths must be absolute without parent traversal".into());
    }
    let mut ancestor = path;
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("Git identity path became a symlink".into())
            }
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .ok_or("Git watch ancestor unavailable")?
                        .to_os_string(),
                );
                ancestor = ancestor.parent().ok_or("Git watch ancestor unavailable")?;
            }
            Err(e) => return Err(format!("Git watch identity unavailable: {e}")),
        }
    }
    let mut normalized =
        fs::canonicalize(ancestor).map_err(|e| format!("Git watch path unavailable: {e}"))?;
    for part in missing.into_iter().rev() {
        normalized.push(part);
    }
    Ok(normalized)
}

fn existing_directory(path: &Path) -> Result<PathBuf, String> {
    let mut candidate = path;
    loop {
        match fs::metadata(candidate) {
            Ok(meta) if meta.is_dir() => return Ok(candidate.to_path_buf()),
            Ok(_) => return Err("Git metadata observation parent is not a directory".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                candidate = candidate
                    .parent()
                    .ok_or("Git metadata parent unavailable")?
            }
            Err(e) => return Err(format!("Cannot inspect Git observation parent: {e}")),
        }
    }
}

fn read_identity(path: &Path) -> Result<Option<String>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot inspect Git symbolic identity: {e}")),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 16384 {
        return Err("Git symbolic identity must be a bounded regular file".into());
    }
    let mut text = String::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(16385)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() > 16384 {
        return Err("Git symbolic identity exceeds the observation bound".into());
    }
    Ok(Some(text))
}

fn validate_ref(reference: &str) -> Result<(), String> {
    if !reference.starts_with("refs/")
        || reference.len() > 4096
        || reference
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "\\:~^?*[".contains(c))
        || reference.contains("..")
        || reference.contains("@{")
        || reference.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || part.ends_with('.')
                || part.ends_with(".lock")
        })
    {
        return Err("Unsupported Git symbolic reference identity".into());
    }
    Ok(())
}

/// Optional standalone sticky state. The runtime may instead call `invalidates`
/// directly and reuse its existing live flag plus durable invalidation marker.
#[derive(Default)]
#[allow(dead_code)] // Optional standalone observer; runtime uses its durable sticky state.
pub(crate) struct GitWatchState {
    changed: AtomicBool,
}
#[allow(dead_code)]
impl GitWatchState {
    pub(crate) fn observe(&self, plan: &GitWatchPlan, event: &notify::Result<Event>) -> bool {
        if plan.invalidates(event) {
            self.changed.store(true, Ordering::Release);
        }
        self.changed()
    }
    pub(crate) fn changed(&self) -> bool {
        self.changed.load(Ordering::Acquire)
    }
    pub(crate) fn register(
        &self,
        plan: &GitWatchPlan,
        watcher: &mut impl Watcher,
    ) -> Result<(), String> {
        for target in plan.targets() {
            if let Err(error) = watcher.watch(&target.path, target.mode) {
                self.changed.store(true, Ordering::Release);
                return Err(format!("Cannot observe Git identity: {error}"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::{
        event::{AccessKind, AccessMode, CreateKind, DataChange, ModifyKind, RenameMode},
        EventKind,
    };
    use std::{
        fs,
        process::{Command, Stdio},
        sync::{atomic::AtomicU64, Arc},
        time::{Duration, Instant},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        base: PathBuf,
        repo: PathBuf,
        lane: PathBuf,
    }
    fn git(root: &Path, args: &[&str]) -> Result<String, String> {
        let mut cmd = Command::new("git");
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                cmd.env_remove(key);
            }
        }
        let out = cmd
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args([
                "--no-optional-locks",
                "-c",
                "commit.gpgSign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .current_dir(root)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        String::from_utf8(out.stdout).map_err(|e| e.to_string())
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "vl-git-watch-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let repo = base.join("仓库 with spaces");
            let lane = base.join("linked 工作区");
            fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init", "--initial-branch=main"]).unwrap();
            git(&repo, &["config", "user.name", "Watch fixture"]).unwrap();
            git(&repo, &["config", "user.email", "fixture@example.invalid"]).unwrap();
            fs::write(repo.join("source.txt"), "source\n").unwrap();
            git(&repo, &["add", "source.txt"]).unwrap();
            git(&repo, &["commit", "-m", "base"]).unwrap();
            git(
                &repo,
                &[
                    "worktree",
                    "add",
                    "-b",
                    "task/topic",
                    lane.to_str().unwrap(),
                ],
            )
            .unwrap();
            Self { base, repo, lane }
        }
        fn plan(&self) -> GitWatchPlan {
            GitWatchPlan::resolve(&self.lane, |args| git(&self.lane, args)).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    fn event(kind: EventKind, paths: &[PathBuf]) -> notify::Result<Event> {
        Ok(paths
            .iter()
            .fold(Event::new(kind), |e, p| e.add_path(p.clone())))
    }
    fn write(path: PathBuf) -> notify::Result<Event> {
        event(
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            &[path],
        )
    }
    #[test]
    fn resolves_linked_metadata_and_observes_current_ref_outside_workspace() {
        let f = Fixture::new();
        let p = f.plan();
        assert_eq!(p.common_dir, fs::canonicalize(f.repo.join(".git")).unwrap());
        assert_ne!(p.git_dir, p.common_dir);
        assert!(!p.git_dir.starts_with(&f.lane));
        for path in [
            p.git_dir.join("HEAD"),
            p.git_dir.join("index"),
            p.common_dir.join("refs/heads/task/topic"),
            p.common_dir.join("packed-refs"),
            p.common_dir.join("config"),
            p.common_dir.join("shallow"),
            p.git_dir.join("config.worktree"),
            p.git_dir.join("commondir"),
            f.lane.join(".git"),
        ] {
            assert!(
                p.invalidates(&write(path.clone())),
                "missing identity path {path:?}"
            );
        }
        assert!(!p.targets().is_empty());
    }
    #[test]
    fn ignores_access_lock_logs_objects_and_unrelated_branch_noise() {
        let f = Fixture::new();
        let p = f.plan();
        for kind in [
            AccessKind::Read,
            AccessKind::Open(AccessMode::Read),
            AccessKind::Close(AccessMode::Write),
            AccessKind::Any,
        ] {
            assert!(!p.invalidates(&event(EventKind::Access(kind), &[p.git_dir.join("index")])));
        }
        for path in [
            p.git_dir.join("index.lock"),
            p.common_dir.join("config.lock"),
            p.common_dir.join("refs/heads/task/topic.lock"),
            p.git_dir.join("logs/HEAD"),
            p.common_dir.join("objects/ab/object"),
            p.common_dir.join("refs/heads/unrelated"),
        ] {
            assert!(!p.invalidates(&write(path.clone())), "noise {path:?}");
        }
    }
    #[test]
    fn rename_to_identity_and_parent_removal_invalidate_but_lock_only_rename_does_not() {
        let f = Fixture::new();
        let p = f.plan();
        let rename = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        assert!(p.invalidates(&event(
            rename,
            &[p.git_dir.join("index.lock"), p.git_dir.join("index")]
        )));
        assert!(!p.invalidates(&event(
            rename,
            &[
                p.git_dir.join("index.lock"),
                p.git_dir.join("index.lock.old")
            ]
        )));
        assert!(p.invalidates(&event(
            EventKind::Remove(notify::event::RemoveKind::Folder),
            &[p.common_dir.join("refs/heads/task")]
        )));
    }
    #[test]
    fn detached_and_packed_heads_remain_observable() {
        let f = Fixture::new();
        git(&f.repo, &["pack-refs", "--all"]).unwrap();
        let p = f.plan();
        assert!(p.invalidates(&write(p.common_dir.join("refs/heads/task/topic"))));
        git(&f.lane, &["checkout", "--detach"]).unwrap();
        let p = f.plan();
        assert!(p.invalidates(&write(p.git_dir.join("HEAD"))));
        assert!(p.invalidates(&write(p.common_dir.join("packed-refs"))));
    }
    #[test]
    fn errors_and_rescan_are_sticky_even_after_access_noise() {
        let f = Fixture::new();
        let p = f.plan();
        let state = GitWatchState::default();
        assert!(state.observe(&p, &Err(notify::Error::generic("watch lost"))));
        assert!(state.observe(
            &p,
            &event(
                EventKind::Access(AccessKind::Read),
                &[p.git_dir.join("HEAD")]
            )
        ));
        let mut rescan = Event::new(EventKind::Other);
        rescan.attrs.set_flag(notify::event::Flag::Rescan);
        assert!(p.invalidates(&Ok(rescan)));
        assert!(p.invalidates(&event(EventKind::Modify(ModifyKind::Any), &[])));
    }
    #[test]
    fn missing_registration_fails_closed() {
        let f = Fixture::new();
        let p = f.plan();
        let state = GitWatchState::default();
        let mut watcher = notify::recommended_watcher(|_| {}).unwrap();
        fs::remove_dir_all(&f.base).unwrap();
        assert!(state.register(&p, &mut watcher).is_err());
        assert!(state.changed());
    }
    #[test]
    fn real_linked_empty_commit_and_ref_restore_never_restore_watch_freshness() {
        let f = Fixture::new();
        let p = Arc::new(f.plan());
        let state = Arc::new(GitWatchState::default());
        let callback_plan = p.clone();
        let callback_state = state.clone();
        let mut watcher = notify::recommended_watcher(move |result| {
            callback_state.observe(&callback_plan, &result);
        })
        .unwrap();
        state.register(&p, &mut watcher).unwrap();
        let h = git(&f.lane, &["rev-parse", "HEAD"]).unwrap();
        git(
            &f.lane,
            &["-c", "core.preloadIndex=false", "status", "--porcelain"],
        )
        .unwrap();
        // Permit delivery of read/access events before asserting they are ignored.
        std::thread::sleep(Duration::from_millis(350));
        assert!(!state.changed(), "read-only status invalidated inputs");
        git(&f.lane, &["commit", "--allow-empty", "-m", "empty H2"]).unwrap();
        let h2 = git(&f.lane, &["rev-parse", "HEAD"]).unwrap();
        assert_ne!(h, h2);
        git(
            &f.lane,
            &["update-ref", "refs/heads/task/topic", h.trim(), h2.trim()],
        )
        .unwrap();
        assert_eq!(git(&f.lane, &["rev-parse", "HEAD"]).unwrap(), h);
        let deadline = Instant::now() + Duration::from_secs(6);
        while !state.changed() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            state.changed(),
            "H -> empty H2 -> H disappeared outside workspace watch"
        );
        assert!(state.observe(
            &p,
            &event(
                EventKind::Access(AccessKind::Read),
                &[p.git_dir.join("HEAD")]
            )
        ));
    }
    #[test]
    fn normal_repository_and_symbolic_ref_chain_are_supported() {
        let f = Fixture::new();
        let p = GitWatchPlan::resolve(&f.repo, |args| git(&f.repo, args)).unwrap();
        assert_eq!(p.git_dir, p.common_dir);
        git(
            &f.lane,
            &["symbolic-ref", "refs/heads/alias", "refs/heads/task/topic"],
        )
        .unwrap();
        git(&f.lane, &["symbolic-ref", "HEAD", "refs/heads/alias"]).unwrap();
        let p = f.plan();
        assert!(p.invalidates(&write(p.common_dir.join("refs/heads/alias"))));
        assert!(p.invalidates(&write(p.common_dir.join("refs/heads/task/topic"))));
    }
    #[test]
    fn future_refs_tree_has_creation_coverage() {
        let f = Fixture::new();
        git(&f.repo, &["pack-refs", "--all"]).unwrap();
        let p = f.plan();
        assert!(p
            .targets()
            .iter()
            .any(|t| t.path == p.common_dir.join("refs")
                || matches!(t.mode, RecursiveMode::Recursive)
                    && p.common_dir.join("refs/replace/new").starts_with(&t.path)));
        assert!(p.invalidates(&event(
            EventKind::Create(CreateKind::File),
            &[p.common_dir.join("refs/replace/new")]
        )));
    }
    #[cfg(unix)]
    #[test]
    fn symlink_replacement_of_identity_fails_closed() {
        let f = Fixture::new();
        let p = f.plan();
        let head = p.git_dir.join("HEAD");
        let outside = f.base.join("outside-head");
        fs::write(&outside, "ref: refs/heads/task/topic\n").unwrap();
        fs::remove_file(&head).unwrap();
        std::os::unix::fs::symlink(&outside, &head).unwrap();
        assert!(
            p.invalidates(&write(head)),
            "identity symlink replacement escaped filter"
        );
    }
    #[test]
    fn metadata_roots_never_require_recursive_object_database_watch() {
        let f = Fixture::new();
        let p = f.plan();
        assert!(
            !p.targets()
                .iter()
                .any(|t| t.path == p.common_dir && matches!(t.mode, RecursiveMode::Recursive)),
            "watching common root recursively includes the entire object database"
        );
        assert!(p.invalidates(&event(
            EventKind::Create(CreateKind::Folder),
            &[p.common_dir.join("refs/replace")]
        )));
    }
    #[test]
    fn real_packed_branch_ref_round_trip_without_index_events_is_sticky() {
        let f = Fixture::new();
        let h = git(&f.lane, &["rev-parse", "HEAD"]).unwrap();
        git(&f.lane, &["commit", "--allow-empty", "-m", "empty H2"]).unwrap();
        let h2 = git(&f.lane, &["rev-parse", "HEAD"]).unwrap();
        git(
            &f.lane,
            &["update-ref", "refs/heads/task/topic", h.trim(), h2.trim()],
        )
        .unwrap();
        git(&f.repo, &["pack-refs", "--all"]).unwrap();
        let p = Arc::new(f.plan());
        let state = Arc::new(GitWatchState::default());
        let cp = p.clone();
        let cs = state.clone();
        let mut watcher = notify::recommended_watcher(move |e| {
            cs.observe(&cp, &e);
        })
        .unwrap();
        state.register(&p, &mut watcher).unwrap();
        git(
            &f.lane,
            &["update-ref", "refs/heads/task/topic", h2.trim(), h.trim()],
        )
        .unwrap();
        git(
            &f.lane,
            &["update-ref", "refs/heads/task/topic", h.trim(), h2.trim()],
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(6);
        while !state.changed() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(git(&f.lane, &["rev-parse", "HEAD"]).unwrap(), h);
        assert!(
            state.changed(),
            "current ref changes vanished without any index writes"
        );
    }
    #[test]
    fn same_sha_branch_switch_during_registration_requires_a_new_plan() {
        let f = Fixture::new();
        let p = f.plan();
        git(&f.lane, &["branch", "new-branch"]).unwrap();
        git(&f.lane, &["symbolic-ref", "HEAD", "refs/heads/new-branch"]).unwrap();
        assert!(p.revalidate(&f.lane, |args| git(&f.lane, args)).is_err());
        let new = f.plan();
        assert!(new.revalidate(&f.lane, |args| git(&f.lane, args)).is_ok());
    }
    #[test]
    fn real_index_lock_only_activity_is_not_an_identity_change() {
        let f = Fixture::new();
        let p = Arc::new(f.plan());
        let state = Arc::new(GitWatchState::default());
        let cp = p.clone();
        let cs = state.clone();
        let mut watcher = notify::recommended_watcher(move |e| {
            cs.observe(&cp, &e);
        })
        .unwrap();
        state.register(&p, &mut watcher).unwrap();
        fs::write(p.git_dir.join("index.lock"), "lock noise").unwrap();
        fs::remove_file(p.git_dir.join("index.lock")).unwrap();
        fs::write(
            p.common_dir.join("refs/heads/task/topic.lock"),
            "lock noise",
        )
        .unwrap();
        fs::remove_file(p.common_dir.join("refs/heads/task/topic.lock")).unwrap();
        std::thread::sleep(Duration::from_millis(350));
        assert!(
            !state.changed(),
            "lock-only write triggered sticky invalidation"
        );
        fs::write(f.lane.join("source.txt"), "staged source\n").unwrap();
        git(&f.lane, &["add", "source.txt"]).unwrap();
        let deadline = Instant::now() + Duration::from_secs(6);
        while !state.changed() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(state.changed(), "real staged index replacement was ignored");
    }
    #[cfg(unix)]
    #[test]
    fn lock_only_events_do_not_require_successful_filesystem_normalization() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let p = f.plan();
        let lock = p.git_dir.join("index.lock");
        // A queued lock event can outlive its file. A dangling lock symlink gives
        // a deterministic normalization failure instead of relying on a delete
        // racing the callback's metadata -> canonicalize syscalls.
        symlink(f.base.join("already-removed-lock-target"), &lock).unwrap();
        assert!(normalize_path(&lock).is_err());
        for kind in [
            EventKind::Create(CreateKind::File),
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            EventKind::Remove(notify::event::RemoveKind::File),
        ] {
            assert!(
                !p.invalidates(&event(kind, &[lock.clone()])),
                "lock-only {kind:?} must not consult transient filesystem state"
            );
        }
        // A mixed event must inspect the destination even when its source lock
        // is unresolvable. Renaming a lock onto index is a real identity change.
        assert!(p.invalidates(&event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &[lock.clone(), p.git_dir.join("index")],
        )));
        let mut rescan = Event::new(EventKind::Other).add_path(lock);
        rescan.attrs.set_flag(notify::event::Flag::Rescan);
        assert!(p.invalidates(&Ok(rescan)));
        assert!(p.invalidates(&Err(notify::Error::generic("watch failed"))));
    }

    #[test]
    fn lock_named_metadata_ancestor_removal_is_not_lock_noise() {
        let f = Fixture::new();
        let lane = f.base.join("separate-workspace");
        let metadata = f.base.join("metadata.lock");
        fs::create_dir(&lane).unwrap();
        git(
            &lane,
            &[
                "init",
                "--initial-branch=main",
                "--separate-git-dir",
                metadata.to_str().unwrap(),
            ],
        )
        .unwrap();
        let p = GitWatchPlan::resolve(&lane, |args| git(&lane, args)).unwrap();
        assert_eq!(p.git_dir.file_name().unwrap(), "metadata.lock");
        for kind in [
            EventKind::Remove(notify::event::RemoveKind::Folder),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        ] {
            assert!(p.invalidates(&event(kind, &[p.git_dir.clone()])), "removal/rename of metadata.lock directory must invalidate its HEAD/index descendants");
        }
        assert!(!p.invalidates(&event(
            EventKind::Create(CreateKind::File),
            &[p.git_dir.join("index.lock")],
        )));
    }
    #[test]
    fn windows_untyped_creation_of_packed_ref_parent_is_sticky() {
        let f = Fixture::new();
        git(&f.repo, &["pack-refs", "--all"]).unwrap();
        let common = fs::canonicalize(f.repo.join(".git")).unwrap();
        let ref_parent = common.join("refs/heads/task");
        // A packed ref needs no loose file or nested parent. Ensure that state
        // explicitly even on Git versions which retain empty ref directories.
        if ref_parent.exists() {
            fs::remove_dir(&ref_parent).unwrap();
        }
        let p = f.plan();
        assert!(p.targets().iter().any(|target| {
            target.path == common.join("refs/heads")
                && matches!(target.mode, RecursiveMode::NonRecursive)
        }));
        assert!(!ref_parent.exists());
        let state = GitWatchState::default();
        // ReadDirectoryChangesW reports FILE_ACTION_ADDED as Create(Any), not
        // Create(Folder). A nonrecursive parent watch cannot see the later ref
        // file written inside this newly created directory.
        assert!(
            state.observe(
                &p,
                &event(EventKind::Create(CreateKind::Any), &[ref_parent]),
            ),
            "untyped parent creation must invalidate the packed current ref"
        );
        assert!(state.observe(
            &p,
            &event(
                EventKind::Access(AccessKind::Read),
                &[p.git_dir.join("HEAD")],
            )
        ));
        assert!(!p.invalidates(&event(
            EventKind::Create(CreateKind::Any),
            &[common.join("refs/heads/unrelated")],
        )));
        assert!(!p.invalidates(&event(
            EventKind::Create(CreateKind::Any),
            &[common.join("refs/heads/task.lock")],
        )));
    }
}
