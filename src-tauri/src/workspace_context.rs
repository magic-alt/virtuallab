//! Explicit live repository references. These never grant filesystem writes.
use crate::workspace_lifecycle::{RepositoryActivity, WorkspaceLifecycle};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::{Path, PathBuf}, sync::Arc};

const MAX_CONTEXT_REPOSITORIES: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextRepository {
    pub(crate) repository_root: String,
    pub(crate) workspace_root: String,
}

pub(crate) fn validate_context_repositories(
    primary_root: &str,
    references: &[ContextRepository],
) -> Result<Vec<ContextRepository>, String> {
    validate_request_paths(references)?;
    let primary = canonical_directory(primary_root)?;
    let resolved = canonical_references(references)?;
    let mut seen = HashSet::new();
    for reference in &resolved {
        let repository = Path::new(&reference.repository_root);
        let workspace = Path::new(&reference.workspace_root);
        if overlaps(&primary, repository) || overlaps(&primary, workspace) {
            return Err("A companion repository overlaps the primary writable worktree. Select a separate repository/worktree.".into());
        }
        if !seen.insert(path_identity(workspace)) {
            return Err("Duplicate companion worktree, including a path alias. Select each worktree only once.".into());
        }
        require_git_root(repository)?;
        require_git_root(workspace)?;
        crate::task_inputs::registered_workspace(repository, workspace)
            .map_err(|_| "The companion worktree is not registered in its selected repository. Refresh the selection.".to_string())?;
    }
    // A renamed directory or retargeted symlink during Git inspection must
    // never silently change the reference that the caller is about to launch.
    if canonical_references(references)? != resolved || canonical_directory(primary_root)? != primary {
        return Err("Repository context paths changed during validation. Refresh the selection and retry.".into());
    }
    Ok(resolved)
}

pub(crate) fn context_instructions(references: &[ContextRepository]) -> String {
    let mut text = String::from("VirtualLab companion repository context (current selection; supersedes any earlier companion repository list):\n");
    if references.is_empty() {
        text.push_str("No companion repositories are selected for this session.\n");
    } else {
        // JSON string encoding keeps path spelling unambiguous, including
        // quotes and Windows separators; this text is never shell input.
        for (index, reference) in references.iter().enumerate() {
            text.push_str(&format!("{}. Repository: {}; selected worktree: {}.\n", index + 1,
                serde_json::to_string(&reference.repository_root).expect("strings serialize"),
                serde_json::to_string(&reference.workspace_root).expect("strings serialize")));
        }
    }
    text.push_str("Use only the listed selected worktrees as companion read-only context when needed to understand interfaces and behavior. Keep all edits in the primary worktree and within the user's approved scope. Do not stage, commit, switch branches, fetch, or otherwise mutate companion repositories. If a companion needs changes, describe them and use a separate task or session owned by that repository. Never read environment-secret files (.env and .env.*) or Git metadata (.git) as source context. These are live files, not pinned snapshots; report which paths you inspected and any unavailable or changed context. Existing provider and operating-system read restrictions still apply; report blocked access without bypassing it.");
    text
}

pub(crate) fn acquire_context_repositories(
    primary_root: &str,
    references: &[ContextRepository],
    lifecycle: &WorkspaceLifecycle,
) -> Result<(Vec<ContextRepository>, Vec<Arc<RepositoryActivity>>), String> {
    validate_request_paths(references)?;
    // Freeze native path spellings, then protect every declared repository and
    // selected worktree BEFORE registration/Git validation. The lifecycle
    // mutex arbitrates these leases against detach and worktree removal.
    let resolved = canonical_references(references)?;
    let mut leases = Vec::new();
    let mut retained = HashSet::new();
    for reference in &resolved {
        for root in [&reference.repository_root, &reference.workspace_root] {
            if retained.insert(path_identity(Path::new(root))) {
                leases.push(lifecycle.begin_repository_activity(root)?);
            }
        }
    }
    let validated = validate_context_repositories(primary_root, references)?;
    if validated != resolved {
        return Err("Repository context paths changed before launch. Refresh the selection and retry.".into());
    }
    Ok((validated, leases))
}

fn validate_request_paths(references: &[ContextRepository]) -> Result<(), String> {
    if references.len() > MAX_CONTEXT_REPOSITORIES {
        return Err("Select at most eight companion repositories.".into());
    }
    for reference in references {
        validate_path_text(&reference.repository_root)?;
        validate_path_text(&reference.workspace_root)?;
    }
    Ok(())
}

