//! Native delivery decisions. Frontend state and provider messages cannot authorize readiness.
use crate::{
    task_evidence::{
        assess_checks, digest_json, hash_file, observe_toolchains, profile_paths, verify_artifacts,
    },
    task_inputs::{git, registered_workspace, source_identity, SourceIdentity},
    tasks::{
        new_id, now_ms, TaskAcceptance, TaskAttempt, TaskEvidence, TaskManager, TaskRecord,
        TaskReview,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskReadiness {
    pub status: String,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
    pub candidate_sha: Option<String>,
    pub review_current: bool,
    pub acceptance_current: bool,
}

#[derive(Clone)]
struct Observation {
    source: Option<SourceIdentity>,
    profile_digest: String,
    toolchain_digest: Option<String>,
    provenance_error: Option<String>,
    integrity_error: Option<String>,
}

fn derive_readiness(task: &TaskRecord, current: Observation) -> TaskReadiness {
    let attempt = task.attempts.last();
    let mut result = TaskReadiness {
        status: "unverified".into(),
        blockers: vec![],
        warnings: vec![],
        candidate_sha: attempt.and_then(|a| a.candidate_sha.clone()),
        review_current: false,
        acceptance_current: false,
    };
    let Some(profile) = task.profile.as_ref() else {
        result.blockers.push("尚未指定验收 Profile".into());
        return result;
    };
    let Some(attempt) = attempt else {
        result.blockers.push("任务尚未执行".into());
        return result;
    };
    let Some(evidence) = attempt.evidence.as_ref() else {
        result.blockers.push("当前 Attempt 没有完整验证证据".into());
        return result;
    };
    let assessment = assess_checks(profile, &evidence.checks);
    let trustworthy_observation =
        current.provenance_error.is_none() && current.integrity_error.is_none();
    let mut known_blocked = !assessment.blocked.is_empty();
    result.blockers.extend(assessment.blocked);
    result.blockers.extend(assessment.missing);
    result.warnings.extend(assessment.warnings);
    if let Some(error) = current.integrity_error {
        known_blocked = true;
        result.blockers.push(error);
    }
    if let Some(error) = current.provenance_error {
        result.blockers.push(error);
    }
    let matching = trustworthy_observation
        && current.source.as_ref().is_some_and(|source| {
            source.clean
                && source.head_sha == evidence.head_sha
                && source.digest == evidence.input_digest
        })
        && attempt.candidate_sha.as_deref() == Some(evidence.head_sha.as_str())
        && current.profile_digest == evidence.profile_digest
        && current.toolchain_digest.as_deref() == Some(evidence.toolchain_digest.as_str());
    if !matching {
        result
            .blockers
            .push("代码、Profile 或工具链已变化，旧证据不适用于当前结果".into());
    }
    if attempt.state != "succeeded" {
        result
            .blockers
            .push("执行尚未得到完整、成功的原生结束观察".into());
    }
    result.review_current = matching
        && task.review.as_ref().is_some_and(|review| {
            review.approved
                && review.head_sha == evidence.head_sha
                && review.input_digest == evidence.input_digest
                && review.profile_digest == evidence.profile_digest
                && review.run_id.as_deref() == Some(evidence.run_id.as_str())
                && review.toolchain_digest.as_deref() == Some(evidence.toolchain_digest.as_str())
        });
    if !result.review_current {
        if matching
            && task.review.as_ref().is_some_and(|review| {
                !review.approved
                    && review.head_sha == evidence.head_sha
                    && review.input_digest == evidence.input_digest
                    && review.profile_digest == evidence.profile_digest
            })
        {
            known_blocked = true;
            result.blockers.push("当前版本的人工审查未通过".into());
        } else {
            result.blockers.push("需要对当前版本完成人工审查".into());
        }
    }
    result.status = if known_blocked {
        "blocked"
    } else if !result.blockers.is_empty() {
        "unverified"
    } else if !result.warnings.is_empty() {
        "warning"
    } else {
        "ready"
    }
    .into();
    result.acceptance_current = matches!(result.status.as_str(), "ready" | "warning")
        && task.acceptance.as_ref().is_some_and(|acceptance| {
            acceptance.head_sha == evidence.head_sha
                && acceptance.input_digest == evidence.input_digest
                && acceptance.profile_digest == evidence.profile_digest
                && acceptance.run_id.as_deref() == Some(evidence.run_id.as_str())
                && acceptance.toolchain_digest.as_deref()
                    == Some(evidence.toolchain_digest.as_str())
                && (result.warnings.is_empty() || acceptance.acknowledged_warnings)
        });
    result
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationPreview {
    pub plan_id: String,
    pub task_id: String,
    pub repository_root: String,
    pub workspace_root: String,
    pub target_head_sha: String,
    pub source_commits: Vec<String>,
    pub expires_at_ms: u64,
}

pub(crate) struct TaskDelivery {
    session_id: String,
    plans: Mutex<HashMap<String, IntegrationPreview>>,
    watches: Mutex<HashMap<String, InputWatch>>,
}
impl Default for TaskDelivery {
    fn default() -> Self {
        Self {
            session_id: new_id(),
            plans: Mutex::default(),
            watches: Mutex::default(),
        }
    }
}

fn evidence_session_current(session: &str, manifest: &Value) -> bool {
    !session.is_empty() && manifest["observationSession"].as_str() == Some(session)
}
fn candidate_rejected(task: &TaskRecord, evidence: &TaskEvidence) -> bool {
    task.review.as_ref().is_some_and(|review| {
        !review.approved
            && review.head_sha == evidence.head_sha
            && review.input_digest == evidence.input_digest
            && review.profile_digest == evidence.profile_digest
    })
}
impl TaskDelivery {
    fn insert(&self, preview: IntegrationPreview) -> Result<(), String> {
        let mut plans = self
            .plans
            .lock()
            .map_err(|_| "Integration preview lock poisoned")?;
        plans.retain(|_, plan| plan.expires_at_ms > now_ms());
        if plans.len() >= 32 {
            return Err("Too many pending integration previews".into());
        }
        plans.insert(preview.plan_id.clone(), preview);
        Ok(())
    }
    fn take(&self, id: &str, timestamp: u64) -> Result<IntegrationPreview, String> {
        let plan = self
            .plans
            .lock()
            .map_err(|_| "Integration preview lock poisoned")?
            .remove(id)
            .ok_or("集成预览不存在或已使用")?;
        if timestamp >= plan.expires_at_ms {
            return Err("集成预览已过期，请重新预览".into());
        }
        Ok(plan)
    }
}

pub(crate) fn publish(app: &AppHandle, manager: &TaskManager) {
    // Query snapshots remain authoritative even if event delivery is lost.
    if let Ok(events) = manager.events(0) {
        if let Some(event) = events.last() {
            let _ = app.emit("task://event", event);
        }
    }
}

fn root(task: &TaskRecord) -> Result<PathBuf, String> {
    registered_workspace(
        Path::new(&task.repository_root),
        Path::new(
            task.workspace_root
                .as_deref()
                .ok_or("请先明确创建任务工作区")?,
        ),
    )
}
fn paths(profile: &Value) -> Result<(Vec<String>, Vec<String>), String> {
    let sources = profile_paths(profile, "sourcePaths")?;
    let mut outputs = profile_paths(profile, "outputPaths")?;
    // Only the existing runner's exact owned output directory is excluded.
    outputs.push(".virtuallab/evidence".into());
    Ok((sources, outputs))
}
fn manifest_path(manager: &TaskManager, run_id: &str) -> Result<PathBuf, String> {
    if run_id.is_empty()
        || !run_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid run identity".into());
    }
    let store = manager.storage_dir().join("task-evidence");
    let run = store.join(run_id);
    for directory in [&store, &run] {
        match fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("Evidence store must be a regular directory".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot inspect evidence store: {error}")),
        }
    }
    Ok(run.join("manifest-v2.json"))
}
fn manifest_matches_record(manifest: &Value, evidence: &TaskEvidence) -> Result<bool, String> {
    let mut expected = serde_json::to_value(evidence).map_err(|e| e.to_string())?;
    expected
        .as_object_mut()
        .ok_or("Malformed evidence record")?
        .remove("manifestDigest");
    Ok(manifest["evidence"] == expected
        && evidence.manifest_digest.as_deref() == Some(digest_json(manifest)?.as_str()))
}
fn observation(app: &AppHandle, manager: &TaskManager, task: &TaskRecord) -> Observation {
    let mut observed = Observation {
        source: None,
        profile_digest: String::new(),
        toolchain_digest: None,
        provenance_error: None,
        integrity_error: None,
    };
    let provenance = (|| -> Result<(), String> {
        let profile = task.profile.as_ref().ok_or("尚未指定 Profile")?;
        observed.profile_digest = digest_json(profile)?;
        let root = root(task)?;
        let (sources, outputs) = paths(profile)?;
        observed.source = Some(source_identity(&root, &sources, &outputs)?);
        observed.toolchain_digest = Some(observe_toolchains(profile, &root, true)?.0);
        Ok(())
    })();
    if let Err(error) = provenance {
        observed.provenance_error = Some(error);
    }
    if let Some(evidence) = task.attempts.last().and_then(|a| a.evidence.as_ref()) {
        let stale_live = app
            .state::<TaskDelivery>()
            .watches
            .lock()
            .map(|watches| {
                watches
                    .get(&task.id)
                    .is_some_and(|watch| watch.changed.load(Ordering::Acquire))
            })
            .unwrap_or(true);
        let stale_disk = manifest_path(manager, &evidence.run_id)
            .map(|path| path.parent().unwrap().join("invalidated.json").exists())
            .unwrap_or(true);
        if stale_live || stale_disk {
            observed.provenance_error =
                Some("验证后源输入曾发生变化，请重新验证；恢复原内容不会恢复旧证据".into());
        }
        let integrity = (|| -> Result<(), String> {
            let manifest_path = manifest_path(manager, &evidence.run_id)?;
            let meta = fs::symlink_metadata(&manifest_path).map_err(|e| e.to_string())?;
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 2 * 1024 * 1024 {
                return Err("Evidence manifest must be a bounded regular file".into());
            }
            let managed = fs::canonicalize(manager.storage_dir().join("task-evidence"))
                .map_err(|e| e.to_string())?;
            if !fs::canonicalize(&manifest_path)
                .map_err(|e| e.to_string())?
                .starts_with(managed)
            {
                return Err("Evidence manifest escaped managed storage".into());
            }
            let manifest: Value =
                serde_json::from_slice(&fs::read(&manifest_path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if !evidence_session_current(&app.state::<TaskDelivery>().session_id, &manifest) {
                observed.provenance_error =
                    Some("应用重启后的观察连续性未知；请重新验证并审查，历史验收仍保留".into());
            }
            if evidence.manifest_digest.is_none() {
                observed.provenance_error = Some("旧证据缺少完整 Manifest 绑定，请重新验证".into());
            }
            if manifest["schemaVersion"] != 2
                || manifest["taskId"] != task.id
                || manifest["attemptId"] != task.attempts.last().unwrap().id
                || !manifest_matches_record(&manifest, evidence)?
            {
                return Err("Evidence manifest identity or content mismatch".into());
            }
            verify_artifacts(
                &manager.storage_dir().join("task-evidence"),
                &evidence.artifacts,
            )
        })();
        if let Err(error) = integrity {
            if manifest_path(manager, &evidence.run_id).is_ok_and(|path| !path.exists())
                || evidence.artifacts.iter().any(|artifact| {
                    artifact["path"]
                        .as_str()
                        .is_none_or(|path| !Path::new(path).exists())
                })
            {
                observed.provenance_error = Some(format!("验证证据缺失：{error}"));
            } else {
                observed.integrity_error = Some(format!("证据完整性检查失败：{error}"));
            }
        }
        let changed = observed.source.as_ref().is_some_and(|source| {
            !source.clean
                || source.head_sha != evidence.head_sha
                || source.digest != evidence.input_digest
        }) || observed
            .toolchain_digest
            .as_ref()
            .is_some_and(|digest| digest != &evidence.toolchain_digest)
            || !observed.profile_digest.is_empty()
                && observed.profile_digest != evidence.profile_digest;
        if changed {
            observed.provenance_error = Some(
                "已观察到输入、Profile 或工具链变化；旧 Run 永久保留为历史，请重新验证".into(),
            );
            if let Ok(path) = manifest_path(manager, &evidence.run_id) {
                use std::io::Write;
                if let Ok(mut file) = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path.parent().unwrap().join("invalidated.json"))
                {
                    let _ =
                        file.write_all(format!("{{\"invalidatedAtMs\":{}}}", now_ms()).as_bytes());
                    let _ = file.sync_all();
                    let _ = manager.update(&task.id, |_| Ok(()));
                    publish(app, manager);
                }
            }
        }
    }
    observed
}

pub(crate) fn prerequisites(app: &AppHandle, task: &TaskRecord) -> Result<Vec<String>, String> {
    prerequisites_inner(app, task, 0, &mut HashMap::new())
}
fn prerequisites_inner(
    app: &AppHandle,
    task: &TaskRecord,
    depth: usize,
    cached: &mut HashMap<String, Vec<String>>,
) -> Result<Vec<String>, String> {
    if depth > 64 {
        return Err("Dependency depth exceeds the supported observation bound".into());
    }
    if let Some(commits) = cached.get(&task.id) {
        return Ok(commits.clone());
    }
    let manager = app.state::<TaskManager>();
    let mut commits = Vec::new();
    for id in &task.dependencies {
        let dependency = manager.get(id)?;
        if crate::workspace_identity::key(&dependency.repository_root)
            != crate::workspace_identity::key(&task.repository_root)
        {
            return Err("Dependency belongs to a different repository".into());
        }
        let attempt = dependency.attempts.last().ok_or("前置任务尚未执行")?;
        let evidence = attempt.evidence.as_ref().ok_or("前置任务缺少验证证据")?;
        if candidate_rejected(&dependency, evidence) {
            return Err(format!(
                "前置任务 {} 的当前候选已被人工拒绝，请先处理审查意见",
                dependency.title
            ));
        }
        let current = observation(app, &manager, &dependency);
        let profile = dependency.profile.as_ref().ok_or("前置任务没有 Profile")?;
        let assessment = assess_checks(profile, &evidence.checks);
        if attempt.state != "succeeded"
            || !assessment.blocked.is_empty()
            || !assessment.missing.is_empty()
            || current.provenance_error.is_some()
            || current.integrity_error.is_some()
            || current.profile_digest != evidence.profile_digest
            || current.toolchain_digest.as_deref() != Some(evidence.toolchain_digest.as_str())
            || !current.source.as_ref().is_some_and(|s| {
                s.clean && s.head_sha == evidence.head_sha && s.digest == evidence.input_digest
            })
            || attempt.candidate_sha.as_deref() != Some(evidence.head_sha.as_str())
        {
            return Err(format!(
                "前置任务 {} 的固定候选或必需检查尚未满足",
                dependency.title
            ));
        }
        if !dependency.dependencies.is_empty() {
            let upstream = prerequisites_inner(app, &dependency, depth + 1, cached)?;
            require_fixed_lineage(
                &export_lineage(&manager, &dependency.id, &attempt.id, evidence),
                &upstream,
            )?;
        }
        commits.push(evidence.head_sha.clone());
    }
    cached.insert(task.id.clone(), commits.clone());
    Ok(commits)
}

fn dependency_revisions(
    manager: &TaskManager,
    task: &TaskRecord,
) -> Result<Vec<(String, u64)>, String> {
    let mut pending = task.dependencies.clone();
    let mut observed = std::collections::BTreeMap::new();
    while let Some(id) = pending.pop() {
        if observed.contains_key(&id) {
            continue;
        }
        let record = manager.get(&id)?;
        pending.extend(record.dependencies.clone());
        observed.insert(id, record.revision);
    }
    Ok(observed.into_iter().collect())
}

fn apply_dependency_readiness(result: &mut TaskReadiness, dependencies: Result<(), String>) {
    if let Err(reason) = dependencies {
        result.blockers.insert(0, format!("依赖未满足：{reason}"));
        if matches!(result.status.as_str(), "ready" | "warning") {
            result.status = "unverified".into();
        }
        result.acceptance_current = false;
        result.review_current = false;
    }
}

fn require_fixed_lineage(lineage: &Value, commits: &[String]) -> Result<(), String> {
    if lineage["status"] != "recorded" || lineage["sourceCommits"] != json!(commits) {
        return Err("当前依赖候选与已验证的固定来源不同，请显式重新集成并验证".into());
    }
    Ok(())
}

fn complete_readiness(
    app: &AppHandle,
    manager: &TaskManager,
    task: &TaskRecord,
    observed: Observation,
) -> TaskReadiness {
    let mut result = derive_readiness(task, observed);
    if !task.dependencies.is_empty() {
        let dependency_state = (|| {
            let commits = prerequisites(app, task)?;
            let attempt = task.attempts.last().ok_or("尚无验证运行")?;
            let evidence = attempt.evidence.as_ref().ok_or("尚无验证证据")?;
            let lineage = export_lineage(manager, &task.id, &attempt.id, evidence);
            require_fixed_lineage(&lineage, &commits)
        })();
        apply_dependency_readiness(&mut result, dependency_state);
    }
    result
}

#[tauri::command]
pub(crate) async fn task_readiness(
    app: AppHandle,
    manager: State<'_, TaskManager>,
    task_id: String,
) -> Result<TaskReadiness, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let task = manager.get(&task_id)?;
        Ok(complete_readiness(
            &app,
            &manager,
            &task,
            observation(&app, &manager, &task),
        ))
    })
    .await
    .map_err(|error| format!("Readiness observer failed: {error}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskIdRequest {
    pub(crate) task_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviewRequest {
    task_id: String,
    expected_head_sha: String,
    note: String,
    approved: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AcceptanceRequest {
    task_id: String,
    expected_head_sha: String,
    acknowledged_warnings: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConfirmRequest {
    plan_id: String,
}

fn review_record(
    app: AppHandle,
    manager: TaskManager,
    request: ReviewRequest,
) -> Result<TaskRecord, String> {
    if request.note.len() > 8192 || request.note.contains('\0') {
        return Err("Review note is too large or invalid".into());
    }
    let task = manager.get(&request.task_id)?;
    let root = root(&task)?;
    let _claim = app
        .state::<crate::workspace_lifecycle::WorkspaceLifecycle>()
        .reserve(&root.to_string_lossy(), "task human review")?;
    let observed = observation(&app, &manager, &task);
    let source = observed.source.ok_or("当前版本无法观察")?;
    let evidence = task
        .attempts
        .last()
        .and_then(|a| a.evidence.as_ref())
        .ok_or("请先验证当前版本")?;
    if !source.clean
        || source.head_sha != request.expected_head_sha
        || source.head_sha != evidence.head_sha
        || source.digest != evidence.input_digest
        || observed.profile_digest != evidence.profile_digest
        || observed.toolchain_digest.as_deref() != Some(evidence.toolchain_digest.as_str())
        || observed.provenance_error.is_some()
        || observed.integrity_error.is_some()
    {
        return Err("审查对象已变化或证据不完整，请重新验证".into());
    }
    let updated = manager.update(&request.task_id, |record| {
        if record.revision != task.revision {
            return Err("Task changed during review".into());
        }
        record.review = Some(TaskReview {
            head_sha: source.head_sha,
            input_digest: source.digest,
            profile_digest: observed.profile_digest,
            run_id: Some(evidence.run_id.clone()),
            toolchain_digest: Some(evidence.toolchain_digest.clone()),
            approved: request.approved,
            note: request.note,
            created_at_ms: now_ms(),
        });
        Ok(())
    })?;
    publish(&app, &manager);
    Ok(updated)
}

fn accept_record(
    app: AppHandle,
    manager: TaskManager,
    request: AcceptanceRequest,
) -> Result<TaskRecord, String> {
    let task = manager.get(&request.task_id)?;
    let root = root(&task)?;
    let _claim = app
        .state::<crate::workspace_lifecycle::WorkspaceLifecycle>()
        .reserve(&root.to_string_lossy(), "task acceptance")?;
    let observed = observation(&app, &manager, &task);
    let dependency_revisions = dependency_revisions(&manager, &task)?;
    let readiness = complete_readiness(&app, &manager, &task, observed.clone());
    if !matches!(readiness.status.as_str(), "ready" | "warning")
        || readiness.candidate_sha.as_deref() != Some(request.expected_head_sha.as_str())
        || (!readiness.warnings.is_empty() && !request.acknowledged_warnings)
    {
        return Err("当前结果未满足验收条件，或可选限制尚未确认".into());
    }
    let source = observed.source.ok_or("Source observation missing")?;
    let profile = task.profile.as_ref().ok_or("Profile missing")?;
    let (sources, outputs) = paths(profile)?;
    let rechecked = source_identity(&root, &sources, &outputs)?;
    if !rechecked.clean
        || rechecked.head_sha != source.head_sha
        || rechecked.digest != source.digest
    {
        return Err("Source changed before acceptance".into());
    }
    let updated = manager.update_with_dependency_revisions(
        &request.task_id,
        &dependency_revisions,
        |record| {
            if record.revision != task.revision {
                return Err("Task changed during acceptance".into());
            }
            let evidence = task
                .attempts
                .last()
                .and_then(|a| a.evidence.as_ref())
                .ok_or("Evidence missing")?;
            record.acceptance = Some(TaskAcceptance {
                head_sha: source.head_sha,
                input_digest: source.digest,
                profile_digest: observed.profile_digest,
                run_id: Some(evidence.run_id.clone()),
                toolchain_digest: Some(evidence.toolchain_digest.clone()),
                accepted_at_ms: now_ms(),
                acknowledged_warnings: request.acknowledged_warnings,
            });
            Ok(())
        },
    )?;
    publish(&app, &manager);
    Ok(updated)
}

#[tauri::command]
pub(crate) async fn task_review(
    app: AppHandle,
    manager: State<'_, TaskManager>,
    request: ReviewRequest,
) -> Result<TaskRecord, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || review_record(app, manager, request))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub(crate) async fn task_accept_result(
    app: AppHandle,
    manager: State<'_, TaskManager>,
    request: AcceptanceRequest,
) -> Result<TaskRecord, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || accept_record(app, manager, request))
        .await
        .map_err(|error| error.to_string())?
}

struct InputWatch {
    _watcher: notify::RecommendedWatcher,
    changed: Arc<AtomicBool>,
    armed: Arc<AtomicBool>,
    tools: Arc<Mutex<std::collections::BTreeSet<PathBuf>>>,
    contexts: Arc<Mutex<std::collections::BTreeSet<PathBuf>>>,
    context_trees: Arc<Mutex<std::collections::BTreeSet<PathBuf>>>,
    registered: std::collections::BTreeSet<PathBuf>,
}
fn protected_path_changed(paths: &std::collections::BTreeSet<PathBuf>, path: &Path) -> bool {
    paths
        .iter()
        .any(|known| path == known || known.starts_with(path))
}
fn protected_tree_changed(paths: &std::collections::BTreeSet<PathBuf>, path: &Path) -> bool {
    paths
        .iter()
        .any(|known| path.starts_with(known) || known.starts_with(path))
}

fn watch_inputs(
    root: &Path,
    outputs: &[String],
    app: AppHandle,
    manager: TaskManager,
    task_id: String,
    marker: PathBuf,
) -> Result<InputWatch, String> {
    use notify::Watcher;
    let git_plan = crate::task_git_watch::GitWatchPlan::resolve(root, |args| git(root, args))?;
    let observed_git = git_plan.clone();
    let changed = Arc::new(AtomicBool::new(false));
    let observed = changed.clone();
    let root_path = root.to_path_buf();
    let outputs = outputs.to_vec();
    let armed = Arc::new(AtomicBool::new(false));
    let active = armed.clone();
    let tools = Arc::new(Mutex::new(std::collections::BTreeSet::<PathBuf>::new()));
    let watched_tools = tools.clone();
    let contexts = Arc::new(Mutex::new(std::collections::BTreeSet::<PathBuf>::new()));
    let watched_contexts = contexts.clone();
    let context_trees = Arc::new(Mutex::new(std::collections::BTreeSet::<PathBuf>::new()));
    let watched_trees = context_trees.clone();
    let invalidate = move || {
        if !observed.swap(true, Ordering::AcqRel) && active.load(Ordering::Acquire) {
            // Immutable stale marker survives a change-and-revert and application restart.
            use std::io::Write;
            if let Ok(mut file) = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)
            {
                let _ = file.write_all(format!("{{\"invalidatedAtMs\":{}}}", now_ms()).as_bytes());
                let _ = file.sync_all();
            }
            // A failed marker write still leaves the live observer invalidated.
            let _ = manager.update(&task_id, |_| Ok(()));
            publish(&app, &manager);
        }
    };
    let mut watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if observed_git.invalidates(&event) {
                invalidate();
                return;
            }
            match event {
                Err(_) => invalidate(),
                Ok(event) if !matches!(event.kind, notify::EventKind::Access(_)) => {
                    if event.paths.iter().any(|path| {
                        let relevant = |set: &Arc<Mutex<std::collections::BTreeSet<PathBuf>>>| {
                            set.lock()
                                .map(|paths| protected_path_changed(&paths, path))
                                .unwrap_or(true)
                        };
                        if relevant(&watched_tools) {
                            return true;
                        }
                        if relevant(&watched_contexts) {
                            return true;
                        }
                        if watched_trees
                            .lock()
                            .map(|paths| protected_tree_changed(&paths, path))
                            .unwrap_or(true)
                        {
                            return true;
                        }
                        path.strip_prefix(&root_path).is_ok_and(|relative| {
                            let name = relative.to_string_lossy().replace('\\', "/");
                            name != ".git"
                                && !name.starts_with(".git/")
                                && !outputs.iter().any(|output| {
                                    name == *output || name.starts_with(&format!("{output}/"))
                                })
                                && name != ".virtuallab"
                        })
                    }) {
                        invalidate();
                    }
                }
                _ => {}
            }
        })
        .map_err(|e| e.to_string())?;
    watcher
        .watch(root, notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    let mut registered = std::collections::BTreeSet::from([root.to_path_buf()]);
    for target in git_plan.targets() {
        if registered.insert(target.path.clone()) {
            watcher
                .watch(&target.path, target.mode)
                .map_err(|error| format!("Cannot observe task Git identity: {error}"))?;
        }
    }
    git_plan.revalidate(root, |args| git(root, args))?;
    Ok(InputWatch {
        _watcher: watcher,
        changed,
        armed,
        tools,
        contexts,
        context_trees,
        registered,
    })
}

