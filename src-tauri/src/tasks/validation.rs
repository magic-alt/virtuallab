use super::{
    model::*,
    store::{Generation, MAX_DECISIONS, MAX_EVENTS, MAX_QUEUED, MAX_TASKS},
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::Path,
};

pub(super) fn id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("Identifier must contain 1–64 ASCII letters/digits/_/-.".into());
    }
    Ok(())
}
pub(super) fn sha(value: &str) -> Result<(), String> {
    if !matches!(value.len(), 40 | 64)
        || !value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("Expected a full lower-case commit SHA.".into());
    }
    Ok(())
}
fn digest(value: &str) -> Result<(), String> {
    if value.len() != 64 {
        return Err("Expected a SHA-256 digest.".into());
    }
    sha(value)
}
fn text(value: &str, max: usize, required: bool) -> Result<(), String> {
    if value.len() > max || (required && value.trim().is_empty()) || value.contains('\0') {
        return Err("Invalid or oversized structural text.".into());
    }
    Ok(())
}
pub(super) fn canonical_root(root: &str) -> Result<String, String> {
    text(root, 4096, true)?;
    if !Path::new(root).is_absolute() {
        return Err("Repository path must be absolute.".into());
    }
    let path = fs::canonicalize(root).map_err(|_| "Repository path is unavailable.")?;
    if !path.is_dir() {
        return Err("Repository path is not a directory.".into());
    }
    let spelling = path
        .to_str()
        .ok_or("Repository path is not valid Unicode.")?;
    Ok(crate::workspace_identity::key(spelling))
}
pub(super) fn repository_head(root: &str, expected: &str) -> Result<String, String> {
    let canonical = canonical_root(root)?;
    // Fixed, read-only argv; never interpret a request-supplied revision.
    let read = |args: &[&str]| -> Result<String, String> {
        let out = crate::process::background_command("git")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .arg("--no-optional-locks")
            .args(args)
            .current_dir(&canonical)
            .output()
            .map_err(|_| "Git repository identity inspection failed.")?;
        if !out.status.success() || out.stdout.len() > 16_384 {
            return Err("Git repository identity inspection failed.".into());
        }
        let value =
            String::from_utf8(out.stdout).map_err(|_| "Git returned a non-Unicode identity.")?;
        Ok(value.trim_end_matches(['\r', '\n']).into())
    };
    let top = read(&["rev-parse", "--show-toplevel"])?;
    if canonical_root(&top)? != canonical {
        return Err("Select the repository root, not a subdirectory.".into());
    }
    let head = read(&["rev-parse", "--verify", "HEAD^{commit}"])?;
    sha(&head)?;
    if head != expected {
        return Err("Repository HEAD changed; refresh the task plan.".into());
    }
    Ok(canonical)
}
fn relative(value: &str) -> Result<(), String> {
    text(value, 1024, true)?;
    if value.contains('\\')
        || value
            .chars()
            .any(|c| c.is_control() || ":*?[]<>|\"".contains(c))
        || value.starts_with('/')
    {
        return Err("Scope/profile paths must be safe literal relative paths.".into());
    }
    for part in value.split('/') {
        let lower = part.to_ascii_lowercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || lower == ".git"
            || lower == ".env"
            || lower.starts_with(".env.")
            || lower.starts_with(".env-")
        {
            return Err("Unsafe traversal, repository metadata or secret path.".into());
        }
    }
    Ok(())
}
fn paths(values: &[String], required: bool, root: Option<&str>, allow_root: bool) -> Result<(), String> {
    if values.len() > 128 || (required && values.is_empty()) {
        return Err("Scope/path list must contain at most 128 paths.".into());
    }
    // Only an explicit single task scope may cover the repository root. Profile paths stay narrow.
    if allow_root && values.iter().any(|path| path == ".") && values.len() != 1 {
        return Err("Repository-wide scope must be the sole task path.".into());
    }
    // Durable identity keys normalize Windows case and verbatim prefixes.
    // Filesystem containment must compare native canonical paths on both sides.
    let base = root
        .map(fs::canonicalize)
        .transpose()
        .map_err(|_| "Repository path is unavailable.")?;
    let mut seen = HashSet::new();
    for path in values {
        if path != "." || !allow_root {
            relative(path)?;
        }
        if !seen.insert(path) {
            return Err("Duplicate scope/profile path.".into());
        }
        if let Some(base) = base.as_deref() {
            let mut candidate = base.join(path);
            loop {
                match fs::symlink_metadata(&candidate) {
                    Ok(_) => {
                        let actual =
                            fs::canonicalize(&candidate).map_err(|_| "Invalid scope symlink.")?;
                        if !actual.starts_with(base) {
                            return Err(
                                "Scope/profile path escapes the selected repository.".into()
                            );
                        }
                        // A safe alias must not smuggle metadata or secret inputs
                        // through a symlink pointing inside the repository.
                        if actual != base {
                            let resolved = actual
                                .strip_prefix(base)
                                .map_err(|_| "Invalid scope identity.")?;
                            let resolved = resolved.to_str().ok_or("Scope path is not Unicode.")?;
                            // Native Windows separators are not request syntax;
                            // on Unix a literal backslash remains disallowed.
                            #[cfg(windows)]
                            relative(&resolved.replace('\\', "/"))?;
                            #[cfg(not(windows))]
                            relative(resolved)?;
                        }
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        if !candidate.pop() {
                            return Err("Invalid scope ancestor.".into());
                        }
                    }
                    Err(_) => return Err("Cannot inspect scope ancestor.".into()),
                }
            }
        }
    }
    Ok(())
}
fn object<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let obj = value
        .as_object()
        .ok_or("Expected a structured JSON object.")?;
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("Unknown structural JSON field.".into());
    }
    Ok(obj)
}
fn string<'a>(v: &'a Value, field: &str) -> Result<&'a str, String> {
    v.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Expected string field: {field}."))
}
fn string_list(v: &Value) -> Result<Vec<String>, String> {
    let array = v.as_array().ok_or("Expected path/argument array.")?;
    if array.len() > 128 {
        return Err("Too many paths/arguments.".into());
    }
    array
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "Expected string path/argument.".into())
        })
        .collect()
}
fn execution(value: &Value) -> Result<(), String> {
    super::store::bounded_json(value, 8192)?;
    object(
        value,
        &["harness", "executablePath", "version", "threadId", "turnId"],
    )?;
    id(string(value, "harness")?)?;
    for field in ["executablePath", "version", "threadId", "turnId"] {
        let value = value
            .get(field)
            .ok_or("Missing execution identity field.")?;
        if value.is_null() {
            continue;
        }
        let value = value
            .as_str()
            .ok_or("Execution identity must contain strings or null.")?;
        let maximum = match field {
            "executablePath" => 4096,
            "version" => 256,
            _ => 512,
        };
        text(value, maximum, false)?;
        if value.chars().any(char::is_control) {
            return Err("Execution identity must not contain raw output.".into());
        }
        if field == "executablePath" {
            absolute(value)?;
        }
    }
    Ok(())
}
pub(crate) fn profile(value: &Value, root: Option<&str>) -> Result<(), String> {
    // Bound the entire profile, including argv and adapter metadata, before
    // retaining it in a durable generation. Never allocate its full encoding.
    super::store::bounded_json(value, 64 * 1024)?;
    object(
        value,
        &[
            "schemaVersion",
            "id",
            "name",
            "description",
            "gates",
            "outputPaths",
            "sourcePaths",
            "toolchainPrograms",
        ],
    )?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported task profile schema.".into());
    }
    id(string(value, "id")?)?;
    text(string(value, "name")?, 256, true)?;
    if let Some(description) = value.get("description") {
        text(
            description.as_str().ok_or("Invalid profile description.")?,
            4096,
            false,
        )?;
    }
    for field in ["outputPaths", "sourcePaths"] {
        if let Some(list) = value.get(field) {
            paths(&string_list(list)?, false, root, false)?;
        }
    }
    if let Some(list) = value.get("toolchainPrograms") {
        let values = string_list(list)?;
        let mut seen = HashSet::new();
        for program in values {
            executable_identity(&program)?;
            if !seen.insert(program) {
                return Err("Duplicate toolchain program.".into());
            }
        }
    }
    let gates = value
        .get("gates")
        .and_then(Value::as_array)
        .ok_or("Profile gates required.")?;
    if gates.is_empty() || gates.len() > 64 {
        return Err("A task profile requires 1–64 gates.".into());
    }
    let mut ids = HashSet::new();
    for gate in gates {
        object(
            gate,
            &["id", "label", "kind", "required", "approval", "executor"],
        )?;
        let gate_id = string(gate, "id")?;
        id(gate_id)?;
        if !ids.insert(gate_id) {
            return Err("Duplicate gate ID.".into());
        }
        text(string(gate, "label")?, 256, true)?;
        if !matches!(
            string(gate, "kind")?,
            "build" | "unit" | "evidence" | "hil" | "hardware" | "soak"
        ) || !matches!(string(gate, "approval")?, "none" | "human")
            || gate.get("required").and_then(Value::as_bool).is_none()
        {
            return Err("Invalid verification gate policy.".into());
        }
        let executor = gate.get("executor").ok_or("Gate executor required.")?;
        match string(executor, "type")? {
            "process" => {
                object(executor, &["type", "program", "args", "cwd", "timeoutMs"])?;
                let program = string(executor, "program")?;
                // Match verification::approved_program exactly. Provenance
                // metadata can name absolute tools; runnable gate names cannot.
                if !matches!(
                    program,
                    "cargo"
                        | "cargo.exe"
                        | "cmake"
                        | "cmake.exe"
                        | "ctest"
                        | "ctest.exe"
                        | "ninja"
                        | "ninja.exe"
                        | "npm"
                        | "npm.exe"
                        | "node"
                        | "node.exe"
                ) {
                    return Err(
                        "Gate program must match a supported runner name exactly: cargo/cargo.exe, cmake/cmake.exe, ctest/ctest.exe, ninja/ninja.exe, npm/npm.exe, or node/node.exe. Declare executable provenance paths in toolchainPrograms.".into(),
                    );
                }
                let args = string_list(executor.get("args").ok_or("Process argv required.")?)?;
                for arg in &args {
                    text(arg, 2048, false)?;
                    if arg.chars().any(char::is_control) {
                        return Err("Invalid process argument.".into());
                    }
                }
                if args.iter().any(|a| {
                    matches!(
                        a.as_str(),
                        "-e" | "--eval"
                            | "-p"
                            | "--print"
                            | "-c"
                            | "--command"
                            | "--input-type=module"
                    ) || a.starts_with("--eval=")
                        || a.starts_with("--print=")
                }) || (matches!(program, "node" | "node.exe")
                    && args.iter().any(|a| {
                        (a.starts_with("-e") || a.starts_with("-c") || a.starts_with("-p"))
                            && !a.starts_with("--")
                    }))
                {
                    return Err(
                        "Inline JavaScript or shell/interpreter code is not allowed.".into(),
                    );
                }
                if !matches!(string(executor, "cwd")?, "workspace" | "repository") {
                    return Err("Invalid process working directory.".into());
                }
                if let Some(timeout) = executor.get("timeoutMs").filter(|v| !v.is_null()) {
                    if timeout.as_u64().is_none_or(|n| n == 0 || n > 600_000) {
                        return Err("Invalid process timeout.".into());
                    }
                }
            }
            "adapter" => {
                object(executor, &["type", "adapter", "action", "parameters"])?;
                if !matches!(string(executor, "adapter")?, "hil" | "hardware") {
                    return Err("Unknown verification adapter.".into());
                }
                id(string(executor, "action")?)?;
                if let Some(parameters) = executor.get("parameters") {
                    let map = parameters
                        .as_object()
                        .ok_or("Invalid adapter parameters.")?;
                    if map.len() > 64 {
                        return Err("Too many adapter parameters.".into());
                    }
                    for (key, value) in map {
                        id(key)?;
                        if let Some(s) = value.as_str() {
                            text(s, 1024, false)?;
                        } else if !value.is_number() && !value.is_boolean() {
                            return Err("Adapter parameters must be scalar.".into());
                        }
                    }
                }
            }
            _ => return Err("Unknown task profile executor.".into()),
        }
    }
    Ok(())
}
fn executable_identity(program: &str) -> Result<(), String> {
    text(program, 4096, true)?;
    if program.split(['/', '\\']).any(|part| {
        let part = part.to_ascii_lowercase();
        part == "."
            || part == ".."
            || part == ".git"
            || part == ".env"
            || part.starts_with(".env.")
            || part.starts_with(".env-")
    }) {
        return Err("Executable provenance cannot fingerprint secret or metadata paths.".into());
    }
    if program
        .chars()
        .any(|c| c.is_control() || ";|&`$<>\"".contains(c))
    {
        return Err("Invalid executable identity.".into());
    }
    let absolute = Path::new(program).is_absolute()
        || (program.as_bytes().get(1) == Some(&b':')
            && matches!(program.as_bytes().get(2), Some(b'\\' | b'/')))
        || program.starts_with("\\\\");
    if !absolute
        && !program
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
    {
        return Err("Executable identity must be a command name or an absolute path.".into());
    }
    Ok(())
}
pub(super) fn draft(task: &TaskDraft, root: &str) -> Result<(), String> {
    id(&task.key)?;
    text(&task.title, 256, true)?;
    text(&task.goal, 8192, true)?;
    paths(&task.scope, true, Some(root), true)?;
    if !matches!(task.kind.as_str(), "implementation" | "integration") {
        return Err("Unknown task kind.".into());
    }
    if task.dependency_keys.len() > 128 {
        return Err("Too many task dependencies.".into());
    }
    for dep in &task.dependency_keys {
        id(dep)?;
    }
    if let Some(p) = &task.profile {
        profile(p, Some(root))?;
    }
    Ok(())
}
pub(super) fn event_kind(kind: &str) -> Result<(), String> {
    if !matches!(
        kind,
        "plan.accepted"
            | "task.updated"
            | "attempt.queued"
            | "attempt.started"
            | "attempt.running"
            | "attempt.stopping"
            | "attempt.succeeded"
            | "attempt.failed"
            | "attempt.cancelled"
            | "attempt.interrupted"
            | "attempt.retried"
            | "workspace.prepared"
            | "verification.started"
            | "verification.completed"
            | "review.recorded"
            | "result.accepted"
            | "integration.previewed"
            | "integration.confirmed"
            | "integration.failed"
            | "candidate.sealed"
    ) {
        return Err("Unknown structural task event kind.".into());
    }
    Ok(())
}
pub(super) fn mutation(old: &TaskRecord, new: &TaskRecord) -> Result<(), String> {
    if old.id != new.id
        || old.repository_root != new.repository_root
        || old.base_sha != new.base_sha
        || old.kind != new.kind
        || old.scope != new.scope
        || old.dependencies != new.dependencies
        || old.profile != new.profile
        || old.auto_commit != new.auto_commit
        || old.created_at_ms != new.created_at_ms
    {
        return Err("Accepted plan identity and inputs are immutable.".into());
    }
    if new.attempts.len() < old.attempts.len()
        || old
            .attempts
            .iter()
            .zip(&new.attempts)
            .any(|(a, b)| a.id != b.id || a.started_at_ms != b.started_at_ms)
    {
        return Err("Attempt lineage cannot be removed or replaced.".into());
    }
    if old.attempts.iter().zip(&new.attempts).any(|(a, b)| {
        matches!(
            a.state.as_str(),
            "succeeded" | "failed" | "cancelled" | "interrupted"
        ) && a != b
    }) {
        return Err("Completed attempts are historical; retry creates a new attempt.".into());
    }
    Ok(())
}
fn absolute(path: &str) -> Result<(), String> {
    text(path, 4096, true)?;
    if !Path::new(path).is_absolute() {
        return Err("Stored workspace/repository paths must be absolute.".into());
    }
    Ok(())
}
fn status(value: &str) -> Result<(), String> {
    if !matches!(
        value,
        "pass" | "warn" | "fail" | "running" | "not_run" | "blocked" | "cancelled"
    ) {
        return Err("Unknown evidence status.".into());
    }
    Ok(())
}
fn evidence(e: &TaskEvidence) -> Result<(), String> {
    id(&e.run_id)?;
    sha(&e.head_sha)?;
    digest(&e.profile_digest)?;
    digest(&e.input_digest)?;
    digest(&e.toolchain_digest)?;
    status(&e.status)?;
    if e.checks.len() > 64 || e.artifacts.len() > 256 {
        return Err("Evidence capacity exceeded.".into());
    }
    let mut gates = HashSet::new();
    for check in &e.checks {
        object(
            check,
            &[
                "gateId",
                "status",
                "detail",
                "startedAtMs",
                "finishedAtMs",
                "exitCode",
            ],
        )?;
        let gate_id = string(check, "gateId")?;
        id(gate_id)?;
        if !gates.insert(gate_id) {
            return Err("Duplicate evidence check.".into());
        }
        status(string(check, "status")?)?;
        text(string(check, "detail")?, 4096, false)?;
        if check.get("startedAtMs").and_then(Value::as_u64).is_none() {
            return Err("Invalid check timestamp.".into());
        }
        for field in ["finishedAtMs", "exitCode"] {
            if let Some(v) = check.get(field).filter(|v| !v.is_null()) {
                if (field == "finishedAtMs" && v.as_u64().is_none())
                    || (field == "exitCode" && v.as_i64().is_none())
                {
                    return Err("Invalid evidence check result.".into());
                }
            }
        }
    }
    let mut artifacts = HashSet::new();
    for a in &e.artifacts {
        object(a, &["id", "kind", "path", "sha256", "sizeBytes"])?;
        let artifact_id = string(a, "id")?;
        id(artifact_id)?;
        if !artifacts.insert(artifact_id) {
            return Err("Duplicate evidence artifact.".into());
        }
        if !matches!(
            string(a, "kind")?,
            "log" | "junit" | "trace" | "waveform" | "image" | "report" | "other"
        ) {
            return Err("Invalid artifact kind.".into());
        }
        text(string(a, "path")?, 4096, true)?;
        if let Some(v) = a.get("sha256").filter(|v| !v.is_null()) {
            digest(v.as_str().ok_or("Invalid artifact digest.")?)?;
        }
        if a.get("sizeBytes")
            .is_some_and(|v| !v.is_null() && v.as_u64().is_none())
        {
            return Err("Invalid artifact size.".into());
        }
    }
    Ok(())
}
pub(super) fn generation(g: &Generation) -> Result<(), String> {
    if g.schema_version != 1
        || g.tasks.len() > MAX_TASKS
        || g.events.len() > MAX_EVENTS
        || g.decision_history.len() > MAX_DECISIONS
        || g.launch_requests.len() > MAX_TASKS
        || g.rejected_launch_requests.len() > MAX_TASKS
    {
        return Err("Incompatible/oversized task store.".into());
    }
    let mut ids = HashSet::new();
    let mut by_id = HashMap::new();
    let mut attempts = HashMap::new();
    let mut queued = 0;
    let mut launch_ids = HashSet::new();
    for receipt in &g.launch_requests {
        id(&receipt.request_id)?;
        id(&receipt.task_id)?;
        digest(&receipt.request_digest)?;
        if !launch_ids.insert(&receipt.request_id)
            || !g.tasks.iter().any(|task| task.id == receipt.task_id)
            || (!receipt.finished && receipt.launch_error.is_some()) {
            return Err("Invalid durable launch receipt.".into());
        }
        if let Some(error) = &receipt.launch_error { text(error, 4096, false)?; }
    }
    for receipt in &g.rejected_launch_requests {
        id(&receipt.request_id)?;
        text(&receipt.message, 4096, false)?;
        if !launch_ids.insert(&receipt.request_id) { return Err("Duplicate or contradictory launch receipt.".into()); }
    }
    for task in &g.tasks {
        id(&task.id)?;
        if !ids.insert(task.id.as_str()) {
            return Err("Duplicate durable ID.".into());
        }
        by_id.insert(task.id.as_str(), task);
        absolute(&task.repository_root)?;
        sha(&task.base_sha)?;
        text(&task.title, 256, true)?;
        text(&task.goal, 8192, true)?;
        paths(&task.scope, true, None, true)?;
        if !matches!(task.kind.as_str(), "implementation" | "integration")
            || task.revision == 0
            || task.updated_at_ms < task.created_at_ms
            || task.dependencies.len() > 128
            || task.attempts.len() > 1024
        {
            return Err("Invalid stored task structure.".into());
        }
        if let Some(root) = &task.workspace_root {
            absolute(root)?;
        }
        if let Some(p) = &task.profile {
            profile(p, None)?;
        }
        let mut active = 0;
        for attempt in &task.attempts {
            id(&attempt.id)?;
            if !ids.insert(attempt.id.as_str()) {
                return Err("Duplicate durable ID.".into());
            }
            attempts.insert(attempt.id.as_str(), task.id.as_str());
            if !matches!(
                attempt.state.as_str(),
                "queued"
                    | "running"
                    | "stopping"
                    | "succeeded"
                    | "failed"
                    | "cancelled"
                    | "interrupted"
            ) || !matches!(
                attempt.phase.as_str(),
                "implementation" | "sealing" | "integration" | "verification" | "review"
            ) {
                return Err("Unknown attempt state/phase.".into());
            }
            if matches!(attempt.state.as_str(), "queued" | "running" | "stopping") {
                active += 1;
            }
            if attempt.state == "queued" && task.kind == "implementation" {
                queued += 1;
            }
            if let Some(sha_value) = &attempt.candidate_sha {
                sha(sha_value)?;
            }
            if let Some(failure) = &attempt.failure {
                text(failure, 4096, false)?;
            }
            if attempt
                .ended_at_ms
                .is_some_and(|end| end < attempt.started_at_ms)
            {
                return Err("Invalid attempt timestamps.".into());
            }
            if let Some(e) = &attempt.evidence {
                evidence(e)?;
            }
            if let Some(identity) = &attempt.execution {
                execution(identity)?;
            }
        }
        if active > 1 {
            return Err("Task has competing active attempts.".into());
        }
        if let Some(review) = &task.review {
            sha(&review.head_sha)?;
            digest(&review.input_digest)?;
            digest(&review.profile_digest)?;
            text(&review.note, 8192, false)?;
        }
        if let Some(acceptance) = &task.acceptance {
            sha(&acceptance.head_sha)?;
            digest(&acceptance.input_digest)?;
            digest(&acceptance.profile_digest)?;
        }
    }
    if queued > MAX_QUEUED {
        return Err("Queued leaf task limit (32) reached.".into());
    }
    for decision in &g.decision_history {
        id(decision.task_id())?;
        if !by_id.contains_key(decision.task_id()) {
            return Err("Archived decision references an unknown task.".into());
        }
        match decision {
            TaskDecision::Review { record, .. } => {
                sha(&record.head_sha)?;
                digest(&record.input_digest)?;
                digest(&record.profile_digest)?;
                text(&record.note, 8192, false)?;
            }
            TaskDecision::Acceptance { record, .. } => {
                sha(&record.head_sha)?;
                digest(&record.input_digest)?;
                digest(&record.profile_digest)?;
            }
        }
    }
    let mut indegree: HashMap<&str, usize> = by_id.keys().map(|id| (*id, 0)).collect();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
    for task in &g.tasks {
        let mut seen = HashSet::new();
        for dep in &task.dependencies {
            id(dep)?;
            let target = by_id
                .get(dep.as_str())
                .ok_or("Dependency does not exist.")?;
            if target.repository_root != task.repository_root || !seen.insert(dep) {
                return Err("Cross-repository or duplicate dependency.".into());
            }
            *indegree.get_mut(task.id.as_str()).unwrap() += 1;
            dependents.entry(dep).or_default().push(&task.id);
        }
    }
    let mut ready: VecDeque<_> = indegree
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut visited = 0;
    while let Some(id) = ready.pop_front() {
        visited += 1;
        for dep in dependents.get(id).into_iter().flatten() {
            let n = indegree.get_mut(dep).unwrap();
            *n -= 1;
            if *n == 0 {
                ready.push_back(*dep);
            }
        }
    }
    if visited != g.tasks.len() {
        return Err("Task dependency cycle.".into());
    }
    let mut revisions: HashMap<&str, u64> = HashMap::new();
    for (offset, event) in g.events.iter().enumerate() {
        id(&event.event_id)?;
        event_kind(&event.kind)?;
        if event.schema_version != 1
            || event.seq != offset as u64 + 1
            || !ids.insert(event.event_id.as_str())
            || !by_id.contains_key(event.task_id.as_str())
        {
            return Err("Invalid event identity/sequence; lineage cannot be truncated.".into());
        }
        if let Some(attempt) = &event.attempt_id {
            if attempts.get(attempt.as_str()) != Some(&event.task_id.as_str()) {
                return Err("Event references an unknown/cross-task attempt.".into());
            }
        }
        let revision = revisions.entry(&event.task_id).or_default();
        if *revision == 0 && event.kind != "plan.accepted" {
            return Err("Task creation lineage is missing.".into());
        }
        if *revision != 0 && event.kind == "plan.accepted" {
            return Err("Duplicate task creation event.".into());
        }
        *revision += 1;
    }
    if g.tasks
        .iter()
        .any(|t| revisions.get(t.id.as_str()) != Some(&t.revision))
    {
        return Err("Task revision/event lineage mismatch.".into());
    }
    Ok(())
}
