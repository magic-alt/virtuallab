//! Opt-in, native-owned draft PR delivery. Provider turns never receive Git or
//! GitHub mutation authority. Write intentions are persisted before network I/O;
//! execution attempts remain immutable when publication needs a separate retry.
use crate::tasks::{now_ms, TaskManager, TaskPrDelivery, TaskRecord};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{atomic::{AtomicBool, Ordering}, Arc},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub(crate) fn validate_branch_name(branch: &str) -> Result<(), String> {
    if branch.is_empty() || branch.len() > 240 || branch.starts_with('-') || branch.starts_with("refs/")
        || branch == "HEAD" || branch == "@" || branch.contains("..") || branch.contains("@{")
        || branch.chars().any(|c| c.is_control() || " ~^:?*[\\".contains(c))
        || branch.split('/').any(|part| part.is_empty() || part.starts_with('.') || part.ends_with('.') || part.ends_with(".lock")) {
        return Err("PR branches must be bounded literal Git branch names".into());
    }
    Ok(())
}

pub(crate) fn validate_policy(enabled: bool, auto_commit: bool, kind: &str, base: Option<&str>) -> Result<(), String> {
    if enabled && (!auto_commit || kind != "implementation") {
        return Err("Automatic draft PR delivery requires an implementation task with native automatic commit enabled".into());
    }
    if let Some(base) = base {
        if !enabled { return Err("A PR base branch requires automatic draft PR delivery to be enabled".into()); }
        validate_branch_name(base)?;
    }
    Ok(())
}

fn valid_repository(repository: &str) -> bool {
    let parts: Vec<_> = repository.split('/').collect();
    parts.len() == 2 && parts.iter().all(|part| !part.is_empty() && part.len() <= 100
        && !matches!(*part, "." | "..") && !part.starts_with('-')
        && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte)))
}

fn remote_repository(remote: &str) -> Result<String, String> {
    // Only the existing GitHub host is supported; embedded credentials, URL
    // query/fragment/port tricks, URL helpers and plaintext HTTP fail closed.
    let path = ["https://github.com/", "git@github.com:", "ssh://git@github.com/"]
        .iter().find_map(|prefix| remote.strip_prefix(prefix))
        .ok_or("Automatic PR delivery requires a secure github.com origin URL")?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let expected = path.strip_suffix(".git").unwrap_or(path);
    let repository = crate::github::parse_github_remote(remote)
        .filter(|repository| valid_repository(repository) && repository == expected)
        .ok_or("GitHub origin repository identity is ambiguous or invalid")?;
    Ok(repository)
}

fn single_remote(value: &str) -> Result<&str, String> {
    let lines: Vec<_> = value.lines().collect();
    if lines.len() != 1 || lines[0].is_empty() || lines[0].trim() != lines[0] {
        return Err("PR delivery requires exactly one origin fetch URL and one origin push URL".into());
    }
    Ok(lines[0])
}

/// Read-only acceptance qualification pins the destination before provider
/// startup. Authentication is checked at delivery so local execution can finish
/// while GitHub credentials or connectivity are temporarily unavailable.
pub(crate) fn approved_repository(root: &Path) -> Result<String, String> {
    let fetch = crate::task_inputs::git(root, &["remote", "get-url", "--all", "origin"])?;
    let push = crate::task_inputs::git(root, &["remote", "get-url", "--push", "--all", "origin"])?;
    let fetch = single_remote(&fetch)?;
    let push = single_remote(&push)?;
    let repository = remote_repository(fetch)?;
    if !remote_repository(push)?.eq_ignore_ascii_case(&repository) {
        return Err("Origin fetch and push URLs target different GitHub repositories".into());
    }
    require_unrewritten(root, fetch)?;
    require_unrewritten(root, push)?;
    Ok(repository)
}

fn require_unrewritten(root: &Path, destination: &str) -> Result<(), String> {
    crate::git::require_unrewritten_task_destination(root.to_str().ok_or("Repository root is not Unicode")?, destination)
}

