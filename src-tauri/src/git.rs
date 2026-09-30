use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::thread;

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
    old_path: Option<String>,
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
    let root = git_read(&path, &["rev-parse", "--show-toplevel"])?;
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

    // Porcelain -z keeps spaces/Unicode lossless and reports rename/copy paths
    // as separate NUL-delimited fields. "normal" avoids recursively expanding
    // every file under large untracked directories.
    let status = git_read(
        &root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignore-submodules=dirty",
        ],
    )?;
    let parsed_status = parse_status_z(&status)?;
    let mut changes = Vec::with_capacity(parsed_status.len());
    let mut staged_count = 0usize;
    let mut unstaged_count = 0usize;
    let mut untracked_count = 0usize;

    for entry in parsed_status {
        if entry.index == '?' && entry.worktree == '?' {
            untracked_count += 1;
        } else {
            if entry.index != ' ' {
                staged_count += 1;
            }
            if entry.worktree != ' ' {
                unstaged_count += 1;
            }
        }

        let kind = change_kind(entry.index, entry.worktree).to_string();
        changes.push(ChangeEntry {
            path: entry.path,
            old_path: entry.old_path,
            index_status: entry.index.to_string(),
            worktree_status: entry.worktree.to_string(),
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


#[derive(Debug, PartialEq, Eq)]
struct ParsedStatusEntry {
    index: char,
    worktree: char,
    path: String,
    old_path: Option<String>,
}

fn parse_status_z(raw: &str) -> Result<Vec<ParsedStatusEntry>, String> {
    let mut fields = raw.split('\0').filter(|field| !field.is_empty());
    let mut result = Vec::new();

    while let Some(field) = fields.next() {
        let bytes = field.as_bytes();
        if bytes.len() < 3 {
            return Err("Malformed Git status entry".to_string());
        }

        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        let path = field
            .get(3..)
            .ok_or_else(|| "Malformed Git status path".to_string())?
            .to_string();

        let renamed_or_copied =
            matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C');
        let old_path = if renamed_or_copied {
            Some(
                fields
                    .next()
                    .ok_or_else(|| "Malformed Git rename/copy status".to_string())?
                    .to_string(),
            )
        } else {
            None
        };

        result.push(ParsedStatusEntry {
            index,
            worktree,
            path,
            old_path,
        });
    }

    Ok(result)
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




const MAX_DIFF_BYTES: usize = 512 * 1024;
const MAX_DIFF_LINES: usize = 12_000;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiffMode {
    Worktree,
    Index,
    Base,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    repository_root: String,
    workspace_root: String,
    path: Option<String>,
    old_path: Option<String>,
    mode: DiffMode,
    base_ref: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileSummary {
    path: String,
    old_path: Option<String>,
    status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResponse {
    mode: DiffMode,
    base_ref: Option<String>,
    path: Option<String>,
    old_path: Option<String>,
    files: Vec<DiffFileSummary>,
    patch: String,
    binary: bool,
    truncated: bool,
    returned_bytes: usize,
    original_text: Option<String>,
    modified_text: Option<String>,
    content_truncated: bool,
}

#[tauri::command]
pub async fn git_diff(request: DiffRequest) -> Result<DiffResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_blocking(request))
        .await
        .map_err(|error| format!("Git diff task failed: {error}"))?
}

fn git_diff_blocking(request: DiffRequest) -> Result<DiffResponse, String> {
    let repository_root = git_read(&request.repository_root, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let workspace_root = git_read(&request.workspace_root, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();

    ensure_registered_worktree(&repository_root, &workspace_root)?;

    let path = request
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_relative_path)
        .transpose()?;
    let old_path = request
        .old_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_relative_path)
        .transpose()?;

    let base_ref = match request.mode {
        DiffMode::Base => {
            let value = request
                .base_ref
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Base diff requires baseRef".to_string())?;
            validate_ref(value)?;
            let verify = format!("{value}^{{commit}}");
            git_read(
                &workspace_root,
                &["rev-parse", "--verify", "--end-of-options", verify.as_str()],
            )
            .map_err(|_| format!("Base ref is not a valid commit: {value}"))?;
            Some(value.to_string())
        }
        _ => None,
    };

    let args = diff_args(
        request.mode,
        base_ref.as_deref(),
        path.as_deref(),
        old_path.as_deref(),
    )?;

    let mut metadata_args = args.clone();
    let metadata_index = 4;
    metadata_args.insert(metadata_index, "--name-status".to_string());
    metadata_args.insert(metadata_index + 1, "-z".to_string());
    let metadata_refs: Vec<&str> = metadata_args.iter().map(String::as_str).collect();
    let name_status = git_read(&workspace_root, &metadata_refs)?;
    let files = parse_name_status_z(&name_status)?;

    let mut numstat_args = args.clone();
    let numstat_index = 4;
    numstat_args.insert(numstat_index, "--numstat".to_string());
    numstat_args.insert(numstat_index + 1, "-z".to_string());
    let numstat_refs: Vec<&str> = numstat_args.iter().map(String::as_str).collect();
    let numstat = git_read(&workspace_root, &numstat_refs)?;
    let binary = numstat
        .split('\0')
        .any(|entry| entry.starts_with("-\t-\t"));

    let patch_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (raw_patch, byte_truncated) =
        git_read_limited(&workspace_root, &patch_refs, MAX_DIFF_BYTES)?;
    let text = String::from_utf8_lossy(&raw_patch).to_string();
    let (mut patch, line_truncated) = truncate_lines(text, MAX_DIFF_LINES);
    let mut truncated = byte_truncated || line_truncated;
    if patch.len() > MAX_DIFF_BYTES {
        let mut end = MAX_DIFF_BYTES;
        while end > 0 && !patch.is_char_boundary(end) {
            end -= 1;
        }
        patch.truncate(end);
        truncated = true;
    }
    let returned_bytes = patch.len();

    let selected_file = path.as_deref().and_then(|selected| {
        files.iter().find(|file| {
            file.path == selected || file.old_path.as_deref() == Some(selected)
        })
    });
    let selected_old_path = old_path
        .or_else(|| selected_file.and_then(|file| file.old_path.clone()));
    let selected_status = selected_file
        .map(|file| file.status.as_str())
        .unwrap_or("");

    let (original_text, modified_text, content_truncated) =
        if let Some(selected_path) = path.as_deref() {
            if binary {
                (None, None, false)
            } else {
                let (original, modified, was_truncated) = read_review_sides(
                    &workspace_root,
                    request.mode,
                    base_ref.as_deref(),
                    selected_path,
                    selected_old_path.as_deref(),
                    selected_status,
                )?;
                (Some(original), Some(modified), was_truncated)
            }
        } else {
            (None, None, false)
        };

    Ok(DiffResponse {
        mode: request.mode,
        base_ref,
        path,
        old_path: selected_old_path,
        files,
        patch,
        binary,
        truncated,
        returned_bytes,
        original_text,
        modified_text,
        content_truncated,
    })
}

fn diff_args(
    mode: DiffMode,
    base_ref: Option<&str>,
    path: Option<&str>,
    old_path: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--no-textconv".to_string(),
        "--no-color".to_string(),
    ];

    match mode {
        DiffMode::Worktree => {}
        DiffMode::Index => args.push("--cached".to_string()),
        DiffMode::Base => {
            let base = base_ref.ok_or_else(|| "Base diff requires baseRef".to_string())?;
            args.push(format!("{base}...HEAD"));
        }
    }

    args.push("--find-renames".to_string());

    if let Some(path) = path {
        args.push("--".to_string());
        if let Some(old_path) = old_path.filter(|old_path| *old_path != path) {
            args.push(old_path.to_string());
        }
        args.push(path.to_string());
    }

    Ok(args)
}


fn read_review_sides(
    workspace_root: &str,
    mode: DiffMode,
    base_ref: Option<&str>,
    path: &str,
    old_path: Option<&str>,
    status: &str,
) -> Result<(String, String, bool), String> {
    let status_code = status.chars().next().unwrap_or('M');
    let previous_path = old_path.unwrap_or(path);

    let (original, original_truncated) = match mode {
        DiffMode::Worktree => {
            if status_code == 'A' {
                (Vec::new(), false)
            } else {
                read_git_text_limited(workspace_root, &format!(":{previous_path}"), MAX_DIFF_BYTES)?
            }
        }
        DiffMode::Index => {
            if status_code == 'A' {
                (Vec::new(), false)
            } else {
                read_git_text_limited(
                    workspace_root,
                    &format!("HEAD:{previous_path}"),
                    MAX_DIFF_BYTES,
                )?
            }
        }
        DiffMode::Base => {
            if status_code == 'A' {
                (Vec::new(), false)
            } else {
                let base = base_ref.ok_or_else(|| "Base diff requires baseRef".to_string())?;
                let merge_base = git_read(workspace_root, &["merge-base", base, "HEAD"])?
                    .trim()
                    .to_string();
                read_git_text_limited(
                    workspace_root,
                    &format!("{merge_base}:{previous_path}"),
                    MAX_DIFF_BYTES,
                )?
            }
        }
    };

    let (modified, modified_truncated) = match mode {
        DiffMode::Worktree => {
            if status_code == 'D' {
                (Vec::new(), false)
            } else {
                read_workspace_file_limited(workspace_root, path, MAX_DIFF_BYTES)?
            }
        }
        DiffMode::Index => {
            if status_code == 'D' {
                (Vec::new(), false)
            } else {
                read_git_text_limited(workspace_root, &format!(":{path}"), MAX_DIFF_BYTES)?
            }
        }
        DiffMode::Base => {
            if status_code == 'D' {
                (Vec::new(), false)
            } else {
                read_git_text_limited(
                    workspace_root,
                    &format!("HEAD:{path}"),
                    MAX_DIFF_BYTES,
                )?
            }
        }
    };

    Ok((
        String::from_utf8_lossy(&original).to_string(),
        String::from_utf8_lossy(&modified).to_string(),
        original_truncated || modified_truncated,
    ))
}

fn read_git_text_limited(repo: &str, spec: &str, limit: usize) -> Result<(Vec<u8>, bool), String> {
    git_read_limited(
        repo,
        &[
            "show",
            "--no-ext-diff",
            "--no-textconv",
            "--format=",
            spec,
        ],
        limit,
    )
}

fn read_workspace_file_limited(
    workspace_root: &str,
    relative_path: &str,
    limit: usize,
) -> Result<(Vec<u8>, bool), String> {
    let root = std::fs::canonicalize(workspace_root)
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let candidate = root.join(relative_path);
    let resolved = std::fs::canonicalize(&candidate)
        .map_err(|error| format!("Failed to resolve workspace file {relative_path}: {error}"))?;

    if !resolved.starts_with(&root) {
        return Err("Diff file resolves outside the workspace".to_string());
    }

    let mut file = File::open(&resolved)
        .map_err(|error| format!("Failed to open workspace file {relative_path}: {error}"))?;
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    file.by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read workspace file {relative_path}: {error}"))?;

    let truncated = bytes.len() > limit;
    if truncated {
        bytes.truncate(limit);
    }
    Ok((bytes, truncated))
}

fn validate_ref(value: &str) -> Result<(), String> {
    if value.starts_with('-') || value.contains('\0') {
        return Err("Invalid baseRef".to_string());
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<String, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Diff path must stay inside the workspace".to_string());
    }
    Ok(value.to_string())
}

fn ensure_registered_worktree(repository_root: &str, workspace_root: &str) -> Result<(), String> {
    let inventory = parse_worktrees(&git_read(
        repository_root,
        &["worktree", "list", "--porcelain"],
    )?);
    let requested = canonical_or_original(Path::new(workspace_root));
    let registered = inventory
        .iter()
        .any(|item| canonical_or_original(Path::new(&item.path)) == requested);

    if registered {
        Ok(())
    } else {
        Err("workspaceRoot is not a registered worktree of repositoryRoot".to_string())
    }
}

fn parse_name_status_z(raw: &str) -> Result<Vec<DiffFileSummary>, String> {
    let fields: Vec<&str> = raw.split('\0').filter(|field| !field.is_empty()).collect();
    let mut result = Vec::new();
    let mut index = 0usize;

    while index < fields.len() {
        let status = fields[index];
        index += 1;

        if status.starts_with('R') || status.starts_with('C') {
            if index + 1 >= fields.len() {
                return Err("Malformed Git rename/copy metadata".to_string());
            }
            let old_path = fields[index].to_string();
            let path = fields[index + 1].to_string();
            index += 2;
            result.push(DiffFileSummary {
                path,
                old_path: Some(old_path),
                status: status.to_string(),
            });
        } else {
            let Some(path) = fields.get(index) else {
                return Err("Malformed Git diff metadata".to_string());
            };
            index += 1;
            result.push(DiffFileSummary {
                path: (*path).to_string(),
                old_path: None,
                status: status.to_string(),
            });
        }
    }

    Ok(result)
}

fn git_read_limited(repo: &str, args: &[&str], limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut child = Command::new("git")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to launch git: {error}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture Git stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture Git stderr".to_string())?;

    let stderr_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });

    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0u8; 8192];
    let mut truncated = false;

    loop {
        let read = stdout
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read Git output: {error}"))?;
        if read == 0 {
            break;
        }

        if output.len() < limit {
            let remaining = limit - output.len();
            let kept = remaining.min(read);
            output.extend_from_slice(&buffer[..kept]);
            if kept < read {
                truncated = true;
            }
        } else {
            truncated = true;
        }

        // Do not kill Git as soon as the UI byte limit is reached. On Windows,
        // terminating git.exe while its stdout/stderr pipes are active can leave
        // pipe handles alive long enough for child.wait()/stderr join to stall.
        // Continue draining stdout while discarding excess bytes; memory remains
        // bounded and Git exits normally on every supported desktop platform.
    }

    let status = child
        .wait()
        .map_err(|error| format!("Failed to wait for Git: {error}"))?;
    let stderr = stderr_thread.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();

    if !status.success() {
        return Err(if stderr.is_empty() {
            format!("Git command failed with {status}")
        } else {
            stderr
        });
    }

    Ok((output, truncated))
}

