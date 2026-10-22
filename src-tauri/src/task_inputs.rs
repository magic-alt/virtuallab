//! Repository-neutral source observation and task-scoped local Git adapters.
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

mod eol;

const MAX_GIT_OUTPUT: usize = 8 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
static NEXT_INDEX: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub(crate) struct SourceIdentity {
    pub head_sha: String,
    pub digest: String,
    pub clean: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct SourceSnapshot {
    pub identity: SourceIdentity,
    pub raw_files: BTreeMap<String, String>,
    conversion_config: String,
    conversion_external: String,
    conversion_working: BTreeMap<String, String>,
    conversion_files: BTreeMap<String, String>,
}

struct PreparedInput {
    mode: String,
    oid: String,
    path: PathBuf,
    raw_path: PathBuf,
    safe_to_seal: bool,
}
impl PreparedInput {
    fn entry(&self) -> String { format!("{} {} 0", self.mode, self.oid) }
}
struct ObservedSources {
    snapshot: SourceSnapshot,
    changed: BTreeSet<String>,
    prepared: BTreeMap<String, PreparedInput>,
    // Own the private immutable canonical copies through candidate publication.
    _copies: TemporaryIndex,
}

fn git_command(root: &Path, args: &[&str], index: Option<&Path>) -> Command {
    let mut command = crate::process::background_command("git");
    // Ambient Git variables must never redirect the selected repository,
    // index, objects, configuration, pathspec semantics or commit identity.
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(name);
        }
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .arg("--literal-pathspecs")
        .arg("--no-optional-locks")
        .args(["-c", "core.fsmonitor=false"]);
    #[cfg(unix)]
    command.args(["-c", "core.filemode=true"]);
    if let Some(index) = index {
        command
            .env("GIT_INDEX_FILE", index)
            .args(["-c", "core.splitIndex=false"]);
    }
    if matches!(args.first(), Some(&"diff") | Some(&"diff-tree")) {
        command
            .arg(args[0])
            .args(["--no-ext-diff", "--no-textconv"])
            .args(&args[1..]);
    } else {
        command.args(args);
    }
    command
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn operation(args: &[&str]) -> &'static str {
    match args.first().copied() {
        Some("add") | Some("update-index") => "staging",
        Some("read-tree") | Some("write-tree") => "candidate tree",
        Some("commit-tree") => "candidate commit",
        Some("update-ref") => "candidate reference",
        Some("merge") => "integration",
        _ => "inspection",
    }
}

fn drain(
    mut reader: impl Read,
    retain: bool,
    overflow: Arc<AtomicBool>,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| "Git output stream could not be drained")?;
        if count == 0 {
            return Ok(bytes);
        }
        total = total.saturating_add(count);
        if total > MAX_GIT_OUTPUT {
            overflow.store(true, Ordering::Release);
        }
        if retain && bytes.len() < MAX_GIT_OUTPUT {
            let keep = count.min(MAX_GIT_OUTPUT - bytes.len());
            bytes.extend_from_slice(&buffer[..keep]);
        }
    }
}

fn run_git(
    root: &Path,
    args: &[&str],
    index: Option<&Path>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    let label = operation(args);
    if check().is_err() {
        return Err(format!(
            "Git {label} cancelled; inspect the preserved workspace."
        ));
    }
    let mut child = crate::managed_process::spawn(&mut git_command(root, args, index))
        .map_err(|_| format!("Git {label} could not start; inspect local Git setup."))?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().ok_or("Git output pipe unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Git diagnostic pipe unavailable")?;
    let out_flag = overflow.clone();
    let err_flag = overflow.clone();
    let out = thread::spawn(move || drain(stdout, true, out_flag));
    let err = thread::spawn(move || drain(stderr, false, err_flag));
    let started = Instant::now();
    let mut failure = None;
    let status = loop {
        if check().is_err() {
            failure = Some("cancelled");
            break None;
        }
        if overflow.load(Ordering::Acquire) {
            failure = Some("exceeded its output limit");
            break None;
        }
        if started.elapsed() >= GIT_TIMEOUT {
            failure = Some("timed out after 120 seconds");
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                failure = Some("exit could not be observed");
                break None;
            }
        }
    };
    // Even a successful Git leader can leave hook descendants holding pipes.
    // Unknown cleanup retains the worker (and caller's workspace reservation).
    let mut cleanup_retried = false;
    while crate::process::terminate_tree(&mut child).is_err() {
        cleanup_retried = true;
        thread::sleep(Duration::from_millis(50));
    }
    let output = out.join().map_err(|_| "Git output worker failed")??;
    err.join().map_err(|_| "Git diagnostic worker failed")??;
    if let Some(reason) = failure {
        return Err(format!(
            "Git {label} {reason}; inspect the preserved workspace."
        ));
    }
    if overflow.load(Ordering::Acquire) {
        return Err(format!(
            "Git {label} exceeded its output limit; inspect the preserved workspace."
        ));
    }
    if cleanup_retried {
        return Err(format!(
            "Git {label} needed process cleanup recovery; inspect the preserved workspace."
        ));
    }
    let status = status.ok_or("Git exit status unavailable")?;
    if !status.success() {
        // These two documented logical variables use exit 1 when a source is
        // disabled/unset. An unsupported capability exits differently and is
        // reported by the conversion qualifier; never ignore arbitrary errors.
        if status.code() == Some(1)
            && matches!(args, ["var", "GIT_ATTR_SYSTEM"] | ["var", "GIT_ATTR_GLOBAL"])
        {
            return Ok(String::new());
        }
        // Raw hook/tool stderr and stdout never enter durable Attempt.failure.
        return Err(format!(
            "Git {label} failed (exit {}); inspect the preserved workspace locally.",
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".into())
        ));
    }
    String::from_utf8(output)
        .map_err(|_| "Git returned a non-UTF-8 result; this task cannot qualify it".into())
}

pub(crate) fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    run_git(root, args, None, &|| Ok(()))
}
fn index_git(root: &Path, index: &Path, args: &[&str]) -> Result<String, String> {
    run_git(root, args, Some(index), &|| Ok(()))
}
fn files(value: &str) -> BTreeSet<String> {
    value
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn line(value: &str) -> &str {
    value.trim_end_matches(['\r', '\n'])
}

pub(crate) fn safe_relative(value: &str, allow_root: bool) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains(['\\', '\0', ':'])
        || value.chars().any(char::is_control)
    {
        return Err("A task path must be a bounded literal relative path".into());
    }
    if value == "." && allow_root {
        return Ok(());
    }
    if Path::new(value)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Task paths cannot escape the selected workspace".into());
    }
    if value
        .split('/')
        .any(|s| s.eq_ignore_ascii_case(".git") || s.to_lowercase().starts_with(".env"))
    {
        return Err(
            "Git internals and environment-secret files are outside task input scope".into(),
        );
    }
    Ok(())
}
fn in_paths(path: &str, paths: &[String]) -> bool {
    paths.iter().any(|prefix| {
        prefix == "."
            || path == prefix
            || path.starts_with(&format!("{}/", prefix.trim_end_matches('/')))
    })
}

pub(crate) fn registered_workspace(repository: &Path, workspace: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(workspace).map_err(|_| "Workspace unavailable")?;
    let listing = git(repository, &["worktree", "list", "--porcelain", "-z"])?;
    if !listing
        .split('\0')
        .filter_map(|entry| entry.strip_prefix("worktree "))
        .any(|path| {
            crate::workspace_identity::key(path)
                == crate::workspace_identity::key(&root.to_string_lossy())
        })
    {
        return Err("Task workspace is not registered in its selected repository".into());
    }
    Ok(root)
}

fn outputs_policy(
    root: &Path,
    sources: &[String],
    outputs: &[String],
) -> Result<(BTreeSet<String>, Vec<String>), String> {
    for path in sources {
        safe_relative(path, true)?;
    }
    for path in outputs {
        safe_relative(path, false)?;
    }
    let mut excluded = outputs.to_vec();
    excluded.push(".virtuallab/evidence".into());
    let mut tracked = files(&git(root, &["ls-files", "-z", "--cached"])?);
    // A staged deletion must not let an output declaration hide HEAD sources.
    tracked.extend(files(&git(
        root,
        &["ls-tree", "-r", "--name-only", "-z", "HEAD"],
    )?));
    if tracked.iter().any(|path| in_paths(path, &excluded)) {
        return Err("Declared outputs must not mask tracked source files".into());
    }
    if sources
        .iter()
        .any(|source| source != "." && in_paths(source, &excluded))
    {
        return Err("Declared outputs must not mask declared source inputs".into());
    }
    Ok((tracked, excluded))
}

fn reject_hidden_flags(root: &Path) -> Result<(), String> {
    for entry in git(root, &["ls-files", "-v", "-z", "--cached"])?
        .split('\0')
        .filter(|entry| !entry.is_empty())
    {
        let tag = entry.as_bytes()[0];
        if tag == b'S' || tag.is_ascii_lowercase() {
            return Err("Assume-unchanged or skip-worktree flags prevent committed-input qualification; review the index manually without automatic flag changes.".into());
        }
    }
    if !git(root, &["ls-files", "--unmerged", "-z"])?.is_empty() {
        return Err("Unmerged index entries cannot qualify as committed input".into());
    }
    Ok(())
}

fn collect_declared(
    root: &Path,
    path: &Path,
    outputs: &[String],
    names: &mut BTreeSet<String>,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Source outside workspace")?
        .to_str()
        .ok_or("Non-UTF-8 source path")?
        .replace('\\', "/");
    if !relative.is_empty() && in_paths(&relative, outputs) {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "Declared source unavailable")?;
    if meta.file_type().is_symlink() {
        return Err("Symlink inputs require a separately qualified source policy".into());
    }
    if meta.is_dir() {
        for item in fs::read_dir(path).map_err(|_| "Declared source directory unavailable")? {
            let path = item
                .map_err(|_| "Declared source entry unavailable")?
                .path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "Source outside workspace")?
                .to_str()
                .ok_or("Non-UTF-8 source path")?
                .replace('\\', "/");
            if relative
                .split('/')
                .any(|part| part == ".git" || part.to_lowercase().starts_with(".env"))
            {
                continue;
            }
            collect_declared(root, &path, outputs, names)?;
            if names.len() > 20_000 {
                return Err(
                    "Declared source inventory exceeds 20000 files; narrow sourcePaths".into(),
                );
            }
        }
    } else if meta.is_file() {
        safe_relative(&relative, false)?;
        names.insert(relative);
    } else {
        return Err("Source input must be a regular file".into());
    }
    Ok(())
}

fn head_entries(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut entries = BTreeMap::new();
    for entry in git(root, &["ls-tree", "-r", "-z", "HEAD"])?
        .split('\0')
        .filter(|entry| !entry.is_empty())
    {
        let (metadata, name) = entry
            .split_once('\t')
            .ok_or("Unsupported committed entry")?;
        let fields: Vec<_> = metadata.split_whitespace().collect();
        if fields.len() != 3 || fields[1] != "blob" || !matches!(fields[0], "100644" | "100755") {
            return Err(
                "Committed inputs must be regular files, not symlinks or submodules".into(),
            );
        }
        safe_relative(name, false)?;
        entries.insert(name.into(), format!("{} {} 0", fields[0], fields[2]));
    }
    Ok(entries)
}