fn valid_sha(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn validate_record(task: &TaskRecord) -> Result<(), String> {
    if !task.auto_draft_pr {
        if task.pr_repository.is_some() || task.delivery.is_some() { return Err("PR delivery metadata requires the accepted task opt-in".into()); }
        return Ok(());
    }
    let repository = task.pr_repository.as_deref().filter(|value| valid_repository(value))
        .ok_or("Automatic PR task is missing its native-approved repository")?;
    let Some(delivery) = &task.delivery else { return Ok(()); };
    if !matches!(delivery.status.as_str(), "pending" | "running" | "failed" | "reconcile_required" | "delivered")
        || !matches!(delivery.stage.as_str(), "preflight" | "push" | "create_pr" | "complete")
        || !valid_sha(&delivery.candidate_sha)
        || !task.attempts.iter().any(|attempt| attempt.id == delivery.attempt_id && attempt.state == "succeeded" && attempt.candidate_sha.as_deref() == Some(&delivery.candidate_sha))
        || delivery.repository.as_deref() != Some(repository)
        || delivery.updated_at_ms < task.created_at_ms {
        return Err("Invalid durable PR delivery identity or status".into());
    }
    for branch in [&delivery.branch, &delivery.base_branch].into_iter().flatten() { validate_branch_name(branch)?; }
    if let Some(sha) = &delivery.remote_base_sha { if !valid_sha(sha) { return Err("Invalid PR base SHA".into()); } }
    if delivery.stage != "preflight" && (delivery.branch.is_none() || delivery.base_branch.is_none() || delivery.remote_base_sha.is_none()) {
        return Err("External PR write intention requires an exact branch and base snapshot".into());
    }
    if (delivery.status == "delivered") != (delivery.stage == "complete")
        || (delivery.status == "delivered") != delivery.pull_request_url.is_some()
        || delivery.pull_request_url.is_some() != delivery.pull_request_number.is_some() {
        return Err("Incomplete durable PR result".into());
    }
    if let (Some(url), Some(number)) = (&delivery.pull_request_url, delivery.pull_request_number) {
        validate_pr_url(repository, number, url)?;
    }
    if delivery.error.as_ref().is_some_and(|error| error.len() > 4096 || error.contains('\0')) {
        return Err("Invalid durable PR delivery error".into());
    }
    Ok(())
}

pub(crate) fn validate_delivery_mutation(old: Option<&TaskPrDelivery>, new: Option<&TaskPrDelivery>) -> Result<(), String> {
    let Some(old) = old else { return Ok(()); };
    let new = new.ok_or("PR delivery history cannot be discarded")?;
    if old.status == "delivered" && old != new { return Err("Delivered PR receipts are historical and immutable".into()); }
    if old.stage != "preflight" && (old.candidate_sha != new.candidate_sha || old.repository != new.repository
        || old.branch != new.branch || old.base_branch != new.base_branch || old.remote_base_sha != new.remote_base_sha
        || (old.stage == "create_pr" && new.stage == "push") || new.stage == "preflight") {
        return Err("A persisted external write intention cannot change its target or candidate".into());
    }
    Ok(())
}

trait DeliveryIo {
    fn check(&self) -> Result<(), String>;
    fn git(&mut self, root: &Path, args: &[&str]) -> Result<String, String>;
    fn gh(&mut self, root: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Value, String>;
    fn qualify(&mut self, root: &Path, repository: &str) -> Result<(), String>;
}

struct NativeIo<'a> { app: &'a AppHandle, task_id: &'a str }
impl DeliveryIo for NativeIo<'_> {
    fn check(&self) -> Result<(), String> {
        let execution = self.app.state::<crate::task_execution::TaskExecution>();
        if execution.is_closed() || execution.cancellation_requested(self.task_id)? {
            return Err("PR delivery stopped; saved remote outcomes require reconciliation".into());
        }
        Ok(())
    }
    fn git(&mut self, root: &Path, args: &[&str]) -> Result<String, String> { run_command(root, "git", args, None, &|| self.check()) }
    fn gh(&mut self, root: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Value, String> {
        serde_json::from_str(&run_command(root, "gh", args, input, &|| self.check())?)
            .map_err(|_| "GitHub returned an invalid or incomplete JSON result".into())
    }
    fn qualify(&mut self, root: &Path, repository: &str) -> Result<(), String> {
        self.check()?;
        crate::github::qualify_task_delivery(root.to_str().ok_or("Task worktree is not Unicode")?, repository)?;
        self.check()
    }
}

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
fn drain(mut reader: impl Read, limit: usize, overflow: Arc<AtomicBool>) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer).map_err(|_| "Delivery output could not be observed")?;
        if count == 0 { return Ok(bytes); }
        let retained = count.min(limit.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..retained]);
        if retained != count { overflow.store(true, Ordering::Release); }
    }
}