fn truncate_lines(text: String, max_lines: usize) -> (String, bool) {
    let mut lines = text.lines();
    let selected: Vec<&str> = lines.by_ref().take(max_lines).collect();
    let truncated = lines.next().is_some();
    if truncated {
        (selected.join("\n"), true)
    } else {
        (text, false)
    }
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
    fn status_parser_preserves_unicode_spaces_and_rename_identity() {
        let raw = "R  新 c.txt\0a b.txt\0?? untracked dir/\0";
        let entries = parse_status_z(raw).expect("status parse");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].index, 'R');
        assert_eq!(entries[0].path, "新 c.txt");
        assert_eq!(entries[0].old_path.as_deref(), Some("a b.txt"));
        assert_eq!(entries[1].path, "untracked dir/");
        assert_eq!(entries[1].old_path, None);
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

    fn init_fixture_repo(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let sandbox = unique_root(name);
        let repo = sandbox.join("repo");
        fs::create_dir_all(&repo).expect("repo directory");
        git_ok(&repo, &["init"]);
        git_ok(&repo, &["config", "user.email", "virtuallab@example.invalid"]);
        git_ok(&repo, &["config", "user.name", "VirtualLab Tests"]);
        fs::write(repo.join("README.md"), "line one\n").expect("fixture write");
        git_ok(&repo, &["add", "README.md"]);
        git_ok(&repo, &["commit", "-m", "fixture"]);
        (sandbox, repo)
    }

    fn diff_request(
        repo: &std::path::Path,
        mode: DiffMode,
        path: Option<&str>,
        base_ref: Option<&str>,
    ) -> DiffResponse {
        git_diff_blocking(DiffRequest {
            repository_root: repo.to_string_lossy().to_string(),
            workspace_root: repo.to_string_lossy().to_string(),
            path: path.map(ToOwned::to_owned),
            old_path: None,
            mode,
            base_ref: base_ref.map(ToOwned::to_owned),
        })
        .expect("git diff")
    }

    #[test]
    fn diff_supports_worktree_and_index_modes_with_unicode_paths() {
        let (sandbox, repo) = init_fixture_repo("diff-modes");
        fs::write(repo.join("README.md"), "line one\nline two\n").expect("modify");
        let worktree = diff_request(&repo, DiffMode::Worktree, Some("README.md"), None);
        assert!(worktree.patch.contains("+line two"));
        assert_eq!(worktree.files[0].status, "M");
        assert_eq!(worktree.original_text.as_deref(), Some("line one\n"));
        assert!(worktree
            .modified_text
            .as_deref()
            .is_some_and(|text| text.contains("line two")));

        fs::write(repo.join("新 file.txt"), "hello\n").expect("unicode file");
        git_ok(&repo, &["add", "新 file.txt"]);
        let index = diff_request(&repo, DiffMode::Index, Some("新 file.txt"), None);
        assert!(index.patch.contains("hello"));
        assert_eq!(index.files[0].path, "新 file.txt");
        assert_eq!(index.files[0].status, "A");
        assert_eq!(index.original_text.as_deref(), Some(""));
        assert_eq!(index.modified_text.as_deref(), Some("hello\n"));

        let _ = fs::remove_dir_all(sandbox);
    }

    #[test]
    fn diff_reports_rename_delete_and_base_ref() {
        let (sandbox, repo) = init_fixture_repo("diff-rename");
        let base = git_read(repo.to_string_lossy().as_ref(), &["rev-parse", "HEAD"])
            .expect("base");
        fs::rename(repo.join("README.md"), repo.join("renamed file.md")).expect("rename");
        git_ok(&repo, &["add", "-A"]);
        let snapshot =
            inspect_repository_blocking(repo.to_string_lossy().to_string()).expect("inspect rename");
        assert!(snapshot.changes.iter().any(|change| {
            change.kind == "renamed"
                && change.old_path.as_deref() == Some("README.md")
                && change.path == "renamed file.md"
        }));

        let index = diff_request(&repo, DiffMode::Index, None, None);
        assert!(index.files.iter().any(|file| {
            file.status.starts_with('R')
                && file.old_path.as_deref() == Some("README.md")
                && file.path == "renamed file.md"
        }));
        git_ok(&repo, &["commit", "-m", "rename"]);

        fs::remove_file(repo.join("renamed file.md")).expect("delete");
        git_ok(&repo, &["add", "-A"]);
        git_ok(&repo, &["commit", "-m", "delete"]);

        let base_diff = diff_request(&repo, DiffMode::Base, None, Some(base.trim()));
        assert!(base_diff.files.iter().any(|file| file.status.starts_with('D')));

        let _ = fs::remove_dir_all(sandbox);
    }

    #[test]
    fn diff_detects_binary_and_bounds_large_patch() {
        let (sandbox, repo) = init_fixture_repo("diff-bounds");
        fs::write(repo.join("blob.bin"), [0u8, 1, 2, 3]).expect("binary");
        git_ok(&repo, &["add", "blob.bin"]);
        git_ok(&repo, &["commit", "-m", "binary"]);
        fs::write(repo.join("blob.bin"), [0u8, 9, 8, 7]).expect("binary modify");

        let binary = diff_request(&repo, DiffMode::Worktree, Some("blob.bin"), None);
        assert!(binary.binary);

        let large = "x".repeat(MAX_DIFF_BYTES + 200_000);
        fs::write(repo.join("large.txt"), large).expect("large");
        git_ok(&repo, &["add", "large.txt"]);
        let bounded = diff_request(&repo, DiffMode::Index, Some("large.txt"), None);
        assert!(bounded.truncated);
        assert!(bounded.returned_bytes <= MAX_DIFF_BYTES);

        let _ = fs::remove_dir_all(sandbox);
    }

    #[test]
    fn diff_rejects_path_escape_and_unregistered_workspace() {
        let (sandbox, repo) = init_fixture_repo("diff-guards");
        let invalid_path = git_diff_blocking(DiffRequest {
            repository_root: repo.to_string_lossy().to_string(),
            workspace_root: repo.to_string_lossy().to_string(),
            path: Some("../outside.txt".to_string()),
            old_path: None,
            mode: DiffMode::Worktree,
            base_ref: None,
        });
        assert!(invalid_path.is_err());

        let other = sandbox.join("other");
        fs::create_dir_all(&other).expect("other repo");
        git_ok(&other, &["init"]);
        let invalid_workspace = git_diff_blocking(DiffRequest {
            repository_root: repo.to_string_lossy().to_string(),
            workspace_root: other.to_string_lossy().to_string(),
            path: None,
            old_path: None,
            mode: DiffMode::Worktree,
            base_ref: None,
        });
        assert!(invalid_workspace.is_err());

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