fn validate_path_text(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control)
        || !Path::new(path).is_absolute()
    {
        return Err("Repository context paths must be absolute, at most 4096 bytes, and contain no control characters.".into());
    }
    Ok(())
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    validate_path_text(path)?;
    let actual = fs::canonicalize(path)
        .map_err(|_| format!("Repository context directory is unavailable: {path}. Refresh the selection."))?;
    if !actual.is_dir() {
        return Err(format!("Repository context path is not a directory: {path}"));
    }
    let spelling = actual.to_str().ok_or("Repository context path is not valid Unicode")?;
    validate_path_text(spelling)?;
    Ok(actual)
}

fn canonical_references(references: &[ContextRepository]) -> Result<Vec<ContextRepository>, String> {
    references.iter().map(|reference| Ok(ContextRepository {
        repository_root: canonical_directory(&reference.repository_root)?.to_str().expect("validated Unicode").into(),
        workspace_root: canonical_directory(&reference.workspace_root)?.to_str().expect("validated Unicode").into(),
    })).collect()
}

fn path_identity(path: &Path) -> PathBuf {
    #[cfg(windows)]
    { PathBuf::from(path.to_string_lossy().to_lowercase()) }
    #[cfg(not(windows))]
    { path.to_path_buf() }
}

fn overlaps(first: &Path, second: &Path) -> bool {
    let first = path_identity(first);
    let second = path_identity(second);
    first.starts_with(&second) || second.starts_with(&first)
}