/// An explicit executable and argument vector only. Both streams, stdin and the
/// process tree are owned until shutdown; credential prompts are disabled.
fn run_command(root: &Path, executable: &str, args: &[&str], input: Option<&[u8]>, check: &dyn Fn() -> Result<(), String>) -> Result<String, String> {
    check()?;
    let mut command = crate::process::background_command(executable);
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().to_ascii_uppercase().starts_with("GIT_") { command.env_remove(name); }
    }
    command.env_remove("GH_REPO").env_remove("GH_HOST").env_remove("GH_FORCE_TTY")
        .env("GH_PROMPT_DISABLED", "1").env("GIT_TERMINAL_PROMPT", "0").env("GCM_INTERACTIVE", "never");
    if executable == "git" {
        command.args(["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "push.followTags=false", "-c", "push.gpgSign=false"]);
        if matches!(args.first(), Some(&"ls-remote") | Some(&"push")) {
            let destination = args.iter().position(|arg| *arg == "--").and_then(|index| args.get(index + 1))
                .ok_or("Native Git delivery requires an explicit destination")?;
            crate::git::configure_task_github_transport(&mut command, destination)?;
        }
    }
    command.args(args).current_dir(root).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = crate::managed_process::spawn(&mut command).map_err(|error| format!("Cannot start {executable}: {error}"))?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().ok_or("Delivery output pipe unavailable")?;
    let stderr = child.stderr.take().ok_or("Delivery diagnostic pipe unavailable")?;
    let out_flag = overflow.clone();
    let err_flag = overflow.clone();
    let out = thread::spawn(move || drain(stdout, OUTPUT_LIMIT, out_flag));
    let err = thread::spawn(move || drain(stderr, 64 * 1024, err_flag));
    let writer = input.map(|bytes| {
        let bytes = bytes.to_vec();
        let mut stdin = child.stdin.take().expect("requested stdin pipe");
        thread::spawn(move || stdin.write_all(&bytes))
    });
    let started = Instant::now();
    let mut failure = None;
    let status = loop {
        if let Err(error) = check() { failure = Some(error); break None; }
        if overflow.load(Ordering::Acquire) { failure = Some("PR delivery command exceeded its output bound".into()); break None; }
        if started.elapsed() >= Duration::from_secs(120) { failure = Some("PR delivery command timed out; its external outcome must be reconciled".into()); break None; }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => { failure = Some(format!("PR delivery exit could not be observed: {error}")); break None; }
        }
    };
    while crate::process::terminate_tree(&mut child).is_err() { thread::sleep(Duration::from_millis(50)); }
    let stdout = out.join().map_err(|_| "Delivery output reader failed")??;
    let stderr = err.join().map_err(|_| "Delivery diagnostic reader failed")??;
    if let Some(writer) = writer { writer.join().map_err(|_| "Delivery input writer failed")?.map_err(|_| "Delivery request input could not be written")?; }
    if let Some(error) = failure { return Err(error); }
    if overflow.load(Ordering::Acquire) { return Err("PR delivery output exceeded its bound".into()); }
    if !status.is_some_and(|status| status.success()) {
        let detail = crate::task_reports::bounded_text(&String::from_utf8_lossy(&stderr), 3000).0;
        return Err(format!("{executable} delivery request failed. Check GitHub authentication, repository push permission and connectivity. {detail}"));
    }
    String::from_utf8(stdout).map_err(|_| "PR delivery returned non-Unicode output".into())
}

fn save(manager: &TaskManager, id: &str, delivery: &TaskPrDelivery, notify: &dyn Fn()) -> Result<TaskRecord, String> {
    let saved = manager.record(id, Some(&delivery.attempt_id), "delivery.updated", |task| {
        if task.attempts.last().is_none_or(|attempt| attempt.id != delivery.attempt_id || attempt.state != "succeeded" || attempt.candidate_sha.as_deref() != Some(&delivery.candidate_sha)) {
            return Err("Task candidate changed during PR delivery".into());
        }
        task.delivery = Some(delivery.clone());
        Ok(())
    })?;
    notify();
    Ok(saved)
}