fn read_bounded_source(file: File, total: &mut u64) -> Result<Vec<u8>, String> {
    const FILE_LIMIT: u64 = 64 * 1024 * 1024;
    const TOTAL_LIMIT: u64 = 256 * 1024 * 1024;
    let remaining = TOTAL_LIMIT
        .checked_sub(*total)
        .ok_or("Source fingerprint exceeds the bounded qualification size")?;
    let limit = FILE_LIMIT.min(remaining);
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Source bytes unavailable")?;
    if bytes.len() as u64 > limit {
        return Err("Source fingerprint exceeds the bounded qualification size".into());
    }
    *total += bytes.len() as u64;
    Ok(bytes)
}

pub(crate) fn source_identity(
    root: &Path,
    source_paths: &[String],
    output_paths: &[String],
) -> Result<SourceIdentity, String> {
    Ok(source_snapshot(root, source_paths, output_paths)?.identity)
}

pub(crate) fn source_snapshot(
    root: &Path,
    source_paths: &[String],
    output_paths: &[String],
) -> Result<SourceSnapshot, String> {
    Ok(observe_sources(root, source_paths, output_paths)?.snapshot)
}

/// Observe retained provider edits without touching the real index or history.
/// Uncommitted results still obey the approved source/output and scope policy.
pub(crate) fn retained_candidate(
    root: &Path,
    expected: &SourceSnapshot,
    scope: &[String],
    sources: &[String],
    outputs: &[String],
) -> Result<SourceIdentity, String> {
    if scope.is_empty() { return Err("Task requires an approved file scope".into()); }
    for path in scope { safe_relative(path, true)?; }
    let observed = observe_sources(root, sources, outputs)?;
    validate_provider_snapshot(&observed, expected, scope)?;
    Ok(observed.snapshot.identity)
}

fn validate_provider_snapshot(observed: &ObservedSources, expected: &SourceSnapshot, scope: &[String]) -> Result<(), String> {
    let snapshot = &observed.snapshot;
    if snapshot.identity.head_sha != expected.identity.head_sha {
        return Err("Provider changed Git HEAD; retained work requires manual reconciliation".into());
    }
    let raw_changed: BTreeSet<_> = expected.raw_files.keys().chain(snapshot.raw_files.keys())
        .filter(|name| expected.raw_files.get(*name) != snapshot.raw_files.get(*name)).cloned().collect();
    let attribute_changed: BTreeSet<_> = expected.conversion_working.keys().chain(snapshot.conversion_working.keys())
        .filter(|name| expected.conversion_working.get(*name) != snapshot.conversion_working.get(*name)).cloned().collect();
    if observed.changed.iter().chain(raw_changed.iter()).chain(attribute_changed.iter()).any(|path| !in_paths(path, scope)) {
        return Err("Provider changes files outside the approved scope; changes retained for review".into());
    }
    if snapshot.conversion_config != expected.conversion_config {
        return Err("Git conversion configuration changed during provider execution; retained work requires manual reconciliation".into());
    }
    if snapshot.conversion_external != expected.conversion_external {
        return Err("Git input attribute policy changed outside the observed source edits; retained work requires manual reconciliation".into());
    }
    // Working attribute sources (including ignored files) have their own scope
    // identities. Cached attribute edits are also covered by staged-path scope.
    let attributes_changed = !attribute_changed.is_empty()
        || observed.changed.iter().any(|name| name.rsplit('/').next() == Some(".gitattributes"));
    if !attributes_changed && expected.conversion_files.iter().any(|(name, policy)| {
        snapshot.conversion_files.get(name).is_some_and(|current| current != policy)
    }) {
        return Err("Git input attribute policy changed outside the observed source edits; retained work requires manual reconciliation".into());
    }
    Ok(())
}

fn observe_sources(
    root: &Path,
    source_paths: &[String],
    output_paths: &[String],
) -> Result<ObservedSources, String> {
    reject_hidden_flags(root)?;
    let (tracked, outputs) = outputs_policy(root, source_paths, output_paths)?;
    let head_sha = git(root, &["rev-parse", "--verify", "HEAD"])?
        .trim()
        .to_string();
    let committed = head_entries(root)?;
    let indexed = index_entries(&git(root, &["ls-files", "--stage", "-z"])?)?;
    let mut changed = BTreeSet::new();
    for name in committed.keys().chain(indexed.keys()) {
        if committed.get(name) != indexed.get(name) {
            changed.insert(name.clone());
        }
    }
    let untracked = files(&git(
        root,
        &["ls-files", "-z", "--others", "--exclude-standard"],
    )?);
    let mut names = tracked.clone();
    names.extend(
        untracked
            .iter()
            .filter(|path| !in_paths(path, &outputs))
            .cloned(),
    );
    let mut declared = BTreeSet::new();
    for path in source_paths {
        collect_declared(root, &root.join(path), &outputs, &mut declared)?;
    }
    names.extend(declared);
    if names.len() > 20_000 {
        return Err("Source inventory exceeds 20000 files".into());
    }
    for name in &names {
        safe_relative(name, false)?;
    }
    let policy = eol::observe(root, &names)?;
    // Fingerprint the actual bytes, then derive Git objects from immutable
    // canonical copies under the qualified built-in policy. No Git clean or
    // encoding filter is executed, and the stat cache is never trusted.
    let snapshots = TemporaryIndex::new(&std::env::temp_dir())?;
    let mut actual = Vec::new();
    let mut raw_files = BTreeMap::new();
    let mut prepared = BTreeMap::new();
    let canonical_root = fs::canonicalize(root).map_err(|_| "Source workspace unavailable")?;
    let mut hash = Sha256::new();
    hash.update(b"virtuallab-source-v3\0");
    hash.update(head_sha.as_bytes());
    hash.update(policy.fingerprint().as_bytes());
    let mut clean = !changed.iter().any(|path| !in_paths(path, &outputs));
    let mut total = 0u64;
    for name in &names {
        if name
            .split('/')
            .any(|part| part.to_lowercase().starts_with(".env"))
        {
            if tracked.contains(name) {
                return Err("Tracked environment-secret input cannot be fingerprinted".into());
            }
            continue;
        }
        safe_relative(&name, false)?;
        if in_paths(&name, &outputs) {
            continue;
        }
        if !tracked.contains(name) {
            clean = false;
        }
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        let path = root.join(&name);
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                clean = false;
                changed.insert(name.clone());
                hash.update(b"missing");
                raw_files.insert(name.clone(), "missing".into());
                continue;
            }
            Err(_) => return Err("Source metadata unavailable".into()),
        };
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("Source inputs must be regular files, not symlinks or submodules".into());
        }
        if !fs::canonicalize(&path)
            .map_err(|_| "Source identity unavailable")?
            .starts_with(&canonical_root)
        {
            return Err("Source input escapes workspace".into());
        }
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            let executable = meta.permissions().mode() & 0o111 != 0;
            hash.update([u8::from(executable)]);
            if executable { "100755" } else { "100644" }.to_owned()
        };
        #[cfg(not(unix))]
        let mode = committed
            .get(name)
            .or_else(|| indexed.get(name))
            .and_then(|entry| entry.split_whitespace().next())
            .unwrap_or("100644")
            .to_owned();
        let bytes = read_bounded_source(
            File::open(path).map_err(|_| "Source bytes unavailable")?,
            &mut total,
        )?;
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(&bytes);
        let mut raw = Sha256::new();
        raw.update(mode.as_bytes());
        raw.update((bytes.len() as u64).to_le_bytes());
        raw.update(&bytes);
        raw_files.insert(name.clone(), format!("{:x}", raw.finalize()));
        let (canonical, safe_to_seal) = policy.canonicalize(name, &bytes);
        let snapshot = snapshots.0.join(format!("blob-{}", actual.len()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&snapshot)
            .map_err(|_| "Input byte snapshot unavailable")?;
        file.write_all(&canonical)
            .map_err(|_| "Input byte snapshot could not be written")?;
        let raw_snapshot = if canonical == bytes { snapshot.clone() } else {
            let raw_snapshot = snapshots.0.join(format!("raw-{}", actual.len()));
            let mut raw = OpenOptions::new().write(true).create_new(true).open(&raw_snapshot)
                .map_err(|_| "Raw input byte snapshot unavailable")?;
            raw.write_all(&bytes).map_err(|_| "Raw input byte snapshot could not be written")?;
            raw_snapshot
        };
        actual.push((name.clone(), mode, snapshot, raw_snapshot, safe_to_seal));
    }
    for chunk in actual.chunks(16) {
        let mut args = vec!["hash-object", "--no-filters", "--"];
        for (_, _, path, _, _) in chunk {
            args.push(path.to_str().ok_or("Non-Unicode input snapshot path")?);
        }
        let objects = git(root, &args)?;
        let objects: Vec<_> = objects.lines().collect();
        if objects.len() != chunk.len() {
            return Err("Raw input object hashing was incomplete".into());
        }
        for ((name, mode, path, raw_path, safe_to_seal), oid) in chunk.iter().zip(objects) {
            if oid.len() != head_sha.len() || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("Raw input object identity unavailable".into());
            }
            let entry = format!("{mode} {oid} 0");
            if committed.get(name) != Some(&entry) || indexed.get(name) != Some(&entry) {
                changed.insert(name.clone());
            }
            prepared.insert(name.clone(), PreparedInput { mode: mode.clone(), oid: oid.to_owned(), path: path.clone(), raw_path: raw_path.clone(), safe_to_seal: *safe_to_seal });
        }
    }
    clean &= changed.is_empty();
    if git(root, &["rev-parse", "--verify", "HEAD"])?.trim() != head_sha
        || index_entries(&git(root, &["ls-files", "--stage", "-z"])?)? != indexed
        || eol::observe(root, &names)? != policy
    {
        return Err(
            "Committed, staged or conversion inputs changed during observation; retry after inspecting state"
                .into(),
        );
    }
    Ok(ObservedSources {
        snapshot: SourceSnapshot {
            identity: SourceIdentity { head_sha, digest: format!("{:x}", hash.finalize()), clean },
            raw_files,
            conversion_config: policy.config_fingerprint(),
            conversion_external: policy.external_fingerprint(),
            conversion_working: policy.working_sources(),
            conversion_files: policy.file_fingerprints(),
        },
        changed,
        prepared,
        _copies: snapshots,
    })
}

fn require_automatic_commit_policy(root: &Path) -> Result<(), String> {
    if git(
        root,
        &[
            "config",
            "--type=bool",
            "--default=false",
            "--get",
            "commit.gpgSign",
        ],
    )?
    .trim()
        == "true"
    {
        return Err("Commit signing is required; make a manual candidate commit and adopt it through verification.".into());
    }
    let hooks = PathBuf::from(line(&git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    )?));
    for name in [
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
        "post-rewrite",
        "post-index-change",
        "reference-transaction",
    ] {
        match fs::metadata(hooks.join(name)) {
            Ok(meta) => {
                #[cfg(unix)] let active = { use std::os::unix::fs::PermissionsExt; meta.permissions().mode() & 0o111 != 0 };
                #[cfg(not(unix))] let active = true;
                if !meta.is_file() || active { return Err("Effective commit hooks require a manual candidate commit and adoption through verification; no hook was executed.".into()); }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("Commit hook policy could not be inspected; make a manual candidate commit and adopt it through verification.".into()),
        }
    }
    Ok(())
}

