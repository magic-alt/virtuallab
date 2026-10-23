use super::*;
use std::{sync::atomic::{AtomicBool, Ordering}, time::{Duration, Instant}};
#[path = "cleanup_analysis.rs"]
mod analysis;
pub use analysis::{CleanupAnalysisManager, git_cleanup_analyze, git_cleanup_cancel};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupTarget {
    branch: String,
    local_sha: Option<String>,
    remote_sha: Option<String>,
    worktree_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPlan {
    repository_root: String,
    selected_workspace: String,
    base_ref: String,
    base_sha: String,
    origin_default_branch: Option<String>,
    origin_default_sha: Option<String>,
    origin_url: Option<String>,
    push_url: Option<String>,
    targets: Vec<CleanupTarget>,
    skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOutcome {
    pub removed: Vec<String>,
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupSelection {
    branch: String,
    local: bool,
    remote: bool,
    worktree: bool,
}

fn validate_selection(plan: &CleanupPlan, selection: &[CleanupSelection]) -> Result<(), String> {
    if selection.is_empty() { return Err("Select at least one cleanup action".into()); }
    let mut seen = HashSet::new();
    for item in selection {
        let target = plan.targets.iter().find(|target| target.branch == item.branch)
            .ok_or("Invalid cleanup selection: branch is not eligible")?;
        if !seen.insert(&item.branch) || !(item.local || item.remote || item.worktree)
            || (item.local && target.local_sha.is_none())
            || (item.remote && target.remote_sha.is_none())
            || (item.worktree && target.worktree_path.is_none())
            || (item.local && target.worktree_path.is_some() && !item.worktree) {
            return Err("Invalid cleanup selection: duplicate, unavailable or occupied action".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn git_cleanup_selected(
    app: tauri::AppHandle, plan: CleanupPlan, selection: Vec<CleanupSelection>, operation_id: String,
) -> Result<CleanupOutcome, String> {
    use tauri::Emitter;
    let lifecycle = app.state::<WorkspaceLifecycle>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        execute_selected_cleanup(plan, selection, &lifecycle, |completed, total, branch| {
            let _ = app.emit("git-cleanup-progress", CleanupProgress {
                operation_id: operation_id.clone(), completed, total, branch: branch.into(),
            });
        })
    }).await.map_err(|_| "Cleanup worker failed".to_string())?
}

/// Preview uses ancestry against the default branch, never a feature's own
/// upstream (a pushed feature is not necessarily merged). No fetch or prune.
pub(super) fn preview_cleanup(root: &str, selected: &str) -> Result<CleanupPlan, String> {
    preview_cleanup_cancellable(root, selected, None)
}

fn preview_cleanup_cancellable(root: &str, selected: &str, cancelled: Option<&AtomicBool>) -> Result<CleanupPlan, String> {
    require_not_cancelled(cancelled)?;
    let (root, selected) = resolve_git_workspace(root, selected)?;
    let root = std::fs::canonicalize(root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let inventory = parse_worktrees(&git_read(
        &root,
        &["worktree", "list", "--porcelain", "-z"],
    )?);
    let origin_url = git_read_optional(&root, &["remote", "get-url", "origin"])
        .map(|raw| cleanup_destination(&root, &raw))
        .transpose()?;
    let push_url = if origin_url.is_some() {
        Some(cleanup_destination(
            &root,
            &git_read(&root, &["remote", "get-url", "--push", "--all", "origin"])?,
        )?)
    } else {
        None
    };
    // A differently configured push destination must never receive deletions
    // based on the fetch server's ancestry/default branch.
    if origin_url != push_url {
        return Err(
            "Origin fetch and push URLs differ. Cleanup requires the same destination.".into(),
        );
    }
    let remote = if origin_url.is_some() {
        Some(remote_heads_cancellable(&root, origin_url.as_deref().unwrap(), cancelled)?)
    } else {
        None
    };
    let base_ref = resolve_cleanup_base(&root, remote.as_ref().map(|(default, _)| default.as_str()))?;
    let base_sha = git_read(
        &root,
        &["rev-parse", "--verify", &format!("{base_ref}^{{commit}}")],
    )?
    .trim()
    .to_string();
    let origin_default_branch = remote.as_ref().map(|(default, _)| default.clone());
    let origin_default_sha = match &remote {
        Some((default, heads)) => Some(
            heads
                .get(default)
                .ok_or("Origin default branch has no commit")?
                .clone(),
        ),
        None => None,
    };
    let selected_key = registered_path_key(&selected)?;
    let primary = inventory
        .first()
        .ok_or("Repository has no registered worktrees")?;
    let primary_key = registered_path_key(&primary.path)?;
    let mut branches = BTreeMap::<String, CleanupTarget>::new();
    let local = git_read(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(objectname)",
            "refs/heads",
        ],
    )?;
    for line in local.lines() {
        let (reference, sha) = line.split_once('\t').ok_or("Invalid branch inventory")?;
        let branch = reference
            .strip_prefix("refs/heads/")
            .ok_or("Invalid local ref")?
            .to_string();
        branches.insert(
            branch.clone(),
            CleanupTarget {
                branch,
                local_sha: Some(sha.into()),
                remote_sha: None,
                worktree_path: None,
            },
        );
    }
    if let Some((_, heads)) = &remote {
        for (branch, sha) in heads {
            branches
                .entry(branch.clone())
                .or_insert_with(|| CleanupTarget {
                    branch: branch.clone(),
                    local_sha: None,
                    remote_sha: None,
                    worktree_path: None,
                })
                .remote_sha = Some(sha.clone());
        }
    }
    let mut targets = Vec::new();
    let mut skipped = Vec::new();
    for (branch, mut target) in branches {
        require_not_cancelled(cancelled)?;
        if matches!(branch.as_str(), "main" | "master") || base_ref == format!("refs/heads/{branch}")
            || remote
                .as_ref()
                .is_some_and(|(default, _)| default == &branch)
        {
            continue;
        }
        let owners: Vec<_> = inventory
            .iter()
            .filter(|t| t.branch.as_deref() == Some(&branch))
            .collect();
        let unsafe_owner = owners.iter().find(|t| {
            let key = registered_path_key(&t.path).ok();
            key.as_ref()
                .is_some_and(|key| Path::new(&selected_key).starts_with(Path::new(key)))
                || key.as_ref() == Some(&primary_key)
                || t.locked
        });
        if unsafe_owner.is_some() || owners.len() > 1 {
            skipped.push(format!("{branch}: current, primary or locked worktree"));
            continue;
        }
        if let Some(tree) = owners.first() {
            if !tree.missing && !cleanup_worktree_clean(&tree.path)? {
                skipped.push(format!(
                    "{branch}: worktree contains changes, untracked or ignored files"
                ));
                continue;
            }
            target.worktree_path = Some(tree.path.clone());
        }
        if let Some(sha) = &target.local_sha {
            if !is_merged(&root, sha, &base_sha)? {
                skipped.push(format!("{branch}: local branch is not merged into {base_ref}; squash/rebase integration is unproven"));
                continue;
            }
        }
        if let Some(sha) = &target.remote_sha {
            // Missing remote objects require an explicit Fetch; never assume merged.
            let merged_on_server = origin_default_sha
                .as_deref()
                .is_some_and(|server_base| is_merged(&root, sha, server_base).unwrap_or(false));
            if !is_merged(&root, sha, &base_sha).unwrap_or(false) || !merged_on_server {
                skipped.push(format!("origin/{branch}: not merged into both {base_ref} and origin's default branch (or commit unavailable; Fetch first)"));
                target.remote_sha = None;
            }
        }
        if target.local_sha.is_some() || target.remote_sha.is_some() {
            targets.push(target);
        } else {
            skipped.push(format!(
                "{branch}: not merged into {base_ref} (or commit unavailable; Fetch first)"
            ));
        }
    }
    Ok(CleanupPlan {
        repository_root: root,
        selected_workspace: selected,
        base_ref,
        base_sha,
        origin_default_branch,
        origin_default_sha,
        origin_url,
        push_url,
        targets,
        skipped,
    })
}

pub(super) fn cleanup_worktree_clean(path: &str) -> Result<bool, String> {
    Ok(git_read(
        path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--ignore-submodules=none",
        ],
    )?
    .is_empty())
}

fn is_merged(root: &str, sha: &str, base: &str) -> Result<bool, String> {
    let output = background_command("git")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("-C")
        .arg(root)
        .args(["merge-base", "--is-ancestor", sha, base])
        .output()
        .map_err(|e| e.to_string())?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(format!(
            "Cannot verify merge ancestry: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
    }
}

// get-url has already expanded origin's rewrite. Applying a matching rule to
// that result again could redirect a native remote operation to another repository.
pub(super) fn require_unrewritten_destination(root: &str, destination: &str) -> Result<(), String> {
    inspect_unrewritten_destination(root, destination, false)
}

pub(crate) fn require_unrewritten_task_destination(root: &str, destination: &str) -> Result<(), String> {
    inspect_unrewritten_destination(root, destination, true)
}

fn inspect_unrewritten_destination(root: &str, destination: &str, isolated_task_git: bool) -> Result<(), String> {
    let mut command = background_command("git");
    // Match task-native Git's environment isolation. Ambient GIT_CONFIG_* or
    // GIT_DIR must not make this qualification inspect a different rule set.
    if isolated_task_git {
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().to_ascii_uppercase().starts_with("GIT_") {
                command.env_remove(name);
            }
        }
    }
    let output = command.env("GIT_TERMINAL_PROMPT", "0").arg("-C")
        .arg(root)
        .args([
            "config",
            "--null",
            "--get-regexp",
            r"^url\..*\.(insteadof|pushinsteadof)$",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    match output.status.code() {
        Some(1) => return Ok(()),
        Some(0) => {}
        _ => return Err("Cannot inspect Git URL rewrite configuration; refusing the remote operation".into()),
    }
    if output.stdout.len() > 2 * 1024 * 1024 { return Err("Git URL rewrite configuration exceeds its qualification bound".into()); }
    let rules = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    for entry in rules.split('\0').filter(|entry| !entry.is_empty()) {
        let (_, prefix) = entry
            .split_once('\n')
            .ok_or("Cannot parse Git URL rewrite configuration")?;
        if destination.starts_with(prefix) {
            return Err("Origin destination would be rewritten again by Git; use an unambiguous origin URL before the remote operation.".into());
        }
    }
    Ok(())
}

fn remote_heads(
    root: &str,
    destination: &str,
) -> Result<(String, BTreeMap<String, String>), String> {
    remote_heads_cancellable(root, destination, None)
}

fn remote_heads_cancellable(root: &str, destination: &str, cancelled: Option<&AtomicBool>) -> Result<(String, BTreeMap<String, String>), String> {
    require_unrewritten_destination(root, destination)?;
    let mut command = background_command("git");
    #[cfg(target_os = "macos")]
    if is_github_https_remote(destination) { configure_github_https_git(&mut command, macos_gh_cli().as_deref()); }
    command.arg("-C").arg(root).args([
            "ls-remote",
            "--symref",
            "--",
            destination,
            "HEAD",
            "refs/heads/*",
        ]).env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let raw = bounded_network_read(command, cancelled, Duration::from_secs(30))?;
    let mut default = None;
    let mut heads = BTreeMap::new();
    for line in raw.lines() {
        let Some((value, reference)) = line.split_once('\t') else {
            continue;
        };
        if reference == "HEAD" {
            if let Some(branch) = value.strip_prefix("ref: refs/heads/") {
                default = Some(branch.to_string());
            }
        } else if let Some(branch) = reference.strip_prefix("refs/heads/") {
            if (value.len() == 40 || value.len() == 64)
                && value.bytes().all(|c| c.is_ascii_hexdigit())
            {
                heads.insert(branch.to_string(), value.to_string());
            }
        }
    }
    Ok((
        default.ok_or("Cannot verify origin default branch; refusing cleanup")?,
        heads,
    ))
}

fn require_not_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), String> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { return Err("Analysis cancelled".into()); }
    Ok(())
}

/// Bound remote inventory reads as well as the model phase. Never expose Git
/// stderr: authentication helpers may echo credential-bearing destinations.
fn bounded_network_read(mut command: std::process::Command, cancelled: Option<&AtomicBool>, timeout: Duration) -> Result<String, String> {
    let mut child = crate::managed_process::spawn(&mut command).map_err(|_| "Cannot start remote inspection")?;
    let stdout = child.stdout.take().ok_or("Remote inspection output unavailable")?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = stdout.take(1_000_001).read_to_end(&mut bytes);
        let _ = tx.send(read.map(|_| bytes));
    });
    let begin = Instant::now();
    let mut output = None;
    let status = loop {
        if let Err(error) = require_not_cancelled(cancelled) { break Err(error); }
        if begin.elapsed() >= timeout { break Err("Remote inspection timed out; retry when the remote is reachable".into()); }
        if output.is_none() {
            match rx.try_recv() {
                Ok(Ok(bytes)) if bytes.len() <= 1_000_000 => output = Some(bytes),
                Ok(_) => break Err("Remote inspection output failed or exceeds limit".to_string()),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break Err("Remote inspection reader disconnected".into()),
                Err(std::sync::mpsc::TryRecvError::Empty) => {},
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => break Err("Remote inspection failed; verify authentication and connectivity".into()),
            Ok(Some(_)) if output.is_some() => break Ok(()),
            Err(_) => break Err("Cannot observe remote inspection exit".into()),
            _ => thread::sleep(Duration::from_millis(30)),
        }
    };
    // Keep native ownership until every descendant is observed stopped, even
    // if the operating system briefly refuses the first termination request.
    while crate::process::terminate_tree(&mut child).is_err() { thread::sleep(Duration::from_millis(30)); }
    status?;
    String::from_utf8(output.ok_or("Remote inspection returned no output")?).map_err(|_| "Invalid remote inventory encoding".into())
}

fn resolve_cleanup_base(root: &str, remote_default: Option<&str>) -> Result<String, String> {
    if let Some(branch) = remote_default {
        for reference in [format!("refs/heads/{branch}"), format!("refs/remotes/origin/{branch}")] {
            if git_read(root, &["rev-parse", "--verify", &format!("{reference}^{{commit}}")]).is_ok() { return Ok(reference); }
        }
        return Err("Default branch commit is unavailable locally. Fetch explicitly before cleanup.".into());
    }
    let candidates: Vec<_> = ["refs/heads/main", "refs/heads/master"].into_iter()
        .filter(|reference| git_read(root, &["show-ref", "--verify", "--quiet", reference]).is_ok()).collect();
    if candidates.len() != 1 { return Err("Cannot determine an unambiguous default branch for cleanup.".into()); }
    Ok(candidates[0].into())
}

// Force URL semantics: an unqualified relative local path could otherwise be
// reinterpreted by Git as another configured remote name.
pub(super) fn cleanup_destination(root: &str, raw: &str) -> Result<String, String> {
    let value = raw.trim_end_matches(['\r', '\n']);
    if value.is_empty() || value.contains(['\r', '\n']) {
        return Err("Cleanup requires exactly one origin destination".into());
    }
    if let Some((scheme, rest)) = value.split_once("://") {
        let authority = rest.split('/').next().unwrap_or("");
        if matches!(scheme, "http" | "https") && (authority.contains('@') || value.contains(['?', '#'])) {
            return Err("Credential-bearing Git URLs cannot be used for reviewed operations; configure a credential helper or SSH authentication.".into());
        }
    }
    let bytes = value.as_bytes();
    let drive = bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    let scp_or_scheme = value
        .find(':')
        .is_some_and(|colon| !value[..colon].contains('/'))
        && !drive;
    if scp_or_scheme {
        return Ok(value.to_string());
    }
    let path = Path::new(value);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(root).join(path)
    };
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve origin destination: {e}"))?;
    worktree_git_path(&canonical.to_string_lossy(), cfg!(windows))
}

fn validate_remote_plan(plan: &CleanupPlan) -> Result<Option<BTreeMap<String, String>>, String> {
    if git_read(
        &plan.repository_root,
        &["rev-parse", "--verify", &plan.base_ref],
    )?
    .trim()
        != plan.base_sha
    {
        return Err("Default branch changed; preview cleanup again".into());
    }
    let Some(destination) = plan.origin_url.as_deref() else {
        return Ok(None);
    };
    if cleanup_destination(
        &plan.repository_root,
        &git_read(&plan.repository_root, &["remote", "get-url", "origin"])?,
    )? != destination
        || cleanup_destination(
            &plan.repository_root,
            &git_read(
                &plan.repository_root,
                &["remote", "get-url", "--push", "--all", "origin"],
            )?,
        )?
        .as_str()
            != plan.push_url.as_deref().unwrap_or("")
    {
        return Err("Origin destination changed; preview cleanup again".into());
    }
    let (default, heads) = remote_heads(&plan.repository_root, destination)?;
    if Some(&default) != plan.origin_default_branch.as_ref()
        || heads.get(&default) != plan.origin_default_sha.as_ref()
    {
        return Err("Origin default branch changed; preview cleanup again".into());
    }
    Ok(Some(heads))
}

#[tauri::command]
pub async fn git_cleanup_preview(
    repository_root: String,
    selected_workspace: String,
) -> Result<CleanupPlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        preview_cleanup(&repository_root, &selected_workspace)
    })
    .await
    .map_err(|e| format!("Cleanup preview failed: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupProgress {
    operation_id: String,
    completed: usize,
    total: usize,
    branch: String,
}

#[tauri::command]
pub async fn git_cleanup_merged(
    app: tauri::AppHandle,
    plan: CleanupPlan,
    operation_id: String,
) -> Result<CleanupOutcome, String> {
    use tauri::Emitter;
    let lifecycle = app.state::<WorkspaceLifecycle>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        execute_cleanup(plan, &lifecycle, |completed, total, branch| {
            let _ = app.emit(
                "git-cleanup-progress",
                CleanupProgress {
                    operation_id: operation_id.clone(),
                    completed,
                    total,
                    branch: branch.into(),
                },
            );
        })
    })
    .await
    .map_err(|e| format!("Merged cleanup failed: {e}"))?
}