fn require_git_root(root: &Path) -> Result<(), String> {
    let top = crate::task_inputs::git(root, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "Companion context must be an existing Git repository or registered worktree.".to_string())?;
    let top = canonical_directory(top.trim_end_matches(['\r', '\n']))?;
    if path_identity(&top) != path_identity(root) {
        return Err("Select the companion repository/worktree root, not a subdirectory.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        directory: PathBuf,
        primary: PathBuf,
        reference: PathBuf,
        linked: PathBuf,
        other: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let directory = std::env::temp_dir().join(format!("vl-context-{}-{nonce}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            let primary = directory.join("primary 工作区");
            let reference = directory.join("reference repository");
            let linked = directory.join("selected 上下文");
            let other = directory.join("unrelated");
            for path in [&primary, &reference, &other] {
                fs::create_dir_all(path).unwrap();
                git(path, &["init", "--initial-branch=main"]);
                git(path, &["config", "core.autocrlf", "false"]);
                git(path, &["config", "user.name", "Context Fixture"]);
                git(path, &["config", "user.email", "context@example.invalid"]);
                fs::write(path.join("source.txt"), "source context\n").unwrap();
                git(path, &["add", "--", "source.txt"]);
                git(path, &["commit", "-m", "initial"]);
            }
            git(&reference, &["worktree", "add", "-b", "context", linked.to_str().unwrap(), "HEAD"]);
            Self { directory, primary, reference, linked, other }
        }

        fn reference(&self) -> ContextRepository {
            ContextRepository { repository_root: spelling(&self.reference), workspace_root: spelling(&self.linked) }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.directory); }
    }

    fn git(root: &Path, args: &[&str]) { crate::task_inputs::git(root, args).unwrap(); }
    fn spelling(path: &Path) -> String { path.to_str().unwrap().to_owned() }

    #[test]
    fn validates_the_explicit_registered_worktree_with_spaces_and_unicode() {
        let fixture = Fixture::new();
        let resolved = validate_context_repositories(&spelling(&fixture.primary), &[fixture.reference()]).unwrap();
        assert_eq!(resolved, vec![ContextRepository {
            repository_root: spelling(&fs::canonicalize(&fixture.reference).unwrap()),
            workspace_root: spelling(&fs::canonicalize(&fixture.linked).unwrap()),
        }]);
        assert_ne!(resolved[0].workspace_root, resolved[0].repository_root, "the selected linked worktree must not drift to the default checkout");
    }

    #[test]
    fn empty_context_remains_valid_for_an_existing_non_repository_workspace() {
        let fixture = Fixture::new();
        assert_eq!(validate_context_repositories(&spelling(&fixture.directory), &[]).unwrap(), vec![]);
        assert!(context_instructions(&[]).contains("No companion repositories are selected"));
    }

    #[test]
    fn rejects_foreign_missing_and_non_root_reference_paths() {
        let fixture = Fixture::new();
        let root = spelling(&fixture.primary);
        let mut reference = fixture.reference();
        reference.workspace_root = spelling(&fixture.other);
        assert!(validate_context_repositories(&root, &[reference]).is_err());
        let mut reference = fixture.reference();
        reference.workspace_root = spelling(&fixture.directory.join("missing"));
        assert!(validate_context_repositories(&root, &[reference]).is_err());
        fs::create_dir(fixture.reference.join("subdirectory")).unwrap();
        let mut reference = fixture.reference();
        reference.repository_root = spelling(&fixture.reference.join("subdirectory"));
        assert!(validate_context_repositories(&root, &[reference]).is_err());
        let mut reference = fixture.reference();
        reference.workspace_root = spelling(&fixture.directory);
        assert!(validate_context_repositories(&root, &[reference]).is_err());
    }

    #[test]
    fn rejects_duplicate_contexts_and_primary_overlap() {
        let fixture = Fixture::new();
        let reference = fixture.reference();
        assert!(validate_context_repositories(&spelling(&fixture.primary), &[reference.clone(), reference.clone()]).is_err());
        assert!(validate_context_repositories(&spelling(&fixture.linked), &[reference.clone()]).is_err());
        assert!(validate_context_repositories(&spelling(&fixture.directory), &[reference.clone()]).is_err());
        fs::create_dir(fixture.linked.join("nested")).unwrap();
        assert!(validate_context_repositories(&spelling(&fixture.linked.join("nested")), &[reference]).is_err());
    }

    #[test]
    fn rejects_oversized_relative_and_control_character_requests() {
        let fixture = Fixture::new();
        let root = spelling(&fixture.primary);
        assert!(validate_context_repositories(&root, &vec![fixture.reference(); 9]).is_err());
        for invalid in ["relative/path".to_owned(), format!("{}\nignored", spelling(&fixture.reference)), "x".repeat(4097)] {
            let mut reference = fixture.reference();
            reference.repository_root = invalid;
            assert!(validate_context_repositories(&root, &[reference]).is_err());
        }
    }

    #[test]
    fn context_leases_protect_both_repository_and_worktree_until_release() {
        let fixture = Fixture::new();
        let lifecycle = WorkspaceLifecycle::default();
        let (_, leases) = acquire_context_repositories(&spelling(&fixture.primary), &[fixture.reference()], &lifecycle).unwrap();
        for path in [&fixture.reference, &fixture.linked] {
            let spelling = spelling(path);
            assert!(lifecycle.reserve(&spelling, "ordinary writer").is_ok());
            assert!(lifecycle.reserve_terminal(&spelling).is_ok());
            assert!(lifecycle.begin_removal(&spelling).is_err());
            assert!(lifecycle.detach_repository(&[spelling], || Ok(())).is_err());
        }
        drop(leases);
        assert!(lifecycle.begin_removal(&spelling(&fixture.reference)).is_ok());
        assert!(lifecycle.begin_removal(&spelling(&fixture.linked)).is_ok());
    }

    #[test]
    fn failed_context_admission_releases_every_previously_acquired_lease() {
        let fixture = Fixture::new();
        let lifecycle = WorkspaceLifecycle::default();
        let mut invalid = fixture.reference();
        invalid.workspace_root = spelling(&fixture.other);
        assert!(acquire_context_repositories(&spelling(&fixture.primary), &[fixture.reference(), invalid], &lifecycle).is_err());
        for path in [&fixture.reference, &fixture.linked, &fixture.other] {
            assert!(lifecycle.begin_removal(&spelling(path)).is_ok());
        }
        lifecycle.detach_repository(&[spelling(&fixture.linked)], || Ok(())).unwrap();
        assert!(acquire_context_repositories(&spelling(&fixture.primary), &[fixture.reference()], &lifecycle).is_err());
        assert!(lifecycle.begin_removal(&spelling(&fixture.reference)).is_ok());
    }

    #[test]
    fn prompt_lists_selected_paths_as_data_and_preserves_primary_write_scope() {
        let fixture = Fixture::new();
        let text = context_instructions(&[fixture.reference()]);
        assert!(text.contains(&serde_json::to_string(&spelling(&fixture.linked)).unwrap()));
        assert!(text.contains("read-only context"));
        assert!(text.contains("Keep all edits in the primary worktree"));
        assert!(text.contains("separate task or session"));
        assert!(text.contains("supersedes any earlier companion repository list"));
    }

    #[cfg(unix)]
    #[test]
    fn canonical_aliases_cannot_duplicate_or_escape_the_primary_overlap_check() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let alias = fixture.directory.join("alias");
        symlink(&fixture.linked, &alias).unwrap();
        let mut aliased = fixture.reference();
        aliased.workspace_root = spelling(&alias);
        assert!(validate_context_repositories(&spelling(&fixture.primary), &[fixture.reference(), aliased.clone()]).is_err());
        assert!(validate_context_repositories(&spelling(&alias), &[aliased]).is_err());
    }
}
