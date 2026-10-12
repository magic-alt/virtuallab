use std::path::{Path, PathBuf};

pub(crate) fn cargo_target_dir(path: &Path) -> PathBuf {
    // Cargo/Tauri permission discovery uses glob patterns. Windows verbatim
    // paths (\\?\...) from canonicalize are not safe inputs to that scanner.
    // Keep canonical paths for native identity checks; adapt only this CLI value.
    #[cfg(windows)]
    {
        use std::{ffi::OsString, path::{Component, Prefix}};
        let mut components = path.components();
        let mut ordinary = match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(drive) => OsString::from(format!("{}:", drive as char)),
                Prefix::VerbatimUNC(server, share) => {
                    let mut prefix = OsString::from(r"\\");
                    prefix.push(server);
                    prefix.push(r"\");
                    prefix.push(share);
                    prefix
                }
                _ => return path.to_path_buf(),
            },
            _ => return path.to_path_buf(),
        };
        ordinary.push(components.as_path());
        PathBuf::from(ordinary)
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn cargo_paths_remove_verbatim_prefix_without_losing_unicode_or_spaces() {
        for (input, expected) in [
            (r"\\?\D:\工程 lab\target", r"D:\工程 lab\target"),
            (r"\\?\UNC\server\share\工程 lab\target", r"\\server\share\工程 lab\target"),
            (r"D:\工程 lab\target", r"D:\工程 lab\target"),
        ] {
            assert_eq!(cargo_target_dir(Path::new(input)), PathBuf::from(expected));
        }
    }
}