fn begin(manager: &TaskManager, id: &str, notify: &dyn Fn()) -> Result<TaskRecord, String> {
    let task = manager.get(id)?;
    validate_policy(task.auto_draft_pr, task.auto_commit, &task.kind, task.pr_base_branch.as_deref())?;
    if !task.auto_draft_pr { return Err("This task did not authorize automatic draft PR delivery at creation".into()); }
    if let Some(delivery) = task.delivery.as_ref().filter(|delivery| delivery.status == "delivered") {
        if task.attempts.last().and_then(|attempt| attempt.candidate_sha.as_deref()) != Some(&delivery.candidate_sha) {
            return Err("This task already delivered an immutable earlier candidate. The new result has not been published; create a follow-up task for another draft PR.".into());
        }
        return Ok(task);
    }
    let attempt = task.attempts.last().filter(|attempt| attempt.state == "succeeded" && attempt.ended_at_ms.is_some())
        .ok_or("Draft PR delivery requires a successfully completed native task attempt")?;
    let candidate = attempt.candidate_sha.as_ref().ok_or("Draft PR delivery requires a sealed candidate commit")?;
    let mut delivery = task.delivery.clone().unwrap_or(TaskPrDelivery {
        status: "pending".into(), stage: "preflight".into(), attempt_id: attempt.id.clone(), candidate_sha: candidate.clone(),
        repository: task.pr_repository.clone(), branch: None, base_branch: None, remote_base_sha: None,
        pull_request_url: None, pull_request_number: None, error: None, updated_at_ms: now_ms(),
    });
    if delivery.candidate_sha != *candidate && delivery.stage != "preflight" {
        return Err("A different candidate already has a retained external delivery intention; reconcile that delivery before creating another task".into());
    }
    delivery.attempt_id = attempt.id.clone();
    delivery.candidate_sha = candidate.clone();
    delivery.status = "running".into();
    delivery.error = None;
    delivery.updated_at_ms = now_ms().max(task.created_at_ms);
    save(manager, id, &delivery, notify)
}

fn finish_error(manager: &TaskManager, id: &str, error: &str, notify: &dyn Fn()) -> Result<TaskRecord, String> {
    let task = manager.get(id)?;
    let mut delivery = task.delivery.ok_or("PR delivery receipt is missing")?;
    if delivery.status == "delivered" { return manager.get(id); }
    delivery.status = if matches!(delivery.stage.as_str(), "push" | "create_pr") { "reconcile_required" } else { "failed" }.into();
    delivery.error = Some(crate::task_reports::bounded_text(error, 4096).0.replace('\0', ""));
    delivery.updated_at_ms = now_ms().max(delivery.updated_at_ms);
    save(manager, id, &delivery, notify)
}

