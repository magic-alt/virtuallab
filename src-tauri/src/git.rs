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
pub fn inspect_repository(path: String) -> Result<RepositorySnapshot, String> {
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

    let branch = git(&root, &["branch", "--show-current"])?
        .trim()
        .to_string();
    let head_sha = git(&root, &["rev-parse", "--short=10", "HEAD"])?
        .trim()
        .to_string();

    let current_branch = if branch.is_empty() {
        format!("detached@{head_sha}")
    } else {
        branch
    };

    let remote_url = git_optional(&root, &["remote", "get-url", "origin"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let status = git(&root, &["status", "--porcelain=v1", "--untracked-files=all"])?;
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

    let worktrees = parse_worktrees(&git(&root, &["worktree", "list", "--porcelain"])?);
    let recent_commits = parse_commits(&git(
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
    if pair.iter().any(|code| matches!(code, 'U')) || matches!((index, worktree), ('A', 'A') | ('D', 'D')) {
        "conflicted"
    } else if pair.iter().any(|code| matches!(code, 'R' | 'C')) {
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

fn git_optional(repo: &str, args: &[&str]) -> Option<String> {
    git(repo, args).ok()
}
