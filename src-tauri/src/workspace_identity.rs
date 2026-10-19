//! Canonical native filesystem identity for exclusive agent ownership.
 //! This is not a permission boundary by itself: executable authorization
 //! remains separate from filesystem path identity.
use std::path::PathBuf;

/// Preserve case and literal backslashes on Unix (including case-sensitive
/// APFS). Resolve existing symlinks so aliases cannot start two harnesses.
pub(crate) fn key(path: &str) -> String {
    let stripped = path.trim_end_matches(|ch| ch == '/' || (cfg!(windows) && ch == '\\'));
    let effective = if stripped.is_empty() { path } else { stripped };
    let canonical = std::fs::canonicalize(effective)
        .unwrap_or_else(|_| PathBuf::from(effective));
    #[cfg(windows)]
    let slashed = canonical.to_string_lossy().replace('\\', "/");
    #[cfg(not(windows))]
    let slashed = canonical.to_string_lossy().into_owned();
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

    #[cfg(unix)]
    fn assert_distinct_directories(first: &str, second: &str) {
        use std::{fs, time::{SystemTime, UNIX_EPOCH}};
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("virtuallab-literal-identity-{}-{unique}", std::process::id()));
        let first = base.join(first);
        let second = base.join(second);
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let first_path = fs::canonicalize(&first).unwrap();
        let second_path = fs::canonicalize(&second).unwrap();
        let first_key = key(first.to_str().unwrap());
        let second_key = key(second.to_str().unwrap());
        fs::remove_dir_all(base).unwrap();
        assert_ne!(first_path, second_path, "fixture must create distinct directories");
        assert_ne!(first_key, second_key, "distinct Unix directories must not share an agent owner or journal key");
        assert_eq!(first_key, first_path.to_string_lossy());
    }

    #[cfg(unix)]
    #[test]
    fn literal_backslash_does_not_become_a_unix_directory_separator() {
        assert_distinct_directories("literal\\child", "literal/child");
    }

    #[cfg(unix)]
    #[test]
    fn trailing_backslash_remains_part_of_the_unix_directory_name() {
        assert_distinct_directories("trailing\\", "trailing");
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
        symlink(&actual, &alias).unwrap();
        assert_eq!(key(actual.to_str().unwrap()), key(alias.to_str().unwrap()));
        fs::remove_file(alias).unwrap();
        fs::remove_dir_all(base).unwrap();
    }
}
