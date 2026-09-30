use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    root: String,
    name: String,
    current_branch: String,
    head_sha: String,
    remote_url: Option<String>,
    dirty_count: usize,
    staged_count: usize,
    unstaged_count: usize,
    untracked_count: usize,
    changes: Vec<ChangeEntry>,
    worktrees: Vec<WorktreeSummary>,
    recent_commits: Vec<CommitSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    path: String,
    index_status: String,
    worktree_status: String,
    kind: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSummary {
    path: String,
    head: String,
    branch: Option<String>,
    detached: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    sha: String,
    subject: String,
    timestamp: i64,
}

#[tauri::command]
pub async fn inspect_repository(path: String) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_repository_blocking(path))
        .await
        .map_err(|error| format!("Repository inspection task failed: {error}"))?
}

fn inspect_repository_blocking(path: String) -> Result<RepositorySnapshot, String> {
    let root = git(&path, &["rev-parse", "--show-toplevel"])?;
    let root = root.trim().to_string();

    if root.is_empty() {
        return Err("Git returned an empty repository root".to_string());
    }

    let name = Path::new(&root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repository")
        .to_string();

    let branch = git_read(&root, &["branch", "--show-current"])?
        .trim()
        .to_string();
    let head_sha = git_read(&root, &["rev-parse", "--short=10", "HEAD"])?
        .trim()
        .to_string();

    let current_branch = if branch.is_empty() {
        format!("detached@{head_sha}")
    } else {
        branch
    };

    let remote_url = git_read_optional(&root, &["remote", "get-url", "origin"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    // Do not recursively expand every file under untracked directories. On large
    // build/source trees that can turn a status refresh into seconds of disk I/O.
    let status = git_read(
        &root,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
            "--ignore-submodules=dirty",
        ],
    )?;
    let mut changes = Vec::new();
    let mut staged_count = 0usize;
    let mut unstaged_count = 0usize;
    let mut untracked_count = 0usize;

    for line in status.lines() {
        let bytes = line.as_bytes();
        if bytes.len() < 3 {
            continue;
        }

        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        let file_path = line.get(3..).unwrap_or_default().to_string();

        if index == '?' && worktree == '?' {
            untracked_count += 1;
        } else {
            if index != ' ' {
                staged_count += 1;
            }
            if worktree != ' ' {
                unstaged_count += 1;
            }
        }

        let kind = change_kind(index, worktree).to_string();
        changes.push(ChangeEntry {
            path: file_path,
            index_status: index.to_string(),
            worktree_status: worktree.to_string(),
            kind,
        });
    }

    let worktrees = parse_worktrees(&git_read(&root, &["worktree", "list", "--porcelain"])?);
    let recent_commits = parse_commits(&git_read(
        &root,
        &["log", "-n", "8", "--format=%h%x1f%s%x1f%ct"],
    )?);

    Ok(RepositorySnapshot {
        root,
        name,
        current_branch,
        head_sha,
        remote_url,
        dirty_count: changes.len(),
        staged_count,
        unstaged_count,
        untracked_count,
        changes,
        worktrees,
        recent_commits,
    })
}

fn change_kind(index: char, worktree: char) -> &'static str {
    if index == '?' && worktree == '?' {
        return "untracked";
    }

    let pair = [index, worktree];
    if pair.iter().any(|code| *code == 'U') || matches!((index, worktree), ('A', 'A') | ('D', 'D')) {
        "conflicted"
    } else if pair.iter().any(|code| matches!(*code, 'R' | 'C')) {
        "renamed"
    } else if pair.iter().any(|code| *code == 'D') {
        "deleted"
    } else if pair.iter().any(|code| *code == 'A') {
        "added"
    } else if pair.iter().any(|code| *code == 'M') {
        "modified"
    } else {
        "other"
    }
}

fn parse_worktrees(raw: &str) -> Vec<WorktreeSummary> {
    let mut result = Vec::new();
    let mut current = WorktreeSummary::default();

    for line in raw.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if !current.path.is_empty() {
                result.push(current);
                current = WorktreeSummary::default();
            }
            continue;
        }

        if let Some(value) = line.strip_prefix("worktree ") {
            current.path = value.to_string();
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            current.head = value.chars().take(10).collect();
        } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
            current.branch = Some(value.to_string());
        } else if line == "detached" {
            current.detached = true;
        }
    }

    result
}

