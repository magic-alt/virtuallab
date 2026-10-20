//! Qualified built-in Git EOL rules. No conversion command or filter is run.
//!
//! Semantics checked against Git v2.51.1 convert.c: convert_attrs,
//! gather_stats/convert_is_binary, has_crlf_in_index and crlf_to_git.
//! https://github.com/git/git/blob/v2.51.1/convert.c
use super::{git, index_git, read_bounded_source};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::{self, File}, path::{Path, PathBuf}, thread};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AutoCrlf { False, True, Input }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Text { Unspecified, Binary, Auto, Required }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SafeCrlf { False, Warn, True }
#[derive(Clone, Debug, PartialEq, Eq)]
struct Config {
    autocrlf: AutoCrlf,
    output_crlf: bool,
    eol: String,
    safecrlf: SafeCrlf,
    attributes_file: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Attributes { text: Text, output_crlf: Option<bool> }
impl Default for Attributes {
    fn default() -> Self { Self { text: Text::Unspecified, output_crlf: None } }
}
#[derive(Clone, Copy, Debug)]
struct Action { text: Text, output_crlf: bool }

#[derive(Clone, Debug, PartialEq, Eq)]
struct AttributeSources {
    external: String,
    working: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Policy {
    config: Config,
    working: BTreeMap<String, Attributes>,
    cached: BTreeMap<String, Attributes>,
    indexed_crlf: BTreeSet<String>,
    sources: AttributeSources,
}

fn config_value(root: &Path, key: &str, default: &str) -> Result<String, String> {
    Ok(git(root, &["config", &format!("--default={default}"), "--get", key])?
        .trim().to_string())
}
fn config_bool(root: &Path, key: &str) -> Result<bool, String> {
    let value = git(root, &["config", "--type=bool", "--default=false", "--get", key])
        .map_err(|_| format!("Git {key} is not a valid qualified boolean setting"))?;
    match value.trim() {
        "false" => Ok(false), "true" => Ok(true),
        _ => Err(format!("Git {key} could not be qualified")),
    }
}
fn configuration_eol(root: &Path) -> Result<(AutoCrlf, bool, String), String> {
    let autocrlf = if config_value(root, "core.autocrlf", "false")?.eq_ignore_ascii_case("input") {
        AutoCrlf::Input
    } else if config_bool(root, "core.autocrlf")? { AutoCrlf::True } else { AutoCrlf::False };
    let eol = config_value(root, "core.eol", "native")?;
    let default_crlf = match eol.as_str() {
        "lf" => false, "crlf" => true, "native" => cfg!(windows),
        _ => return Err("Git core.eol must be lf, crlf or native for automatic qualification".into()),
    };
    let output_crlf = match autocrlf {
        AutoCrlf::True => true, AutoCrlf::Input => false, AutoCrlf::False => default_crlf,
    };
    Ok((autocrlf, output_crlf, eol))
}
fn configuration_safety(root: &Path) -> Result<(SafeCrlf, String), String> {
    let safecrlf = if config_value(root, "core.safecrlf", "false")?.eq_ignore_ascii_case("warn") {
        SafeCrlf::Warn
    } else if config_bool(root, "core.safecrlf")? { SafeCrlf::True } else { SafeCrlf::False };
    Ok((safecrlf, config_value(root, "core.attributesFile", "")?))
}

fn attributes(root: &Path, names: &BTreeSet<String>, cached: bool, index: Option<&Path>)
    -> Result<BTreeMap<String, Attributes>, String>
{
    let mut result: BTreeMap<_, _> = names.iter().map(|name| (name.clone(), Attributes::default())).collect();
    let paths: Vec<_> = names.iter().map(String::as_str).collect();
    for chunk in paths.chunks(16) {
        let mut args = vec!["check-attr", "-z"];
        if cached { args.push("--cached"); }
        args.extend(["--all", "--"]);
        args.extend(chunk.iter().copied());
        let output = match index { Some(index) => index_git(root, index, &args)?, None => git(root, &args)? };
        let fields: Vec<_> = output.split_terminator('\0').collect();
        if fields.len() % 3 != 0 { return Err("Git input attributes could not be qualified".into()); }
        let mut seen = BTreeSet::new();
        for entry in fields.chunks_exact(3) {
            if !chunk.contains(&entry[0]) || !seen.insert((entry[0], entry[1])) {
                return Err("Git returned ambiguous input attributes".into());
            }
            let value = result.get_mut(entry[0]).ok_or("Git returned an unexpected attribute path")?;
            let unsupported = || format!("Git input attribute {} on {} is unsupported; only built-in text/eol conversions are qualified", entry[1], entry[0]);
            match entry[1] {
                "text" => value.text = match entry[2] {
                    "unspecified" => Text::Unspecified, "unset" => Text::Binary,
                    "set" => Text::Required, "auto" => Text::Auto,
                    _ => return Err(unsupported()),
                },
                "eol" => value.output_crlf = match entry[2] {
                    "unspecified" | "unset" => None, "lf" => Some(false), "crlf" => Some(true),
                    _ => return Err(unsupported()),
                },
                "filter" | "ident" | "working-tree-encoding" => {
                    if !matches!(entry[2], "unset" | "unspecified") { return Err(unsupported()); }
                }
                // Even -crlf is a meaningful legacy rule. Do not accidentally
                // treat it as an absent rule when core.autocrlf is active.
                "crlf" => if entry[2] != "unspecified" { return Err(unsupported()); },
                // Attributes unrelated to input bytes (diff, linguist, etc.)
                // neither authorize a conversion nor need a special policy.
                _ => {},
            }
        }
    }
    Ok(result)
}

fn attribute_source(path: &Path, workspace: Option<&Path>, total: &mut u64) -> Result<Option<String>, String> {
    let before = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Git attribute source metadata is unavailable".into()),
    };
    if !before.is_file() || before.file_type().is_symlink() {
        return Err("Git attribute sources must be bounded regular files, not symlinks; review attribute policy manually".into());
    }
    let canonical = fs::canonicalize(path).map_err(|_| "Git attribute source identity is unavailable")?;
    if workspace.is_some_and(|root| !canonical.starts_with(root)) {
        return Err("Working Git attribute source escapes the selected workspace".into());
    }
    let file = File::open(path).map_err(|_| "Git attribute source bytes are unavailable")?;
    let opened = file.metadata().map_err(|_| "Git attribute source identity is unavailable")?;
    if !opened.is_file() || opened.len() != before.len() || opened.modified().ok() != before.modified().ok() {
        return Err("Git attribute source changed during observation".into());
    }
    let bytes = read_bounded_source(file, total)
        .map_err(|_| "Git attribute sources exceed the bounded qualification size")?;
    let after = fs::symlink_metadata(path).map_err(|_| "Git attribute source changed during observation")?;
    if !after.is_file() || after.file_type().is_symlink()
        || before.len() != after.len() || before.modified().ok() != after.modified().ok()
        || fs::canonicalize(path).map_err(|_| "Git attribute source identity is unavailable")? != canonical
    {
        return Err("Git attribute source changed during observation".into());
    }
    let mut hash = Sha256::new();
    hash.update(canonical.as_os_str().as_encoded_bytes());
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
    Ok(Some(format!("{:x}", hash.finalize())))
}

fn attribute_sources(root: &Path, names: &BTreeSet<String>) -> Result<AttributeSources, String> {
    let mut total = 0;
    let mut external = Sha256::new();
    for variable in ["GIT_ATTR_SYSTEM", "GIT_ATTR_GLOBAL", "info/attributes"] {
        let output = if variable == "info/attributes" {
            git(root, &["rev-parse", "--path-format=absolute", "--git-path", variable])?
        } else {
            git(root, &["var", variable]).map_err(|_| format!(
                "Git must expose {variable} for task input qualification; inspect local Git capabilities or use manual candidate review"
            ))?
        };
        external.update(variable.as_bytes());
        external.update((output.len() as u64).to_le_bytes());
        external.update(output.as_bytes());
        // Git resolves the configured/default locations itself, including
        // Windows and XDG paths. No complete configuration dump is requested.
        let paths: Vec<_> = output.split_terminator('\n').filter(|path| !path.is_empty()).collect();
        if paths.len() > 16 { return Err("Git attribute source inventory exceeds its bound".into()); }
        for value in paths {
            let value = value.strip_suffix('\r').unwrap_or(value);
            if value.len() > 4096 || value.chars().any(char::is_control) {
                return Err("Git attribute source path is not qualified".into());
            }
            let path = PathBuf::from(value);
            let path = if path.is_absolute() { path } else { root.join(path) };
            external.update(attribute_source(&path, None, &mut total)?.as_deref().unwrap_or("missing").as_bytes());
        }
    }
    let canonical_root = fs::canonicalize(root).map_err(|_| "Git attribute workspace is unavailable")?;
    let mut paths = BTreeSet::new();
    for name in names {
        for parent in Path::new(name).ancestors().skip(1) {
            let name = parent.join(".gitattributes").to_str()
                .ok_or("Git attribute source path is not Unicode")?.replace('\\', "/");
            paths.insert(name);
            if paths.len() > 20_000 { return Err("Git attribute source inventory exceeds 20000 files".into()); }
        }
    }
    let mut working = BTreeMap::new();
    for name in paths {
        // Ignored nested .gitattributes still affects tracked sources and must
        // carry its own scope identity. Absent paths are not treated as edits.
        if let Some(identity) = attribute_source(&root.join(&name), Some(&canonical_root), &mut total)? {
            working.insert(name, identity);
        }
    }
    Ok(AttributeSources { external: format!("{:x}", external.finalize()), working })
}

fn indexed_eol(root: &Path, index: Option<&Path>) -> Result<BTreeSet<String>, String> {
    let mut indexed_crlf = BTreeSet::new();
    // This plumbing command classifies immutable indexed blobs without clean,
    // smudge or textconv execution. i/-text also covers binary blobs with CRLF.
    let args = &["ls-files", "--cached", "--eol", "-z"];
    let output = match index { Some(index) => index_git(root, index, args)?, None => git(root, args)? };
    for entry in output.split_terminator('\0') {
        let (metadata, name) = entry.split_once('\t').ok_or("Indexed EOL metadata unavailable")?;
        let kind = metadata.split_whitespace().next().and_then(|field| field.strip_prefix("i/"))
            .ok_or("Indexed EOL identity unavailable")?;
        match kind {
            "crlf" | "mixed" => { indexed_crlf.insert(name.to_string()); },
            "lf" | "none" | "-text" => {},
            _ => return Err("Indexed EOL content is not qualified".into()),
        }
    }
    Ok(indexed_crlf)
}

fn worker_result<T>(result: thread::Result<Result<T, String>>) -> Result<T, String> {
    result.map_err(|_| "Git conversion observation worker failed".to_owned())?
}

fn observe_index(root: &Path, names: &BTreeSet<String>, index: Option<&Path>) -> Result<Policy, String> {
    // Exactly six independent read-only probes, regardless of file count.
    // Each configuration worker runs at most three unchanged Git commands.
    // Join every worker before propagating an error. The caller repeats and
    // compares the complete policy around the immutable source capture.
    let (eol_config, safety_config, working, cached, indexed_crlf, sources) = thread::scope(|workers| {
        let eol_config = workers.spawn(|| configuration_eol(root));
        let safety_config = workers.spawn(|| configuration_safety(root));
        let working = workers.spawn(|| attributes(root, names, false, index));
        let cached = workers.spawn(|| attributes(root, names, true, index));
        let indexed_crlf = workers.spawn(|| indexed_eol(root, index));
        let sources = workers.spawn(|| attribute_sources(root, names));
        (eol_config.join(), safety_config.join(), working.join(), cached.join(), indexed_crlf.join(), sources.join())
    });
    let (autocrlf, output_crlf, eol) = worker_result(eol_config)?;
    let (safecrlf, attributes_file) = worker_result(safety_config)?;
    let config = Config { autocrlf, output_crlf, eol, safecrlf, attributes_file };
    Ok(Policy { config, working: worker_result(working)?,
        cached: worker_result(cached)?, indexed_crlf: worker_result(indexed_crlf)?, sources: worker_result(sources)? })
}

pub(super) fn observe(root: &Path, names: &BTreeSet<String>) -> Result<Policy, String> {
    observe_index(root, names, None)
}

pub(super) fn observe_candidate(root: &Path, index: &Path, names: &BTreeSet<String>) -> Result<Policy, String> {
    observe_index(root, names, Some(index))
}

impl Policy {
    fn action(&self, name: &str) -> Action {
        let attrs = &self.working[name];
        let text = match (attrs.text, attrs.output_crlf, self.config.autocrlf) {
            (Text::Binary, _, _) => Text::Binary,
            (Text::Unspecified, Some(_), _) => Text::Required,
            (Text::Unspecified, None, AutoCrlf::False) => Text::Binary,
            (Text::Unspecified, None, _) => Text::Auto,
            (text, _, _) => text,
        };
        Action { text, output_crlf: attrs.output_crlf.unwrap_or(self.config.output_crlf) }
    }
    pub(super) fn config_fingerprint(&self) -> String {
        format!("{:x}", Sha256::digest(format!("{:?}", self.config).as_bytes()))
    }
    pub(super) fn external_fingerprint(&self) -> String { self.sources.external.clone() }
    pub(super) fn working_sources(&self) -> BTreeMap<String, String> { self.sources.working.clone() }
    pub(super) fn file_fingerprints(&self) -> BTreeMap<String, String> {
        self.working.iter().map(|(name, working)| {
            // Indexed blob classification belongs to the full observation,
            // not to the provider's external attribute-policy baseline.
            let value = format!("{working:?}|{:?}", self.cached[name]);
            (name.clone(), format!("{:x}", Sha256::digest(value.as_bytes())))
        }).collect()
    }
    pub(super) fn fingerprint(&self) -> String {
        format!("{:x}", Sha256::digest(format!("{self:?}").as_bytes()))
    }
    pub(super) fn canonicalize(&self, name: &str, bytes: &[u8]) -> (Vec<u8>, bool) {
        let action = self.action(name);
        let stats = Stats::read(bytes);
        let convert = stats.crlf != 0 && match action.text {
            Text::Required => true,
            Text::Auto => !stats.binary() && !self.indexed_crlf.contains(name),
            Text::Binary | Text::Unspecified => false,
        };
        let canonical = if convert {
            bytes.iter().enumerate().filter_map(|(index, byte)| {
                if *byte == b'\r' && bytes.get(index + 1) == Some(&b'\n') { None } else { Some(*byte) }
            }).collect()
        } else { bytes.to_vec() };
        // Match Git's round-trip simulation. Recounting canonical bytes can
        // reclassify an adjacent lone CR (for example CR CR LF) and incorrectly
        // waive core.safecrlf even though a CRLF pair was removed.
        let mut checkout = stats;
        if convert {
            checkout.lonelf += checkout.crlf;
            checkout.crlf = 0;
        }
        if action.text != Text::Binary && action.output_crlf && checkout.lonelf != 0
            && (action.text != Text::Auto || (checkout.crlf == 0 && !checkout.binary()))
        {
            checkout.crlf += checkout.lonelf;
            checkout.lonelf = 0;
        }
        let reversible = !(stats.crlf != 0 && checkout.crlf == 0
            || stats.lonelf != 0 && checkout.lonelf == 0);
        (canonical, self.config.safecrlf != SafeCrlf::True || reversible)
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Stats { nul: usize, lonecr: usize, lonelf: usize, crlf: usize, printable: usize, nonprintable: usize }
impl Stats {
    fn read(bytes: &[u8]) -> Self {
        let mut stats = Self::default();
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'\r' if bytes.get(index + 1) == Some(&b'\n') => { stats.crlf += 1; index += 1; },
                b'\r' => stats.lonecr += 1,
                b'\n' => stats.lonelf += 1,
                8 | 9 | 27 | 12 => stats.printable += 1,
                0 => { stats.nul += 1; stats.nonprintable += 1; },
                1..=31 | 127 => stats.nonprintable += 1,
                _ => stats.printable += 1,
            }
            index += 1;
        }
        if bytes.last() == Some(&26) { stats.nonprintable -= 1; }
        stats
    }
    fn binary(&self) -> bool { self.nul != 0 || self.lonecr != 0 || (self.printable >> 7) < self.nonprintable }
}