fn register_provenance_watch(
    watch: &mut InputWatch,
    path: &Path,
    context: bool,
) -> Result<(), String> {
    use notify::Watcher;
    let known = if context {
        &watch.contexts
    } else {
        &watch.tools
    };
    known
        .lock()
        .map_err(|_| "Provenance watch lock poisoned")?
        .insert(path.to_path_buf());
    let actual = path
        .ancestors()
        .find(|candidate| candidate.exists())
        .ok_or("No existing provenance observation root")?;
    if watch.registered.insert(actual.to_path_buf()) {
        watch
            ._watcher
            .watch(actual, notify::RecursiveMode::NonRecursive)
            .map_err(|error| format!("Cannot observe required toolchain context: {error}"))?;
    }
    Ok(())
}

pub(crate) async fn verify_task_internal(
    app: AppHandle,
    task_id: String,
) -> Result<TaskRecord, String> {
    let manager = app.state::<TaskManager>().inner().clone();
    let task = manager.get(&task_id)?;
    let _activity = app.state::<crate::workspace_lifecycle::WorkspaceLifecycle>()
        .begin_repository_activity(&task.repository_root)?;
    let workspace = root(&task)?;
    let profile = task.profile.clone().ok_or("任务没有指定验收 Profile")?;
    let candidate = task
        .attempts
        .last()
        .and_then(|a| a.candidate_sha.clone())
        .ok_or("尚未封存候选提交")?;
    let attempt_id = task.attempts.last().unwrap().id.clone();
    let run_id = format!("run-{}", new_id());
    let target_manifest = manifest_path(&manager, &run_id)?;
    let (sources, outputs) = paths(&profile)?;
    let mut watch = watch_inputs(
        &workspace,
        &outputs,
        app.clone(),
        manager.clone(),
        task_id.clone(),
        target_manifest.parent().unwrap().join("invalidated.json"),
    )?;
    let before = source_identity(&workspace, &sources, &outputs)?;
    if !before.clean || before.head_sha != candidate {
        return Err("正式验证要求准确候选提交和干净的受控源输入".into());
    }
    let profile_digest = digest_json(&profile)?;
    // Configure through exploratory Run before formal compiler qualification.
    let (toolchain_digest, tools) = observe_toolchains(&profile, &workspace, true)?;
    {
        let mut watched = std::collections::BTreeSet::new();
        for tool in &tools {
            for key in ["launcherPath", "executablePath"] {
                if let Some(path) = tool[key]
                    .as_str()
                    .filter(|path| watched.insert(path.to_string()))
                {
                    register_provenance_watch(&mut watch, Path::new(path), false)?;
                }
            }
            if let Some(paths) = tool["contextWatchPaths"].as_array() {
                for path in paths.iter().filter_map(Value::as_str) {
                    register_provenance_watch(&mut watch, Path::new(path), true)?;
                }
            }
            if let Some(paths) = tool["contextWatchTrees"].as_array() {
                for path in paths.iter().filter_map(Value::as_str) {
                    use notify::Watcher;
                    let path = PathBuf::from(path);
                    let metadata = fs::symlink_metadata(&path)
                        .map_err(|_| "Required implementation tree unavailable")?;
                    if !path.is_absolute()
                        || !metadata.is_dir()
                        || metadata.file_type().is_symlink()
                    {
                        return Err(
                            "Implementation tree must be a regular absolute directory".into()
                        );
                    }
                    watch
                        .context_trees
                        .lock()
                        .map_err(|_| "Implementation watch lock poisoned")?
                        .insert(path.clone());
                    watch
                        ._watcher
                        .watch(&path, notify::RecursiveMode::Recursive)
                        .map_err(|_| "Cannot observe required implementation tree")?;
                    watch.registered.insert(path);
                }
            }
        }
    }
    if watch.changed.load(Ordering::Acquire)
        || observe_toolchains(&profile, &workspace, true)?.0 != toolchain_digest
    {
        return Err("Required toolchain changed during observer registration".into());
    }
    let source_commits = prerequisites(&app, &task)?;
    if task.kind == "integration" {
        for source in &source_commits {
            git(
                &workspace,
                &["merge-base", "--is-ancestor", source, &candidate],
            )?;
        }
    }
    if manual_candidate(&task, &source_commits)? != candidate {
        return Err("Candidate changed before formal verification".into());
    }
    manager.update(&task_id, |record| {
        let attempt = record.attempts.last_mut().ok_or("Attempt missing")?;
        if attempt.id != attempt_id {
            return Err("Attempt changed".into());
        }
        attempt.phase = "verification".into();
        Ok(())
    })?;
    publish(&app, &manager);
    app.state::<crate::task_execution::TaskExecution>()
        .bind_verification_run(&task_id, &run_id)?;
    let request: crate::verification::VerificationRequest = serde_json::from_value(
        json!({"runId":run_id,"workspaceRoot":workspace.to_string_lossy(),"profile":profile}),
    )
    .map_err(|e| e.to_string())?;
    let outcome = crate::verification::verification_run(
        app.clone(),
        app.state::<crate::verification::VerificationManager>(),
        request,
    )
    .await;
    let manifest = serde_json::to_value(outcome?).map_err(|e| e.to_string())?;
    let after = source_identity(&workspace, &sources, &outputs)?;
    if watch.changed.load(Ordering::Acquire)
        || !after.clean
        || before.head_sha != after.head_sha
        || before.digest != after.digest
        || observe_toolchains(&profile, &workspace, true)?.0 != toolchain_digest
    {
        return Err("验证期间源输入或工具链发生变化；本次结果不可用于交付".into());
    }
    let directory = target_manifest.parent().unwrap();
    fs::create_dir_all(directory.parent().unwrap()).map_err(|e| e.to_string())?;
    manifest_path(&manager, &run_id)?;
    fs::create_dir(directory).map_err(|e| format!("Cannot create immutable run store: {e}"))?;
    let mut artifacts = Vec::new();
    for (index, artifact) in manifest["artifacts"]
        .as_array()
        .ok_or("Runner artifacts missing")?
        .iter()
        .enumerate()
    {
        let relative = artifact["path"]
            .as_str()
            .ok_or("Runner artifact path missing")?;
        crate::task_inputs::safe_relative(relative, false)?;
        let source = fs::canonicalize(workspace.join(relative)).map_err(|e| e.to_string())?;
        if !source.starts_with(&workspace) {
            return Err("Runner artifact escaped its worktree".into());
        }
        let expected = artifact["sha256"]
            .as_str()
            .ok_or("Runner artifact digest missing")?;
        if hash_file(&source, 16 * 1024 * 1024)? != expected {
            return Err("Runner artifact changed before indexing".into());
        }
        let target = directory.join(format!("artifact-{index}.log"));
        fs::copy(&source, &target).map_err(|e| e.to_string())?;
        let mut copied = artifact.clone();
        copied["path"] = json!(target.to_string_lossy());
        if hash_file(&target, 16 * 1024 * 1024)? != expected {
            return Err("Evidence copy integrity failed".into());
        }
        artifacts.push(copied);
    }
    let mut evidence = TaskEvidence {
        run_id: run_id.clone(),
        head_sha: candidate,
        profile_digest,
        input_digest: before.digest,
        toolchain_digest,
        manifest_digest: None,
        status: manifest["status"]
            .as_str()
            .ok_or("Runner status missing")?
            .into(),
        checks: manifest["checks"]
            .as_array()
            .ok_or("Runner checks missing")?
            .clone(),
        artifacts,
        observed_at_ms: now_ms(),
    };
    let mut body_evidence = serde_json::to_value(&evidence).map_err(|e| e.to_string())?;
    body_evidence
        .as_object_mut()
        .unwrap()
        .remove("manifestDigest");
    let passport = json!({"schemaVersion":2,"taskId":task_id,"attemptId":attempt_id,"observationSession":app.state::<TaskDelivery>().session_id,"evidence":body_evidence,"toolchainObservations":tools,"sourceCommits":source_commits,"profileDigest":evidence.profile_digest});
    evidence.manifest_digest = Some(digest_json(&passport)?);
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target_manifest)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&passport).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    let final_source = source_identity(&workspace, &sources, &outputs)?;
    if watch.changed.load(Ordering::Acquire)
        || !final_source.clean
        || final_source.head_sha != before.head_sha
        || final_source.digest != evidence.input_digest
    {
        return Err("证据归档期间源输入变化，本次结果不能用于验收".into());
    }
    watch.armed.store(true, Ordering::Release);
    app.state::<TaskDelivery>()
        .watches
        .lock()
        .map_err(|_| "Input watch lock poisoned")?
        .insert(task_id.clone(), watch);
    let updated = manager.update(&task_id, |record| {
        let attempt = record.attempts.last_mut().ok_or("Attempt missing")?;
        if attempt.id != attempt_id || attempt.state == "stopping" {
            return Err("Attempt changed or cancellation requested during verification".into());
        }
        attempt.evidence = Some(evidence);
        attempt.state = "succeeded".into();
        attempt.ended_at_ms = Some(now_ms());
        attempt.failure = None;
        Ok(())
    })?;
    publish(&app, &manager);
    Ok(updated)
}