fn parse_commits(raw: &str) -> Vec<CommitSummary> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\u{1f}');
            let sha = parts.next()?.to_string();
            let subject = parts.next()?.to_string();
            let timestamp = parts.next()?.parse::<i64>().ok()?;

            Some(CommitSummary {
                sha,
                subject,
                timestamp,
            })
        })
        .collect()
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|error| format!("Failed to launch git: {error}"))?;

    if output.status.success() {
        String::from_utf8(output.stdout)
            .map_err(|error| format!("Git output was not valid UTF-8: {error}"))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Git command failed with {}", output.status)
        } else {
            stderr
        })
    }
}

fn git_read(repo: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|error| format!("Failed to launch git: {error}"))?;

    if output.status.success() {
        String::from_utf8(output.stdout)
            .map_err(|error| format!("Git output was not valid UTF-8: {error}"))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Git command failed with {}", output.status)
        } else {
            stderr
        })
    }
}

fn git_read_optional(repo: &str, args: &[&str]) -> Option<String> {
    git_read(repo, args).ok()
}

fn git_optional(repo: &str, args: &[&str]) -> Option<String> {
    git(repo, args).ok()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMutationResult {
    path: String,
    branch: String,
}

#[tauri::command]
pub async fn create_worktree(
    repository_root: String,
    branch: String,
    base_ref: Option<String>,
    target_path: Option<String>,
) -> Result<WorkspaceMutationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_worktree_blocking(repository_root, branch, base_ref, target_path)
    })
    .await
    .map_err(|error| format!("Worktree creation task failed: {error}"))?
}

fn create_worktree_blocking(
    repository_root: String,
    branch: String,
    base_ref: Option<String>,
    target_path: Option<String>,
) -> Result<WorkspaceMutationResult, String> {
    let repository_root = git(&repository_root, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();

    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("Workspace branch must not be empty".to_string());
    }

    git(&repository_root, &["check-ref-format", "--branch", branch.as_str()])?;

    let target = match target_path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
    {
        Some(path) => std::path::PathBuf::from(path),
        None => default_worktree_path(&repository_root, &branch)?,
    };

    if target.exists() {
        return Err(format!(
            "Workspace target already exists: {}",
            target.to_string_lossy()
        ));
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create workspace parent directory: {error}"))?;
    }

    let target_string = target.to_string_lossy().to_string();
    let base_ref = base_ref
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "HEAD".to_string());

    git(
        &repository_root,
        &[
            "worktree",
            "add",
            "-b",
            branch.as_str(),
            target_string.as_str(),
            base_ref.as_str(),
        ],
    )?;

    Ok(WorkspaceMutationResult {
        path: target_string,
        branch,
    })
}

#[tauri::command]
pub async fn remove_worktree(repository_root: String, worktree_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_worktree_blocking(repository_root, worktree_path)
    })
    .await
    .map_err(|error| format!("Worktree removal task failed: {error}"))?
}

