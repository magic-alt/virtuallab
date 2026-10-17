//! Task qualification observes individual gates and immutable artifact bytes.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Default)]
pub(crate) struct GateAssessment {
    pub blocked: Vec<String>,
    pub missing: Vec<String>,
    pub warnings: Vec<String>,
}

pub(crate) fn assess_checks(profile: &Value, checks: &[Value]) -> GateAssessment {
    let mut result = GateAssessment::default();
    let gates = profile
        .get("gates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !gates.iter().any(|g| g["required"] == true) {
        result.missing.push("没有定义必需验证检查".into());
    }
    let known: BTreeSet<_> = gates.iter().filter_map(|g| g["id"].as_str()).collect();
    let mut observed = BTreeMap::new();
    for check in checks {
        let id = check["gateId"].as_str().unwrap_or("");
        if !known.contains(id) || observed.insert(id, check).is_some() {
            result.blocked.push("验证证据包含重复或未知检查".into());
        }
    }
    for gate in &gates {
        let id = gate["id"].as_str().unwrap_or("");
        let status = observed
            .get(id)
            .and_then(|c| c["status"].as_str())
            .unwrap_or("not_run");
        let label = gate["label"].as_str().unwrap_or(id);
        if gate["required"] == true {
            match status {
                "pass" => {}
                "fail" | "blocked" => result.blocked.push(format!("必需检查 {label}: {status}")),
                _ => result
                    .missing
                    .push(format!("必需检查尚未通过 {label}: {status}")),
            }
        } else if status != "pass" {
            result.warnings.push(format!("可选检查 {label}: {status}"));
        }
    }
    result
}

pub(crate) fn digest_json(value: &Value) -> Result<String, String> {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let ordered: BTreeMap<_, _> =
                    map.iter().map(|(k, v)| (k.clone(), canonical(v))).collect();
                Value::Object(ordered.into_iter().collect())
            }
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            _ => value.clone(),
        }
    }
    let bytes = serde_json::to_vec(&canonical(value)).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(crate) fn hash_file(path: &Path, max_size: u64) -> Result<String, String> {
    use std::io::Read;
    let meta =
        fs::symlink_metadata(path).map_err(|e| format!("Required evidence unavailable: {e}"))?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > max_size {
        return Err("Evidence/tool must be a bounded regular file".into());
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max_size {
            return Err("Input grew beyond its qualification limit".into());
        }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn verify_artifacts(store: &Path, artifacts: &[Value]) -> Result<(), String> {
    if artifacts.is_empty() {
        return Err("Required run evidence is missing".into());
    }
    let root = fs::canonicalize(store).map_err(|e| e.to_string())?;
    for artifact in artifacts {
        let path = Path::new(artifact["path"].as_str().ok_or("Artifact path missing")?);
        let canonical =
            fs::canonicalize(path).map_err(|e| format!("Required artifact missing: {e}"))?;
        if !canonical.starts_with(&root) {
            return Err("Artifact escaped its managed evidence directory".into());
        }
        let expected = artifact["sha256"]
            .as_str()
            .ok_or("Artifact digest missing")?;
        if hash_file(path, 16 * 1024 * 1024)? != expected {
            return Err("Evidence artifact digest mismatch".into());
        }
        if artifact["sizeBytes"].as_u64()
            != Some(fs::metadata(path).map_err(|e| e.to_string())?.len())
        {
            return Err("Evidence artifact size mismatch".into());
        }
    }
    Ok(())
}

pub(crate) fn profile_paths(profile: &Value, key: &str) -> Result<Vec<String>, String> {
    match profile.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(values)) if values.len() <= 32 => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("{key} must contain strings"))
            })
            .collect(),
        _ => Err(format!("{key} must be a bounded array")),
    }
}

const TOOL_LIMIT: u64 = 512 * 1024 * 1024;
const PROBE_LIMIT: u64 = 16 * 1024;
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

#[derive(Clone)]
struct ObservedTool {
    launcher: PathBuf,
    executable: PathBuf,
    sha: String,
}
impl ObservedTool {
    fn value(&self, program: &str) -> Value {
        json!({"program":program,"launcherPath":self.launcher,"executablePath":self.executable,
            "sha256":self.sha,"version":null})
    }
}

fn provenance_path(path: &Path) -> Result<(), String> {
    let value = path.to_str().ok_or("Non-Unicode toolchain path")?;
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
        || path.components().any(|part| {
            let part = part.as_os_str().to_string_lossy().to_lowercase();
            part == ".." || part == ".git" || part.starts_with(".env")
        })
    {
        return Err("Invalid or sensitive toolchain path".into());
    }
    Ok(())
}

fn observe_program(program: &str) -> Result<ObservedTool, String> {
    provenance_path(Path::new(program))?;
    let command = crate::execution::process_command(program);
    let actual = PathBuf::from(command.get_program());
    let launcher = if actual.is_absolute() {
        actual
    } else {
        if actual.components().count() != 1 {
            return Err("Relative toolchain indirection is unsupported".into());
        }
        let overridden = command
            .get_envs()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            .and_then(|(_, value)| value.map(std::ffi::OsStr::to_os_string));
        let search = overridden
            .or_else(|| std::env::var_os("PATH"))
            .ok_or("Toolchain PATH unavailable")?;
        let directories: Vec<_> = std::env::split_paths(&search).collect();
        // The runner changes cwd after constructing its command. Relative/empty
        // PATH entries could otherwise select different binaries in that workspace.
        if directories.iter().any(|path| !path.is_absolute()) {
            return Err("Relative PATH tool selection is not qualified".into());
        }
        crate::cli_path::find_executable(&actual, &directories)
            .ok_or("Required toolchain executable unavailable")?
    };
    provenance_path(&launcher)?;
    let executable = fs::canonicalize(&launcher).map_err(|_| "Toolchain executable unavailable")?;
    provenance_path(&executable)?;
    let sha = hash_file(&executable, TOOL_LIMIT)?;
    Ok(ObservedTool {
        launcher,
        executable,
        sha,
    })
}

fn tool_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd")
        .to_string()
}

#[derive(Clone, Copy)]
enum AppleCompiler {
    Cc,
    Cxx,
    Clang,
    Clangxx,
    Gcc,
    Gxx,
}
impl AppleCompiler {
    fn name(self) -> &'static str {
        match self {
            Self::Cc => "cc",
            Self::Cxx => "c++",
            Self::Clang => "clang",
            Self::Clangxx => "clang++",
            Self::Gcc => "gcc",
            Self::Gxx => "g++",
        }
    }
}

fn apple_compiler_proxy(tool: &ObservedTool) -> Option<AppleCompiler> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    for path in [&tool.launcher, &tool.executable] {
        if path.parent() == Some(Path::new("/usr/bin")) {
            let compiler = match path.file_name()?.to_str()? {
                "cc" => AppleCompiler::Cc,
                "c++" => AppleCompiler::Cxx,
                "clang" => AppleCompiler::Clang,
                "clang++" => AppleCompiler::Clangxx,
                "gcc" => AppleCompiler::Gcc,
                "g++" => AppleCompiler::Gxx,
                _ => continue,
            };
            return Some(compiler);
        }
    }
    None
}