fn manual_candidate(task: &TaskRecord, prerequisite_commits: &[String]) -> Result<String, String> {
    let candidate = {
        let workspace = root(&task)?;
        let profile = task.profile.as_ref().ok_or("Profile missing")?;
        let (sources, outputs) = paths(profile)?;
        let identity = source_identity(&workspace, &sources, &outputs)?;
        if !identity.clean {
            return Err("Manually resolved integration must be committed and clean".into());
        }
        git(
            &workspace,
            &[
                "merge-base",
                "--is-ancestor",
                &task.base_sha,
                &identity.head_sha,
            ],
        )?;
        for source in prerequisite_commits {
            git(
                &workspace,
                &["merge-base", "--is-ancestor", &source, &identity.head_sha],
            )?;
        }
        // Integration scope must include the complete approved combined result,
        // including source changes and manual conflict resolution.
        let scope_base = task.base_sha.as_str();
        {
            git(
                &workspace,
                &[
                    "merge-base",
                    "--is-ancestor",
                    scope_base,
                    &identity.head_sha,
                ],
            )?;
            let changed = git(
                &workspace,
                &[
                    "diff",
                    "--no-renames",
                    "--name-only",
                    "-z",
                    scope_base,
                    &identity.head_sha,
                    "--",
                ],
            )?;
            for path in changed.split('\0').filter(|path| !path.is_empty()) {
                crate::task_inputs::safe_relative(path, false)?;
                if !task.scope.iter().any(|scope| {
                    scope == "."
                        || path == scope
                        || path.starts_with(&format!("{}/", scope.trim_end_matches('/')))
                }) {
                    return Err(
                        "候选包含任务范围外变更；集成范围须覆盖全部来源与人工修复，请先协调计划"
                            .into(),
                    );
                }
            }
        }
        identity.head_sha
    };
    Ok(candidate)
}