pub(super) fn execute_cleanup(
    plan: CleanupPlan,
    lifecycle: &WorkspaceLifecycle,
    progress: impl FnMut(usize, usize, &str),
) -> Result<CleanupOutcome, String> {
    let selection = plan.targets.iter().map(|target| CleanupSelection {
        branch: target.branch.clone(), local: target.local_sha.is_some(), remote: target.remote_sha.is_some(), worktree: target.worktree_path.is_some(),
    }).collect();
    if plan.targets.is_empty() { return Ok(CleanupOutcome { removed: vec![], failed: vec![] }); }
    execute_selected_cleanup(plan, selection, lifecycle, progress)
}

pub(super) fn execute_selected_cleanup(
    plan: CleanupPlan,
    selection: Vec<CleanupSelection>,
    lifecycle: &WorkspaceLifecycle,
    mut progress: impl FnMut(usize, usize, &str),
) -> Result<CleanupOutcome, String> {
    validate_selection(&plan, &selection)?;
    // Reject forged paths and any changes while the confirmation was open.
    let current = preview_cleanup(&plan.repository_root, &plan.selected_workspace)?;
    if current != plan {
        return Err("Cleanup preview is stale. Preview again before deleting anything.".into());
    }
    let mut outcome = CleanupOutcome {
        removed: Vec::new(),
        failed: Vec::new(),
    };
    for (index, item) in selection.iter().enumerate() {
        let target = plan.targets.iter().find(|target| target.branch == item.branch).ok_or("Invalid selection")?;
        progress(index, selection.len(), &target.branch);
        let local = (|| -> Result<(), String> {
            validate_remote_plan(&plan)?;
            if let Some(path) = target.worktree_path.as_ref().filter(|_| item.worktree) {
                if !matches!(std::fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
                {
                    if !cleanup_worktree_clean(path)? {
                        return Err("Worktree changed; refusing cleanup".into());
                    }
                    let actual = worktree_removal_state(path)?.0;
                    if Some(&actual.head_sha) != target.local_sha.as_ref()
                        || actual.branch != format!("refs/heads/{}", target.branch)
                    {
                        return Err("Worktree HEAD changed; refusing cleanup".into());
                    }
                }
                let guard = LocalBranchDeletionState {
                    repository_root: plan.repository_root.clone(),
                    branch: target.branch.clone(),
                    branch_head_sha: target
                        .local_sha
                        .clone()
                        .ok_or("Missing cleanup branch SHA")?,
                    comparison_ref: plan.base_ref.clone(),
                    comparison_head_sha: plan.base_sha.clone(),
                };
                match remove_worktree_guarded(
                    plan.repository_root.clone(),
                    path.clone(),
                    false,
                    None,
                    lifecycle,
                    Some(&guard),
                )? {
                    WorktreeRemovalResult::Removed => {
                        outcome.removed.push(format!("worktree {path}"))
                    }
                    _ => return Err("Worktree became dirty; refusing cleanup".into()),
                }
            }
            if let Some(sha) = target.local_sha.as_ref().filter(|_| item.local) {
                let _claim = lifecycle.reserve(&plan.repository_root, "merged branch cleanup")?;
                if !is_merged(&plan.repository_root, sha, &plan.base_sha)? {
                    return Err("Branch is not merged".into());
                }
                // Atomic compare-and-delete also verifies the approved base SHA.
                force_delete_local_branch_ref(
                    &plan.repository_root,
                    &LocalBranchDeletionState {
                        repository_root: plan.repository_root.clone(),
                        branch: target.branch.clone(),
                        branch_head_sha: sha.clone(),
                        comparison_ref: plan.base_ref.clone(),
                        comparison_head_sha: plan.base_sha.clone(),
                    },
                )?;
                outcome.removed.push(format!("local {}", target.branch));
            }
            Ok(())
        })();
        if let Err(error) = local {
            outcome.failed.push(format!("{}: {error}", target.branch));
            progress(index + 1, selection.len(), &target.branch);
            continue; // Keep its remote branch too if local work could not be safely retired.
        }
        if let Some(sha) = target.remote_sha.as_ref().filter(|_| item.remote) {
            let result = (|| -> Result<(), String> {
                let _claim =
                    lifecycle.reserve(&plan.repository_root, "merged remote branch cleanup")?;
                let heads = validate_remote_plan(&plan)?.ok_or("Missing origin destination")?;
                if heads.get(&target.branch) != Some(sha) {
                    return Err("Origin branch changed; preview cleanup again".into());
                }
                let reference = format!("refs/heads/{}", target.branch);
                let lease = format!("--force-with-lease={reference}:{sha}");
                let destination = plan
                    .push_url
                    .as_deref()
                    .ok_or("Missing approved destination")?;
                require_unrewritten_destination(&plan.repository_root, destination)?;
                git_network_at(
                    &plan.repository_root,
                    destination,
                    &["push", &lease, "--", destination, &format!(":{reference}")],
                    true,
                )?;
                let tracking = format!("refs/remotes/origin/{}", target.branch);
                // Do not delete a concurrently updated local tracking ref.
                if git_read_optional(&plan.repository_root, &["rev-parse", "--verify", &tracking])
                    .as_deref()
                    .map(str::trim)
                    == Some(sha)
                {
                    git(&plan.repository_root, &["update-ref", "-d", &tracking, sha])?;
                }
                Ok(())
            })();
            match result {
                Ok(()) => outcome.removed.push(format!("origin/{}", target.branch)),
                Err(error) => outcome
                    .failed
                    .push(format!("origin/{}: {error}", target.branch)),
            }
        }
        progress(index + 1, selection.len(), &target.branch);
    }
    Ok(outcome)
}
