//! App-data configuration only. Saving a library entry never changes an accepted Task.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
const MAX_BYTES: usize = 9 * 1024 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProfileRecord {
    pub id: String,
    pub revision: u64,
    pub profile: Value,
    pub updated_at_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveProfileRequest {
    pub profile: Value,
    pub expected_revision: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Generation {
    schema_version: u32,
    records: Vec<ProfileRecord>,
}
#[derive(Clone)]
pub(crate) struct TaskProfileLibrary {
    path: Arc<PathBuf>,
    state: Arc<Mutex<Generation>>,
    error: Option<Arc<String>>,
}
fn io_error(_: std::io::Error) -> String {
    "Profile storage unavailable; original data preserved. Check permissions and repair explicitly."
        .into()
}
fn regular(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
            Err("Profile storage must be a regular file.".into())
        }
        Ok(m) if m.len() > MAX_BYTES as u64 => Err("Profile storage exceeds 9 MiB.".into()),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(e)),
    }
}
fn validate(g: &Generation) -> Result<(), String> {
    if g.schema_version != 1 || g.records.len() > 128 {
        return Err("Unsupported or oversized Profile library.".into());
    }
    let mut ids = HashSet::new();
    for r in &g.records {
        crate::tasks::validate_profile_definition(&r.profile)?;
        if r.profile.get("id").and_then(Value::as_str) != Some(r.id.as_str())
            || !ids.insert(&r.id)
            || r.revision == 0
            || r.revision > MAX_REVISION
            || r.updated_at_ms > MAX_REVISION
        {
            return Err("Invalid Profile identity or revision.".into());
        }
    }
    Ok(())
}
// Stream into a bounded buffer rather than allocating an oversized full encoding.
fn encode(g: &Generation) -> Result<Vec<u8>, String> {
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            if b.len() > MAX_BYTES.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other("size limit"));
            }
            self.0.extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut out = Bounded(Vec::new());
    serde_json::to_writer(&mut out, g).map_err(|_| "Profile library exceeds 9 MiB.".to_string())?;
    Ok(out.0)
}
fn persist(path: &Path, g: &Generation) -> Result<(), String> {
    validate(g)?;
    let bytes = encode(g)?;
    regular(path)?;
    let parent = path.parent().ok_or("Profile storage parent required.")?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let temporary = parent.join(format!(".profiles-{}.tmp", crate::tasks::new_id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(io_error)?;
        file.write_all(&bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        #[cfg(unix)]
        let directory = {
            let f = File::open(parent).map_err(io_error)?;
            f.sync_all().map_err(io_error)?;
            f
        };
        regular(path)?;
        fs::rename(&temporary, path).map_err(io_error)?;
        #[cfg(unix)]
        {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
impl TaskProfileLibrary {
    /// One manager per application path; clone it for concurrent consumers.
    pub(crate) fn open(path: PathBuf) -> Result<Self, String> {
        if !path.is_absolute() || path.file_name().is_none() {
            return Err("Profile library requires an absolute file path.".into());
        }
        regular(&path)?;
        let generation = match File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(MAX_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(io_error)?;
                if bytes.len() > MAX_BYTES {
                    return Err("Profile library exceeds 9 MiB.".into());
                }
                serde_json::from_slice::<Generation>(&bytes).map_err(|_| {
                    "Corrupt/incompatible Profile library; explicit repair required.".to_string()
                })?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let g = Generation {
                    schema_version: 1,
                    records: vec![],
                };
                persist(&path, &g)?;
                g
            }
            Err(e) => return Err(io_error(e)),
        };
        validate(&generation)?;
        Ok(Self {
            path: Arc::new(path),
            state: Arc::new(Mutex::new(generation)),
            error: None,
        })
    }
    pub(crate) fn unavailable(error: String) -> Self {
        Self {
            path: Arc::new(PathBuf::new()),
            state: Arc::new(Mutex::new(Generation {
                schema_version: 1,
                records: vec![],
            })),
            error: Some(Arc::new(error)),
        }
    }
    fn available(&self) -> Result<(), String> {
        if let Some(error) = &self.error {
            Err(error.to_string())
        } else {
            Ok(())
        }
    }
    pub(crate) fn list(&self) -> Result<Vec<ProfileRecord>, String> {
        self.available()?;
        Ok(self
            .state
            .lock()
            .map_err(|_| "Profile library lock unavailable.")?
            .records
            .clone())
    }
    pub(crate) fn save(&self, request: SaveProfileRequest) -> Result<ProfileRecord, String> {
        self.available()?;
        crate::tasks::validate_profile_definition(&request.profile)?;
        if request
            .expected_revision
            .is_some_and(|r| r == 0 || r > MAX_REVISION)
        {
            return Err("Invalid expected Profile revision.".into());
        }
        let id = request.profile["id"]
            .as_str()
            .ok_or("Profile ID required.")?
            .to_string();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Profile library lock unavailable.")?;
        let existing = state.records.iter().position(|r| r.id == id);
        let revision =
            match (existing, request.expected_revision) {
                (None, None) => 1,
                (Some(i), Some(r)) if state.records[i].revision == r && r < MAX_REVISION => r + 1,
                _ => return Err(
                    "Profile revision conflict. Reload the latest record or copy under a new ID."
                        .into(),
                ),
            };
        let record = ProfileRecord {
            id,
            revision,
            profile: request.profile,
            updated_at_ms: crate::tasks::now_ms(),
        };
        let mut next = state.clone();
        if let Some(i) = existing {
            next.records[i] = record.clone();
        } else {
            next.records.push(record.clone());
        }
        persist(&self.path, &next)?;
        *state = next;
        Ok(record)
    }
}
#[tauri::command]
pub(crate) fn task_profile_list(
    library: tauri::State<'_, TaskProfileLibrary>,
) -> Result<Vec<ProfileRecord>, String> {
    library.list()
}
#[tauri::command]
pub(crate) fn task_profile_save(
    library: tauri::State<'_, TaskProfileLibrary>,
    request: SaveProfileRequest,
) -> Result<ProfileRecord, String> {
    library.save(request)
}
#[cfg(test)]
mod tests;