#[tauri::command]
pub(crate) async fn task_verify(
    app: AppHandle,
    request: TaskIdRequest,
) -> Result<TaskRecord, String> {
    let _slot = app
        .state::<crate::task_execution::TaskExecution>()
        .claim_manual(app.clone(), &request.task_id)?;
    let manager = app.state::<TaskManager>().inner().clone();
    let task = manager.get(&request.task_id)?;
    if task
        .attempts
        .last()
        .is_some_and(|a| matches!(a.state.as_str(), "queued" | "running" | "stopping"))
    {
        return Err("任务仍在执行，请等待其结束".into());
    }
    let candidate = manual_candidate(&task, &prerequisites(&app, &task)?)?;
    manager.update(&request.task_id, |record| {
        record.attempts.push(TaskAttempt {
            id: new_id(),
            state: "running".into(),
            phase: "verification".into(),
            execution: None,
            candidate_sha: Some(candidate),
            failure: None,
            started_at_ms: now_ms(),
            ended_at_ms: None,
            evidence: None,
        });
        Ok(())
    })?;
    publish(&app, &manager);
    let result = crate::task_execution::verify_in_slot(app.clone(), request.task_id.clone()).await;
    if let Err(error) = &result {
        let _ = manager.update(&request.task_id, |record| {
            if let Some(a) = record.attempts.last_mut() {
                a.state = if a.state == "stopping" {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                a.failure = Some(error.clone());
                a.ended_at_ms = Some(now_ms());
            }
            Ok(())
        });
        publish(&app, &manager);
    }
    result
}

fn preview_integration(
    app: AppHandle,
    manager: TaskManager,
    request: TaskIdRequest,
) -> Result<IntegrationPreview, String> {
    let task = manager.get(&request.task_id)?;
    if task.kind != "integration" || task.dependencies.is_empty() {
        return Err("Only integration tasks with fixed dependencies can integrate".into());
    }
    if task
        .attempts
        .last()
        .is_some_and(|a| matches!(a.state.as_str(), "queued" | "running" | "stopping"))
    {
        return Err("Integration task is active".into());
    }
    let workspace = root(&task)?;
    let source_commits = prerequisites(&app, &task)?;
    let (sources, outputs) = paths(task.profile.as_ref().ok_or("Integration Profile missing")?)?;
    let identity = source_identity(&workspace, &sources, &outputs)?;
    if !identity.clean || identity.head_sha != task.base_sha {
        return Err("集成目标须为基础版本上的干净专用 Worktree；部分集成需人工协调".into());
    }
    if crate::workspace_identity::key(&workspace.to_string_lossy())
        == crate::workspace_identity::key(&task.repository_root)
    {
        return Err("Integration requires a dedicated worktree".into());
    }
    for id in &task.dependencies {
        if manager.get(id)?.workspace_root.as_deref() == Some(workspace.to_string_lossy().as_ref())
        {
            return Err("Integration cannot reuse an implementation workspace".into());
        }
    }
    let preview = IntegrationPreview {
        plan_id: new_id(),
        task_id: task.id,
        repository_root: task.repository_root,
        workspace_root: workspace.to_string_lossy().into_owned(),
        target_head_sha: identity.head_sha,
        source_commits,
        expires_at_ms: now_ms() + 300_000,
    };
    app.state::<TaskDelivery>().insert(preview.clone())?;
    Ok(preview)
}

#[tauri::command]
pub(crate) async fn task_integration_preview(
    app: AppHandle,
    manager: State<'_, TaskManager>,
    request: TaskIdRequest,
) -> Result<IntegrationPreview, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || preview_integration(app, manager, request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn task_integration_confirm(
    app: AppHandle,
    request: ConfirmRequest,
) -> Result<TaskRecord, String> {
    // Consume before presenting the native gate: cancelled/failed intents are never replayable.
    let preview = app
        .state::<TaskDelivery>()
        .take(&request.plan_id, now_ms())?;
    let confirm_app = app.clone();
    let shown = preview.clone();
    let confirmed=tauri::async_runtime::spawn_blocking(move||confirm_app.dialog().message(format!("确认本地集成固定提交？\n仓库：{}\n目标：{}\n目标 HEAD：{}\n来源顺序：\n{}\n\n冲突或部分失败将停止，需人工处理。此操作不推送、不合并远程 PR。",shown.repository_root,shown.workspace_root,shown.target_head_sha,shown.source_commits.join("\n"))).title("VirtualLab · 确认本地集成").kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancel).blocking_show()).await.map_err(|e|e.to_string())?;
    if !confirmed {
        return Err("已取消集成；没有修改仓库".into());
    }
    let _slot = app
        .state::<crate::task_execution::TaskExecution>()
        .claim_manual(app.clone(), &preview.task_id)?;
    let manager = app.state::<TaskManager>().inner().clone();
    let task = manager.get(&preview.task_id)?;
    let workspace = root(&task)?;
    let _writer = app
        .state::<crate::workspace_lifecycle::WorkspaceLifecycle>()
        .reserve(&preview.workspace_root, "task local integration")?;
    let (sources, outputs) = paths(task.profile.as_ref().ok_or("Integration Profile missing")?)?;
    let current = source_identity(&workspace, &sources, &outputs)?;
    if now_ms() >= preview.expires_at_ms
        || !current.clean
        || current.head_sha != preview.target_head_sha
        || prerequisites(&app, &task)? != preview.source_commits
    {
        return Err("集成预览已变化或过期，请重新预览".into());
    }
    let attempt_id = new_id();
    manager.update(&task.id, |record| {
        record.attempts.push(TaskAttempt {
            id: attempt_id.clone(),
            state: "running".into(),
            phase: "integration".into(),
            execution: None,
            candidate_sha: None,
            failure: None,
            started_at_ms: now_ms(),
            ended_at_ms: None,
            evidence: None,
        });
        Ok(())
    })?;
    publish(&app, &manager);
    let merge_app = app.clone();
    let merge_task = task.id.clone();
    let merge_head = preview.target_head_sha.clone();
    let merge_sources = preview.source_commits.clone();
    let integration = match tauri::async_runtime::spawn_blocking(move || {
        let _writer = _writer;
        crate::task_inputs::integrate_candidates_with_policy(
            &workspace,
            &merge_head,
            &merge_sources,
            &sources,
            &outputs,
            || {
                if merge_app
                    .state::<crate::task_execution::TaskExecution>()
                    .cancellation_requested(&merge_task)?
                {
                    Err("集成取消已请求；已完成步骤保留，停止后续合并".into())
                } else {
                    Ok(())
                }
            },
        )
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("原生集成工作线程中断；保留工作区，不自动重放，请人工协调".into()),
    };
    match integration {
        Err(error) => {
            manager.update(&task.id, |record| {
                let a = record.attempts.last_mut().ok_or("Attempt missing")?;
                a.state = if a.state == "stopping" {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                a.failure = Some(format!(
                    "集成已停止，保留当前 Git 状态，请人工协调：{error}"
                ));
                a.ended_at_ms = Some(now_ms());
                Ok(())
            })?;
            publish(&app, &manager);
            Err(error)
        }
        Ok(candidate) => {
            manager.update(&task.id, |record| {
                let a = record.attempts.last_mut().ok_or("Attempt missing")?;
                a.candidate_sha = Some(candidate);
                a.phase = "verification".into();
                Ok(())
            })?;
            publish(&app, &manager);
            let result = crate::task_execution::verify_in_slot(app.clone(), task.id.clone()).await;
            if let Err(error) = &result {
                let _ = manager.update(&task.id, |record| {
                    let a = record.attempts.last_mut().ok_or("Attempt missing")?;
                    a.state = if a.state == "stopping" {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    a.failure = Some(error.clone());
                    a.ended_at_ms = Some(now_ms());
                    Ok(())
                });
                publish(&app, &manager);
            }
            result
        }
    }
}

fn export_passport(
    app: AppHandle,
    manager: TaskManager,
    request: TaskIdRequest,
) -> Result<String, String> {
    let task = manager.get(&request.task_id)?;
    let readiness = complete_readiness(&app, &manager, &task, observation(&app, &manager, &task));
    let attempts:Vec<_>=task.attempts.iter().map(|a|json!({"attemptId":a.id,"state":a.state,"phase":a.phase,"candidateSha":a.candidate_sha,
        "execution":a.execution.as_ref().map(|e|json!({"harness":e["harness"],"version":e["version"],"threadId":e["threadId"],"turnId":e["turnId"]})),
        "lineage":a.evidence.as_ref().map(|e|export_lineage(&manager,&task.id,&a.id,e)),
        "evidence":a.evidence.as_ref().map(|e|json!({"runId":e.run_id,"headSha":e.head_sha,"profileDigest":e.profile_digest,"inputDigest":e.input_digest,"toolchainDigest":e.toolchain_digest,"manifestDigest":e.manifest_digest,
            "status":e.status,"checks":e.checks.iter().map(|c|json!({"gateId":c["gateId"],"status":c["status"],"exitCode":c["exitCode"]})).collect::<Vec<_>>(),
            "artifacts":e.artifacts.iter().map(|artifact|json!({"id":artifact["id"],"kind":artifact["kind"],"sha256":artifact["sha256"],"sizeBytes":artifact["sizeBytes"]})).collect::<Vec<_>>()}))})).collect();
    let mut decisions = manager.decisions(&task.id)?;
    for decision in &mut decisions {
        if let Some(record) = decision["record"].as_object_mut() {
            record.remove("note");
        }
    }
    serde_json::to_string_pretty(&json!({"schemaVersion":2,"taskId":task.id,"title":task.title,"goal":task.goal,"scope":task.scope,"baseSha":task.base_sha,"dependencies":task.dependencies,"attempts":attempts,
        "readiness":{"status":readiness.status,"blockerCount":readiness.blockers.len(),"warningCount":readiness.warnings.len(),"reviewCurrent":readiness.review_current,"acceptanceCurrent":readiness.acceptance_current},"decisionHistory":decisions,
        "limitations":["Observed specified checks; not a correctness guarantee or signed execution attestation","Export excludes raw logs, provider transcripts, local paths and review notes"]})).map_err(|e|e.to_string())
}

fn export_lineage(
    manager: &TaskManager,
    task_id: &str,
    attempt_id: &str,
    evidence: &TaskEvidence,
) -> Value {
    let unqualified = json!({"status":"unverified","sourceCommits":[],"toolchainObservations":[]});
    let Ok(path) = manifest_path(manager, &evidence.run_id) else {
        return unqualified;
    };
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return unqualified;
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 2 * 1024 * 1024 {
        return unqualified;
    }
    let Ok(bytes) = fs::read(path) else {
        return unqualified;
    };
    let Ok(manifest) = serde_json::from_slice::<Value>(&bytes) else {
        return unqualified;
    };
    if manifest["taskId"] != task_id
        || manifest["attemptId"] != attempt_id
        || !manifest_matches_record(&manifest, evidence).unwrap_or(false)
    {
        return unqualified;
    }
    let tools:Vec<_>=manifest["toolchainObservations"].as_array().into_iter().flatten().map(|tool|{
        let program=tool["program"].as_str().unwrap_or("unknown");
        json!({"program":Path::new(program).file_name().unwrap_or_default().to_string_lossy(),"sha256":tool["sha256"],"version":tool["version"]})
    }).collect();
    json!({"status":"recorded","sourceCommits":manifest["sourceCommits"],"toolchainObservations":tools})
}

#[tauri::command]
pub(crate) async fn task_export_passport(
    app: AppHandle,
    manager: State<'_, TaskManager>,
    request: TaskIdRequest,
) -> Result<String, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || export_passport(app, manager, request))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn implementation_tree_protection_covers_nested_libraries_and_parent_replacement() {
        let package = PathBuf::from("/tools/npm");
        let paths = std::collections::BTreeSet::from([package]);
        assert!(protected_tree_changed(
            &paths,
            Path::new("/tools/npm/node_modules/parser/index.js")
        ));
        assert!(protected_tree_changed(&paths, Path::new("/tools")));
        assert!(!protected_tree_changed(
            &paths,
            Path::new("/tools/npm-other/index.js")
        ));
    }
    #[test]
    fn compiler_selection_change_and_restore_inside_outputs_is_sticky_before_publication() {
        use notify::Watcher;
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let fixture = Fixture(std::env::temp_dir().join(format!("vl-context-watch-{}", new_id())));
        let build = fixture.0.join("build");
        fs::create_dir_all(&build).unwrap();
        let build = fs::canonicalize(build).unwrap();
        let cache = build.join("CMakeCache.txt");
        let original = "CMAKE_C_COMPILER:FILEPATH=/compiler/A\n";
        fs::write(&cache, original).unwrap();
        let paths = std::collections::BTreeSet::from([cache.clone()]);
        let changed = Arc::new(AtomicBool::new(false));
        let observed = changed.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if event.as_ref().map_or(true, |event| {
                    !matches!(event.kind, notify::EventKind::Access(_))
                        && event
                            .paths
                            .iter()
                            .any(|path| protected_path_changed(&paths, path))
                }) {
                    observed.store(true, Ordering::Release);
                }
            })
            .unwrap();
        watcher
            .watch(&build, notify::RecursiveMode::Recursive)
            .unwrap();
        fs::write(&cache, "CMAKE_C_COMPILER:FILEPATH=/compiler/B\n").unwrap();
        fs::write(&cache, original).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
        while !changed.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(fs::read_to_string(cache).unwrap(), original);
        assert!(changed.load(Ordering::Acquire));
    }
    #[test]
    fn rejected_dependency_revokes_current_review_and_acceptance() {
        let mut result = TaskReadiness {
            status: "ready".into(),
            blockers: vec![],
            warnings: vec![],
            candidate_sha: Some("head".into()),
            review_current: true,
            acceptance_current: true,
        };
        apply_dependency_readiness(&mut result, Err("source rejected".into()));
        assert_eq!(result.status, "unverified");
        assert!(!result.acceptance_current && !result.review_current);
        assert!(result.blockers[0].contains("source rejected"));
    }
    #[test]
    fn newly_passing_dependency_cannot_qualify_old_integrated_lineage() {
        let lineage = json!({"status":"recorded","sourceCommits":["A1","B1"]});
        assert!(require_fixed_lineage(&lineage, &["A1".into(), "B1".into()]).is_ok());
        assert!(require_fixed_lineage(&lineage, &["A2".into(), "B1".into()]).is_err());
        assert!(require_fixed_lineage(
            &json!({"status":"unverified","sourceCommits":["A1","B1"]}),
            &["A1".into(), "B1".into()]
        )
        .is_err());
    }
    #[test]
    fn explicit_verification_adopts_committed_integration_fix_without_rewriting_old_candidate() {
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let fixture =
            Fixture(std::env::temp_dir().join(format!("vl-manual-candidate-{}", new_id())));
        let root = &fixture.0;
        fs::create_dir_all(root.join("src")).unwrap();
        git(root, &["init", "--initial-branch=main"]).unwrap();
        git(root, &["config", "core.autocrlf", "false"]).unwrap();
        git(root, &["config", "user.name", "Task Fixture"]).unwrap();
        git(root, &["config", "user.email", "fixture@example.invalid"]).unwrap();
        fs::write(root.join("src/code.cpp"), "broken\n").unwrap();
        git(root, &["add", "--", "src/code.cpp"]).unwrap();
        git(root, &["commit", "-m", "base"]).unwrap();
        let old = git(root, &["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        let mut record = task();
        record.repository_root = root.to_string_lossy().into();
        record.workspace_root = Some(record.repository_root.clone());
        record.kind = "integration".into();
        record.base_sha = old.clone();
        record.attempts[0].candidate_sha = Some(old.clone());
        record.attempts[0].state = "failed".into();
        fs::write(root.join("src/code.cpp"), "fixed\n").unwrap();
        git(root, &["add", "--", "src/code.cpp"]).unwrap();
        git(root, &["commit", "-m", "fix"]).unwrap();
        let repaired = git(root, &["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        assert_eq!(manual_candidate(&record, &[old.clone()]).unwrap(), repaired);
        assert_eq!(
            record.attempts[0].candidate_sha.as_deref(),
            Some(old.as_str())
        );
        record.attempts[0].candidate_sha = None;
        assert_eq!(manual_candidate(&record, &[old.clone()]).unwrap(), repaired);
        fs::write(root.join("outside.txt"), "unapproved\n").unwrap();
        git(root, &["add", "--", "outside.txt"]).unwrap();
        git(root, &["commit", "-m", "outside"]).unwrap();
        assert!(manual_candidate(&record, &[old])
            .unwrap_err()
            .contains("范围外"));
    }
    fn task() -> TaskRecord {
        serde_json::from_value(json!({
            "id":"task-fixture","repositoryRoot":"/fixture","title":"Fix","goal":"Fix source","scope":["src"],"baseSha":"base",
            "kind":"implementation","dependencies":[],"profile":{"schemaVersion":1,"id":"p","name":"P","gates":[{"id":"build","label":"Build","required":true}]},
            "autoCommit":true,"revision":1,"workspaceRoot":"/fixture/worktree","createdAtMs":1,"updatedAtMs":1,
            "attempts":[{"id":"attempt","state":"succeeded","phase":"verification","candidateSha":"candidate","failure":null,"startedAtMs":1,"endedAtMs":2,
                "evidence":{"runId":"run","headSha":"candidate","profileDigest":"profile","inputDigest":"inputs","toolchainDigest":"tools","status":"pass","checks":[{"gateId":"build","status":"pass"}],"artifacts":[],"observedAtMs":2}}],
            "review":{"headSha":"candidate","inputDigest":"inputs","profileDigest":"profile","runId":"run","toolchainDigest":"tools","approved":true,"note":"Reviewed","createdAtMs":3},
            "acceptance":{"headSha":"candidate","inputDigest":"inputs","profileDigest":"profile","runId":"run","toolchainDigest":"tools","acceptedAtMs":4,"acknowledgedWarnings":false}
        })).unwrap()
    }
    fn observation() -> Observation {
        Observation {
            source: Some(crate::task_inputs::SourceIdentity {
                head_sha: "candidate".into(),
                digest: "inputs".into(),
                clean: true,
            }),
            profile_digest: "profile".into(),
            toolchain_digest: Some("tools".into()),
            provenance_error: None,
            integrity_error: None,
        }
    }
    #[test]
    fn successful_execution_is_not_delivery_without_checks_and_review() {
        let mut task = task();
        task.attempts[0].evidence = None;
        let result = derive_readiness(&task, observation());
        assert_eq!(result.status, "unverified");
        assert!(!result.acceptance_current);
        task = self::task();
        task.review = None;
        assert_eq!(derive_readiness(&task, observation()).status, "unverified");
    }
    #[test]
    fn same_head_changed_source_invalidates_review_and_acceptance() {
        let mut current = observation();
        current.source.as_mut().unwrap().digest = "changed".into();
        let result = derive_readiness(&task(), current);
        assert_eq!(result.status, "unverified");
        assert!(!result.review_current);
        assert!(!result.acceptance_current);
    }
    #[test]
    fn actual_required_failure_overrides_pass_summary_and_acceptance() {
        let mut task = task();
        task.attempts[0].evidence.as_mut().unwrap().checks[0]["status"] = json!("fail");
        let result = derive_readiness(&task, observation());
        assert_eq!(result.status, "blocked");
        assert!(!result.acceptance_current);
    }
    #[test]
    fn valid_result_can_be_ready_and_accepted_as_separate_facts() {
        let task = task();
        let result = derive_readiness(&task, observation());
        assert_eq!(result.status, "ready");
        assert!(result.review_current);
        assert!(result.acceptance_current);
    }
    #[test]
    fn changed_toolchain_or_tampered_artifact_never_remains_accepted() {
        let mut tools = observation();
        tools.toolchain_digest = Some("different".into());
        assert_eq!(derive_readiness(&task(), tools).status, "unverified");
        let mut tampered = observation();
        tampered.integrity_error = Some("digest mismatch".into());
        let result = derive_readiness(&task(), tampered);
        assert_eq!(result.status, "blocked");
        assert!(!result.acceptance_current);
    }
    #[test]
    fn closed_application_continuity_is_unknown_even_if_source_bytes_match() {
        assert!(!evidence_session_current(
            "new-session",
            &json!({"observationSession":"old-session"})
        ));
        assert!(!evidence_session_current("new-session", &json!({})));
        assert!(evidence_session_current(
            "new-session",
            &json!({"observationSession":"new-session"})
        ));
    }
    #[test]
    fn explicit_source_rejection_blocks_candidate_consumption() {
        let mut task = task();
        task.review.as_mut().unwrap().approved = false;
        let evidence = task.attempts[0].evidence.as_ref().unwrap();
        assert!(candidate_rejected(&task, evidence));
        task.review.as_mut().unwrap().approved = true;
        assert!(!candidate_rejected(
            &task,
            task.attempts[0].evidence.as_ref().unwrap()
        ));
    }
    #[test]
    fn fresh_run_under_new_toolchain_requires_new_human_decisions() {
        let mut task = task();
        let evidence = task.attempts[0].evidence.as_mut().unwrap();
        evidence.run_id = "new-run".into();
        evidence.toolchain_digest = "new-tools".into();
        let mut current = observation();
        current.toolchain_digest = Some("new-tools".into());
        let readiness = derive_readiness(&task, current);
        assert_eq!(readiness.status, "unverified");
        assert!(!readiness.review_current);
        assert!(!readiness.acceptance_current);
    }
    #[test]
    fn full_manifest_binding_detects_changed_source_lineage() {
        let mut evidence = task().attempts.remove(0).evidence.unwrap();
        let mut body = serde_json::to_value(&evidence).unwrap();
        body.as_object_mut().unwrap().remove("manifestDigest");
        let mut manifest =
            json!({"schemaVersion":2,"evidence":body,"sourceCommits":["a".repeat(40)]});
        evidence.manifest_digest = Some(digest_json(&manifest).unwrap());
        assert!(manifest_matches_record(&manifest, &evidence).unwrap());
        manifest["sourceCommits"] = json!(["b".repeat(40)]);
        assert!(!manifest_matches_record(&manifest, &evidence).unwrap());
    }
    #[cfg(unix)]
    #[test]
    fn evidence_directory_symlink_cannot_redirect_native_storage() {
        use std::os::unix::fs::symlink;
        let base = std::env::temp_dir().join(format!("vl-evidence-root-{}", new_id()));
        fs::create_dir_all(base.join("outside")).unwrap();
        let manager = TaskManager::open(base.join("tasks.json")).unwrap();
        symlink(base.join("outside"), base.join("task-evidence")).unwrap();
        assert!(manifest_path(&manager, "run-fixture").is_err());
        assert_eq!(fs::read_dir(base.join("outside")).unwrap().count(), 0);
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn integration_preview_expires_and_cannot_be_reused() {
        let runtime = TaskDelivery::default();
        let preview = IntegrationPreview {
            plan_id: "once".into(),
            task_id: "task".into(),
            repository_root: "repo".into(),
            workspace_root: "tree".into(),
            target_head_sha: "head".into(),
            source_commits: vec!["source".into()],
            expires_at_ms: 10,
        };
        runtime.insert(preview.clone()).unwrap();
        assert!(runtime.take("once", 11).is_err());
        runtime.insert(preview).unwrap();
        assert!(runtime.take("once", 9).is_ok());
        assert!(runtime.take("once", 9).is_err());
    }
}
