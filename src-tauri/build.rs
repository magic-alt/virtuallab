mod build_metadata;

use std::{fs, path::Path, time::{SystemTime, UNIX_EPOCH}};

fn main() {
    // Deliberately absent: refresh even for branch switches, untracked changes
    // and incremental desktop self-builds on every Cargo invocation.
    println!("cargo:rerun-if-changed=build-provenance-refresh");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("source root");
    let git = build_metadata::collect_git_metadata(root);
    let built_at = SystemTime::now().duration_since(UNIX_EPOCH).expect("system clock").as_secs();
    let generated = format!(
        "const GIT_COMMIT: Option<&str> = {:?};\nconst GIT_BRANCH: Option<&str> = {:?};\nconst GIT_DIRTY: Option<bool> = {:?};\nconst BUILT_AT: u64 = {};\n",
        git.commit.as_deref(), git.branch.as_deref(), git.dirty, built_at,
    );
    fs::write(Path::new(&std::env::var_os("OUT_DIR").expect("Cargo output directory")).join("app_build_info.rs"), generated)
        .expect("write build provenance");
    tauri_build::build()
}