struct IndexGuard {
    path: PathBuf,
    lock_path: PathBuf,
    file: Option<File>,
    snapshot: Vec<u8>,
    published: bool,
}
impl IndexGuard {
    fn acquire(root: &Path) -> Result<Self, String> {
        let path = PathBuf::from(line(&git(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )?));
        let lock_path = path.with_file_name("index.lock");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
            .map_err(|_| {
                "Git index is locked; wait for the other writer and inspect state before retrying"
            })?;
        let mut guard = Self {
            path,
            lock_path,
            file: Some(file),
            snapshot: Vec::new(),
            published: false,
        };
        let meta = fs::symlink_metadata(&guard.path)
            .map_err(|_| "Original Git index unavailable; inspect state manually")?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 128 * 1024 * 1024 {
            return Err("Original Git index cannot be safely sealed".into());
        }
        guard.snapshot = fs::read(&guard.path).map_err(|_| "Original Git index unavailable")?;
        Ok(guard)
    }
    fn unchanged(&self) -> Result<(), String> {
        let meta = fs::symlink_metadata(&self.path)
            .map_err(|_| "Original Git index changed; inspect state manually")?;
        if meta.file_type().is_symlink()
            || fs::read(&self.path).map_err(|_| "Original Git index unavailable")? != self.snapshot
        {
            return Err("Original Git index changed; inspect state manually".into());
        }
        Ok(())
    }
    fn prepare(&mut self, approved_index: &Path) -> Result<(), String> {
        let bytes = fs::read(approved_index).map_err(|_| "Approved candidate index unavailable")?;
        let file = self
            .file
            .as_mut()
            .ok_or("Candidate index lock unavailable")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Candidate index could not be persisted; original index preserved")?;
        let permissions = fs::metadata(&self.path)
            .map_err(|_| "Original index permissions unavailable")?
            .permissions();
        file.set_permissions(permissions)
            .map_err(|_| "Candidate index permissions could not be preserved")?;
        Ok(())
    }
    fn publish(&mut self) -> Result<(), String> {
        self.unchanged()?;
        self.file.take();
        fs::rename(&self.lock_path, &self.path)
            .map_err(|_| "Approved index replacement failed; inspect repository state")?;
        self.published = true;
        Ok(())
    }
}
impl Drop for IndexGuard {
    fn drop(&mut self) {
        self.file.take();
        if !self.published {
            let _ = fs::remove_file(&self.lock_path);
        }
    }
}

