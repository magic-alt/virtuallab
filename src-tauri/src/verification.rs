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
    let mut child = match background_command(program)
        .args(args)
        .current_dir(working)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return ("fail".into(), format!("Cannot start process: {e}"), None),
    };

    let out_path = dir.join(format!("{}.stdout.log",gate.id));
    let err_path = dir.join(format!("{}.stderr.log",gate.id));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let output = thread::spawn(move || -> io::Result<()> {
        let mut file = File::create(out_path)?;
        if let Some(mut output) = stdout { io::copy(&mut output,&mut file)?; }
        file.sync_all()
    });
    let error = thread::spawn(move || -> io::Result<()> {
        let mut file = File::create(err_path)?;
        if let Some(mut output) = stderr { io::copy(&mut output,&mut file)?; }
        file.sync_all()
    });

    let begin = Instant::now();
    let (status, detail, exit) = loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = child.kill();
            break ("cancelled".into(), "Verification cancelled.".into(), None);
        }
        if begin.elapsed() >= timeout {
            let _ = child.kill();
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
    let _ = child.wait();
    let out_ok = output.join().is_ok_and(|r| r.is_ok());
    let err_ok = error.join().is_ok_and(|r| r.is_ok());
    if !out_ok || !err_ok {
        return ("fail".into(), "Could not persist output stream evidence.".into(), exit);
    }
    for (suffix,stream) in [("stdout","stdout"),("stderr","stderr")] {
        let path = dir.join(format!("{}.{}.log",gate.id,suffix));
        if let Ok(artifact) = artifact_from_file(
            &path, format!("{}-{stream}",gate.id), "log".into(),
            format!(".virtuallab/evidence/{}/{}.{}.log", dir.file_name().unwrap().to_string_lossy(),gate.id,suffix),
        ) {
            artifacts.push(artifact);
        }
    }
    (status,detail,exit)
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
    let path=dir.join("manifest.json");
    let mut file=File::create(path).map_err(|e|format!("Cannot persist evidence manifest: {e}"))?;
    file.write_all(&content).and_then(|_|file.sync_all()).map_err(|e|e.to_string())
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
