mod execution;
mod git;
mod github;
mod watch;

use execution::{
    process_spawn, process_stop, terminal_resize, terminal_spawn, terminal_stop,
    terminal_write, ProcessManager, TerminalManager,
};
use git::{create_worktree, git_diff, inspect_repository, remove_worktree};
use github::{github_capabilities, github_context, github_post_review_comment};
use watch::{watch_start, watch_stop, WatchManager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TerminalManager::default())
        .manage(ProcessManager::default())
        .manage(WatchManager::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_repository,
            git_diff,
            github_capabilities,
            github_context,
            github_post_review_comment,
            create_worktree,
            remove_worktree,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_stop,
            process_spawn,
            process_stop,
            watch_start,
            watch_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running VirtualLab");
}