fn remove_worktree_blocking(repository_root: String, worktree_path: String) -> Result<(), String> {
    let repository_root = git(&repository_root, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let inventory = parse_worktrees(&git(
        &repository_root,
        &["worktree", "list", "--porcelain"],
    )?);

    if inventory.is_empty() {
        return Err("Repository has no registered worktrees".to_string());
    }

    let requested = canonical_or_original(std::path::Path::new(worktree_path.trim()));
    let primary = canonical_or_original(std::path::Path::new(&inventory[0].path));

    if requested == primary {
        return Err("Refusing to remove the repository primary worktree".to_string());
    }

    let registered = inventory.iter().any(|item| {
        canonical_or_original(std::path::Path::new(&item.path)) == requested
    });
    if !registered {
        return Err("Requested path is not a registered worktree".to_string());
    }

    let worktree_string = requested.to_string_lossy().to_string();
    git(
        &repository_root,
        &["worktree", "remove", worktree_string.as_str()],
    )?;
    Ok(())
}

fn default_worktree_path(repository_root: &str, branch: &str) -> Result<std::path::PathBuf, String> {
    let root = std::path::Path::new(repository_root);
    let parent = root
        .parent()
        .ok_or_else(|| "Repository root has no parent directory".to_string())?;
    let repository_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repository");

    let slug: String = branch
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect();

    Ok(parent
        .join(".virtuallab-workspaces")
        .join(repository_name)
        .join(slug))
}

fn canonical_or_original(path: &std::path::Path) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_root(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "virtuallab-{name}-{}-{stamp}",
            std::process::id()
        ))
    }

    fn git_ok(repo: &std::path::Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .status()
            .expect("git should start");
        assert!(status.success(), "git command failed: {args:?}");
    }

    #[test]
    fn read_only_git_command_works_on_fixture() {
        let sandbox = unique_root("read-git");
        let repo = sandbox.join("repo");
        fs::create_dir_all(&repo).expect("repo directory");
        git_ok(&repo, &["init"]);
        git_ok(&repo, &["config", "user.email", "virtuallab@example.invalid"]);
        git_ok(&repo, &["config", "user.name", "VirtualLab Tests"]);
        fs::write(repo.join("README.md"), "fixture\n").expect("fixture write");
        git_ok(&repo, &["add", "README.md"]);
        git_ok(&repo, &["commit", "-m", "fixture"]);

        let head = git_read(repo.to_string_lossy().as_ref(), &["rev-parse", "--short", "HEAD"])
            .expect("read-only git");
        assert!(!head.trim().is_empty());

        let _ = fs::remove_dir_all(sandbox);
    }

    #[test]
    fn change_kind_classifies_porcelain_states() {
        assert_eq!(change_kind('?', '?'), "untracked");
        assert_eq!(change_kind('M', ' '), "modified");
        assert_eq!(change_kind('A', ' '), "added");
        assert_eq!(change_kind('D', ' '), "deleted");
        assert_eq!(change_kind('R', ' '), "renamed");
        assert_eq!(change_kind('U', 'U'), "conflicted");
    }

    #[test]
    fn default_worktree_path_sanitizes_branch_separators() {
        let root = unique_root("path").join("repo");
        let path = default_worktree_path(root.to_string_lossy().as_ref(), "feat/pixel ui")
            .expect("path should resolve");
        assert!(path.ends_with(
            std::path::Path::new("repo").join("feat-pixel-ui")
        ));
    }


    #[test]
    fn inspect_repository_reports_fixture_without_async_runtime() {
        let sandbox = unique_root("inspect");
        let repo = sandbox.join("repo");
        fs::create_dir_all(&repo).expect("repo directory");

        git_ok(&repo, &["init"]);
        git_ok(&repo, &["config", "user.email", "virtuallab@example.invalid"]);
        git_ok(&repo, &["config", "user.name", "VirtualLab Tests"]);
        fs::write(repo.join("README.md"), "fixture\n").expect("fixture write");
        git_ok(&repo, &["add", "README.md"]);
        git_ok(&repo, &["commit", "-m", "fixture"]);

        let snapshot =
            inspect_repository_blocking(repo.to_string_lossy().to_string()).expect("inspect repo");
        assert_eq!(snapshot.dirty_count, 0);
        assert!(!snapshot.head_sha.is_empty());
        assert_eq!(snapshot.worktrees.len(), 1);

        let _ = fs::remove_dir_all(sandbox);
    }

    #[test]
    fn create_and_remove_worktree_round_trip() {
        let sandbox = unique_root("worktree");
        let repo = sandbox.join("repo");
        let target = sandbox.join("workspace");
        fs::create_dir_all(&repo).expect("repo directory");

        git_ok(&repo, &["init"]);
        git_ok(&repo, &["config", "user.email", "virtuallab@example.invalid"]);
        git_ok(&repo, &["config", "user.name", "VirtualLab Tests"]);
        fs::write(repo.join("README.md"), "fixture\n").expect("fixture write");
        git_ok(&repo, &["add", "README.md"]);
        git_ok(&repo, &["commit", "-m", "fixture"]);

        let created = create_worktree_blocking(
            repo.to_string_lossy().to_string(),
            "feat/control-test".to_string(),
            Some("HEAD".to_string()),
            Some(target.to_string_lossy().to_string()),
        )
        .expect("create worktree");

        assert_eq!(created.branch, "feat/control-test");
        assert!(target.is_dir());
        let branch = git(target.to_string_lossy().as_ref(), &["branch", "--show-current"])
            .expect("branch lookup");
        assert_eq!(branch.trim(), "feat/control-test");

        remove_worktree_blocking(
            repo.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
        )
        .expect("remove worktree");
        assert!(!target.exists());

        let _ = fs::remove_dir_all(sandbox);
    }
}
