#[path = "build_metadata.rs"]
mod build_metadata;
use std::{fs, path::Path, process::Command, time::{SystemTime, UNIX_EPOCH}};
fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "git fixture failed");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
#[test]
fn records_commits_dirty_states_detached_heads_and_linked_worktrees() {
    let root = std::env::temp_dir().join(format!("vl build metadata {} {}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-b", "fixture"]);
    fs::write(root.join("source.txt"), "initial").unwrap();
    git(&root, &["add", "source.txt"]);
    git(&root, &["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
    let expected = git(&root, &["rev-parse", "HEAD"]);
    let clean = build_metadata::collect_git_metadata(&root);
    assert_eq!(clean.commit.as_deref(), Some(expected.as_str()));
    assert_eq!(clean.branch.as_deref(), Some("fixture"));
    assert_eq!(clean.dirty, Some(false));
    fs::write(root.join("source.txt"), "edited").unwrap();
    assert_eq!(build_metadata::collect_git_metadata(&root).dirty, Some(true));
    git(&root, &["add", "source.txt"]);
    assert_eq!(build_metadata::collect_git_metadata(&root).dirty, Some(true));
    git(&root, &["restore", "--staged", "--worktree", "source.txt"]);
    fs::write(root.join("new.txt"), "untracked").unwrap();
    assert_eq!(build_metadata::collect_git_metadata(&root).dirty, Some(true));
    git(&root, &["checkout", "--detach"]);
    assert_eq!(build_metadata::collect_git_metadata(&root).branch.as_deref(), Some("detached HEAD"));
    let linked = root.join("linked worktree");
    git(&root, &["worktree", "add", "-b", "linked", linked.to_str().unwrap()]);
    let info = build_metadata::collect_git_metadata(&linked);
    assert_eq!(info.commit.as_deref(), Some(expected.as_str()));
    assert_eq!(info.branch.as_deref(), Some("linked"));
    assert_eq!(info.dirty, Some(false));
    let archive = root.join("archive without git");
    fs::create_dir(&archive).unwrap();
    assert!(build_metadata::collect_git_metadata(&archive).commit.is_none());
    git(&root, &["worktree", "remove", linked.to_str().unwrap()]);
    // This test owns this unique temporary directory in its entirety.
    fs::remove_dir_all(&root).unwrap();
}
