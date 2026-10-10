//! Local verification runner and evidence storage.
//! This module intentionally does NOT authorize hardware execution.
use crate::process::background_command;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
const READER_CLEANUP_TIMEOUT: Duration = Duration::from_secs(3);

const MAX_TIMEOUT_MS: u64 = 600_000;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRequest {
    run_id: String,
    workspace_root: String,
    profile: Profile,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    schema_version: u32,
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    gates: Vec<Gate>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Gate {
    id: String,
    label: String,
    kind: String,
    required: bool,
    approval: String,
    executor: Executor,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Executor {
    Process {
        program: String,
        args: Vec<String>,
        cwd: String,
        #[serde(default)]
        timeout_ms: Option<u64>,
    },
    Adapter {
        adapter: String,
        action: String,
        #[serde(default)]
        parameters: Option<HashMap<String, serde_json::Value>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceManifest {
    schema_version: u32,
    run_id: String,
    profile_id: String,
    workspace_root: String,
    repository_head_sha: String,
    started_at_ms: u128,
    finished_at_ms: Option<u128>,
    status: String,
    checks: Vec<EvidenceCheck>,
    artifacts: Vec<EvidenceArtifact>,
    metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceCheck {
    gate_id: String,
    status: String,
    detail: String,
    started_at_ms: u128,
    finished_at_ms: Option<u128>,
    exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceArtifact {
    id: String,
    kind: String,
    path: String,
    sha256: Option<String>,
    size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactImportRequest {
    workspace_root: String,
    run_id: String,
    file_path: String,
    kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerificationEvent {
    run_id: String,
    gate_id: Option<String>,
    status: String,
    detail: String,
}

#[derive(Clone, Default)]
pub struct VerificationManager {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    artifact_write: Arc<Mutex<()>>,
}

#[tauri::command]
pub async fn verification_run(
    app: AppHandle,
    manager: State<'_, VerificationManager>,
    request: VerificationRequest,
) -> Result<EvidenceManifest, String> {
    validate_id(&request.run_id)?;
    validate_profile(&request.profile)?;
    let manager = manager.inner().clone();
    let token = Arc::new(AtomicBool::new(false));
    {
        let mut active = manager.active.lock().map_err(lock_err)?;
        if active.contains_key(&request.run_id) {
            return Err("Verification run id is already active.".into());
        }
        active.insert(request.run_id.clone(), token.clone());
    }
    let run_id = request.run_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        execute_verification(&app, request, token)
    })
    .await
    .map_err(|error| format!("Verification worker crashed: {error}"));
    manager.active.lock().map_err(lock_err)?.remove(&run_id);
    outcome?
}

#[tauri::command]
pub fn verification_cancel(
    manager: State<'_, VerificationManager>,
    run_id: String,
) -> Result<(), String> {
    validate_id(&run_id)?;
    let active = manager.active.lock().map_err(lock_err)?;
    let token = active
        .get(&run_id)
        .ok_or_else(|| "Verification run is not active.".to_string())?;
    token.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub async fn verification_import_artifact(
    manager: State<'_, VerificationManager>,
    request: ArtifactImportRequest,
) -> Result<EvidenceManifest, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_artifact(&manager, request)
    })
    .await
    .map_err(|error| format!("Evidence import worker failed: {error}"))?
}

fn execute_verification(
    app: &AppHandle,
    request: VerificationRequest,
    cancelled: Arc<AtomicBool>,
) -> Result<EvidenceManifest, String> {
    let root = fs::canonicalize(&request.workspace_root)
        .map_err(|error| format!("Cannot resolve workspace: {error}"))?;
    if !root.is_dir() {
        return Err("Verification workspace is not a directory.".into());
    }
    let head = background_command("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(&root)
        .output()
        .map_err(|error| format!("Cannot inspect Git HEAD: {error}"))?;
    if !head.status.success() {
        return Err("Verification requires a Git worktree with HEAD.".into());
    }
    let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if sha.len() != 40 || !sha.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Invalid Git HEAD fingerprint.".into());
    }

    let dir = evidence_dir(&root, &request.run_id, true)?;
    let started = now_ms();
    let mut manifest = EvidenceManifest {
        schema_version: 1,
        run_id: request.run_id.clone(),
        profile_id: request.profile.id.clone(),
        workspace_root: root.to_string_lossy().into_owned(),
        repository_head_sha: sha,
        started_at_ms: started,
        finished_at_ms: None,
        status: "running".into(),
        checks: Vec::new(),
        artifacts: Vec::new(),
        metadata: serde_json::json!({}),
    };
    fs::write(
        dir.join("profile.json"),
        serde_json::to_vec_pretty(&request.profile).map_err(|e| e.to_string())?,
    ).map_err(|e| format!("Cannot persist verification profile: {e}"))?;
    let _ = app.emit(
        "verification://event",
        VerificationEvent {run_id: request.run_id.clone(), gate_id: None,
            status: "running".into(), detail: "Verification started.".into()},
    );

    for gate in &request.profile.gates {
        let gate_start = now_ms();
        let (status, detail, exit_code) = if cancelled.load(Ordering::Acquire) {
            ("cancelled".into(), "Cancelled before gate execution.".into(), None)
        } else {
            run_gate(&root, &dir, gate, &cancelled, &mut manifest.artifacts)
        };
        manifest.checks.push(EvidenceCheck {
            gate_id: gate.id.clone(), status: status.clone(), detail: detail.clone(),
            started_at_ms: gate_start, finished_at_ms: Some(now_ms()), exit_code,
        });
        let _ = app.emit(
            "verification://event",
            VerificationEvent {run_id: request.run_id.clone(),gate_id: Some(gate.id.clone()),
                status, detail},
        );
        if cancelled.load(Ordering::Acquire) {
            break;
        }
    }
    manifest.status = verdict(&request.profile, &manifest.checks);
    manifest.finished_at_ms = Some(now_ms());
    persist_manifest(&dir, &manifest)?;
    let _ = app.emit(
        "verification://event",
        VerificationEvent {run_id: request.run_id, gate_id: None,
            status: manifest.status.clone(), detail: "Evidence manifest finalized.".into()},
    );
    Ok(manifest)
}

fn run_gate(
    root: &Path,
    dir: &Path,
    gate: &Gate,
    cancelled: &AtomicBool,
    artifacts: &mut Vec<EvidenceArtifact>,
) -> (String, String, Option<i32>) {
    if gate.approval != "none" {
        return ("blocked".into(), "Gate requires human approval; no approval executor is connected.".into(), None);
    }
    if !matches!(gate.kind.as_str(), "build" | "unit" | "evidence") {
        return ("blocked".into(), "HIL/hardware/soak gates are blocked until hardware broker integration.".into(), None);
    }
    let Executor::Process {program,args,cwd,timeout_ms} = &gate.executor else {
        return ("blocked".into(), "Hardware/other adapters are not enabled.".into(), None);
    };
    if !approved_program(program) {
        return ("blocked".into(), "Program is outside the initial build/test tool allowlist.".into(), None);
    }
    let working = if cwd == "workspace" || cwd == "repository" { root } else {
        return ("blocked".into(), "Unknown process cwd scope.".into(), None);
    };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let mut command = crate::execution::process_command(program);
    command.args(args)
        .current_dir(working)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match crate::managed_process::spawn(&mut command) {
        Ok(child) => child,
        Err(e) => return ("fail".into(), format!("Cannot start process: {e}"), None),
    };

    let out_path = dir.join(format!("{}.stdout.log",gate.id));
    let err_path = dir.join(format!("{}.stderr.log",gate.id));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let output = thread::spawn(move || persist_stream(stdout, &out_path));
    let error = thread::spawn(move || persist_stream(stderr, &err_path));

    let begin = Instant::now();
    let (status, detail, exit) = loop {
        if cancelled.load(Ordering::Acquire) {
            break ("cancelled".into(), "Verification cancelled.".into(), None);
        }
        if begin.elapsed() >= timeout {
            break ("fail".into(), "Verification gate timed out.".into(), None);
        }
        match child.try_wait() {
            Ok(Some(result)) => {
                let code = result.code();
                break (
                    if result.success() {"pass"} else {"fail"}.into(),
                    format!("Process finished with exit code {:?}.", code),
                    code,
                );
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => break ("fail".into(), format!("Cannot wait for gate process: {e}"), None),
        }
    };
    // Includes the successful leader-exit path: descendants can still own pipes.
    if let Err(error) = crate::process::terminate_tree(&mut child) {
        return ("fail".into(), format!("Process tree cleanup not confirmed: {error}"), exit);
    }
    let deadline = Instant::now() + READER_CLEANUP_TIMEOUT;
    while !output.is_finished() || !error.is_finished() {
        if Instant::now() >= deadline {
            return ("fail".into(), "Output stream cleanup not confirmed within 3 seconds.".into(), exit);
        }
        thread::sleep(Duration::from_millis(20));
    }
    let (Ok(Ok(out_truncated)), Ok(Ok(err_truncated))) = (output.join(), error.join()) else {
        return ("fail".into(), "Could not persist output stream evidence.".into(), exit);
    };
    for (suffix,stream) in [("stdout","stdout"),("stderr","stderr")] {
        let path = dir.join(format!("{}.{}.log",gate.id,suffix));
        if let Ok(artifact) = artifact_from_file(
            &path, format!("{}-{stream}",gate.id), "log".into(),
            format!(".virtuallab/evidence/{}/{}.{}.log", dir.file_name().unwrap().to_string_lossy(),gate.id,suffix),
        ) {
            artifacts.push(artifact);
        }
    }
    if out_truncated || err_truncated {
        return ("fail".into(), format!("{detail} Output exceeded the 8 MiB per-stream evidence limit; logs were truncated."), exit);
    }
    (status,detail,exit)
}

fn persist_stream(reader: Option<impl Read>, path: &Path) -> io::Result<bool> {
    let mut file = File::create(path)?;
    let truncated = if let Some(mut reader) = reader {
        copy_capped(&mut reader, &mut file, MAX_LOG_BYTES)?
    } else { false };
    file.sync_all()?;
    Ok(truncated)
}

// Drain excess bytes to keep the child from blocking, but never grow the file
// or allocate in proportion to output volume.
fn copy_capped(reader: &mut impl Read, writer: &mut impl Write, limit: u64) -> io::Result<bool> {
    let mut remaining = limit;
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    loop {
        let count = match reader.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 { return Ok(truncated); }
        let keep = count.min(remaining as usize);
        writer.write_all(&buffer[..keep])?;
        remaining -= keep as u64;
        truncated |= keep < count;
    }
}

fn import_artifact(
    manager: &VerificationManager,
    request: ArtifactImportRequest,
) -> Result<EvidenceManifest,String> {
    validate_id(&request.run_id)?;
    let allowed = ["junit","trace","waveform","image","report","other"];
    if !allowed.contains(&request.kind.as_str()) {
        return Err("Unsupported evidence artifact kind.".into());
    }
    if manager.active.lock().map_err(lock_err)?.contains_key(&request.run_id) {
        return Err("Cannot import artifacts into an active run.".into());
    }
    let _guard = manager.artifact_write.lock().map_err(lock_err)?;
    let root = fs::canonicalize(&request.workspace_root).map_err(|e| e.to_string())?;
    let source = fs::canonicalize(&request.file_path).map_err(|e| e.to_string())?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err("Artifact source must be a regular file inside the workspace.".into());
    }
    let dir = evidence_dir(&root,&request.run_id,false)?;
    let mut manifest = read_manifest(&dir)?;
    if manifest.workspace_root != root.to_string_lossy() {
        return Err("Evidence manifest belongs to a different workspace.".into());
    }
    let name = source.file_name().and_then(|name| name.to_str())
        .ok_or_else(|| "Artifact filename must be UTF-8.".to_string())?;
    let name = format!("import-{}-{name}",manifest.artifacts.len());
    let dest = dir.join(&name);
    if dest.exists() {
        return Err("Evidence artifact name already exists.".into());
    }
    fs::copy(&source,&dest).map_err(|e| format!("Cannot copy artifact: {e}"))?;
    let artifact = artifact_from_file(
        &dest,name.clone(),request.kind,
        format!(".virtuallab/evidence/{}/{}",request.run_id,name),
    )?;
    manifest.artifacts.push(artifact);
    persist_manifest(&dir,&manifest)?;
    Ok(manifest)
}

fn approved_program(program: &str) -> bool {
    // The catalog is deliberately narrow. Shells and scripts are never treated
    // as an approval/security boundary. Agent-originated profiles are not yet wired.
    matches!(program, "cargo" | "cargo.exe" | "cmake" | "cmake.exe" |
        "ctest" | "ctest.exe" | "ninja" | "ninja.exe" |
        "npm" | "npm.exe" | "node" | "node.exe")
}

fn verdict(profile:&Profile,checks:&[EvidenceCheck])->String {
    let by_id:HashMap<&str,&str> = checks.iter().map(|c|(c.gate_id.as_str(),c.status.as_str())).collect();
    for gate in profile.gates.iter().filter(|g|g.required) {
        if by_id.get(gate.id.as_str())==Some(&"fail") {return "fail".into();}
    }
    if checks.iter().any(|c|c.status=="cancelled") {return "cancelled".into();}
    if profile.gates.iter().filter(|g|g.required)
        .any(|g|by_id.get(g.id.as_str())==Some(&"blocked")) {return "blocked".into();}
    if profile.gates.iter().filter(|g|g.required)
        .any(|g|!by_id.contains_key(g.id.as_str())) {return "not_run".into();}
    if checks.iter().any(|c|matches!(c.status.as_str(),"fail"|"warn"|"blocked")) {return "warn".into();}
    "pass".into()
}

fn validate_profile(profile:&Profile)->Result<(),String> {
    if profile.schema_version!=1 {return Err("Unsupported profile schema.".into());}
    validate_id(&profile.id)?;
    if profile.name.trim().is_empty()||profile.gates.is_empty(){return Err("Profile name/gates required.".into());}
    let mut ids=HashSet::new();
    for g in &profile.gates {
        validate_id(&g.id)?;
        if !ids.insert(&g.id){return Err("Duplicate gate id.".into());}
        if g.label.trim().is_empty(){return Err("Gate label required.".into());}
        if !matches!(g.kind.as_str(),"build"|"unit"|"evidence"|"hil"|"hardware"|"soak"){return Err("Unknown gate kind.".into());}
        if !matches!(g.approval.as_str(),"none"|"human"){return Err("Unknown approval policy.".into());}
        if let Executor::Process {timeout_ms,..}=&g.executor {
            if timeout_ms.is_some_and(|ms|ms==0||ms>MAX_TIMEOUT_MS){return Err("Invalid gate timeout.".into());}
        }
    }
    Ok(())
}

fn validate_id(id:&str)->Result<(),String> {
    if id.is_empty()||id.len()>64||!id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'){
        return Err("Identifier must be 1–64 ASCII letters/digits/_/-.".into());
    }
    Ok(())
}

fn evidence_dir(root:&Path,id:&str,create:bool)->Result<PathBuf,String> {
    validate_id(id)?;
    let state=root.join(".virtuallab");
    let base=state.join("evidence");
    for folder in [&state,&base] {
        if folder.exists() {
            let metadata=fs::symlink_metadata(folder).map_err(|e|e.to_string())?;
            if metadata.file_type().is_symlink()||!metadata.is_dir(){
                return Err("Evidence directory must not be a symlink.".into());
            }
        } else if create {
            fs::create_dir(folder).map_err(|e|format!("Cannot create evidence folder: {e}"))?;
        } else {
            return Err("Evidence directory does not exist.".into());
        }
    }
    let path=base.join(id);
    if create {
        fs::create_dir(&path).map_err(|e|format!("Run evidence already exists or cannot be created: {e}"))?;
    } else {
        let meta=fs::symlink_metadata(&path).map_err(|e|e.to_string())?;
        if meta.file_type().is_symlink()||!meta.is_dir(){return Err("Invalid run evidence directory.".into());}
    }
    Ok(path)
}

fn artifact_from_file(path:&Path,id:String,kind:String,relative:String)->Result<EvidenceArtifact,String> {
    let mut file=File::open(path).map_err(|e|e.to_string())?;
    let size=file.metadata().map_err(|e|e.to_string())?.len();
    let mut sha=Sha256::new();
    let mut buf=[0u8;8192];
    loop {
        let read=file.read(&mut buf).map_err(|e|e.to_string())?;
        if read==0 {break;}
        sha.update(&buf[..read]);
    }
    Ok(EvidenceArtifact {
        id,kind,path:relative,sha256:Some(format!("{:x}",sha.finalize())),size_bytes:Some(size),
    })
}

fn persist_manifest(dir:&Path,manifest:&EvidenceManifest)->Result<(),String> {
    let content=serde_json::to_vec_pretty(manifest).map_err(|e|e.to_string())?;
    static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let temporary = dir.join(format!(".manifest-{}-{}-{}.tmp", std::process::id(), now_ms(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)
        .map_err(|error| format!("Cannot create evidence manifest temporary file: {error}"))?;
    let result = (|| -> io::Result<()> {
        file.write_all(&content)?;
        file.sync_all()?;
        drop(file);
        // Both paths are siblings: rename atomically replaces the destination
        // on Unix and Windows. Never delete the previous manifest first.
        fs::rename(&temporary, dir.join("manifest.json"))?;
        #[cfg(unix)] File::open(dir)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result.map_err(|error| format!("Cannot persist evidence manifest: {error}"))
}

fn read_manifest(dir:&Path)->Result<EvidenceManifest,String> {
    let content=fs::read(dir.join("manifest.json")).map_err(|e|e.to_string())?;
    serde_json::from_slice(&content).map_err(|e|format!("Invalid manifest: {e}"))
}

fn now_ms()->u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn lock_err<T>(_:std::sync::PoisonError<T>)->String{"Verification manager lock poisoned.".into()}

#[cfg(test)]
mod tests {
    use super::*;
    fn node_gate(script: &str, timeout: u64) -> Gate {
        Gate { id: "fixture".into(), label: "Fixture".into(), kind: "unit".into(),
            required: true, approval: "none".into(), executor: Executor::Process {
                program: "node".into(), args: vec!["-e".into(), script.into()],
                cwd: "workspace".into(), timeout_ms: Some(timeout) } }
    }
    fn fixture_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("virtuallab-verification-{label}-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn exited_parent_with_inherited_pipes_finishes_promptly() {
        let dir = fixture_dir("parent-exit");
        // Finite descendant ensures a broken runner fails rather than hanging the suite.
        let gate = node_gate("const {spawn}=require('child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},3500)'],{stdio:['ignore',1,2]}); process.exit(0)", 10000);
        let begin = Instant::now();
        let result = run_gate(&dir, &dir, &gate, &AtomicBool::new(false), &mut vec![]);
        assert_eq!(result.0, "pass");
        assert!(begin.elapsed() < Duration::from_secs(2), "Inherited pipes delayed gate completion");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn timeout_cleans_descendants_before_joining_readers() {
        let dir = fixture_dir("timeout");
        let gate = node_gate("const {spawn}=require('child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},3500)'],{stdio:['ignore',1,2]}); setTimeout(()=>{},3500)", 500);
        let begin = Instant::now();
        let result = run_gate(&dir, &dir, &gate, &AtomicBool::new(false), &mut vec![]);
        assert_eq!(result.0, "fail");
        assert!(result.1.contains("timed out"));
        assert!(begin.elapsed() < Duration::from_secs(2));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn cancellation_cleans_descendants_before_joining_readers() {
        let dir = fixture_dir("cancel");
        let gate = node_gate("const {spawn}=require('child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},3500)'],{stdio:['ignore',1,2]}); setTimeout(()=>{},3500)", 10000);
        let cancelled = AtomicBool::new(false);
        let begin = Instant::now();
        let result = thread::scope(|scope| {
            scope.spawn(|| { thread::sleep(Duration::from_millis(500)); cancelled.store(true, Ordering::Release); });
            run_gate(&dir, &dir, &gate, &cancelled, &mut vec![])
        });
        assert_eq!(result.0, "cancelled");
        assert!(begin.elapsed() < Duration::from_secs(2));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn excessive_output_has_bounded_evidence_and_cannot_pass() {
        let dir = fixture_dir("flood");
        let gate = node_gate("require('fs').writeSync(1,Buffer.alloc(9*1024*1024,65)); require('fs').writeSync(2,Buffer.alloc(9*1024*1024,66))", 10000);
        let mut artifacts = vec![];
        let result = run_gate(&dir, &dir, &gate, &AtomicBool::new(false), &mut artifacts);
        assert_eq!(result.0, "fail");
        assert!(result.1.contains("limit"));
        assert_eq!(artifacts.len(), 2);
        for artifact in artifacts { assert!(artifact.size_bytes.unwrap() <= 8 * 1024 * 1024); }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn capped_copy_propagates_disk_write_failure() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> { Err(io::Error::other("disk fixture")) }
            fn flush(&mut self) -> io::Result<()> { Ok(()) }
        }
        assert!(copy_capped(&mut &b"data"[..], &mut Broken, 4).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn failed_manifest_replacement_preserves_previous_manifest_and_cleans_temporary() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = fixture_dir("manifest-locked");
        fs::write(dir.join("manifest.json"), b"previous manifest").unwrap();
        // Permit reads/writes, but prevent deletion/replacement of this file.
        let guard = fs::OpenOptions::new().read(true).share_mode(3).open(dir.join("manifest.json")).unwrap();
        let manifest = EvidenceManifest { schema_version: 1, run_id: "test".into(), profile_id: "test".into(),
            workspace_root: "fixture".into(), repository_head_sha: "a".repeat(40), started_at_ms: 0,
            finished_at_ms: Some(1), status: "pass".into(), checks: vec![], artifacts: vec![], metadata: serde_json::json!({}) };
        assert!(persist_manifest(&dir, &manifest).is_err());
        assert_eq!(fs::read(dir.join("manifest.json")).unwrap(), b"previous manifest");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        drop(guard);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn manifest_replacement_does_not_modify_previous_file() {
        let dir = fixture_dir("manifest");
        fs::write(dir.join("manifest.json"), b"previous manifest").unwrap();
        fs::hard_link(dir.join("manifest.json"), dir.join("previous.json")).unwrap();
        let manifest = EvidenceManifest { schema_version: 1, run_id: "test".into(), profile_id: "test".into(),
            workspace_root: "fixture".into(), repository_head_sha: "a".repeat(40), started_at_ms: 0,
            finished_at_ms: Some(1), status: "pass".into(), checks: vec![], artifacts: vec![], metadata: serde_json::json!({}) };
        persist_manifest(&dir, &manifest).unwrap();
        assert_eq!(read_manifest(&dir).unwrap().status, "pass");
        assert_eq!(fs::read(dir.join("previous.json")).unwrap(), b"previous manifest");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_traversal_run_identifiers() {
        assert!(validate_id("../other").is_err());
        assert!(validate_id("run-01").is_ok());
    }
    #[test]
    fn hardware_actions_fail_closed() {
        assert!(!approved_program("bash"));
        assert!(!approved_program("python"));
        assert!(!approved_program("openocd"));
        assert!(approved_program("cargo"));
    }
    #[test]
    fn evidence_digest_matches_sha256_reference() {
        let file=std::env::temp_dir().join(format!("virtuallab-sha256-{}.txt",std::process::id()));
        fs::write(&file,b"abc").unwrap();
        let artifact=artifact_from_file(&file,"sample".into(),"log".into(),"abc.log".into()).unwrap();
        fs::remove_file(file).unwrap();
        assert_eq!(artifact.sha256.as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    }
    #[test]
    fn verdict_blocks_unapproved_required_hardware_gate() {
        let profile=Profile {schema_version:1,id:"test".into(),name:"Test".into(),
            description:None,gates:vec![Gate {id:"hil".into(),label:"HIL".into(),
            kind:"hil".into(),required:true,approval:"human".into(),
            executor:Executor::Adapter{adapter:"hil".into(),action:"drive".into(),parameters:None}}]};
        let checks=vec![EvidenceCheck{gate_id:"hil".into(),status:"blocked".into(),
            detail:"No approval".into(),started_at_ms:0,finished_at_ms:Some(1),exit_code:None}];
        assert_eq!(verdict(&profile,&checks),"blocked");
    }
}