struct TemporaryIndex(PathBuf);
impl TemporaryIndex {
    fn new(parent: &Path) -> Result<Self, String> {
        for _ in 0..16 {
            let path = parent.join(format!(
                "virtuallab-seal-{}-{}",
                std::process::id(),
                NEXT_INDEX.fetch_add(1, Ordering::Relaxed)
            ));
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("Isolated candidate index directory unavailable".into()),
            }
        }
        Err("Isolated candidate index could not be allocated".into())
    }
    fn path(&self) -> PathBuf {
        self.0.join("index")
    }
}
impl Drop for TemporaryIndex {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn index_entries(value: &str) -> Result<BTreeMap<String, String>, String> {
    let mut entries = BTreeMap::new();
    for entry in value.split('\0').filter(|entry| !entry.is_empty()) {
        let (metadata, path) = entry
            .split_once('\t')
            .ok_or("Unsupported Git index entry")?;
        let parts: Vec<_> = metadata.split_whitespace().collect();
        if parts.len() != 3 || parts[2] != "0" || !matches!(parts[0], "100644" | "100755") {
            return Err("Only regular, merged source entries can be sealed".into());
        }
        safe_relative(path, false)?;
        entries.insert(path.into(), metadata.into());
    }
    Ok(entries)
}
fn ensure_candidate_state(
    root: &Path,
    guard: &IndexGuard,
    expected: &str,
    branch: &str,
) -> Result<(), String> {
    guard.unchanged()?;
    if git(root, &["rev-parse", "--verify", "HEAD"])?.trim() != expected
        || line(&git(root, &["symbolic-ref", "--quiet", "HEAD"])?) != branch
    {
        return Err(
            "Candidate HEAD or branch changed; original index preserved, inspect state manually"
                .into(),
        );
    }
    Ok(())
}

pub(crate) fn seal_candidate(
    root: &Path,
    expected: &str,
    scope: &[String],
    message: &str,
) -> Result<String, String> {
    seal_candidate_with_policy(root, expected, scope, message, &[], &[])
}

fn qualify_candidate_inputs(
    root: &Path,
    index: &Path,
    names: &BTreeSet<String>,
    observed: &ObservedSources,
    changed: &BTreeSet<String>,
) -> Result<eol::Policy, String> {
    // A removed .gitattributes falls back to the index. Qualify against the
    // fully populated candidate index before publishing it, using the same raw
    // immutable inputs that produced the approved objects.
    let policy = eol::observe_candidate(root, index, names)?;
    if policy.config_fingerprint() != observed.snapshot.conversion_config
        || policy.external_fingerprint() != observed.snapshot.conversion_external
        || policy.working_sources() != observed.snapshot.conversion_working
    {
        return Err("Git conversion policy changed while preparing candidate; original index and HEAD preserved".into());
    }
    let copies = TemporaryIndex::new(&std::env::temp_dir())?;
    let mut total = 0;
    let mut qualified = Vec::new();
    for (name, input) in &observed.prepared {
        let bytes = read_bounded_source(File::open(&input.raw_path)
            .map_err(|_| "Approved raw input snapshot unavailable")?, &mut total)?;
        let mut raw = Sha256::new();
        raw.update(input.mode.as_bytes());
        raw.update((bytes.len() as u64).to_le_bytes());
        raw.update(&bytes);
        if observed.snapshot.raw_files.get(name) != Some(&format!("{:x}", raw.finalize())) {
            return Err("Approved raw input snapshot changed; original index and HEAD preserved".into());
        }
        let (canonical, safe_to_seal) = policy.canonicalize(name, &bytes);
        if changed.contains(name) && !safe_to_seal {
            return Err(format!("Git core.safecrlf refuses the candidate line-ending round trip for {name}; original index and HEAD preserved"));
        }
        let path = copies.0.join(format!("qualified-{}", qualified.len()));
        let mut file = OpenOptions::new().write(true).create_new(true).open(&path)
            .map_err(|_| "Candidate policy snapshot unavailable")?;
        file.write_all(&canonical).map_err(|_| "Candidate policy snapshot could not be written")?;
        qualified.push((name, input, path));
    }
    for chunk in qualified.chunks(16) {
        let mut args = vec!["hash-object", "--no-filters", "--"];
        for (_, _, path) in chunk { args.push(path.to_str().ok_or("Non-Unicode candidate policy snapshot path")?); }
        let objects = git(root, &args)?;
        let objects: Vec<_> = objects.lines().collect();
        if objects.len() != chunk.len() {
            return Err("Candidate policy object hashing was incomplete; original index and HEAD preserved".into());
        }
        for ((name, input, _), oid) in chunk.iter().zip(objects) {
            if input.oid != oid {
                return Err(format!("Candidate attribute policy changes the approved input for {name}; original index and HEAD preserved, review attributes and source together"));
            }
        }
    }
    if eol::observe_candidate(root, index, names)? != policy {
        return Err("Candidate conversion policy changed during qualification; original index and HEAD preserved".into());
    }
    Ok(policy)
}

pub(crate) fn seal_candidate_with_policy(
    root: &Path,
    expected: &str,
    scope: &[String],
    message: &str,
    source_paths: &[String],
    output_paths: &[String],
) -> Result<String, String> {
    seal_candidate_observed(root, expected, scope, message, source_paths, output_paths, None)
}

fn seal_candidate_observed(
    root: &Path,
    expected: &str,
    scope: &[String],
    message: &str,
    source_paths: &[String],
    output_paths: &[String],
    provider_before: Option<&SourceSnapshot>,
) -> Result<String, String> {
    if !matches!(expected.len(), 40 | 64) || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Candidate requires a fixed full HEAD commit ID".into());
    }
    if scope.is_empty()
        || message.trim().is_empty()
        || message.len() > 16_384
        || message.contains('\0')
    {
        return Err(
            "Candidate requires explicit approved scope and a bounded commit message".into(),
        );
    }
    for path in scope {
        safe_relative(path, true)?;
    }
    require_automatic_commit_policy(root)?;
    let mut guard = IndexGuard::acquire(root)?;
    let observed = observe_sources(root, source_paths, output_paths)?;
    if let Some(expected) = provider_before {
        validate_provider_snapshot(&observed, expected, scope)?;
    }
    let before = &observed.snapshot.identity;
    let mut changed = observed.changed.clone();
    let branch = git(root, &["symbolic-ref", "--quiet", "HEAD"])?;
    let branch = line(&branch);
    if !branch.starts_with("refs/heads/") {
        return Err(
            "Automatic sealing requires a local task branch; use a manual candidate commit".into(),
        );
    }
    ensure_candidate_state(root, &guard, expected, branch)?;
    let (tracked, outputs) = outputs_policy(root, source_paths, output_paths)?;
    let staged = files(&git(
        root,
        &[
            "diff",
            "--cached",
            "--no-renames",
            "--name-only",
            "-z",
            "HEAD",
            "--",
        ],
    )?);
    let original_entries = index_entries(&git(root, &["ls-files", "--stage", "-z"])?)?;
    changed.extend(files(&git(
        root,
        &["ls-files", "-z", "--others", "--exclude-standard"],
    )?));
    let mut declared = BTreeSet::new();
    for path in source_paths {
        collect_declared(root, &root.join(path), &outputs, &mut declared)?;
    }
    changed.extend(declared.into_iter().filter(|path| !tracked.contains(path)));
    changed.retain(|path| !in_paths(path, &outputs));
    for path in staged.iter().chain(changed.iter()) {
        safe_relative(path, false)?;
        if !in_paths(path, scope) || in_paths(path, &outputs) {
            return Err("Unapproved working or staged path; original index and HEAD preserved, inspect task scope".into());
        }
    }
    if changed.is_empty() {
        if !before.clean {
            return Err(
                "Uncommitted input cannot be adopted automatically; inspect source state".into(),
            );
        }
        ensure_candidate_state(root, &guard, expected, branch)?;
        return Ok(before.head_sha.clone());
    }
    let temp = TemporaryIndex::new(guard.path.parent().ok_or("Git index parent unavailable")?)?;
    let index = temp.path();
    require_automatic_commit_policy(root)?;
    index_git(root, &index, &["read-tree", expected])?;
    let names = observed.snapshot.raw_files.keys().cloned().collect();
    let mut expected_entries = index_entries(&index_git(root, &index, &["ls-files", "--stage", "-z"])?)?;
    let mut write = Vec::new();
    let mut remove = Vec::new();
    for name in &changed {
        if let Some(input) = observed.prepared.get(name) {
            if !input.safe_to_seal {
                return Err(format!("Git core.safecrlf refuses the line-ending round trip for {name}; original index and HEAD preserved"));
            }
            expected_entries.insert(name.clone(), input.entry());
            write.push((name, input));
        } else if observed.snapshot.raw_files.get(name).is_some_and(|value| value == "missing") {
            expected_entries.remove(name);
            remove.push(name.as_str());
        } else {
            return Err("Source inventory changed while preparing candidate; original index and HEAD preserved".into());
        }
    }
    // Publish only the already approved canonical copies. git add would reread
    // live files and attributes, so it is deliberately absent from this adapter.
    for chunk in write.chunks(16) {
        let mut args = vec!["hash-object", "--no-filters", "-w", "--"];
        for (_, input) in chunk { args.push(input.path.to_str().ok_or("Non-Unicode candidate snapshot path")?); }
        let objects = git(root, &args)?;
        let objects: Vec<_> = objects.lines().collect();
        if objects.len() != chunk.len() || chunk.iter().zip(objects).any(|((_, input), oid)| input.oid != oid) {
            return Err("Approved candidate snapshot changed before object creation; original index and HEAD preserved".into());
        }
        let mut args = vec!["update-index".to_string(), "--add".into()];
        for (name, input) in chunk {
            args.extend(["--cacheinfo".into(), format!("{},{},{}", input.mode, input.oid, name)]);
        }
        require_automatic_commit_policy(root)?;
        index_git(root, &index, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    }
    for chunk in remove.chunks(16) {
        let mut args = vec!["update-index", "--force-remove", "--"];
        args.extend(chunk.iter().copied());
        require_automatic_commit_policy(root)?;
        index_git(root, &index, &args)?;
    }
    let approved_entries = index_entries(&index_git(root, &index, &["ls-files", "--stage", "-z"])?)?;
    if approved_entries != expected_entries {
        return Err("Candidate index differs from approved immutable inputs; original index and HEAD preserved".into());
    }
    let candidate_policy = qualify_candidate_inputs(root, &index, &names, &observed, &changed)?;
    let tree = index_git(root, &index, &["write-tree"])?;
    let tree = tree.trim();
    let complete_changes = files(&git(
        root,
        &[
            "diff-tree",
            "--no-commit-id",
            "--no-renames",
            "-r",
            "--name-only",
            "-z",
            expected,
            tree,
        ],
    )?);
    for path in &complete_changes {
        safe_relative(path, false)?;
        if !in_paths(path, scope) || in_paths(path, &outputs) {
            return Err(
                "Complete candidate tree exceeds approved scope; original index and HEAD preserved"
                    .into(),
            );
        }
    }
    for path in &staged {
        if original_entries.get(path) != approved_entries.get(path) {
            return Err("Staged content differs from approved working input; original index and HEAD preserved".into());
        }
    }
    let stable = source_snapshot(root, source_paths, output_paths)?;
    if stable.identity.digest != before.digest || stable.identity.head_sha != expected
        || stable.raw_files != observed.snapshot.raw_files
    {
        return Err(
            "Source changed while preparing candidate; original index and HEAD preserved".into(),
        );
    }
    ensure_candidate_state(root, &guard, expected, branch)?;
    if complete_changes.is_empty() {
        return Err(
            "Staged state does not produce an approved candidate change; inspect index manually"
                .into(),
        );
    }
    if index_entries(&index_git(root, &index, &["ls-files", "--stage", "-z"])?)? != approved_entries {
        return Err("Candidate index changed before preparation; original index and HEAD preserved".into());
    }
    guard.prepare(&index)?;
    require_automatic_commit_policy(root)?;
    let candidate = git(root, &["commit-tree", tree, "-p", expected, "-m", message])?;
    let candidate = candidate.trim().to_string();
    let publishing = source_snapshot(root, source_paths, output_paths)?;
    if publishing.identity.digest != before.digest || publishing.identity.head_sha != expected
        || publishing.raw_files != observed.snapshot.raw_files
        || eol::observe_candidate(root, &index, &names)? != candidate_policy
    {
        return Err("Source or conversion policy changed before candidate publication; original index and HEAD preserved".into());
    }
    ensure_candidate_state(root, &guard, expected, branch)?;
    require_automatic_commit_policy(root)?;
    git(
        root,
        &[
            "update-ref",
            "--no-deref",
            "-m",
            "VirtualLab scoped candidate",
            branch,
            &candidate,
            expected,
        ],
    )?;
    if let Err(error) = guard.publish() {
        if git(
            root,
            &["update-ref", "--no-deref", branch, expected, &candidate],
        )
        .is_err()
        {
            return Err("Candidate reference advanced but index publication failed; preserve workspace and reconcile manually".into());
        }
        return Err(error);
    }
    let after = source_identity(root, source_paths, output_paths)?;
    if !after.clean
        || after.head_sha != candidate
        || line(&git(root, &["symbolic-ref", "--quiet", "HEAD"])?) != branch
    {
        return Err("Candidate committed, but source or branch changed; preserve workspace for manual reconciliation".into());
    }
    Ok(candidate)
}

pub(crate) fn seal_candidate_from_snapshot(
    root: &Path,
    expected: &SourceSnapshot,
    scope: &[String],
    message: &str,
    source_paths: &[String],
    output_paths: &[String],
) -> Result<String, String> {
    seal_candidate_observed(root, &expected.identity.head_sha, scope, message, source_paths, output_paths, Some(expected))
}

pub(crate) fn integrate_candidates(
    root: &Path,
    expected: &str,
    sources: &[String],
    check: impl Fn() -> Result<(), String>,
) -> Result<String, String> {
    integrate_candidates_with_policy(root, expected, sources, &[], &[], check)
}
pub(crate) fn integrate_candidates_with_policy(
    root: &Path,
    expected: &str,
    sources: &[String],
    source_paths: &[String],
    output_paths: &[String],
    check: impl Fn() -> Result<(), String>,
) -> Result<String, String> {
    if !matches!(expected.len(), 40 | 64) || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Integration requires a fixed full target commit ID".into());
    }
    if sources.is_empty() || sources.len() > 32 {
        return Err("Integration needs a bounded fixed source list".into());
    }
    let before = source_identity(root, source_paths, output_paths)?;
    if !before.clean || before.head_sha != expected {
        return Err("Integration target changed since preview".into());
    }
    for source in sources {
        if !matches!(source.len(), 40 | 64) || !source.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Integration source must be a full commit ID".into());
        }
        run_git(
            root,
            &["merge-base", "--is-ancestor", expected, source],
            None,
            &check,
        )?;
    }
    for source in sources {
        run_git(
            root,
            &[
                "merge",
                "--no-ff",
                "--no-edit",
                "--no-overwrite-ignore",
                source,
            ],
            None,
            &check,
        )?;
        if !source_identity(root, source_paths, output_paths)?.clean {
            return Err("Integration source changed or conflict remains; preserve worktree for manual reconciliation".into());
        }
    }
    Ok(source_identity(root, source_paths, output_paths)?.head_sha)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "vl-task-input-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            git(&root, &["init", "--initial-branch=main"]).unwrap();
            git(&root, &["config", "core.autocrlf", "false"]).unwrap();
            git(&root, &["config", "user.name", "Task Fixture"]).unwrap();
            git(&root, &["config", "user.email", "fixture@example.invalid"]).unwrap();
            fs::write(root.join("source.cpp"), "int main() {return 0;}\n").unwrap();
            fs::write(root.join(".gitignore"), "build/\nignored-source/\n.env\n").unwrap();
            git(&root, &["add", "--", "source.cpp", ".gitignore"]).unwrap();
            git(&root, &["commit", "-m", "base"]).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn conceal_equal_length_edit(root: &Path, name: &str, bytes: &[u8]) {
        git(root, &["config", "core.trustctime", "false"]).unwrap();
        git(root, &["config", "core.checkStat", "minimal"]).unwrap();
        // Ensure the index timestamp is newer than recorded source mtimes, so
        // racy-clean protection does not force Git to inspect the content.
        thread::sleep(Duration::from_millis(1100));
        git(root, &["update-index", "--index-version", "4"]).unwrap();
        let path = root.join(name);
        let before = fs::metadata(&path).unwrap();
        assert_eq!(before.len(), bytes.len() as u64);
        fs::write(&path, bytes).unwrap();
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_accessed(before.accessed().unwrap())
                    .set_modified(before.modified().unwrap()),
            )
            .unwrap();
        assert!(
            git(root, &["diff", "--name-only", "HEAD", "--", name])
                .unwrap()
                .is_empty(),
            "fixture must reproduce a real Git stat-cache false clean"
        );
        assert_eq!(
            git(root, &["ls-files", "-v", "--", name])
                .unwrap()
                .chars()
                .next(),
            Some('H')
        );
    }

    #[test]
    fn restored_mtime_stat_cache_does_not_qualify_uncommitted_bytes() {
        let repo = Fixture::new();
        let before = source_identity(&repo.0, &[], &[]).unwrap();
        let index = index_bytes(&repo.0);
        conceal_equal_length_edit(&repo.0, "source.cpp", b"int main() {return 1;}\n");
        let concealed_index = index_bytes(&repo.0);
        let after = source_identity(&repo.0, &[], &[]).unwrap();
        assert_ne!(after.digest, before.digest);
        assert!(!after.clean, "actual bytes differ from the committed blob");
        assert_eq!(
            index_bytes(&repo.0),
            concealed_index,
            "inspection must not refresh the real index"
        );
        assert_ne!(index, concealed_index, "fixture rewrote the index version");
        let candidate = seal_candidate(
            &repo.0,
            &before.head_sha,
            &["source.cpp".into()],
            "actual bytes",
        )
        .unwrap();
        assert_ne!(candidate, before.head_sha, "cannot adopt the old HEAD");
        assert_eq!(
            git(&repo.0, &["show", "HEAD:source.cpp"]).unwrap(),
            "int main() {return 1;}\n"
        );
        assert!(source_identity(&repo.0, &[], &[]).unwrap().clean);
    }

    #[test]
    fn restored_mtime_outside_scope_is_refused_before_sealing() {
        let repo = Fixture::new();
        conceal_equal_length_edit(&repo.0, ".gitignore", b"build/\nignored-source/\n.env!");
        fs::write(repo.0.join("source.cpp"), "approved edit").unwrap();
        let expected = head(&repo.0);
        let index = index_bytes(&repo.0);
        assert!(seal_candidate(&repo.0, &expected, &["source.cpp".into()], "candidate").is_err());
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), index);
    }

    #[test]
    fn unsupported_clean_conversion_is_refused_without_executing_filter() {
        let repo = Fixture::new();
        fs::write(repo.0.join(".gitattributes"), "source.cpp filter=review\n").unwrap();
        git(
            &repo.0,
            &["config", "filter.review.clean", "touch filter-ran; cat"],
        )
        .unwrap();
        git(&repo.0, &["config", "filter.review.required", "true"]).unwrap();
        let expected = head(&repo.0);
        let index = index_bytes(&repo.0);
        assert!(source_identity(&repo.0, &[], &[]).is_err());
        assert!(seal_candidate(&repo.0, &expected, &[".".into()], "candidate").is_err());
        assert!(!repo.0.join("filter-ran").exists());
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), index);
    }

    #[test]
    fn unused_filter_config_and_builtin_autocrlf_input_are_supported() {
        let repo = Fixture::new();
        git(&repo.0, &["config", "core.autocrlf", "input"]).unwrap();
        git(
            &repo.0,
            &["config", "filter.unused.clean", "touch filter-ran; cat"],
        )
        .unwrap();
        let before = source_identity(&repo.0, &[], &[]).unwrap();
        assert!(before.clean);
        let expected = head(&repo.0);
        let index = index_bytes(&repo.0);
        fs::write(repo.0.join("source.cpp"), "int main() {return 0;}\r\n").unwrap();
        let after = source_identity(&repo.0, &[], &[]).unwrap();
        assert!(after.clean, "input mode compares the qualified canonical bytes");
        assert_ne!(after.digest, before.digest, "raw CRLF bytes still change evidence identity");
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), index);
        assert!(!repo.0.join("filter-ran").exists());
    }

    #[test]
    fn unsupported_content_transform_attributes_fail_closed() {
        let repo = Fixture::new();
        for attribute in [
            "text=unknown",
            "eol=unknown",
            "ident",
            "working-tree-encoding=UTF-8",
            "filter=undefined",
            "crlf",
            "-crlf",
        ] {
            fs::write(
                repo.0.join(".gitattributes"),
                format!("source.cpp {attribute}\n"),
            )
            .unwrap();
            assert!(source_identity(&repo.0, &[], &[]).is_err(), "{attribute}");
        }
    }

    #[test]
    fn builtin_eol_fresh_crlf_worktree_is_clean_and_real_edits_are_dirty() {
        let repo = Fixture::new();
        git(&repo.0, &["config", "core.autocrlf", "true"]).unwrap();
        let directory = TemporaryIndex::new(&std::env::temp_dir()).unwrap();
        let lane = directory.0.join("task lane 工作");
        git(&repo.0, &["worktree", "add", "-b", "eol-task", "--", lane.to_str().unwrap(), "HEAD"]).unwrap();
        assert!(git(&lane, &["status", "--porcelain"]).unwrap().is_empty());
        assert_eq!(fs::read(lane.join("source.cpp")).unwrap(), b"int main() {return 0;}\r\n");
        let before = source_identity(&lane, &[], &[]).unwrap();
        assert!(before.clean, "a fresh Git-created CRLF checkout must qualify");
        let index = index_bytes(&lane);
        fs::write(lane.join("source.cpp"), b"int main() {return 1;}\r\n").unwrap();
        let after = source_identity(&lane, &[], &[]).unwrap();
        assert!(!after.clean);
        assert_ne!(before.digest, after.digest);
        assert_eq!(index_bytes(&lane), index, "observation must preserve the real index");
    }

    #[test]
    fn builtin_eol_text_attributes_qualify_their_git_canonical_content() {
        for attribute in ["text", "text=auto", "text eol=lf", "text=auto eol=crlf", "eol=lf"] {
            let repo = Fixture::new();
            fs::write(repo.0.join(".gitattributes"), format!("source.cpp {attribute}\n")).unwrap();
            git(&repo.0, &["add", "--", ".gitattributes"]).unwrap();
            git(&repo.0, &["commit", "-m", "line ending policy"]).unwrap();
            fs::write(repo.0.join("source.cpp"), b"int main() {return 0;}\r\n").unwrap();
            assert!(source_identity(&repo.0, &[], &[]).unwrap().clean, "{attribute}");
        }
    }

    #[test]
    fn builtin_eol_sealing_publishes_canonical_objects_and_preserves_worktree_bytes() {
        let repo = Fixture::new();
        git(&repo.0, &["config", "core.autocrlf", "true"]).unwrap();
        let expected = head(&repo.0);
        let config = fs::read(repo.0.join(".git/config")).unwrap();
        let changed = b"int main() {return 2;}\r\n";
        fs::write(repo.0.join("source.cpp"), changed).unwrap();
        let candidate = seal_candidate(&repo.0, &expected, &["source.cpp".into()], "CRLF candidate").unwrap();
        assert_ne!(candidate, expected);
        assert_eq!(git(&repo.0, &["show", "HEAD:source.cpp"]).unwrap(), "int main() {return 2;}\n");
        assert_eq!(fs::read(repo.0.join("source.cpp")).unwrap(), changed);
        assert_eq!(fs::read(repo.0.join(".git/config")).unwrap(), config);
        assert!(source_identity(&repo.0, &[], &[]).unwrap().clean);
    }

    #[test]
    fn builtin_eol_binary_lone_cr_and_unset_text_edits_remain_byte_exact() {
        for (attribute, original, edited) in [
            (None, &b"a\0\n"[..], &b"a\0\r\n"[..]),
            (None, &b"a\rb\n"[..], &b"a\rb\r\n"[..]),
            (None, &b"\x01\x02\n"[..], &b"\x01\x02\r\n"[..]),
            (Some("-text"), &b"alpha\n"[..], &b"alpha\r\n"[..]),
        ] {
            let repo = Fixture::new();
            fs::write(repo.0.join("source.cpp"), original).unwrap();
            if let Some(attribute) = attribute {
                fs::write(repo.0.join(".gitattributes"), format!("source.cpp {attribute}\n")).unwrap();
                git(&repo.0, &["add", "--", ".gitattributes"]).unwrap();
            }
            git(&repo.0, &["add", "--", "source.cpp"]).unwrap();
            git(&repo.0, &["commit", "-m", "byte exact baseline"]).unwrap();
            git(&repo.0, &["config", "core.autocrlf", "true"]).unwrap();
            assert!(source_identity(&repo.0, &[], &[]).unwrap().clean);
            let expected = head(&repo.0);
            fs::write(repo.0.join("source.cpp"), edited).unwrap();
            assert!(!source_identity(&repo.0, &[], &[]).unwrap().clean, "{attribute:?}: binary or -text EOL edits must not be normalized away");
            seal_candidate(&repo.0, &expected, &["source.cpp".into()], "byte exact edit").unwrap();
            assert_eq!(git(&repo.0, &["rev-parse", "HEAD:source.cpp"]).unwrap(), git(&repo.0, &["hash-object", "--no-filters", "--", "source.cpp"]).unwrap());
            assert_eq!(fs::read(repo.0.join("source.cpp")).unwrap(), edited);
        }
    }

    #[test]
    fn builtin_eol_legacy_crlf_index_content_is_not_renormalized() {
        for original in [&b"alpha\r\nbeta\r\n"[..], &b"alpha\r\nbeta\n"[..]] {
            let repo = Fixture::new();
            fs::write(repo.0.join("source.cpp"), original).unwrap();
            git(&repo.0, &["add", "--", "source.cpp"]).unwrap();
            git(&repo.0, &["commit", "-m", "legacy CRLF baseline"]).unwrap();
            git(&repo.0, &["config", "core.autocrlf", "true"]).unwrap();
            assert!(source_identity(&repo.0, &[], &[]).unwrap().clean);
            let expected = head(&repo.0);
            let mut edited = original.to_vec();
            edited[0] = b'A';
            fs::write(repo.0.join("source.cpp"), &edited).unwrap();
            assert!(!source_identity(&repo.0, &[], &[]).unwrap().clean);
            seal_candidate(&repo.0, &expected, &["source.cpp".into()], "legacy edit").unwrap();
            assert_eq!(git(&repo.0, &["rev-parse", "HEAD:source.cpp"]).unwrap(), git(&repo.0, &["hash-object", "--no-filters", "--", "source.cpp"]).unwrap());
            assert_eq!(fs::read(repo.0.join("source.cpp")).unwrap(), edited);
        }
    }

    #[test]
    fn builtin_eol_explicit_text_normalizes_even_binary_content() {
        let repo = Fixture::new();
        fs::write(repo.0.join(".gitattributes"), "source.cpp text eol=lf\n").unwrap();
        fs::write(repo.0.join("source.cpp"), b"a\0\n").unwrap();
        git(&repo.0, &["add", "--", ".gitattributes", "source.cpp"]).unwrap();
        git(&repo.0, &["commit", "-m", "explicit binary text policy"]).unwrap();
        fs::write(repo.0.join("source.cpp"), b"a\0\r\n").unwrap();
        assert!(source_identity(&repo.0, &[], &[]).unwrap().clean);
    }

    #[test]
    fn builtin_eol_safecrlf_refusal_preserves_index_head_config_and_source() {
        let repo = Fixture::new();
        git(&repo.0, &["config", "core.autocrlf", "input"]).unwrap();
        git(&repo.0, &["config", "core.safecrlf", "true"]).unwrap();
        let expected = head(&repo.0);
        let index = index_bytes(&repo.0);
        let config = fs::read(repo.0.join(".git/config")).unwrap();
        let edited = b"int main() {return 3;}\r\n";
        fs::write(repo.0.join("source.cpp"), edited).unwrap();
        assert!(!source_identity(&repo.0, &[], &[]).unwrap().clean);
        let error = seal_candidate(&repo.0, &expected, &["source.cpp".into()], "unsafe round trip").unwrap_err();
        assert!(error.contains("core.safecrlf"), "{error}");
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), index);
        assert_eq!(fs::read(repo.0.join(".git/config")).unwrap(), config);
        assert_eq!(fs::read(repo.0.join("source.cpp")).unwrap(), edited);
    }

    #[test]
    fn candidate_review_safecrlf_rejects_adjacent_lone_cr_and_crlf() {
        let repo = Fixture::new();
        fs::write(repo.0.join(".gitattributes"), "source.cpp text eol=lf\n").unwrap();
        git(&repo.0, &["add", "--", ".gitattributes"]).unwrap();
        git(&repo.0, &["commit", "-m", "forced text policy"]).unwrap();
        git(&repo.0, &["config", "core.safecrlf", "true"]).unwrap();
        let expected = head(&repo.0);
        let original = index_bytes(&repo.0);
        fs::write(repo.0.join("source.cpp"), b"line\r\r\n").unwrap();
        assert!(git(&repo.0, &["add", "--", "source.cpp"]).is_err(), "Git's own round-trip guard must reject this fixture");
        let result = seal_candidate(&repo.0, &expected, &["source.cpp".into()], "refused round trip");
        assert!(result.is_err(), "native sealing must preserve Git's safecrlf rejection");
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), original);
    }

    #[test]
    fn candidate_review_snapshot_rejects_eol_scope_change_after_provider_validation() {
        let repo = Fixture::new();
        git(&repo.0, &["config", "core.autocrlf", "true"]).unwrap();
        let expected = source_snapshot(&repo.0, &[], &[]).unwrap();
        let original = index_bytes(&repo.0);
        fs::write(repo.0.join("source.cpp"), b"int main() {return 4;}\r\n").unwrap();
        retained_candidate(&repo.0, &expected, &["source.cpp".into()], &[], &[]).unwrap();
        // Reproduce an external edit between completion observation and seal.
        fs::write(repo.0.join(".gitignore"), "build/\r\nignored-source/\r\n.env\r\n").unwrap();
        let result = seal_candidate_from_snapshot(&repo.0, &expected, &["source.cpp".into()], "retained scope", &[], &[]);
        assert!(result.is_err(), "the sealer must validate the pre-provider raw baseline itself");
        assert_eq!(head(&repo.0), expected.identity.head_sha);
        assert_eq!(index_bytes(&repo.0), original);
    }

    #[test]
    fn candidate_review_scoped_attribute_comment_does_not_hide_external_policy_change() {
        let repo = Fixture::new();
        fs::write(repo.0.join(".gitattributes"), "# original comment\n").unwrap();
        git(&repo.0, &["add", "--", ".gitattributes"]).unwrap();
        git(&repo.0, &["commit", "-m", "attribute comment"]).unwrap();
        let expected = source_snapshot(&repo.0, &[], &[]).unwrap();
        fs::write(repo.0.join(".gitattributes"), "# scoped comment change\n").unwrap();
        fs::write(repo.0.join(".git/info/attributes"), "source.cpp text eol=lf\n").unwrap();
        let result = retained_candidate(&repo.0, &expected, &[".gitattributes".into()], &[], &[]);
        assert!(result.is_err(), "a scoped .gitattributes edit must not exempt external attribute sources");
    }

    #[test]
    fn candidate_review_deleted_attributes_are_checked_under_populated_candidate_index() {
        let repo = Fixture::new();
        fs::write(repo.0.join(".gitattributes"), "source.cpp text eol=lf\n").unwrap();
        git(&repo.0, &["add", "--", ".gitattributes"]).unwrap();
        git(&repo.0, &["commit", "-m", "cached text fallback"]).unwrap();
        let bytes = fs::read(repo.0.join("source.cpp")).unwrap();
        let crlf = String::from_utf8(bytes).unwrap().replace('\n', "\r\n");
        fs::write(repo.0.join("source.cpp"), crlf.as_bytes()).unwrap();
        let expected = source_snapshot(&repo.0, &[], &[]).unwrap();
        assert!(expected.identity.clean);
        let original = index_bytes(&repo.0);
        fs::remove_file(repo.0.join(".gitattributes")).unwrap();
        let result = seal_candidate_from_snapshot(&repo.0, &expected, &[".gitattributes".into()], "remove text policy", &[], &[]);
        assert!(result.is_err(), "candidate policy must not leave source dirty after publication");
        assert_eq!(head(&repo.0), expected.identity.head_sha, "policy mismatch must be found before moving HEAD");
        assert_eq!(index_bytes(&repo.0), original);
        assert_eq!(fs::read(repo.0.join("source.cpp")).unwrap(), crlf.as_bytes());
        assert!(!repo.0.join(".gitattributes").exists());
    }

    #[test]
    fn candidate_review_in_scope_staging_is_not_external_attribute_drift() {
        for legacy in [false, true] {
            let repo = Fixture::new();
            if legacy {
                fs::write(repo.0.join("source.cpp"), b"int main() {}\r\n").unwrap();
                git(&repo.0, &["add", "--", "source.cpp"]).unwrap();
                git(&repo.0, &["commit", "-m", "legacy indexed CRLF"]).unwrap();
                git(&repo.0, &["config", "core.autocrlf", "true"]).unwrap();
            }
            let expected = source_snapshot(&repo.0, &[], &[]).unwrap();
            let edited: &[u8] = if legacy { b"int main() {return 5;}\n" } else { b"int main() {return 5;}\r\n" };
            fs::write(repo.0.join("source.cpp"), edited).unwrap();
            git(&repo.0, &["add", "--", "source.cpp"]).unwrap();
            retained_candidate(&repo.0, &expected, &["source.cpp".into()], &[], &[])
                .expect("matching staged and working edits inside scope are not attribute changes");
        }
    }

    #[test]
    fn candidate_review_scoped_comment_does_not_hide_ignored_nested_attributes() {
        let repo = Fixture::new();
        fs::create_dir(repo.0.join("nested")).unwrap();
        fs::write(repo.0.join("nested/source.cpp"), "int nested;\n").unwrap();
        fs::write(repo.0.join(".gitattributes"), "# original comment\n").unwrap();
        fs::write(repo.0.join(".gitignore"), "build/\nignored-source/\n.env\nnested/.gitattributes\n").unwrap();
        git(&repo.0, &["add", "--", ".gitattributes", ".gitignore", "nested/source.cpp"]).unwrap();
        git(&repo.0, &["commit", "-m", "ignored nested attributes"]).unwrap();
        let expected = source_snapshot(&repo.0, &[], &[]).unwrap();
        fs::write(repo.0.join(".gitattributes"), "# scoped comment change\n").unwrap();
        fs::write(repo.0.join("nested/.gitattributes"), "source.cpp text eol=lf\n").unwrap();
        let result = retained_candidate(&repo.0, &expected, &[".gitattributes".into()], &[], &[]);
        assert!(result.is_err(), "ignored attribute sources must obey provider scope independently");
    }

    #[test]
    fn builtin_eol_provider_scope_detects_raw_eol_only_changes() {
        let repo = Fixture::new();
        git(&repo.0, &["config", "core.autocrlf", "true"]).unwrap();
        let expected = source_snapshot(&repo.0, &[], &[]).unwrap();
        fs::write(repo.0.join(".gitignore"), "build/\r\nignored-source/\r\n.env\r\n").unwrap();
        assert!(source_identity(&repo.0, &[], &[]).unwrap().clean, "the Git blob identities are unchanged");
        let error = retained_candidate(&repo.0, &expected, &["source.cpp".into()], &[], &[]).unwrap_err();
        assert!(error.contains("outside the approved scope"));
    }

    #[test]
    fn builtin_eol_provider_rejects_external_policy_drift_but_allows_scoped_attributes() {
        let repo = Fixture::new();
        let expected = source_snapshot(&repo.0, &[], &[]).unwrap();
        git(&repo.0, &["config", "core.autocrlf", "input"]).unwrap();
        assert!(retained_candidate(&repo.0, &expected, &[".".into()], &[], &[]).unwrap_err().contains("configuration changed"));
        git(&repo.0, &["config", "core.autocrlf", "false"]).unwrap();
        fs::write(repo.0.join(".git/info/attributes"), "source.cpp text eol=lf\n").unwrap();
        assert!(retained_candidate(&repo.0, &expected, &[".".into()], &[], &[]).unwrap_err().contains("attribute policy changed"));
        fs::remove_file(repo.0.join(".git/info/attributes")).unwrap();
        fs::write(repo.0.join(".gitattributes"), "source.cpp text eol=lf\n").unwrap();
        assert!(!retained_candidate(&repo.0, &expected, &[".gitattributes".into()], &[], &[]).unwrap().clean);
    }

    #[test]
    fn builtin_eol_cached_external_filters_are_rejected_without_execution() {
        let repo = Fixture::new();
        fs::write(repo.0.join(".gitattributes"), "source.cpp filter=review\n").unwrap();
        git(&repo.0, &["add", "--", ".gitattributes"]).unwrap();
        git(&repo.0, &["config", "filter.review.clean", "touch filter-ran; cat"]).unwrap();
        fs::write(repo.0.join(".gitattributes"), "source.cpp text eol=lf\n").unwrap();
        let expected = head(&repo.0);
        let index = index_bytes(&repo.0);
        let error = source_identity(&repo.0, &[], &[]).unwrap_err();
        assert!(error.contains("filter") && error.contains("source.cpp"));
        assert!(seal_candidate(&repo.0, &expected, &[".".into()], "blocked filter").is_err());
        assert!(!repo.0.join("filter-ran").exists());
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), index);
    }

    #[test]
    fn builtin_eol_boolean_aliases_and_inert_core_eol_are_supported() {
        let repo = Fixture::new();
        for setting in ["FALSE", "Off", "0", "true", "yes", "1", "INPUT"] {
            git(&repo.0, &["config", "core.autocrlf", setting]).unwrap();
            assert!(source_identity(&repo.0, &[], &[]).unwrap().clean, "{setting}");
        }
        git(&repo.0, &["config", "core.autocrlf", "false"]).unwrap();
        git(&repo.0, &["config", "core.eol", "crlf"]).unwrap();
        fs::write(repo.0.join("source.cpp"), b"int main() {return 0;}\r\n").unwrap();
        assert!(!source_identity(&repo.0, &[], &[]).unwrap().clean, "core.eol without text attributes must not enable conversion");
    }

    #[test]
    fn actual_source_reads_enforce_file_and_aggregate_limits() {
        let directory = TemporaryIndex::new(&std::env::temp_dir()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let path = directory.0.join("growing-source");
        // A real sparse file models growth beyond an earlier metadata sample.
        File::create(&path)
            .unwrap()
            .set_len(64 * 1024 * 1024 + 1)
            .unwrap();
        let mut total = 0;
        assert!(read_bounded_source(File::open(&path).unwrap(), &mut total).is_err());
        assert_eq!(total, 0);
        fs::write(&path, b"four").unwrap();
        total = 256 * 1024 * 1024 - 3;
        assert!(read_bounded_source(File::open(&path).unwrap(), &mut total).is_err());
        total = 256 * 1024 * 1024 - 4;
        assert_eq!(
            read_bounded_source(File::open(&path).unwrap(), &mut total).unwrap(),
            b"four"
        );
        assert_eq!(total, 256 * 1024 * 1024);
    }

    #[test]
    fn source_change_without_head_change_invalidates_identity() {
        let repo = Fixture::new();
        let before = source_identity(&repo.0, &[], &[]).unwrap();
        fs::write(repo.0.join("source.cpp"), "int main() {return 1;}\n").unwrap();
        let after = source_identity(&repo.0, &[], &[]).unwrap();
        assert_eq!(before.head_sha, after.head_sha);
        assert_ne!(before.digest, after.digest);
        assert!(!after.clean);
    }

    #[test]
    fn declared_outputs_do_not_mask_tracked_sources() {
        let repo = Fixture::new();
        assert!(source_identity(&repo.0, &[], &["source.cpp".into()]).is_err());
        let before = source_identity(&repo.0, &[], &["build".into()]).unwrap();
        fs::create_dir_all(repo.0.join("build")).unwrap();
        fs::write(repo.0.join("build/output.o"), "generated").unwrap();
        let after = source_identity(&repo.0, &[], &["build".into()]).unwrap();
        assert_eq!(before.digest, after.digest);
        assert!(after.clean);
    }

    #[test]
    fn explicitly_declared_ignored_source_is_not_hidden() {
        let repo = Fixture::new();
        fs::create_dir_all(repo.0.join("ignored-source")).unwrap();
        fs::write(repo.0.join("ignored-source/input.cpp"), "one").unwrap();
        let before = source_identity(&repo.0, &["ignored-source".into()], &[]).unwrap();
        fs::write(repo.0.join("ignored-source/input.cpp"), "two").unwrap();
        let after = source_identity(&repo.0, &["ignored-source".into()], &[]).unwrap();
        assert_ne!(before.digest, after.digest);
        assert!(!after.clean, "uncommitted declared source cannot qualify");
    }

    #[test]
    fn secret_environment_content_never_enters_fingerprint() {
        let repo = Fixture::new();
        fs::write(repo.0.join(".env"), "PASSWORD=one").unwrap();
        let before = source_identity(&repo.0, &[], &[]).unwrap();
        fs::write(repo.0.join(".env"), "PASSWORD=two").unwrap();
        assert_eq!(
            before.digest,
            source_identity(&repo.0, &[], &[]).unwrap().digest
        );
        assert!(source_identity(&repo.0, &[".env".into()], &[]).is_err());
    }

    #[test]
    fn candidate_scope_refuses_outside_files_before_git_staging() {
        let repo = Fixture::new();
        fs::write(repo.0.join("source.cpp"), "changed").unwrap();
        fs::write(repo.0.join("unrelated.txt"), "keep me").unwrap();
        let head = git(&repo.0, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        assert!(seal_candidate(&repo.0, &head, &["source.cpp".into()], "candidate").is_err());
        assert!(git(&repo.0, &["diff", "--cached", "--name-only"])
            .unwrap()
            .is_empty());
        assert_eq!(git(&repo.0, &["rev-parse", "HEAD"]).unwrap().trim(), head);
    }

    #[test]
    fn candidate_sealing_commits_scoped_changes_and_preserves_history() {
        let repo = Fixture::new();
        let head = git(&repo.0, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        fs::write(repo.0.join("source.cpp"), "changed").unwrap();
        let candidate =
            seal_candidate(&repo.0, &head, &["source.cpp".into()], "candidate").unwrap();
        assert_ne!(candidate, head);
        assert_eq!(git(&repo.0, &["rev-parse", "HEAD^"]).unwrap().trim(), head);
        assert!(source_identity(&repo.0, &[], &[]).unwrap().clean);
    }

    #[cfg(unix)]
    #[test]
    fn commit_hook_cannot_silently_expand_the_approved_candidate_scope() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Fixture::new();
        let hook = repo.0.join(".git/hooks/pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\nprintf injected > unrelated.txt\ngit add -- unrelated.txt\n",
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let head = git(&repo.0, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        fs::write(repo.0.join("source.cpp"), "changed").unwrap();
        let index = index_bytes(&repo.0);
        assert!(seal_candidate(&repo.0, &head, &["source.cpp".into()], "candidate").is_err());
        assert!(
            !repo.0.join("unrelated.txt").exists(),
            "refuse before hook execution"
        );
        assert_eq!(git(&repo.0, &["rev-parse", "HEAD"]).unwrap().trim(), head);
        assert_eq!(index_bytes(&repo.0), index);
    }

    fn head(root: &Path) -> String {
        git(root, &["rev-parse", "HEAD"]).unwrap().trim().into()
    }
    fn index_bytes(root: &Path) -> Vec<u8> {
        let path = git(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .unwrap();
        fs::read(path.trim()).unwrap()
    }
    #[test]
    fn hidden_index_flags_never_qualify_stable_uncommitted_inputs() {
        for flag in ["--assume-unchanged", "--skip-worktree"] {
            let repo = Fixture::new();
            let expected = head(&repo.0);
            git(&repo.0, &["update-index", flag, "--", "source.cpp"]).unwrap();
            let index = index_bytes(&repo.0);
            let flags = git(&repo.0, &["ls-files", "-v"]).unwrap();
            fs::write(repo.0.join("source.cpp"), "stable hidden edit").unwrap();
            assert!(source_identity(&repo.0, &[], &[]).is_err(), "{flag}");
            assert!(source_identity(&repo.0, &[], &[]).is_err());
            assert!(
                seal_candidate(&repo.0, &expected, &["source.cpp".into()], "candidate").is_err()
            );
            assert_eq!(index_bytes(&repo.0), index);
            assert_eq!(head(&repo.0), expected);
            assert_eq!(git(&repo.0, &["ls-files", "-v"]).unwrap(), flags);
        }
    }
    #[cfg(unix)]
    #[test]
    fn executable_mode_change_is_dirty_even_when_filemode_tracking_is_disabled() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Fixture::new();
        git(&repo.0, &["config", "core.filemode", "false"]).unwrap();
        let before = source_identity(&repo.0, &[], &[]).unwrap();
        fs::set_permissions(repo.0.join("source.cpp"), fs::Permissions::from_mode(0o755)).unwrap();
        let after = source_identity(&repo.0, &[], &[]).unwrap();
        assert!(!after.clean);
        assert_ne!(before.digest, after.digest);
    }
    #[test]
    fn staged_working_divergence_is_not_clean_and_sealing_preserves_index() {
        let repo = Fixture::new();
        let expected = head(&repo.0);
        fs::write(repo.0.join("source.cpp"), "staged version").unwrap();
        git(&repo.0, &["add", "--", "source.cpp"]).unwrap();
        fs::write(repo.0.join("source.cpp"), "int main() {return 0;}\n").unwrap();
        let index = index_bytes(&repo.0);
        assert!(!source_identity(&repo.0, &[], &[]).unwrap().clean);
        assert!(seal_candidate(&repo.0, &expected, &["source.cpp".into()], "candidate").is_err());
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), index);
    }
    #[test]
    fn prestaged_out_of_scope_version_with_restored_working_bytes_is_refused() {
        let repo = Fixture::new();
        fs::write(repo.0.join("outside.txt"), "original").unwrap();
        git(&repo.0, &["add", "--", "outside.txt"]).unwrap();
        git(&repo.0, &["commit", "-m", "outside baseline"]).unwrap();
        let expected = head(&repo.0);
        fs::write(repo.0.join("outside.txt"), "staged unapproved").unwrap();
        git(&repo.0, &["add", "--", "outside.txt"]).unwrap();
        fs::write(repo.0.join("outside.txt"), "original").unwrap();
        fs::write(repo.0.join("source.cpp"), "approved").unwrap();
        let index = index_bytes(&repo.0);
        assert!(seal_candidate(&repo.0, &expected, &["source.cpp".into()], "candidate").is_err());
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), index);
    }
    #[test]
    fn staged_rename_from_outside_scope_preserves_both_sides_on_refusal() {
        let repo = Fixture::new();
        fs::create_dir(repo.0.join("src")).unwrap();
        git(&repo.0, &["mv", "--", "source.cpp", "src/inside.cpp"]).unwrap();
        let expected = head(&repo.0);
        let index = index_bytes(&repo.0);
        assert!(seal_candidate(&repo.0, &expected, &["src".into()], "candidate").is_err());
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), index);
        assert!(repo.0.join("src/inside.cpp").is_file());
    }
    #[test]
    fn sealing_policy_excludes_previous_evidence_and_declared_generated_outputs() {
        let repo = Fixture::new();
        let expected = head(&repo.0);
        fs::create_dir_all(repo.0.join(".virtuallab/evidence/run")).unwrap();
        fs::create_dir(repo.0.join("artifacts")).unwrap();
        fs::write(
            repo.0.join(".virtuallab/evidence/run/log"),
            "prior evidence",
        )
        .unwrap();
        fs::write(repo.0.join("artifacts/output.bin"), "generated").unwrap();
        let sources = vec![".".into()];
        let outputs = vec!["artifacts".into()];
        assert!(source_identity(&repo.0, &sources, &outputs).unwrap().clean);
        fs::write(repo.0.join("source.cpp"), "approved change").unwrap();
        let candidate = seal_candidate_with_policy(
            &repo.0,
            &expected,
            &["source.cpp".into()],
            "candidate",
            &sources,
            &outputs,
        )
        .unwrap();
        assert_ne!(candidate, expected);
        assert!(source_identity(&repo.0, &sources, &outputs).unwrap().clean);
        let tree = git(&repo.0, &["ls-tree", "-r", "--name-only", "HEAD"]).unwrap();
        assert!(!tree.contains("evidence"));
        assert!(!tree.contains("artifacts"));
    }
    #[test]
    fn outputs_cannot_hide_a_head_source_removed_only_from_the_index() {
        let repo = Fixture::new();
        git(&repo.0, &["rm", "--cached", "--", "source.cpp"]).unwrap();
        assert!(source_identity(&repo.0, &[], &["source.cpp".into()]).is_err());
    }
    #[test]
    fn isolated_staging_treats_brackets_as_a_literal_filename() {
        let repo = Fixture::new();
        fs::write(repo.0.join(".gitignore"), "literal1.cpp\n").unwrap();
        git(&repo.0, &["add", "--", ".gitignore"]).unwrap();
        git(&repo.0, &["commit", "-m", "ignore fixture"]).unwrap();
        fs::write(repo.0.join("literal[1].cpp"), "approved literal").unwrap();
        fs::write(repo.0.join("literal1.cpp"), "unapproved ignored file").unwrap();
        let candidate = seal_candidate(
            &repo.0,
            &head(&repo.0),
            &["literal[1].cpp".into()],
            "candidate",
        )
        .unwrap();
        let tree = git(&repo.0, &["ls-tree", "-r", "--name-only", &candidate]).unwrap();
        assert!(tree.contains("literal[1].cpp"));
        assert!(!tree.contains("literal1.cpp"));
    }
    #[test]
    fn real_index_guard_blocks_a_competing_git_writer_until_release() {
        let repo = Fixture::new();
        let expected = head(&repo.0);
        let original = index_bytes(&repo.0);
        fs::write(repo.0.join("source.cpp"), "writer change").unwrap();
        let guard = IndexGuard::acquire(&repo.0).unwrap();
        let root = repo.0.clone();
        assert!(
            std::thread::spawn(move || git(&root, &["add", "--", "source.cpp"]))
                .join()
                .unwrap()
                .is_err()
        );
        guard.unchanged().unwrap();
        assert_eq!(index_bytes(&repo.0), original);
        assert_eq!(head(&repo.0), expected);
        assert!(seal_candidate(&repo.0, &expected, &["source.cpp".into()], "candidate").is_err());
        drop(guard);
        git(&repo.0, &["add", "--", "source.cpp"]).unwrap();
    }

    #[test]
    fn git_failure_never_retains_raw_stderr_or_user_supplied_revision() {
        let repo = Fixture::new();
        let error = git(
            &repo.0,
            &["rev-parse", "--verify", "PRIVATE_SENTINEL_REVISION"],
        )
        .unwrap_err();
        assert!(!error.contains("PRIVATE_SENTINEL"));
        assert!(error.contains("exit"));
    }

    #[test]
    fn ambient_git_environment_cannot_redirect_sealing() {
        const CHILD: &str = "VIRTUALLAB_GIT_INPUT_TEST_ROOT";
        if let Ok(root) = std::env::var(CHILD) {
            let root = PathBuf::from(root);
            let expected = std::env::var("VIRTUALLAB_GIT_INPUT_TEST_HEAD").unwrap();
            assert_eq!(head(&root), expected);
            fs::write(root.join("source.cpp"), "approved child change").unwrap();
            seal_candidate(&root, &expected, &["source.cpp".into()], "candidate").unwrap();
            assert!(source_identity(&root, &[], &[]).unwrap().clean);
            return;
        }
        let repo = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("source.cpp"), "outside repository").unwrap();
        git(&outside.0, &["add", "--", "source.cpp"]).unwrap();
        git(&outside.0, &["commit", "-m", "outside"]).unwrap();
        let outside_head = head(&outside.0);
        let outside_index = index_bytes(&outside.0);
        let result = crate::process::background_command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "task_inputs::tests::ambient_git_environment_cannot_redirect_sealing",
                "--nocapture",
            ])
            .env(CHILD, &repo.0)
            .env("VIRTUALLAB_GIT_INPUT_TEST_HEAD", head(&repo.0))
            .env("GIT_DIR", outside.0.join(".git"))
            .env("GIT_WORK_TREE", &outside.0)
            .env("GIT_INDEX_FILE", outside.0.join(".git/index"))
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "core.bare")
            .env("GIT_CONFIG_VALUE_0", "true")
            .env("GIT_CONFIG_PARAMETERS", "'core.bare=true'")
            .env("GIT_GLOB_PATHSPECS", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "isolated ambient-environment child failed"
        );
        assert_eq!(head(&outside.0), outside_head);
        assert_eq!(index_bytes(&outside.0), outside_index);
    }

    #[cfg(unix)]
    #[test]
    fn configured_commit_hook_is_refused_before_any_hook_or_index_mutation() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Fixture::new();
        let hooks = repo.0.join(".git/custom-hooks");
        fs::create_dir(&hooks).unwrap();
        let hook = hooks.join("commit-msg");
        fs::write(&hook, "#!/bin/sh\nprintf secret > unrelated.txt\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        git(
            &repo.0,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        )
        .unwrap();
        fs::write(repo.0.join("source.cpp"), "approved").unwrap();
        let expected = head(&repo.0);
        let original = index_bytes(&repo.0);
        let error =
            seal_candidate(&repo.0, &expected, &["source.cpp".into()], "candidate").unwrap_err();
        assert!(error.contains("manual"));
        assert!(!repo.0.join("unrelated.txt").exists());
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), original);
    }

    #[cfg(unix)]
    #[test]
    fn integration_cancellation_stops_hook_descendants_and_preserves_partial_worktree() {
        use std::{cell::Cell, os::unix::fs::PermissionsExt, time::Instant};
        let repo = Fixture::new();
        let expected = head(&repo.0);
        git(&repo.0, &["switch", "-c", "integration-source"]).unwrap();
        fs::write(repo.0.join("source.cpp"), "candidate source").unwrap();
        git(&repo.0, &["add", "--", "source.cpp"]).unwrap();
        git(&repo.0, &["commit", "-m", "source"]).unwrap();
        let source = head(&repo.0);
        git(&repo.0, &["switch", "main"]).unwrap();
        let hook = repo.0.join(".git/hooks/pre-merge-commit");
        fs::write(&hook, "#!/bin/sh\nnode -e 'const fs=require(\"fs\");require(\"child_process\").spawn(process.execPath,[\"-e\",\"setInterval(()=>{},1000)\"],{stdio:[\"ignore\",1,2]});fs.writeFileSync(\".hook-ready\",\"ready\");setInterval(()=>{},1000)'\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        // Measure shutdown after cancellation is requested, excluding Git
        // preflight and hook startup, which can be slow on a loaded runner.
        let cancelled_at: Cell<Option<Instant>> = Cell::new(None);
        let result = integrate_candidates(&repo.0, &expected, &[source], || {
            if repo.0.join(".hook-ready").exists() {
                if cancelled_at.get().is_none() {
                    cancelled_at.set(Some(Instant::now()));
                }
                Err("cancel".into())
            } else {
                Ok(())
            }
        });
        let cleanup_elapsed = cancelled_at.get().expect("hook cancellation was never requested").elapsed();
        let error = result.expect_err("hook integration must be cancelled");
        assert!(error.contains("Git integration cancelled"), "unexpected integration failure: {error}");
        assert!(cleanup_elapsed < Duration::from_secs(15), "hook cancellation and descendant cleanup took {cleanup_elapsed:?}");
        assert_eq!(head(&repo.0), expected);
        assert_eq!(
            fs::read_to_string(repo.0.join("source.cpp")).unwrap(),
            "candidate source"
        );
        assert!(repo.0.join(".hook-ready").is_file());
    }

    #[test]
    fn required_commit_signing_refuses_automatic_sealing_without_index_or_head_changes() {
        let repo = Fixture::new();
        fs::write(repo.0.join("source.cpp"), "approved source").unwrap();
        let expected = head(&repo.0);
        let original = index_bytes(&repo.0);
        git(&repo.0, &["config", "commit.gpgSign", "true"]).unwrap();
        let error =
            seal_candidate(&repo.0, &expected, &["source.cpp".into()], "candidate").unwrap_err();
        assert!(error.contains("signing") && error.contains("manual"));
        assert_eq!(head(&repo.0), expected);
        assert_eq!(index_bytes(&repo.0), original);
    }

    #[test]
    fn integration_policy_preserves_prior_evidence_and_generated_outputs() {
        let repo = Fixture::new();
        let expected = head(&repo.0);
        git(&repo.0, &["switch", "-c", "policy-source"]).unwrap();
        fs::write(repo.0.join("source.cpp"), "candidate source").unwrap();
        git(&repo.0, &["add", "--", "source.cpp"]).unwrap();
        git(&repo.0, &["commit", "-m", "source"]).unwrap();
        let source = head(&repo.0);
        git(&repo.0, &["switch", "main"]).unwrap();
        fs::create_dir_all(repo.0.join(".virtuallab/evidence/run")).unwrap();
        fs::create_dir(repo.0.join("artifacts")).unwrap();
        fs::write(
            repo.0.join(".virtuallab/evidence/run/log"),
            "previous evidence",
        )
        .unwrap();
        fs::write(
            repo.0.join("artifacts/output.bin"),
            "previous generated output",
        )
        .unwrap();
        let sources = vec![".".into()];
        let outputs = vec!["artifacts".into()];
        let integrated = integrate_candidates_with_policy(
            &repo.0,
            &expected,
            &[source],
            &sources,
            &outputs,
            || Ok(()),
        )
        .unwrap();
        assert_ne!(integrated, expected);
        assert!(source_identity(&repo.0, &sources, &outputs).unwrap().clean);
        assert_eq!(
            fs::read_to_string(repo.0.join("artifacts/output.bin")).unwrap(),
            "previous generated output"
        );
        let tree = git(&repo.0, &["ls-tree", "-r", "--name-only", "HEAD"]).unwrap();
        assert!(!tree.contains("evidence"));
        assert!(!tree.contains("artifacts"));
    }

    #[test]
    fn index_snapshot_detects_a_writer_that_ignores_git_lock_protocol() {
        let repo = Fixture::new();
        let expected = head(&repo.0);
        let guard = IndexGuard::acquire(&repo.0).unwrap();
        let mut replaced = guard.snapshot.clone();
        replaced.push(0);
        fs::write(&guard.path, &replaced).unwrap();
        assert!(guard.unchanged().is_err());
        assert_eq!(head(&repo.0), expected);
        fs::write(&guard.path, &guard.snapshot).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn read_only_diffs_never_execute_repository_external_diff_or_textconv() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Fixture::new();
        let tool = repo.0.join(".git/diff-tool");
        fs::write(&tool, "#!/bin/sh\nprintf secret > .diff-ran\nexit 1\n").unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            repo.0.join(".gitattributes"),
            "source.cpp diff=unreviewed\n",
        )
        .unwrap();
        git(&repo.0, &["add", "--", ".gitattributes"]).unwrap();
        git(&repo.0, &["commit", "-m", "attribute fixture"]).unwrap();
        git(
            &repo.0,
            &["config", "diff.external", tool.to_str().unwrap()],
        )
        .unwrap();
        git(
            &repo.0,
            &["config", "diff.unreviewed.textconv", tool.to_str().unwrap()],
        )
        .unwrap();
        fs::write(repo.0.join("source.cpp"), "changed").unwrap();
        let diff = git(&repo.0, &["diff", "HEAD", "--", "source.cpp"]).unwrap();
        assert!(diff.contains("changed"));
        assert!(!repo.0.join(".diff-ran").exists());
        assert!(!source_identity(&repo.0, &[], &[]).unwrap().clean);
    }

    #[test]
    fn individually_passing_candidates_must_be_tested_again_after_integration() {
        let repo = Fixture::new();
        fs::write(repo.0.join("a.txt"), "0").unwrap();
        fs::write(repo.0.join("b.txt"), "0").unwrap();
        git(&repo.0, &["add", "--", "a.txt", "b.txt"]).unwrap();
        git(&repo.0, &["commit", "-m", "integration fixture"]).unwrap();
        let base = git(&repo.0, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        struct Lanes(Vec<PathBuf>);
        impl Drop for Lanes {
            fn drop(&mut self) {
                for path in &self.0 {
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
        let lanes = Lanes(vec![
            repo.0.with_extension("lane-a"),
            repo.0.with_extension("lane-b"),
            repo.0.with_extension("integration"),
        ]);
        for (index, path) in lanes.0.iter().enumerate() {
            git(
                &repo.0,
                &[
                    "worktree",
                    "add",
                    "-b",
                    &format!("lane-{index}"),
                    path.to_str().unwrap(),
                    &base,
                ],
            )
            .unwrap();
        }
        let script="const fs=require('fs');process.exit(Number(fs.readFileSync('a.txt','utf8'))+Number(fs.readFileSync('b.txt','utf8'))>1?1:0)";
        let check = |root: &Path| {
            crate::execution::process_command("node")
                .args(["-e", script])
                .current_dir(root)
                .status()
                .unwrap()
                .success()
        };
        let mut candidates = Vec::new();
        for (index, path) in lanes.0[..2].iter().enumerate() {
            fs::write(path.join(if index == 0 { "a.txt" } else { "b.txt" }), "1").unwrap();
            git(
                path,
                &["add", "--", if index == 0 { "a.txt" } else { "b.txt" }],
            )
            .unwrap();
            git(path, &["commit", "-m", "implementation"]).unwrap();
            assert!(check(path));
            candidates.push(
                git(path, &["rev-parse", "HEAD"])
                    .unwrap()
                    .trim()
                    .to_string(),
            );
        }
        let integrated = integrate_candidates(&lanes.0[2], &base, &candidates, || Ok(())).unwrap();
        assert_ne!(integrated, base);
        assert!(!check(&lanes.0[2]));
        for candidate in candidates {
            git(
                &lanes.0[2],
                &["merge-base", "--is-ancestor", &candidate, &integrated],
            )
            .unwrap();
        }
    }

    #[test]
    fn unregistered_or_foreign_worktree_cannot_be_used() {
        let first = Fixture::new();
        let second = Fixture::new();
        assert!(registered_workspace(&first.0, &first.0).is_ok());
        assert!(registered_workspace(&first.0, &second.0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_input_cannot_read_outside_workspace() {
        use std::os::unix::fs::symlink;
        let repo = Fixture::new();
        let outside = Fixture::new();
        symlink(outside.0.join("source.cpp"), repo.0.join("link.cpp")).unwrap();
        assert!(source_identity(&repo.0, &[], &[]).is_err());
    }
}