/// Known compiler/manager wrappers cannot attest the tools they delegate to.
fn require_native_tool(tool: &ObservedTool) -> Result<(), String> {
    use std::io::Read;
    if apple_compiler_proxy(tool).is_some() {
        return Err("Apple developer-tool proxy requires selected compiler resolution".into());
    }
    for path in [&tool.launcher, &tool.executable] {
        if matches!(
            tool_name(path).as_str(),
            "ccache" | "sccache" | "distcc" | "icecc" | "rustup"
        ) || path.components().any(|c| c.as_os_str() == "shims")
        {
            return Err("Compiler/tool wrapper selection is not qualified".into());
        }
    }
    let mut magic = [0; 4];
    fs::File::open(&tool.executable)
        .and_then(|mut file| file.read_exact(&mut magic))
        .map_err(|_| "Cannot identify native tool executable")?;
    if magic != *b"\x7fELF"
        && &magic[..2] != b"MZ"
        && !matches!(
            magic,
            [0xfe, 0xed, 0xfa, 0xce]
                | [0xce, 0xfa, 0xed, 0xfe]
                | [0xfe, 0xed, 0xfa, 0xcf]
                | [0xcf, 0xfa, 0xed, 0xfe]
                | [0xca, 0xfe, 0xba, 0xbe]
                | [0xbe, 0xba, 0xfe, 0xca]
                | [0xca, 0xfe, 0xba, 0xbf]
                | [0xbf, 0xba, 0xfe, 0xca]
        )
    {
        return Err("Script/compiler wrapper requires a qualified selection adapter".into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum SelectionProbe {
    Cargo,
    Rustc,
    Apple(AppleCompiler),
    NinjaCommands,
}

/// Only these native-owned read-only queries are permitted. No caller supplies argv.
fn probe_output(
    resolver: &Path,
    workspace: &Path,
    selection: SelectionProbe,
) -> Result<Vec<u8>, String> {
    use std::{io::Read, process::Stdio, sync::mpsc, time::Instant};
    let mut command = crate::process::background_command(resolver);
    command
        .args(match selection {
            SelectionProbe::Cargo => ["which", "cargo"],
            SelectionProbe::Rustc => ["which", "rustc"],
            SelectionProbe::Apple(compiler) => ["--find", compiler.name()],
            SelectionProbe::NinjaCommands => ["-t", "commands"],
        })
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = crate::managed_process::spawn(&mut command)
        .map_err(|_| "Cannot start toolchain selection probe")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Selection probe stdout missing")?;
    let (tx, rx) = mpsc::sync_channel(1);
    let limit = if matches!(selection, SelectionProbe::NinjaCommands) {
        8 * 1024 * 1024
    } else {
        PROBE_LIMIT
    };
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut output = None;
    let result = loop {
        if output.is_none() {
            match rx.try_recv() {
                Ok(Ok(bytes)) if bytes.len() as u64 <= limit => output = Some(bytes),
                Ok(_) | Err(mpsc::TryRecvError::Disconnected) => {
                    break Err("Selection probe output unavailable or oversized")
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                break Err("Could not resolve the selected toolchain")
            }
            Ok(Some(_)) if output.is_some() => break Ok(output.take().unwrap()),
            Err(_) => break Err("Selection probe exit could not be observed"),
            _ => {}
        }
        if Instant::now() >= deadline {
            break Err("Toolchain selection probe timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    crate::process::terminate_tree(&mut child)
        .map_err(|_| "Selection probe shutdown could not be confirmed")?;
    result.map_err(str::to_string)
}

fn selection_path(
    resolver: &Path,
    workspace: &Path,
    selection: SelectionProbe,
) -> Result<PathBuf, String> {
    let bytes = probe_output(resolver, workspace, selection)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "Invalid selected-tool path encoding")?;
    let path = PathBuf::from(text.trim_end_matches(['\r', '\n']));
    provenance_path(&path)?;
    if !path.is_absolute() {
        return Err("Resolver returned a non-absolute selected-tool path".into());
    }
    Ok(path)
}

fn selected_apple_compiler(
    resolver: &Path,
    workspace: &Path,
    compiler: AppleCompiler,
) -> Result<ObservedTool, String> {
    let path = selection_path(resolver, workspace, SelectionProbe::Apple(compiler))?;
    let selected = observe_program(path.to_str().ok_or("Invalid selected compiler path")?)?;
    // A second proxy or a known wrapper is still an unknown selection.
    require_native_tool(&selected)?;
    Ok(selected)
}

fn resolve_native_tool(
    tool: &ObservedTool,
    workspace: &Path,
) -> Result<Option<(ObservedTool, ObservedTool)>, String> {
    if let Some(compiler) = apple_compiler_proxy(tool) {
        let resolver = observe_program("/usr/bin/xcrun")?;
        require_native_tool(&resolver)?;
        let selected = selected_apple_compiler(&resolver.executable, workspace, compiler)?;
        Ok(Some((selected, resolver)))
    } else {
        require_native_tool(tool)?;
        Ok(None)
    }
}

fn rust_context(workspace: &Path) -> Result<BTreeSet<PathBuf>, String> {
    // Presence checks only: never read Cargo configuration, credentials, or environment values into evidence.
    for name in [
        "RUSTC",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
        "CARGO_BUILD_RUSTC",
        "CARGO_BUILD_RUSTC_WRAPPER",
        "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
    ] {
        if std::env::var_os(name).is_some_and(|v| !v.is_empty()) {
            return Err("Cargo compiler environment indirection is not qualified".into());
        }
    }
    let mut watches = BTreeSet::new();
    let mut cargo_dirs: Vec<_> = workspace.ancestors().map(|p| p.join(".cargo")).collect();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    if let Some(path) = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|p| p.join(".cargo")))
    {
        if !path.is_absolute() {
            return Err("Relative CARGO_HOME selection is unsupported".into());
        }
        cargo_dirs.push(path);
    }
    for directory in cargo_dirs {
        for name in ["config", "config.toml"] {
            let path = directory.join(name);
            provenance_path(&path)?;
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                _ => return Err("Cargo config indirection is not qualified; use an explicit unwrapped toolchain".into()),
            }
            watches.insert(path);
        }
    }
    for ancestor in workspace.ancestors() {
        for name in ["rust-toolchain", "rust-toolchain.toml"] {
            watches.insert(ancestor.join(name));
        }
    }
    let rustup_home = std::env::var_os("RUSTUP_HOME")
        .map(PathBuf::from)
        .or_else(|| home.map(|p| p.join(".rustup")))
        .ok_or("rustup selection context unavailable")?;
    provenance_path(&rustup_home)?;
    if !rustup_home.is_absolute() {
        return Err("Relative RUSTUP_HOME selection is unsupported".into());
    }
    watches.insert(rustup_home.join("settings.toml"));
    Ok(watches)
}

fn rustup_resolver(tool: &ObservedTool) -> Result<Option<PathBuf>, String> {
    let sibling = tool.launcher.with_file_name(if cfg!(windows) {
        "rustup.exe"
    } else {
        "rustup"
    });
    if tool_name(&tool.executable) == "rustup" {
        return Ok(Some(tool.executable.clone()));
    }
    if sibling.is_file() {
        // Apply canonical secret-path checks before hashing the possible hardlink proxy.
        let resolver = observe_program(sibling.to_str().ok_or("Non-Unicode rustup path")?)?;
        if resolver.sha == tool.sha {
            return Ok(Some(sibling));
        }
    }
    Ok(None)
}

fn observe_rust(
    program: &str,
    tool: &ObservedTool,
    workspace: &Path,
    tools: &mut BTreeMap<String, Value>,
    watches: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    watches.extend(rust_context(workspace)?);
    let rustup = rustup_resolver(tool)?;
    let rustc = if rustup.is_none() {
        Some(observe_program("rustc")?)
    } else {
        None
    };
    let rustc_resolver = rustc.as_ref().map(rustup_resolver).transpose()?.flatten();
    // Native magic is not proof of a final Cargo/rustc: a copied rustup proxy
    // can have any basename and no sibling resolver. Always bind selection to
    // rustup; standalone installations need a separately qualified adapter.
    {
        let known_proxy = rustup.is_some();
        let rustup = match rustup.or(rustc_resolver) {
            Some(path) => path,
            None => {
                observe_program("rustup")
                    .map_err(|_| {
                        "Rust selection unavailable: a qualified rustup resolver is required"
                    })?
                    .executable
            }
        };
        provenance_path(&rustup)?;
        let resolver = observe_program(rustup.to_str().ok_or("Invalid rustup path")?)?;
        let proxy = known_proxy || resolver.sha == tool.sha;
        let selected_cargo = selection_path(&rustup, workspace, SelectionProbe::Cargo)?;
        let selected_rustc = selection_path(&rustup, workspace, SelectionProbe::Rustc)?;
        let cargo = observe_program(selected_cargo.to_str().ok_or("Invalid Cargo path")?)?;
        let rustc = observe_program(selected_rustc.to_str().ok_or("Invalid rustc path")?)?;
        require_native_tool(&cargo)?;
        require_native_tool(&rustc)?;
        if cargo.sha == resolver.sha || rustc.sha == resolver.sha {
            return Err("rustup selected another unresolved proxy".into());
        }
        let selected = if tool_name(Path::new(program)) == "cargo" {
            &cargo
        } else {
            &rustc
        };
        if !proxy && tool.executable != selected.executable {
            return Err("Explicit Rust tool disagrees with rustup selection".into());
        }
        tools.insert(
            format!("{program}:selected-cargo"),
            cargo.value("cargo:selected"),
        );
        tools.insert(
            format!("{program}:selected-rustc"),
            rustc.value("rustc:selected"),
        );
        tools.insert(
            format!("{program}:resolver"),
            resolver.value("rustup:resolver"),
        );
    }
    Ok(())
}

fn observe_npm(tool: &ObservedTool) -> Result<ObservedTool, String> {
    use std::io::{BufRead, BufReader, Read};
    // Presence only: injected modules outside the bounded installed package
    // cannot be qualified. Never retain environment values in evidence/errors.
    if ["NODE_OPTIONS", "NODE_PATH"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
    {
        return Err("Node environment module/option indirection is unqualified".into());
    }
    let mut first = String::new();
    BufReader::new(
        fs::File::open(&tool.executable)
            .map_err(|_| "npm launcher unavailable")?
            .take(512),
    )
    .read_line(&mut first)
    .map_err(|_| "npm launcher is not a qualified Node script")?;
    if !first.ends_with('\n') {
        return Err("npm launcher shebang is missing or oversized".into());
    }
    let interpreter = first
        .trim()
        .strip_prefix("#!")
        .ok_or("Unsupported npm wrapper; Node interpreter unknown")?
        .trim();
    let program = if interpreter == "/usr/bin/env node" {
        "node"
    } else {
        if !Path::new(interpreter).is_absolute() || tool_name(Path::new(interpreter)) != "node" {
            return Err("Unsupported npm interpreter indirection".into());
        }
        interpreter
    };
    let node = observe_program(program)?;
    require_native_tool(&node)?;
    Ok(node)
}

fn bounded_regular(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    provenance_path(path)?;
    let meta = fs::symlink_metadata(path).map_err(|_| "Provenance file unavailable")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > limit {
        return Err("Provenance requires a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Provenance file unavailable")?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Provenance read failed")?;
    if bytes.len() as u64 > limit {
        return Err("Provenance file grew beyond its bound".into());
    }
    Ok(bytes)
}

fn npm_implementation(tool: &ObservedTool) -> Result<Value, String> {
    let bin = tool
        .executable
        .parent()
        .ok_or("npm package layout unavailable")?;
    if tool.executable.file_name().and_then(|s| s.to_str()) != Some("npm-cli.js")
        || bin.file_name().and_then(|s| s.to_str()) != Some("bin")
    {
        return Err("Only the installed npm bin/npm-cli.js layout is qualified".into());
    }
    let root = bin.parent().ok_or("npm package root unavailable")?;
    let launcher = bounded_regular(&tool.executable, 4096)?;
    let launcher = std::str::from_utf8(&launcher).map_err(|_| "Unknown npm entry point")?;
    // An exact supported entry template, not a JavaScript token/source scanner.
    if launcher.split_once('\n').map(|(_, body)| body.trim())
        != Some("require('../lib/cli.js')(process)")
    {
        return Err("Unknown npm entry point; package implementation cannot be bounded".into());
    }
    let package_path = root.join("package.json");
    let package = bounded_regular(&package_path, 1024 * 1024)?;
    let metadata: Value =
        serde_json::from_slice(&package).map_err(|_| "Invalid npm package metadata")?;
    if metadata["name"] != "npm" || metadata["bin"]["npm"] != "bin/npm-cli.js" {
        return Err("Unsupported npm package identity/layout".into());
    }
    let mut entries = BTreeMap::new();
    entries.insert(
        "package.json".to_string(),
        format!("{:x}", Sha256::digest(&package)),
    );
    let mut total = package.len() as u64;
    fn walk(
        root: &Path,
        path: &Path,
        depth: usize,
        total: &mut u64,
        entries: &mut BTreeMap<String, String>,
    ) -> Result<(), String> {
        if depth > 64 || entries.len() >= 10_000 {
            return Err("npm implementation inventory exceeds its bound".into());
        }
        provenance_path(path)?;
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if matches!(
            name.as_str(),
            ".npmrc"
                | ".netrc"
                | ".aws"
                | ".ssh"
                | "credentials"
                | ".credentials"
                | "credentials.json"
                | "secrets.json"
                | "tokens.json"
                | "id_rsa"
                | "id_ed25519"
        ) || name.ends_with(".pem")
            || name.ends_with(".key")
            || name.ends_with(".p12")
        {
            return Err("Sensitive file in npm implementation tree; contents were not read".into());
        }
        let meta = fs::symlink_metadata(path).map_err(|_| "npm implementation unavailable")?;
        if meta.file_type().is_symlink() {
            return Err("Linked npm implementation trees are not qualified".into());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "npm package escape")?
            .to_str()
            .ok_or("Non-Unicode npm path")?
            .to_string();
        if meta.is_dir() {
            entries.insert(relative, "directory".into());
            for entry in
                fs::read_dir(path).map_err(|_| "npm implementation directory unavailable")?
            {
                walk(
                    root,
                    &entry.map_err(|_| "npm directory entry unavailable")?.path(),
                    depth + 1,
                    total,
                    entries,
                )?;
            }
        } else {
            let bytes = bounded_regular(path, 8 * 1024 * 1024)?;
            *total += bytes.len() as u64;
            if *total > 64 * 1024 * 1024 {
                return Err("npm implementation exceeds 64 MiB".into());
            }
            entries.insert(relative, format!("{:x}", Sha256::digest(&bytes)));
        }
        Ok(())
    }
    let trees: Vec<_> = ["bin", "lib", "node_modules"]
        .iter()
        .map(|name| root.join(name))
        .collect();
    for tree in &trees {
        if !fs::symlink_metadata(tree)
            .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        {
            return Err("Incomplete installed npm implementation tree".into());
        }
        walk(root, tree, 0, &mut total, &mut entries)?;
    }
    if !root.join("lib/cli.js").is_file() {
        return Err("npm implementation entry unavailable".into());
    }
    let mut paths = vec![package_path, root.join("index.js")];
    if root.join("index.js").exists() {
        walk(root, &root.join("index.js"), 0, &mut total, &mut entries)?;
    }
    paths.sort();
    // Only installed implementation is fingerprinted; npmrc/user credentials and
    // project scripts are not read as package code. No npm command is executed.
    Ok(
        json!({"program":"npm:implementation", "sha256":digest_json(&json!(entries))?,
        "version":null, "contextWatchTrees":trees, "contextWatchPaths":paths}),
    )
}

fn workspace_output(workspace: &Path, relative: &str) -> Result<PathBuf, String> {
    provenance_path(Path::new(relative))?;
    if Path::new(relative).is_absolute()
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("CMake outputs must be explicit relative directories".into());
    }
    let path = workspace.join(relative);
    let mut ancestor = path.as_path();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                if meta.file_type().is_symlink()
                    || !fs::canonicalize(ancestor)
                        .map_err(|_| "CMake output unavailable")?
                        .starts_with(workspace)
                {
                    return Err("CMake output escapes its workspace or uses a symlink".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("CMake output unavailable".into()),
        }
        if ancestor == workspace {
            break;
        }
        ancestor = ancestor.parent().ok_or("CMake output outside workspace")?;
    }
    Ok(path)
}

struct CmakeCompiler {
    launcher: ObservedTool,
    selected: ObservedTool,
}
struct CmakeSelection {
    compilers: BTreeMap<String, CmakeCompiler>,
    ninja: ObservedTool,
}

fn cmake_compilers(cache: &Path, workspace: &Path) -> Result<CmakeSelection, String> {
    use std::io::{BufRead, BufReader, Read};
    let meta = fs::symlink_metadata(cache).map_err(|_| "CMakeCache unavailable")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
        return Err("CMakeCache must be a bounded regular file".into());
    }
    let reader = BufReader::new(
        fs::File::open(cache)
            .map_err(|_| "CMakeCache unavailable")?
            .take(1024 * 1024 + 1),
    );
    let mut count = 0;
    let mut seen = BTreeSet::new();
    let mut compilers = BTreeMap::new();
    let mut config = BTreeMap::new();
    // Inspect only explicit compiler-selection fields. Never retain unrelated cache/config values.
    for line in reader.lines() {
        let line = line.map_err(|_| "CMakeCache encoding unavailable")?;
        count += line.len() + 1;
        if count > 1024 * 1024 {
            return Err("CMakeCache grew beyond the qualification bound".into());
        }
        if line.starts_with(['#', '/']) {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let selection = key.starts_with("CMAKE_") && key.ends_with("_COMPILER");
        let indirect = matches!(
            key,
            "CMAKE_TOOLCHAIN_FILE" | "RULE_LAUNCH_COMPILE" | "RULE_LAUNCH_LINK"
        ) || key.starts_with("CMAKE_")
            && (key.ends_with("_COMPILER_LAUNCHER")
                || key.ends_with("_LINKER_LAUNCHER")
                || key.ends_with("_COMPILER_ARG1")
                || key.ends_with("_COMPILER_EXTERNAL_TOOLCHAIN"));
        let graph = matches!(
            key,
            "CMAKE_GENERATOR" | "CMAKE_MAKE_PROGRAM" | "CMAKE_HOME_DIRECTORY"
        );
        if !selection && !indirect && !graph {
            continue;
        }
        let (_, value) = rest
            .split_once('=')
            .ok_or("Malformed CMake compiler selection")?;
        if !seen.insert(key.to_string()) {
            return Err("Ambiguous duplicate CMake compiler selection".into());
        }
        if graph {
            config.insert(key.to_owned(), value.to_owned());
        } else if indirect {
            if !value.is_empty() {
                return Err("CMake compiler wrapper/toolchain indirection is not qualified".into());
            }
        } else {
            if !matches!(key, "CMAKE_C_COMPILER" | "CMAKE_CXX_COMPILER") {
                return Err("Only C/C++ CMake compiler selection is qualified".into());
            }
            let path = Path::new(value);
            provenance_path(path)?;
            if !path.is_absolute() || value.contains(';') {
                return Err("CMake compiler must be one absolute executable".into());
            }
            let compiler = observe_program(value)?;
            let selected = resolve_native_tool(&compiler, workspace)?;
            let selected = selected.map_or_else(|| compiler.clone(), |(tool, _)| tool);
            compilers.insert(
                key.to_string(),
                CmakeCompiler {
                    launcher: compiler,
                    selected,
                },
            );
        }
    }
    if compilers.is_empty() {
        return Err("CMakeCache has no observed compiler selection".into());
    }
    if cfg!(windows) || config.get("CMAKE_GENERATOR").map(String::as_str) != Some("Ninja") {
        return Err("CMake qualification requires the supported single-config Ninja generator on a POSIX host".into());
    }
    let ninja = config
        .get("CMAKE_MAKE_PROGRAM")
        .ok_or("CMake Ninja executable is unknown")?;
    if !Path::new(ninja).is_absolute() || tool_name(Path::new(ninja)) != "ninja" {
        return Err("CMake build tool indirection is unqualified".into());
    }
    let ninja = observe_program(ninja)?;
    require_native_tool(&ninja)?;
    let source = config
        .get("CMAKE_HOME_DIRECTORY")
        .ok_or("CMake source directory is unknown")?;
    provenance_path(Path::new(source))?;
    let source = fs::canonicalize(source).map_err(|_| "CMake source directory unavailable")?;
    if !source.starts_with(workspace) {
        return Err("CMake source directory escapes workspace".into());
    }
    Ok(CmakeSelection { compilers, ninja })
}

/// Parse a POSIX *simple command* into argv. Shell operators, expansions,
/// substitutions and response files are unsupported, never executed or guessed.
fn simple_argv(command: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if c.is_control() && c != '\t' {
            return Err("Control character in generated command".into());
        }
        match (quote, c) {
            (Some('\''), '\'') => quote = None,
            (Some('\''), _) => word.push(c),
            (Some('"'), '"') => quote = None,
            (Some('"'), '$' | '`') => {
                return Err("Shell expansion in generated command is unqualified".into())
            }
            (Some('"'), '\\') => {
                let next = chars
                    .next()
                    .filter(|c| !c.is_control())
                    .ok_or("Incomplete command escape")?;
                if !matches!(next, '$' | '`' | '"' | '\\') {
                    word.push('\\');
                }
                word.push(next);
            }
            (Some('"'), _) => word.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                started = true;
            }
            (None, '\\') => {
                word.push(
                    chars
                        .next()
                        .filter(|c| !c.is_control())
                        .ok_or("Incomplete command escape")?,
                );
                started = true;
            }
            (None, ' ' | '\t') => {
                if started {
                    args.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            (
                None,
                '$' | '`' | ';' | '&' | '|' | '<' | '>' | '(' | ')' | '*' | '?' | '[' | ']' | '{'
                | '}' | '~' | '#',
            ) => {
                return Err("Generated shell composition/expansion is unqualified".into());
            }
            (None, _) => {
                word.push(c);
                started = true;
            }
            _ => return Err("Unknown command quoting".into()),
        }
    }
    if quote.is_some() {
        return Err("Unterminated command quote".into());
    }
    if started {
        args.push(word);
    }
    if args.is_empty()
        || args
            .iter()
            .any(|arg| arg.starts_with('@') || arg.contains('\0'))
    {
        return Err("Empty command or compiler response-file indirection is unqualified".into());
    }
    Ok(args)
}

// Ninja itself parses/expands the graph. This restricted include reader only
// discovers the files that must remain watched; variable-driven includes and
// dynamic subgraphs are refused rather than approximated with source tokens.
fn ninja_manifests(build: &Path) -> Result<BTreeSet<PathBuf>, String> {
    let mut pending = vec!["build.ninja".to_string()];
    let mut seen = BTreeSet::new();
    while let Some(relative) = pending.pop() {
        let path = workspace_output(build, &relative)?;
        if seen.contains(&path) {
            continue;
        }
        if seen.len() >= 32 {
            return Err("Ninja graph include bound exceeded".into());
        }
        let bytes = bounded_regular(&path, 2 * 1024 * 1024)?;
        let input = std::str::from_utf8(&bytes).map_err(|_| "Ninja graph encoding unsupported")?;
        let mut logical = String::new();
        for line in input.lines() {
            let line = if logical.is_empty() {
                line
            } else {
                line.trim_start_matches([' ', '\t'])
            };
            logical.push_str(line);
            let dollars = logical.chars().rev().take_while(|c| *c == '$').count();
            if dollars % 2 == 1 {
                logical.pop();
                continue;
            }
            let statement = logical.trim();
            let mut parts = statement.splitn(2, char::is_whitespace);
            let keyword = parts.next().unwrap_or_default();
            if matches!(keyword, "include" | "subninja") {
                let include = parts.next().ok_or("Malformed Ninja include")?.trim();
                // CMake single-config Ninja emits literal relative includes.
                // Everything else needs a qualified parser/adapter.
                if keyword == "subninja" || include.contains(['$', '#', '\t']) || include.is_empty()
                {
                    return Err("Dynamic Ninja include/subgraph is unqualified".into());
                }
                pending.push(include.to_owned());
            }
            if keyword == "dyndep" {
                return Err("Dynamic Ninja dependencies are unqualified".into());
            }
            logical.clear();
        }
        if !logical.is_empty() {
            return Err("Incomplete Ninja continuation".into());
        }
        seen.insert(path);
    }
    Ok(seen)
}

fn observe_cmake_graph(
    cache: &Path,
    workspace: &Path,
    declared: &BTreeSet<PathBuf>,
    tools: &mut BTreeMap<String, Value>,
    watches: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    let selection = cmake_compilers(cache, workspace)?;
    let build = cache.parent().ok_or("CMake build directory missing")?;
    let selected: BTreeSet<_> = selection
        .compilers
        .values()
        .map(|c| c.selected.executable.clone())
        .collect();
    if !selected.is_subset(declared) {
        return Err("CMake selected compiler does not match declared toolchainPrograms".into());
    }
    let manifests = ninja_manifests(build)?;
    let bytes = probe_output(
        &selection.ninja.executable,
        build,
        SelectionProbe::NinjaCommands,
    )?;
    let commands =
        std::str::from_utf8(&bytes).map_err(|_| "Ninja expanded commands unavailable")?;
    let entries: Vec<_> = commands.lines().collect();
    if entries.is_empty() || entries.len() > 20_000 {
        return Err("Ninja command inventory is empty or exceeds its bound".into());
    }
    let mut observed = BTreeMap::<String, ObservedTool>::new();
    let mut bindings = Vec::new();
    let mut compile_count = 0;
    let mut apple_context = selection
        .compilers
        .values()
        .any(|c| apple_compiler_proxy(&c.launcher).is_some());
    for command in entries {
        if command.is_empty() {
            continue;
        } // phony edges do not execute
          // CMake's direct executable-link rule has these exact no-op sentinels.
          // The interior is still parsed as one simple command; other shell chains fail.
        let command = command
            .strip_prefix(": && ")
            .and_then(|s| s.strip_suffix(" && :"))
            .unwrap_or(command);
        let argv = simple_argv(command)?;
        let executable = Path::new(&argv[0]);
        provenance_path(executable)?;
        if !executable.is_absolute() {
            return Err("Ninja compiler/launcher must be an absolute direct tool".into());
        }
        if !observed.contains_key(&argv[0]) {
            let tool = observe_program(&argv[0])?;
            apple_context |= apple_compiler_proxy(&tool).is_some();
            let resolved = resolve_native_tool(&tool, workspace)?
                .map_or_else(|| tool.clone(), |(selected, _)| selected);
            watches.insert(tool.launcher.clone());
            watches.insert(tool.executable.clone());
            observed.insert(argv[0].clone(), resolved);
        }
        let tool = &observed[&argv[0]];
        let output = argv
            .windows(2)
            .find(|pair| pair[0] == "-o")
            .map(|pair| pair[1].as_str())
            .ok_or("Direct compiler output is unknown")?;
        provenance_path(Path::new(output))?;
        if !selected.contains(&tool.executable) {
            return Err("Effective Ninja compiler/launcher does not match CMake selection; wrappers/custom commands are unqualified".into());
        }
        if argv.iter().any(|arg| arg == "-c") {
            compile_count += 1;
        }
        bindings.push(json!({"output":output,"compiler":tool.value("cmake:effective-compiler")}));
    }
    if compile_count == 0 {
        return Err("Ninja graph has no directly observed C/C++ compilation".into());
    }
    let prefix = format!("cmake:{}", cache.display());
    if apple_context {
        let resolver = observe_program("/usr/bin/xcrun")?;
        tools.insert(format!("{prefix}:xcrun"), resolver.value("cmake:xcrun"));
        watches.insert(PathBuf::from("/var/db/xcode_select_link"));
    }
    for (key, compiler) in selection.compilers {
        let mut value = compiler.selected.value(&format!("cmake:{key}"));
        value["launcherPath"] = json!(compiler.launcher.launcher);
        value["launcherSha256"] = json!(compiler.launcher.sha);
        tools.insert(format!("{prefix}:{key}"), value);
    }
    tools.insert(
        format!("{prefix}:ninja"),
        selection.ninja.value("cmake:ninja"),
    );
    tools.insert(format!("{prefix}:graph"), json!({"program":"cmake:effective-build-graph","sha256":digest_json(&json!(bindings))?,"version":null}));
    watches.extend(manifests);
    Ok(())
}

/// Observes exact selected tools through supported native adapters, not every
/// transitive program a tool may execute. Unknown wrappers remain unqualified.
/// Selection queries inherit the runner's workspace and environment, but neither
/// environment values nor arbitrary probe output are retained as evidence.
pub(crate) fn observe_toolchains(
    profile: &Value,
    workspace: &Path,
    require_configured: bool,
) -> Result<(String, Vec<Value>), String> {
    let workspace = fs::canonicalize(workspace).map_err(|_| "Toolchain workspace unavailable")?;
    let gates = profile["gates"]
        .as_array()
        .ok_or("Verification gates missing")?;
    let declared = profile_paths(profile, "toolchainPrograms")?;
    let mut programs: BTreeSet<String> = gates
        .iter()
        .filter_map(|g| g["executor"]["program"].as_str().map(str::to_owned))
        .collect();
    programs.extend(declared.iter().cloned());
    if programs.is_empty() || programs.len() > 32 {
        return Err("Executable provenance missing or exceeds its limit".into());
    }
    let mut tools = BTreeMap::new();
    let mut declared_paths = BTreeSet::new();
    let mut watches = BTreeSet::new();
    for program in programs {
        let tool = observe_program(&program)?;
        let mut selected_path = tool.executable.clone();
        if declared.contains(&program) {
            if !matches!(tool_name(Path::new(&program)).as_str(), "cargo" | "rustc")
                && apple_compiler_proxy(&tool).is_none()
            {
                require_native_tool(&tool)?;
            }
        }
        match tool_name(Path::new(&program)).as_str() {
            "cargo" | "rustc" => {
                for gate in gates.iter().filter(|g| g["executor"]["program"] == program) {
                    if gate["executor"]["args"].as_array().is_some_and(|args| {
                        args.iter().filter_map(Value::as_str).any(|a| {
                            a.starts_with('+')
                                || a == "--config"
                                || a.starts_with("--config=")
                                || a == "--manifest-path"
                                || a.starts_with("--manifest-path=")
                        })
                    }) {
                        return Err(
                            "Cargo argument-based toolchain/config indirection is not qualified"
                                .into(),
                        );
                    }
                }
                observe_rust(&program, &tool, &workspace, &mut tools, &mut watches)?;
            }
            "npm" => {
                let node = observe_npm(&tool)?;
                tools.insert(format!("{program}:node"), node.value("npm:node"));
                tools.insert(
                    format!("{program}:implementation"),
                    npm_implementation(&tool)?,
                );
            }
            _ => {
                if let Some((selected, resolver)) = resolve_native_tool(&tool, &workspace)? {
                    selected_path = selected.executable.clone();
                    let label = format!("{program}:selected");
                    tools.insert(label.clone(), selected.value(&label));
                    tools.insert("xcrun:resolver".into(), resolver.value("xcrun:resolver"));
                    // Watch the system selector without reading its contents. This
                    // is included before configure as well as during readiness.
                    watches.insert(PathBuf::from("/var/db/xcode_select_link"));
                }
            }
        }
        if declared.contains(&program) {
            declared_paths.insert(selected_path);
        }
        tools.insert(program.clone(), tool.value(&program));
    }
    let cmake_gates: Vec<_> = gates
        .iter()
        .filter(|g| {
            g["executor"]["program"]
                .as_str()
                .is_some_and(|p| tool_name(Path::new(p)) == "cmake")
        })
        .collect();
    if !cmake_gates.is_empty() {
        if declared_paths.is_empty() {
            return Err("CMake must declare its actual compilers in toolchainPrograms".into());
        }
        let outputs: Vec<_> = profile_paths(profile, "outputPaths")?
            .iter()
            .map(|p| workspace_output(&workspace, p))
            .collect::<Result<_, _>>()?;
        let mut caches = BTreeSet::new();
        for gate in cmake_gates {
            let args: Vec<_> = gate["executor"]["args"]
                .as_array()
                .ok_or("CMake argv missing")?
                .iter()
                .map(|v| v.as_str().ok_or("Invalid CMake argument"))
                .collect::<Result<_, _>>()?;
            let mut build = None;
            if require_configured && !(args.len() == 2 && args[0] == "--build") {
                return Err("Formal CMake qualification supports only --build <directory> with the default Ninja target; configure/custom targets/options are unqualified".into());
            }
            for (index, arg) in args.iter().enumerate() {
                if matches!(
                    *arg,
                    "--preset" | "--workflow" | "--toolchain" | "-C" | "-P" | "-E"
                ) || arg.starts_with("--preset=")
                    || arg.starts_with("--toolchain=")
                {
                    return Err("CMake preset/script/toolchain indirection is not qualified".into());
                }
                let path = if matches!(*arg, "-B" | "--build") {
                    Some(*args.get(index + 1).ok_or("CMake build directory missing")?)
                } else {
                    arg.strip_prefix("-B").filter(|p| !p.is_empty())
                };
                if let Some(path) = path {
                    if build.replace(workspace_output(&workspace, path)?).is_some() {
                        return Err("Ambiguous CMake build directory".into());
                    }
                }
            }
            let build = build.ok_or("CMake requires an explicit -B/--build output directory")?;
            if !outputs.iter().any(|output| build.starts_with(output)) {
                return Err("CMake build directory must be under declared outputPaths".into());
            }
            caches.insert(build.join("CMakeCache.txt"));
        }
        for cache in caches {
            watches.insert(cache.clone()); // Present before configure too: stable provenance shape.
            match fs::symlink_metadata(&cache) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && !require_configured => {
                    continue
                }
                Err(_) => return Err("Configured CMake compiler selection is unavailable".into()),
                Ok(_) => {}
            }
            observe_cmake_graph(
                &cache,
                &workspace,
                &declared_paths,
                &mut tools,
                &mut watches,
            )?;
        }
    }
    let mut tools: Vec<_> = tools.into_values().collect();
    if let Some(first) = tools.first_mut() {
        first["contextWatchPaths"] = json!(watches);
    }
    Ok((digest_json(&Value::Array(tools.clone()))?, tools))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Positive npm fixtures need a clean interpreter context. Keep CI's Node
    /// heap setting in the parent and never mutate the parallel test process.
    #[cfg(unix)]
    fn run_with_clean_node_environment(test: &str) -> bool {
        const KEY: &str = "VL_CLEAN_NODE_FIXTURE";
        if std::env::var(KEY).as_deref() == Ok(test) {
            return false;
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env(KEY, test)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .status()
            .unwrap();
        assert!(status.success(), "isolated npm fixture failed: {test}");
        true
    }

    struct ProvenanceFixture(PathBuf);
    impl ProvenanceFixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "vl-provenance-{}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(path.join("build")).unwrap();
            Self(path)
        }
        fn binary(&self, name: &str) -> String {
            let path = self.0.join(name);
            fs::hard_link(std::env::current_exe().unwrap(), &path).unwrap();
            path.to_str().unwrap().into()
        }
        fn cmake(&self) -> (Value, String) {
            let compiler = self.binary("gcc");
            (
                json!({"gates":[{"executor":{"program":self.binary("cmake"),"args":["--build","build"]}}],
                "toolchainPrograms":[compiler],"outputPaths":["build"]}),
                compiler,
            )
        }
        fn cache(&self, compiler: &str, extra: &str) {
            fs::write(
                self.0.join("build/CMakeCache.txt"),
                format!("CMAKE_C_COMPILER:FILEPATH={compiler}\n{extra}"),
            )
            .unwrap();
        }
        fn ninja_cache(&self, compiler: &str, extra: &str) {
            let root = fs::canonicalize(&self.0).unwrap();
            let ninja = observe_program("ninja").unwrap();
            self.cache(compiler, &format!("CMAKE_GENERATOR:INTERNAL=Ninja\nCMAKE_MAKE_PROGRAM:FILEPATH={}\nCMAKE_HOME_DIRECTORY:INTERNAL={}\n{extra}", ninja.executable.display(), root.display()));
            fs::write(root.join("build/build.ninja"), format!("rule compile\n  command = '{compiler}' -c source.c -o source.o\nbuild source.o: compile source.c\n")).unwrap();
        }
        fn observe(
            &self,
            profile: &Value,
            configured: bool,
        ) -> Result<(String, Vec<Value>), String> {
            observe_toolchains(profile, &self.0, configured)
        }
    }
    impl Drop for ProvenanceFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn configured_cmake_requires_cache_but_initial_configure_does_not() {
        let fixture = ProvenanceFixture::new();
        let (profile, _) = fixture.cmake();
        assert!(fixture.observe(&profile, false).is_ok());
        assert!(
            fixture.observe(&profile, true).is_err(),
            "missing compiler selection must not qualify"
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn apple_cmake_proxy_observes_selected_compiler_before_and_after_configure() {
        let fixture = ProvenanceFixture::new();
        let (mut profile, _) = fixture.cmake();
        profile["toolchainPrograms"] = json!(["/usr/bin/cc"]);
        let before = fixture.observe(&profile, false).unwrap();
        assert!(
            before.1.iter().any(|tool| {
                tool["program"] == "/usr/bin/cc:selected"
                    && tool["executablePath"].as_str().is_some_and(|path| {
                        Path::new(path).is_absolute() && !path.starts_with("/usr/bin/")
                    })
            }),
            "the developer-tool proxy is not the selected compiler"
        );
        fixture.ninja_cache("/usr/bin/cc", "");
        let configured = fixture.observe(&profile, true).unwrap();
        assert_ne!(
            before.0, configured.0,
            "configured graph must add actual selection evidence"
        );
        let selected = before
            .1
            .iter()
            .find(|tool| tool["program"] == "/usr/bin/cc:selected")
            .unwrap();
        fixture.ninja_cache(selected["executablePath"].as_str().unwrap(), "");
        assert!(fixture.observe(&profile, true).is_ok());
    }
    #[test]
    fn cmake_rejects_actual_compiler_outside_declarations() {
        let fixture = ProvenanceFixture::new();
        let (profile, _) = fixture.cmake();
        fixture.cache(&fixture.binary("clang"), "");
        assert!(
            fixture.observe(&profile, true).is_err(),
            "declaring gcc must not attest a different compiler"
        );
    }
    #[test]
    fn configured_cmake_without_observable_build_graph_is_unqualified() {
        let fixture = ProvenanceFixture::new();
        let (profile, compiler) = fixture.cmake();
        fixture.cache(&compiler, "");
        assert!(
            fixture.observe(&profile, true).is_err(),
            "cache alone cannot prove target launcher selection"
        );
    }
    #[cfg(unix)]
    #[test]
    fn real_cmake_ninja_default_build_qualifies_and_target_launcher_is_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = ProvenanceFixture::new();
        let external = ProvenanceFixture::new();
        let cmake = observe_program("cmake").unwrap();
        let compiler = observe_program("cc").unwrap();
        fs::write(fixture.0.join("main.c"), "int main(void) { return 0; }\n").unwrap();
        let project = "cmake_minimum_required(VERSION 3.20)\nproject(provenance LANGUAGES C)\nadd_executable(provenance main.c)\n";
        fs::write(fixture.0.join("CMakeLists.txt"), project).unwrap();
        let configure = || {
            let result = std::process::Command::new(&cmake.executable)
                .current_dir(&fixture.0)
                .args(["-S", ".", "-B", "build", "-G", "Ninja"])
                .arg(format!(
                    "-DCMAKE_C_COMPILER={}",
                    compiler.launcher.display()
                ))
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "CMake fixture configure failed: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        };
        configure();
        let profile = json!({"gates":[{"executor":{"program":"cmake","args":["--build","build"]}}],
            "toolchainPrograms":[compiler.launcher], "outputPaths":["build"]});
        let before = fixture.observe(&profile, true).unwrap();
        let built = std::process::Command::new(&cmake.executable)
            .current_dir(&fixture.0)
            .args(["--build", "build"])
            .output()
            .unwrap();
        assert!(
            built.status.success(),
            "Real Ninja build failed: {}",
            String::from_utf8_lossy(&built.stderr)
        );
        assert!(
            std::process::Command::new(fixture.0.join("build/provenance"))
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(before.0, fixture.observe(&profile, true).unwrap().0);
        let mut custom = profile.clone();
        custom["gates"][0]["executor"]["args"] =
            json!(["--build", "build", "--target", "rebuild_cache"]);
        assert!(fixture.observe(&custom, true).is_err());
        let launcher = external.0.join("compiler-launcher");
        fs::write(&launcher, "#!/bin/sh\nexec \"$@\"\n").unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            fixture.0.join("CMakeLists.txt"),
            format!(
                "{project}set_property(TARGET provenance PROPERTY C_COMPILER_LAUNCHER \"{}\")\n",
                launcher.display()
            ),
        )
        .unwrap();
        configure();
        assert!(
            fixture.observe(&profile, true).is_err(),
            "target launcher was missing from cache but must be observed in effective graph"
        );
    }
    #[test]
    fn generated_command_parser_handles_quoted_paths_and_refuses_shell_indirection() {
        assert_eq!(
            simple_argv("'/compiler path/cc' -DNAME='hello world' -c source.c -o source.o")
                .unwrap(),
            vec![
                "/compiler path/cc",
                "-DNAME=hello world",
                "-c",
                "source.c",
                "-o",
                "source.o"
            ]
        );
        for command in [
            "/cc $(other) -c a.c",
            "/cc `other`",
            "X=1 /cc && /other",
            "/cc @arguments",
            "/cc >output",
            "'/cc",
            "/cc $FLAGS",
        ] {
            assert!(simple_argv(command).is_err(), "accepted {command}");
        }
    }
    #[test]
    fn cmake_selection_between_two_declared_compilers_changes_identity_or_rejects() {
        let fixture = ProvenanceFixture::new();
        let (mut profile, compiler) = fixture.cmake();
        let other = fixture.binary("clang");
        profile["toolchainPrograms"] = json!([compiler, other]);
        fixture.ninja_cache(&compiler, "");
        let first = fixture.observe(&profile, true).unwrap();
        fixture.ninja_cache(&other, "");
        let second = fixture.observe(&profile, true).unwrap();
        assert_ne!(
            first.0, second.0,
            "declared set concealed actual compiler selection"
        );
    }
    #[cfg(unix)]
    #[test]
    fn npm_package_implementation_changes_are_observed() {
        if run_with_clean_node_environment(
            "task_evidence::tests::npm_package_implementation_changes_are_observed",
        ) {
            return;
        }
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = ProvenanceFixture::new();
        let node = fixture.binary("node");
        let package = fixture.0.join("npm-package");
        for name in ["bin", "lib", "node_modules"] {
            fs::create_dir_all(package.join(name)).unwrap();
        }
        fs::write(
            package.join("bin/npm-cli.js"),
            format!("#!{node}\nrequire('../lib/cli.js')(process)\n"),
        )
        .unwrap();
        fs::set_permissions(
            package.join("bin/npm-cli.js"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        fs::write(
            package.join("package.json"),
            r#"{"name":"npm","version":"1.0.0","bin":{"npm":"bin/npm-cli.js"}}"#,
        )
        .unwrap();
        fs::write(package.join("lib/cli.js"), "module.exports = () => 1\n").unwrap();
        let npm = fixture.0.join("npm");
        symlink(package.join("bin/npm-cli.js"), &npm).unwrap();
        let profile = json!({"gates":[{"executor":{"program":npm,"args":["--version"]}}]});
        let before = fixture.observe(&profile, true).unwrap();
        fs::write(package.join("lib/cli.js"), "module.exports = () => 2\n").unwrap();
        let after = fixture.observe(&profile, true).unwrap();
        assert_ne!(
            before.0, after.0,
            "unchanged npm launcher concealed implementation change"
        );
        fs::write(
            package.join("package.json"),
            r#"{"name":"npm","version":"2.0.0","bin":{"npm":"bin/npm-cli.js"}}"#,
        )
        .unwrap();
        assert_ne!(after.0, fixture.observe(&profile, true).unwrap().0);
        let serialized = serde_json::to_string(&after.1).unwrap();
        assert!(serialized.contains("contextWatchTrees"));
        fs::write(package.join("lib/.env"), "secret-canary").unwrap();
        assert!(fixture.observe(&profile, true).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn npm_external_node_module_injection_is_unqualified() {
        const KEY: &str = "VL_NPM_ENVIRONMENT_TEST";
        if std::env::var_os(KEY).is_some() {
            let fixture = ProvenanceFixture::new();
            let node = fixture.binary("node");
            let entry = fixture.0.join("npm");
            fs::write(
                &entry,
                format!("#!{node}\nrequire('../lib/cli.js')(process)\n"),
            )
            .unwrap();
            assert!(observe_npm(&observe_program(entry.to_str().unwrap()).unwrap()).is_err());
            return;
        }
        for name in ["NODE_OPTIONS", "NODE_PATH"] {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "task_evidence::tests::npm_external_node_module_injection_is_unqualified",
                    "--nocapture",
                ])
                .env_remove("NODE_OPTIONS")
                .env_remove("NODE_PATH")
                .env(KEY, "1")
                .env(name, "/unobserved-module")
                .status()
                .unwrap();
            assert!(
                status.success(),
                "{name} must not inject code outside the bounded package"
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn native_cargo_without_resolvable_selection_is_unqualified() {
        const KEY: &str = "VL_COPIED_PROXY_FIXTURE";
        if let Some(root) = std::env::var_os(KEY) {
            let profile = json!({"gates":[{"executor":{"program":"cargo","args":["--version"]}}]});
            assert!(
                observe_toolchains(&profile, Path::new(&root), true).is_err(),
                "native magic must not qualify an opaque cargo proxy"
            );
            return;
        }
        let fixture = ProvenanceFixture::new();
        let cargo = fixture.0.join("cargo");
        let rustup = observe_program("rustup").unwrap();
        fs::copy(rustup.executable, &cargo).unwrap();
        fixture.binary("rustc");
        fs::create_dir(fixture.0.join("home")).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "task_evidence::tests::native_cargo_without_resolvable_selection_is_unqualified",
                "--nocapture",
            ])
            .env_clear()
            .env(KEY, &fixture.0)
            .env("PATH", &fixture.0)
            .env("HOME", fixture.0.join("home"))
            .env("CARGO_HOME", fixture.0.join("home/.cargo"))
            .env("RUSTUP_HOME", fixture.0.join("home/.rustup"))
            .status()
            .unwrap();
        assert!(status.success());
    }
    #[test]
    fn configured_cmake_graph_is_stable_and_ignores_unrelated_cache_values() {
        let fixture = ProvenanceFixture::new();
        let (profile, compiler) = fixture.cmake();
        fixture.ninja_cache(&compiler, "");
        let before = fixture.observe(&profile, true).unwrap();
        fixture.ninja_cache(&compiler, "UNRELATED_TOKEN:STRING=not-provenance\n");
        let after = fixture.observe(&profile, true).unwrap();
        assert_eq!(before.0, after.0);
        assert!(!serde_json::to_string(&after.1)
            .unwrap()
            .contains("not-provenance"));
    }
    #[test]
    fn cmake_rejects_launcher_and_compiler_arg_indirection() {
        let fixture = ProvenanceFixture::new();
        let (profile, compiler) = fixture.cmake();
        for extra in [
            "CMAKE_C_COMPILER_LAUNCHER:STRING=ccache\n",
            "CMAKE_CXX_COMPILER_LAUNCHER:STRING=sccache\n",
            "CMAKE_C_COMPILER_ARG1:STRING=--other-compiler\n",
            "CMAKE_C_LINKER_LAUNCHER:STRING=wrapper\n",
            "RULE_LAUNCH_COMPILE:STRING=wrapper\n",
            "CMAKE_TOOLCHAIN_FILE:FILEPATH=/unknown/toolchain.cmake\n",
        ] {
            fixture.cache(&compiler, extra);
            assert!(fixture.observe(&profile, true).is_err(), "accepted {extra}");
        }
    }
    #[cfg(unix)]
    #[test]
    fn fixed_xcrun_queries_observe_changes_in_selected_binaries() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = ProvenanceFixture::new();
        let resolver = fixture.0.join("xcrun");
        fs::write(&resolver, "#!/bin/sh\n[ \"$#\" = 2 ] && [ \"$1\" = --find ] || exit 2\ncase \"$2\" in cc|c++|clang|clang++|gcc|g++) cat selected-compiler;; *) exit 3;; esac\n").unwrap();
        fs::set_permissions(&resolver, fs::Permissions::from_mode(0o755)).unwrap();
        let first = fixture.binary("compiler-first");
        let second = fixture.binary("compiler-second");
        for compiler in [
            AppleCompiler::Cc,
            AppleCompiler::Cxx,
            AppleCompiler::Clang,
            AppleCompiler::Clangxx,
            AppleCompiler::Gcc,
            AppleCompiler::Gxx,
        ] {
            fs::write(fixture.0.join("selected-compiler"), &first).unwrap();
            let before = selected_apple_compiler(&resolver, &fixture.0, compiler).unwrap();
            fs::write(fixture.0.join("selected-compiler"), &second).unwrap();
            let after = selected_apple_compiler(&resolver, &fixture.0, compiler).unwrap();
            assert_ne!(
                digest_json(&before.value("selected")).unwrap(),
                digest_json(&after.value("selected")).unwrap()
            );
        }
        // Resolving a compiler must not bless a known script wrapper.
        fs::write(
            fixture.0.join("selected-compiler"),
            resolver.to_str().unwrap(),
        )
        .unwrap();
        assert!(selected_apple_compiler(&resolver, &fixture.0, AppleCompiler::Cc).is_err());
        #[cfg(target_os = "macos")]
        {
            fs::write(fixture.0.join("selected-compiler"), "/usr/bin/cc").unwrap();
            assert!(selected_apple_compiler(&resolver, &fixture.0, AppleCompiler::Cc).is_err());
        }
    }
    #[test]
    fn cmake_rejects_an_external_compiler_toolchain() {
        let fixture = ProvenanceFixture::new();
        let (profile, compiler) = fixture.cmake();
        fixture.cache(
            &compiler,
            "CMAKE_C_COMPILER_EXTERNAL_TOOLCHAIN:PATH=/unknown/sdk\n",
        );
        assert!(fixture.observe(&profile, true).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn cmake_cache_symlinks_and_script_compilers_are_unqualified() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = ProvenanceFixture::new();
        let (profile, compiler) = fixture.cmake();
        let other = fixture.0.join("elsewhere.cache");
        fs::write(&other, format!("CMAKE_C_COMPILER:FILEPATH={compiler}\n")).unwrap();
        symlink(&other, fixture.0.join("build/CMakeCache.txt")).unwrap();
        assert!(fixture.observe(&profile, true).is_err());
        fs::remove_file(fixture.0.join("build/CMakeCache.txt")).unwrap();
        let wrapper = fixture.0.join("custom-cc");
        fs::write(&wrapper, "#!/bin/sh\nexec cc \"$@\"\n").unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        fixture.cache(wrapper.to_str().unwrap(), "");
        let mut profile = profile;
        profile["toolchainPrograms"] = json!([wrapper]);
        assert!(fixture.observe(&profile, true).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn selection_probes_reject_failure_oversize_and_timeout_without_returning_output() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = ProvenanceFixture::new();
        let launcher = fixture.0.join("rustup");
        for body in ["printf secret-canary; exit 1", "while :; do printf '0123456789012345678901234567890123456789012345678901234567890123456789'; done", "sleep 30"] {
            fs::write(&launcher, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
            for probe in [SelectionProbe::Cargo, SelectionProbe::Apple(AppleCompiler::Cc)] {
                let start = std::time::Instant::now();
                let error = selection_path(&launcher, &fixture.0, probe).unwrap_err();
                assert!(!error.contains("secret-canary"));
                assert!(start.elapsed() < std::time::Duration::from_secs(12), "probe or owned-tree cleanup did not finish");
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn npm_refuses_unknown_package_layout_even_with_a_native_node_interpreter() {
        if run_with_clean_node_environment("task_evidence::tests::npm_refuses_unknown_package_layout_even_with_a_native_node_interpreter") { return; }
        use std::os::unix::fs::PermissionsExt;
        let fixture = ProvenanceFixture::new();
        let node = fixture.binary("node");
        let npm = fixture.0.join("npm");
        fs::write(&npm, format!("#!{node}\n// npm entry point\n")).unwrap();
        fs::set_permissions(&npm, fs::Permissions::from_mode(0o755)).unwrap();
        let profile = json!({"gates":[{"executor":{"program":npm,"args":["test"]}}]});
        assert!(fixture.observe(&profile, true).is_err());
        let interpreter = observe_npm(&observe_program(npm.to_str().unwrap()).unwrap()).unwrap();
        let canonical_node = fs::canonicalize(&node).unwrap();
        assert_eq!(interpreter.executable, canonical_node);
    }
    #[test]
    fn cargo_configuration_is_not_silently_ignored() {
        let fixture = ProvenanceFixture::new();
        fs::create_dir(fixture.0.join(".cargo")).unwrap();
        fs::write(
            fixture.0.join(".cargo/config.toml"),
            "[build]\nrustc-wrapper = 'unknown-wrapper'\n",
        )
        .unwrap();
        let profile =
            json!({"gates":[{"executor":{"program":fixture.binary("cargo"),"args":["test"]}}]});
        assert!(fixture.observe(&profile, false).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn stable_rustup_launcher_cannot_hide_a_changed_selected_compiler() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = ProvenanceFixture::new();
        fs::create_dir(fixture.0.join("bin")).unwrap();
        let launcher = fixture.0.join("bin/rustup");
        fs::write(&launcher, "#!/bin/sh\n[ \"$1\" = which ] || exit 2\ncase \"$2\" in cargo) printf '%s/cargo-real\\n' \"$PWD\";; rustc) cat selected-compiler;; *) exit 3;; esac\n").unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        symlink(&launcher, fixture.0.join("bin/cargo")).unwrap();
        fixture.binary("cargo-real");
        let first = fixture.binary("rustc-first");
        let second = fixture.binary("rustc-second");
        fs::write(fixture.0.join("selected-compiler"), format!("{first}\n")).unwrap();
        let profile =
            json!({"gates":[{"executor":{"program":fixture.0.join("bin/cargo"),"args":["test"]}}]});
        let before = fixture.observe(&profile, false).unwrap();
        fs::write(fixture.0.join("selected-compiler"), format!("{second}\n")).unwrap();
        match fixture.observe(&profile, true) {
            Ok(after) => assert_ne!(
                before.0, after.0,
                "stable launcher concealed selected compiler change"
            ),
            Err(_) => {}
        }
    }
    #[cfg(unix)]
    #[test]
    fn declared_rustc_hardlink_proxy_records_its_selected_binary() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = ProvenanceFixture::new();
        fs::create_dir(fixture.0.join("bin")).unwrap();
        let launcher = fixture.0.join("bin/rustup");
        fs::write(
            &launcher,
            "#!/bin/sh\n[ \"$1\" = which ] || exit 2\nprintf '%s/%s-real\\n' \"$PWD\" \"$2\"\n",
        )
        .unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        fs::hard_link(&launcher, fixture.0.join("bin/rustc")).unwrap();
        fixture.binary("cargo-real");
        let rustc = fixture.binary("rustc-real");
        let profile = json!({"gates":[],"toolchainPrograms":[fixture.0.join("bin/rustc")]});
        let (_, tools) = fixture.observe(&profile, false).unwrap();
        assert!(tools
            .iter()
            .any(|tool| tool["executablePath"] == json!(fs::canonicalize(&rustc).unwrap())));
    }
    #[cfg(unix)]
    #[test]
    fn rustup_resolver_refuses_sensitive_symlink_targets() {
        use std::os::unix::fs::symlink;
        let fixture = ProvenanceFixture::new();
        let cargo = fixture.binary("cargo");
        fs::write(fixture.0.join(".env"), "secret-canary").unwrap();
        symlink(fixture.0.join(".env"), fixture.0.join("rustup")).unwrap();
        let tool = observe_program(&cargo).unwrap();
        assert!(
            rustup_resolver(&tool).is_err(),
            "resolver aliases must be rejected before fingerprinting a secret"
        );
    }
    #[test]
    fn missing_required_check_cannot_be_ready() {
        let gates = json!({"gates":[{"id":"build","required":true},{"id":"unit","required":true}]});
        let outcome = assess_checks(&gates, &[json!({"gateId":"build","status":"pass"})]);
        assert_eq!(outcome.missing.len(), 1);
        assert!(outcome.blocked.is_empty());
    }
    #[test]
    fn failed_required_check_blocks_even_when_summary_claims_pass() {
        let gates = json!({"gates":[{"id":"build","required":true}]});
        let outcome = assess_checks(&gates, &[json!({"gateId":"build","status":"fail"})]);
        assert_eq!(outcome.blocked.len(), 1);
    }
    #[test]
    fn optional_failure_is_warning_and_required_warn_is_not_pass() {
        let gates =
            json!({"gates":[{"id":"build","required":true},{"id":"lint","required":false}]});
        let outcome = assess_checks(
            &gates,
            &[
                json!({"gateId":"build","status":"pass"}),
                json!({"gateId":"lint","status":"fail"}),
            ],
        );
        assert!(outcome.missing.is_empty());
        assert!(outcome.blocked.is_empty());
        assert_eq!(outcome.warnings.len(), 1);
        let outcome = assess_checks(&gates, &[json!({"gateId":"build","status":"warn"})]);
        assert!(!outcome.missing.is_empty());
    }
    #[test]
    fn duplicate_unknown_or_empty_checks_never_qualify() {
        let gates = json!({"gates":[{"id":"build","required":true}]});
        let duplicate = assess_checks(
            &gates,
            &[
                json!({"gateId":"build","status":"pass"}),
                json!({"gateId":"build","status":"pass"}),
            ],
        );
        assert!(!duplicate.blocked.is_empty());
        assert!(!assess_checks(&json!({"gates":[]}), &[]).missing.is_empty());
        assert!(
            !assess_checks(&gates, &[json!({"gateId":"unexpected","status":"pass"})])
                .blocked
                .is_empty()
        );
    }
    #[test]
    fn profile_digest_is_stable_for_object_order_but_not_requiredness() {
        let a: serde_json::Value =
            serde_json::from_str(r#"{"id":"p","gates":[{"id":"x","required":true}]}"#).unwrap();
        let b: serde_json::Value =
            serde_json::from_str(r#"{"gates":[{"required":true,"id":"x"}],"id":"p"}"#).unwrap();
        assert_eq!(digest_json(&a).unwrap(), digest_json(&b).unwrap());
        let c = json!({"id":"p","gates":[{"id":"x","required":false}]});
        assert_ne!(digest_json(&a).unwrap(), digest_json(&c).unwrap());
    }
    #[test]
    fn artifact_integrity_requires_matching_digest_under_managed_store() {
        let root = std::env::temp_dir().join(format!(
            "vl-artifact-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("output.log");
        std::fs::write(&path, b"abc").unwrap();
        let artifact = json!({"path":path.to_str().unwrap(),"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","sizeBytes":3});
        assert!(verify_artifacts(&root, &[artifact.clone()]).is_ok());
        std::fs::write(&path, b"def").unwrap();
        assert!(verify_artifacts(&root, &[artifact]).is_err());
        assert!(
            verify_artifacts(&root, &[json!({"path":"/outside/output.log","sha256":"a"})]).is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
