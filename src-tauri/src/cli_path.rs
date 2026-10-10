//! Shared executable lookup for GUI launches; no login shell is evaluated.
use std::path::{Path, PathBuf};
pub(crate) fn find_executable(program: &Path, directories: &[PathBuf]) -> Option<PathBuf> {
    if program.is_absolute() || program.components().count() != 1 {
        return executable(program).then(|| program.to_path_buf());
    }
    directories.iter().filter(|directory| !directory.as_os_str().is_empty())
        .filter_map(|directory| std::path::absolute(directory).ok())
        .map(|directory| directory.join(program)).find(|candidate| executable(candidate))
}
fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else { return false; };
    if !metadata.is_file() { return false; }
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; metadata.permissions().mode() & 0o111 != 0 }
    #[cfg(not(unix))] { true }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_precedes_fallback_and_explicit_paths_never_use_fallback() {
        let root = std::env::temp_dir().join(format!("virtuallab cli 中文 {}", std::process::id()));
        let first = root.join("path"); let fallback = root.join("fallback");
        for dir in [&first, &fallback] {
            std::fs::create_dir_all(dir).unwrap();
            let file = dir.join("tool"); std::fs::write(&file, b"fixture").unwrap();
            #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap(); }
        }
        let dirs = [first.clone(), fallback.clone()];
        assert_eq!(find_executable(Path::new("tool"), &dirs), Some(first.join("tool")));
        std::fs::remove_file(first.join("tool")).unwrap();
        assert_eq!(find_executable(Path::new("tool"), &dirs), Some(fallback.join("tool")));
        assert_eq!(find_executable(&root.join("missing/tool"), &dirs), None);
        assert_eq!(find_executable(&fallback.join("tool"), &dirs), Some(fallback.join("tool")));
        assert_eq!(find_executable(Path::new("missing"), &dirs), None);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn relative_search_directory_selects_stable_absolute_executable() {
        let relative = PathBuf::from(format!(".cli-relative-fixture-{}", std::process::id()));
        std::fs::create_dir_all(&relative).unwrap();
        let file = relative.join("tool"); std::fs::write(&file, b"fixture").unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap(); }
        let selected = find_executable(Path::new("tool"), &[relative.clone()]).unwrap();
        assert_eq!(selected, std::env::current_dir().unwrap().join(&file));
        std::fs::remove_dir_all(relative).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn non_executable_files_and_directories_are_not_launchers() {
        let root = std::env::temp_dir().join(format!("virtuallab cli permissions {}", std::process::id()));
        std::fs::create_dir_all(root.join("tool")).unwrap();
        assert!(find_executable(Path::new("tool"), &[root.clone()]).is_none());
        let file = root.join("plain"); std::fs::write(&file, b"text").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(find_executable(Path::new("plain"), &[root.clone()]).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
