use std::{path::Path, process::Command};
#[derive(Debug, Default)]
pub struct GitMetadata {
    pub commit: Option<String>,
    pub branch: Option<String>,
    pub dirty: Option<bool>,
}
fn git(root: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command.current_dir(root).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8(output.stdout).ok()).flatten()
}

pub fn collect_git_metadata(root: &Path) -> GitMetadata {
    // A source archive nested in another checkout must not inherit its identity.
    let same_root = git(root, &["rev-parse", "--show-toplevel"])
        .and_then(|path| Path::new(path.trim()).canonicalize().ok())
        .zip(root.canonicalize().ok())
        .is_some_and(|(git_root, source_root)| git_root == source_root);
    if !same_root { return GitMetadata::default(); }
    let commit = git(root, &["rev-parse", "--verify", "HEAD"])
        .map(|value| value.trim().to_owned());
    let branch = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|value| value.trim().to_owned())
        .or_else(|| commit.as_ref().map(|_| "detached HEAD".to_owned()));
    let dirty = git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
        .map(|value| !value.is_empty());
    GitMetadata { commit, branch, dirty }
}
