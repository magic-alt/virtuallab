//! Canonical native filesystem identity for exclusive agent ownership.
 //! This is not a permission boundary by itself: executable authorization
 //! remains separate from filesystem path identity.
use std::path::PathBuf;

/// Directory ownership includes descendants, but never a sibling sharing a
/// textual prefix. Use the same canonical/case rules as exact identity.
pub(crate) fn contains(root: &str, path: &str) -> bool {
    contains_key(&key(root), &key(path))
}

pub(crate) fn contains_key(root: &str, path: &str) -> bool {
    root == path || path.strip_prefix(root).is_some_and(|suffix|
        suffix.starts_with('/') || (root == "/" && !suffix.is_empty()))
}

/// Preserve case on Unix (including case-sensitive APFS). Resolve existing
/// symlinks so two spellings of the same worktree cannot start two harnesses.
pub(crate) fn key(path: &str) -> String {
    let stripped = path.trim_end_matches(|ch| ch == '/' || ch == '\\');
    let effective = if stripped.is_empty() { path } else { stripped };
    let canonical = std::fs::canonicalize(effective)
        .unwrap_or_else(|_| PathBuf::from(effective));
    let slashed = canonical.to_string_lossy().replace('\\', "/");
    // canonicalize adds a Windows verbatim prefix; aliases using ordinary
    // drive/UNC spelling must still identify the same workspace.
    #[cfg(windows)]
    let slashed = slashed.strip_prefix("//?/UNC/").map(|path| format!("//{path}"))
        .or_else(|| slashed.strip_prefix("//?/").map(str::to_owned)).unwrap_or(slashed);
    let normalized = if slashed == "/" { slashed } else { slashed.trim_end_matches('/').to_string() };
    if cfg!(windows) { normalized.to_lowercase() } else { normalized }
}

#[cfg(test)]
mod tests {
    use super::key;
    #[test]
    fn directory_ownership_respects_component_boundaries() {
        for (root, path, expected) in [
            ("/repo/workspace", "/repo/workspace", true),
            ("/repo/workspace/", "/repo/workspace/build/output", true),
            ("/repo/workspace", "/repo/workspace-other/build", false),
            ("/repo/workspace/build", "/repo/workspace", false),
        ] {
            assert_eq!(super::contains(root, path), expected, "{root} vs {path}");
        }
        assert!(super::contains_key("/", "/repo"));
        #[cfg(windows)] {
            assert!(super::contains("C:\\Repos\\Feature", "c:/repos/feature/build"));
            assert!(super::contains("\\\\host\\share\\repo", "//HOST/share/repo/build"));
        }
    }
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
        fs::create_dir(actual.join("build")).unwrap();
        symlink(&actual, &alias).unwrap();
        assert_eq!(key(actual.to_str().unwrap()), key(alias.to_str().unwrap()));
        assert!(super::contains(alias.to_str().unwrap(), actual.join("build").to_str().unwrap()));
        assert!(super::contains(actual.to_str().unwrap(), alias.join("build").to_str().unwrap()));
        fs::remove_file(alias).unwrap();
        fs::remove_dir_all(base).unwrap();
    }
}
