use serde::Serialize;

include!(concat!(env!("OUT_DIR"), "/app_build_info.rs"));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBuildInfo {
    version: &'static str,
    git_commit: Option<&'static str>,
    git_branch: Option<&'static str>,
    git_dirty: Option<bool>,
    built_at_unix_seconds: u64,
    profile: &'static str,
}

/// Returns this executable's compile-time identity; never inspects user workspaces.
#[tauri::command]
pub fn app_build_info() -> AppBuildInfo {
    AppBuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        git_commit: GIT_COMMIT,
        git_branch: GIT_BRANCH,
        git_dirty: GIT_DIRTY,
        built_at_unix_seconds: BUILT_AT,
        profile: if cfg!(debug_assertions) { "debug" } else { "release" },
    }
}
