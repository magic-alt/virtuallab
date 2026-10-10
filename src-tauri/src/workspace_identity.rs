//! Canonical native filesystem identity for exclusive agent ownership.
 //! This is not a permission boundary by itself: executable authorization
 //! remains separate from filesystem path identity.
use std::path::PathBuf;

/// Preserve case on Unix (including case-sensitive APFS). Resolve existing
/// symlinks so two spellings of the same worktree cannot start two harnesses.
pub(crate) fn key(path: &str) -> String {
    let stripped = path.trim_end_matches(|ch| ch == '/' || ch == '\\');
    let effective = if stripped.is_empty() { path } else { stripped };
    let canonical = std::fs::canonicalize(effective)
        .unwrap_or_else(|_| PathBuf::from(effective));
    let slashed = canonical.to_string_lossy().replace('\\', "/");
    let normalized = if slashed == "/" { slashed } else { slashed.trim_end_matches('/').to_string() };
    if cfg!(windows) { normalized.to_lowercase() } else { normalized }
}

#[cfg(test)]
mod tests {
    use super::key;
    #[test]
    fn keys_follow_platform_case_rules() {
        #[cfg(windows)]
        assert_eq!(key("C:\\Project\\Repo\\"), key("c:/project/repo"));
        #[cfg(unix)]
        assert_ne!(key("/uncreated-virtuallab/Repo"), key("/uncreated-virtuallab/repo"));
    }
    #[cfg(unix)]
    #[test]
    fn symlink_aliases_share_one_existing_workspace_identity() {
        use std::{fs, os::unix::fs::symlink, time::{SystemTime, UNIX_EPOCH}};
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("virtuallab-identity-{}-{unique}", std::process::id()));
        let actual = base.join("actual");
        let alias = base.join("alias");
        fs::create_dir_all(&actual).unwrap();
        symlink(&actual, &alias).unwrap();
        assert_eq!(key(actual.to_str().unwrap()), key(alias.to_str().unwrap()));
        fs::remove_file(alias).unwrap();
        fs::remove_dir_all(base).unwrap();
    }
}
