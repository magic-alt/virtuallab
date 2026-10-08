mod agent;
mod execution;
mod hardware;
mod verification;
mod git;
mod github;
mod watch;

use agent::{
    agent_harness_capabilities, agent_session_start, agent_session_stop, agent_turn_interrupt,
    agent_turn_start, agent_turn_steer, AgentManager,
};
use execution::{
    process_spawn, process_stop, terminal_resize, terminal_spawn, terminal_stop,
    terminal_write, ProcessManager, TerminalManager,
};
use git::{create_worktree, git_diff, inspect_repository, remove_worktree};
use github::{github_capabilities, github_context, github_post_review_comment};
use watch::{watch_start, watch_stop, WatchManager};
use verification::{verification_cancel,verification_import_artifact,verification_run,VerificationManager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TerminalManager::default())
        .manage(ProcessManager::default())
        .manage(WatchManager::default())
        .manage(AgentManager::default())
        .manage(VerificationManager::default())
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
            agent_harness_capabilities,
            agent_session_start,
            agent_session_stop,
            agent_turn_start,
            agent_turn_steer,
            agent_turn_interrupt,
            verification_run,
            verification_cancel,
            verification_import_artifact,
        ])
        .run(tauri::generate_context!())
        .expect("error while running VirtualLab");
}