fn workspace(task: &TaskRecord) -> Result<PathBuf, String> {
    let repository = std::fs::canonicalize(&task.repository_root).map_err(|_| "Selected repository is unavailable")?;
    let workspace = crate::task_inputs::registered_workspace(&repository, Path::new(task.workspace_root.as_deref().ok_or("Task worktree is missing")?))?;
    if workspace == repository { return Err("PR delivery requires the task's separate registered worktree".into()); }
    let git_identity = |root: &Path| -> Result<PathBuf, String> {
        let path = crate::task_inputs::git(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
        std::fs::canonicalize(path.trim_end()).map_err(|_| "Task repository Git identity is unavailable".into())
    };
    if git_identity(&repository)? != git_identity(&workspace)? {
        return Err("Registered task worktree Git metadata no longer belongs to the approved repository".into());
    }
    let top = crate::task_inputs::git(&workspace, &["rev-parse", "--show-toplevel"])?;
    if std::fs::canonicalize(top.trim_end()).map_err(|_| "Task Git root is unavailable")? != workspace {
        return Err("Task worktree root changed after preparation".into());
    }
    Ok(workspace)
}

fn origin(io: &mut dyn DeliveryIo, root: &Path, expected: &str) -> Result<String, String> {
    let fetch = io.git(root, &["remote", "get-url", "--all", "origin"])?;
    let push = io.git(root, &["remote", "get-url", "--push", "--all", "origin"])?;
    let fetch = single_remote(&fetch)?;
    let push = single_remote(&push)?;
    if !remote_repository(fetch)?.eq_ignore_ascii_case(expected) || !remote_repository(push)?.eq_ignore_ascii_case(expected) {
        return Err("Origin no longer matches the GitHub repository approved when this task was created".into());
    }
    require_unrewritten(root, fetch)?;
    require_unrewritten(root, push)?;
    Ok(push.into())
}

fn inspect_candidate(task: &TaskRecord, root: &Path, delivery: &TaskPrDelivery, validate: &dyn Fn(&TaskRecord) -> Result<(), String>) -> Result<(), String> {
    let branch = delivery.branch.as_deref().ok_or("Delivery branch is missing")?;
    let symbolic = crate::task_inputs::git(root, &["symbolic-ref", "--quiet", "HEAD"])?;
    if symbolic.trim_end() != format!("refs/heads/{branch}") { return Err("Task branch changed or HEAD is detached; no publication performed".into()); }
    let (sources, outputs) = if let Some(profile) = &task.profile {
        (crate::task_evidence::profile_paths(profile, "sourcePaths")?, crate::task_evidence::profile_paths(profile, "outputPaths")?)
    } else { (Vec::new(), Vec::new()) };
    let source = crate::task_inputs::source_identity(root, &sources, &outputs)?;
    if !source.clean || source.head_sha != delivery.candidate_sha { return Err("Draft PR delivery requires the exact clean sealed candidate; worktree inputs or HEAD changed".into()); }
    crate::task_execution::validate_scope(root, &task.base_sha, &delivery.candidate_sha, &task.scope)?;
    if let Some(base) = &delivery.remote_base_sha {
        crate::task_execution::validate_scope(root, base, &delivery.candidate_sha, &task.scope)
            .map_err(|error| format!("The remote PR base is not an available ancestor within the approved scope: {error}"))?;
        if crate::task_inputs::git(root, &["diff", "--no-renames", "--name-only", "-z", base, &delivery.candidate_sha, "--"])?.is_empty() {
            return Err("The sealed candidate has no changes against the PR base".into());
        }
    }
    validate(task)
}

fn remote_sha(io: &mut dyn DeliveryIo, root: &Path, url: &str, branch: &str) -> Result<Option<String>, String> {
    require_unrewritten(root, url)?;
    let reference = format!("refs/heads/{branch}");
    let output = io.git(root, &["ls-remote", "--heads", "--", url, &reference])?;
    if output.is_empty() { return Ok(None); }
    let lines: Vec<_> = output.lines().collect();
    if lines.len() != 1 { return Err("Remote branch inspection returned an ambiguous result".into()); }
    let (sha, observed_ref) = lines[0].split_once('\t').ok_or("Remote branch inspection returned invalid metadata")?;
    if !valid_sha(sha) || observed_ref != reference { return Err("Remote branch identity did not match the requested literal reference".into()); }
    Ok(Some(sha.into()))
}

fn create_only_push_arguments(url: &str, branch: &str, candidate: &str) -> Vec<String> {
    vec!["push".into(), "--porcelain".into(), "--no-verify".into(), "--recurse-submodules=no".into(),
        // Empty expected value is a create-only compare-and-swap. It cannot
        // overwrite an existing ref, including an ancestor created after our
        // read. No user-supplied force or expected-SHA option is accepted.
        format!("--force-with-lease=refs/heads/{branch}:"), "--".into(), url.into(), format!("{candidate}:refs/heads/{branch}")]
}

fn validate_pr_url(repository: &str, number: u64, url: &str) -> Result<(), String> {
    if number == 0 || !url.eq_ignore_ascii_case(&format!("https://github.com/{repository}/pull/{number}")) {
        return Err("GitHub returned an unexpected PR URL".into());
    }
    Ok(())
}

fn marker(task: &TaskRecord) -> String { format!("<!-- virtuallab-task:{} -->", task.id) }

fn matched_pr(task: &TaskRecord, delivery: &TaskPrDelivery, value: &Value) -> Result<(u64, String), String> {
    let repository = delivery.repository.as_deref().ok_or("Missing PR repository")?;
    let number = value["number"].as_u64().ok_or("GitHub PR number is missing")?;
    let url = value["html_url"].as_str().ok_or("GitHub PR URL is missing")?;
    validate_pr_url(repository, number, url)?;
    if value["state"] != "open" || value["draft"] != true
        || value["head"]["ref"].as_str() != delivery.branch.as_deref()
        || value["base"]["ref"].as_str() != delivery.base_branch.as_deref()
        || value["head"]["sha"].as_str() != Some(&delivery.candidate_sha)
        || ![&value["head"]["repo"]["full_name"], &value["base"]["repo"]["full_name"]].iter()
            .all(|name| name.as_str().is_some_and(|name| name.eq_ignore_ascii_case(repository)))
        || !value["body"].as_str().is_some_and(|body| body.lines().any(|line| line == marker(task))) {
        return Err("An existing PR has a different task marker, repository, branch, base, candidate or draft state; no duplicate PR will be created".into());
    }
    Ok((number, url.into()))
}

fn existing_pr(io: &mut dyn DeliveryIo, root: &Path, task: &TaskRecord, delivery: &TaskPrDelivery) -> Result<Option<(u64, String)>, String> {
    let repository = delivery.repository.as_deref().ok_or("Missing PR repository")?;
    let owner = repository.split('/').next().unwrap();
    let endpoint = format!("repos/{repository}/pulls");
    let head = format!("head={owner}:{}", delivery.branch.as_deref().ok_or("Missing PR branch")?);
    // Include closed PRs and every base. A reused/closed/mismatched head must not
    // be silently published again. A full page is ambiguous and fails closed.
    let value = io.gh(root, &["api", "--hostname", "github.com", "--method", "GET", &endpoint,
        "-f", "state=all", "-f", &head, "-f", "per_page=100"], None)?;
    let prs = value.as_array().ok_or("GitHub PR reconciliation did not return an array")?;
    match prs.as_slice() {
        [] => Ok(None),
        [one] => matched_pr(task, delivery, one).map(Some),
        _ => Err("Multiple PRs use the task branch; manual reconciliation is required and no PR will be created".into()),
    }
}

fn delivered(manager: &TaskManager, task: &TaskRecord, delivery: &mut TaskPrDelivery, number: u64, url: String, notify: &dyn Fn()) -> Result<TaskRecord, String> {
    delivery.status = "delivered".into(); delivery.stage = "complete".into();
    delivery.pull_request_number = Some(number); delivery.pull_request_url = Some(url);
    delivery.error = None; delivery.updated_at_ms = now_ms().max(delivery.updated_at_ms);
    save(manager, &task.id, delivery, notify)
}

fn pr_body(task: &TaskRecord, delivery: &TaskPrDelivery) -> String {
    let verification = task.attempts.last().and_then(|attempt| attempt.evidence.as_ref()).map(|evidence| {
        format!("Native formal verification passed. Run: `{}`. Candidate: `{}`.", evidence.run_id, evidence.head_sha)
    }).filter(|_| task.profile.is_some()).unwrap_or_else(||
        "Unverified: no formal verification profile was configured. Provider completion and local checks do not establish formal acceptance.".into());
    let scope = task.scope.iter().map(|path| format!("- `{path}`")).collect::<Vec<_>>().join("\n");
    format!("{}\n\n## Task\n\n{}\n\n## Approved scope\n\n{}\n\n## Verification\n\n{}\n\n## Review\n\nNative sealed candidate `{}`. This is a draft for human review; it does not record task acceptance or authorize merging.\n",
        marker(task), crate::task_reports::bounded_text(&task.goal, 8192).0,
        crate::task_reports::bounded_text(&scope, 8192).0, verification, delivery.candidate_sha)
}

fn perform(manager: &TaskManager, task: &TaskRecord, io: &mut dyn DeliveryIo, validate: &dyn Fn(&TaskRecord) -> Result<(), String>, notify: &dyn Fn()) -> Result<TaskRecord, String> {
    io.check()?;
    let root = workspace(task)?;
    let mut delivery = task.delivery.clone().ok_or("PR delivery receipt missing")?;
    let repository = task.pr_repository.as_deref().ok_or("Task approved repository missing")?;
    let branch = crate::task_execution::delivery_branch(manager, task)?;
    validate_branch_name(&branch)?;
    if delivery.branch.as_ref().is_some_and(|saved| saved != &branch) { return Err("Prepared task branch differs from the persisted delivery target".into()); }
    let url = origin(io, &root, repository)?;
    origin(io, Path::new(&task.repository_root), repository)?;
    io.qualify(&root, repository)?;
    let endpoint = format!("repos/{repository}");
    let repo = io.gh(&root, &["api", "--hostname", "github.com", "--method", "GET", &endpoint], None)?;
    if !repo["full_name"].as_str().is_some_and(|name| name.eq_ignore_ascii_case(repository)) {
        return Err("GitHub resolved a different repository; refresh the approved destination".into());
    }
    let base = delivery.base_branch.clone().or_else(|| task.pr_base_branch.clone())
        .or_else(|| repo["default_branch"].as_str().map(str::to_owned)).ok_or("GitHub repository default branch is unavailable")?;
    validate_branch_name(&base)?;
    if branch == base { return Err("The task branch cannot be the PR base branch".into()); }
    delivery.branch = Some(branch.clone()); delivery.base_branch = Some(base.clone());
    let base_sha = remote_sha(io, &root, &url, &base)?.ok_or("PR base branch is missing on the approved remote")?;
    if delivery.remote_base_sha.as_ref().is_some_and(|saved| saved != &base_sha) {
        // A previously created PR may still be recovered when the target base
        // advanced. Only new writes require the original base snapshot below.
        if let Some((number, link)) = existing_pr(io, &root, task, &delivery)? {
            return delivered(manager, task, &mut delivery, number, link, notify);
        }
        return Err("The remote PR base changed after delivery was prepared; no further write was performed".into());
    }
    delivery.remote_base_sha = Some(base_sha.clone());
    delivery.updated_at_ms = now_ms().max(delivery.updated_at_ms);
    save(manager, &task.id, &delivery, notify)?;
    if let Some((number, link)) = existing_pr(io, &root, task, &delivery)? {
        if remote_sha(io, &root, &url, &branch)?.as_deref() != Some(&delivery.candidate_sha) {
            return Err("Existing PR branch no longer matches the sealed candidate".into());
        }
        return delivered(manager, task, &mut delivery, number, link, notify);
    }
    if delivery.stage == "create_pr" {
        return Err("A prior PR creation outcome is unknown and no exact PR is visible yet. Retry only reconciles this outcome; creation is not replayed, to prevent duplicate PRs.".into());
    }
    if repo["permissions"]["push"] != true { return Err("The authenticated GitHub account lacks push permission to the approved repository; fork delivery is not enabled".into()); }
    inspect_candidate(task, &root, &delivery, validate)?;
    let current_remote = remote_sha(io, &root, &url, &branch)?;
    if current_remote.as_deref().is_some_and(|sha| sha != delivery.candidate_sha) {
        return Err("Remote task branch contains a different commit; automatic PR delivery never overwrites or force-pushes it".into());
    }
    if current_remote.is_none() {
        delivery.stage = "push".into(); delivery.updated_at_ms = now_ms().max(delivery.updated_at_ms);
        save(manager, &task.id, &delivery, notify)?;
        io.check()?;
        if origin(io, &root, repository)? != url || remote_sha(io, &root, &url, &base)?.as_deref() != Some(&base_sha) {
            return Err("Remote target or base changed immediately before push".into());
        }
        inspect_candidate(&manager.get(&task.id)?, &root, &delivery, validate)?;
        require_unrewritten(&root, &url)?;
        io.check()?;
        // One immutable commit and a create-only ref. No hooks, tags, overwrite,
        // implicit remote, upstream change, submodule publication or merge.
        let arguments = create_only_push_arguments(&url, &branch, &delivery.candidate_sha);
        let arguments: Vec<_> = arguments.iter().map(String::as_str).collect();
        let outcome = io.git(&root, &arguments);
        let observed = remote_sha(io, &root, &url, &branch)?;
        if observed.as_deref() != Some(&delivery.candidate_sha) {
            return Err(outcome.err().unwrap_or_else(|| "Push returned without the exact candidate appearing on the approved remote".into()));
        }
    }
    if let Some((number, link)) = existing_pr(io, &root, task, &delivery)? {
        return delivered(manager, task, &mut delivery, number, link, notify);
    }
    io.check()?;
    inspect_candidate(&manager.get(&task.id)?, &root, &delivery, validate)?;
    if origin(io, &root, repository)? != url || remote_sha(io, &root, &url, &base)?.as_deref() != Some(&base_sha)
        || remote_sha(io, &root, &url, &branch)?.as_deref() != Some(&delivery.candidate_sha) {
        return Err("Remote target, base or candidate changed immediately before PR creation".into());
    }
    delivery.stage = "create_pr".into(); delivery.updated_at_ms = now_ms().max(delivery.updated_at_ms);
    save(manager, &task.id, &delivery, notify)?;
    io.check()?;
    let endpoint = format!("repos/{repository}/pulls");
    let body = serde_json::to_vec(&json!({"title":task.title,"head":branch,"base":base,"body":pr_body(task, &delivery),"draft":true,"maintainer_can_modify":false}))
        .map_err(|_| "Cannot encode the draft PR request")?;
    // The API cannot implicitly push or choose a fork/default base. JSON enters
    // stdin rather than a command string or a provider-controlled filesystem file.
    let created = io.gh(&root, &["api", "--hostname", "github.com", "--method", "POST", &endpoint, "--input", "-"], Some(&body));
    match created.and_then(|value| matched_pr(task, &delivery, &value)) {
        Ok((number, link)) => delivered(manager, task, &mut delivery, number, link, notify),
        Err(error) => {
            // A timeout/parse failure can follow a successful server commit.
            // Read reconciliation may complete the receipt, but never replay POST.
            if let Ok(Some((number, link))) = existing_pr(io, &root, task, &delivery) {
                return delivered(manager, task, &mut delivery, number, link, notify);
            }
            Err(format!("PR creation outcome requires reconciliation: {error}"))
        }
    }
}

fn deliver_with(manager: &TaskManager, id: &str, io: &mut dyn DeliveryIo, validate: &dyn Fn(&TaskRecord) -> Result<(), String>, notify: &dyn Fn()) -> Result<TaskRecord, String> {
    let task = begin(manager, id, notify)?;
    if task.delivery.as_ref().is_some_and(|delivery| delivery.status == "delivered") { return Ok(task); }
    match perform(manager, &task, io, validate, notify) {
        Ok(task) => Ok(task),
        Err(error) => finish_error(manager, id, &error, notify),
    }
}

async fn deliver_in_slot(app: AppHandle, task_id: String) -> Result<TaskRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<TaskManager>().inner().clone();
        let task = manager.get(&task_id)?;
        let notify = || crate::task_runtime::publish(&app, &manager);
        let lifecycle = app.state::<crate::workspace_lifecycle::WorkspaceLifecycle>();
        let leases = (|| {
            let repository = lifecycle.begin_repository_activity(&task.repository_root)?;
            let target = task.workspace_root.as_deref().ok_or("Task worktree is missing")?;
            let activity = lifecycle.begin_repository_activity(target)?;
            let reservation = lifecycle.reserve(target, "task draft PR delivery")?;
            Ok::<_, String>((repository, activity, reservation))
        })();
        let outcome = match leases {
            Ok(_leases) => {
                let mut io = NativeIo { app: &app, task_id: &task_id };
                deliver_with(&manager, &task_id, &mut io, &|task| crate::task_runtime::validate_pr_verification(&app, &manager, task), &notify)
            }
            Err(error) => { begin(&manager, &task_id, &notify)?; finish_error(&manager, &task_id, &error, &notify) }
        }?;
        if let (Some(delivery), Some(attempt)) = (&outcome.delivery, outcome.attempts.last()) {
            let message = delivery.pull_request_url.as_ref().map(|url| format!("Draft PR delivered: {url}"))
                .unwrap_or_else(|| format!("Draft PR delivery {}: {}", delivery.status, delivery.error.as_deref().unwrap_or("Pending native reconciliation")));
            let _ = crate::task_reports::update(&app, &task_id, &attempt.id, |report| report.entry("status", &message, false));
        }
        Ok(outcome)
    }).await.map_err(|_| "Native PR delivery worker failed; retry reconciles its retained outcome")?
}

pub(crate) async fn deliver_automatically(app: AppHandle, task_id: String) -> Result<(), String> {
    if app.state::<TaskManager>().get(&task_id)?.auto_draft_pr {
        deliver_in_slot(app, task_id).await?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeliverRequest { task_id: String }

#[tauri::command]
pub(crate) async fn task_deliver_pull_request(app: AppHandle, request: DeliverRequest) -> Result<TaskRecord, String> {
    // Reuses native task exclusion and workspace lifetime protection. A retry is
    // only this delivery operation; it never enqueues or starts an agent.
    let _slot = app.state::<crate::task_execution::TaskExecution>().claim_manual(app.clone(), &request.task_id)?;
    deliver_in_slot(app, request.task_id).await
}

#[cfg(test)]
mod tests;
