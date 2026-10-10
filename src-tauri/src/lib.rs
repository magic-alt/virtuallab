mod bounded_lines;
#[cfg(any(target_os = "macos", test))]
mod cli_path;
#[cfg(unix)]
mod terminal_process;
mod managed_process;
mod workspace_identity;
mod run_registry;
use tauri::Manager;
use run_registry::{RunRegistry, list_runs};
mod agent;
mod agent_ownership;
mod agent_cli;
mod execution;
mod build_workflows;
mod hardware;
mod verification;
mod git;
mod github;
mod watch;
mod process;
mod output_decode;

use agent::{
    agent_harness_capabilities, agent_session_start, agent_session_stop, agent_turn_interrupt,
    agent_turn_start, agent_turn_steer, AgentManager,
};
use agent_ownership::AgentOwnership;
use agent_cli::{agent_cli_capabilities, agent_cli_session_start, agent_cli_session_stop, agent_cli_turn_start, agent_cli_turn_interrupt, CliAgentManager};
use build_workflows::{build_workflow_cancel, build_workflow_discover, build_workflow_start, BuildWorkflowManager};
use execution::{
    process_spawn, process_stop, terminal_resize, terminal_spawn, terminal_stop,
    terminal_write, ProcessManager, TerminalManager,
};
use git::{create_worktree, git_delete_local_branch, git_delete_origin_branch, git_diff, git_fetch_origin, git_local_changes, git_pull_current, git_switch_branch, inspect_repository, remove_worktree};
use github::{github_capabilities, github_context, github_list_pull_requests, github_merge_pull_request, github_post_review_comment};
use watch::{watch_start, watch_stop, WatchManager};
use verification::{verification_cancel,verification_import_artifact,verification_run,VerificationManager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TerminalManager::default())
        .manage(ProcessManager::default())
        .manage(RunRegistry::default())
        .manage(BuildWorkflowManager::default())
        .manage(WatchManager::default())
        .manage(AgentManager::default())
        .manage(AgentOwnership::default())
        .manage(CliAgentManager::default())
        .manage(VerificationManager::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_repository,
            git_diff,
            git_switch_branch,
            git_delete_local_branch,
            git_delete_origin_branch,
            git_fetch_origin,
            git_pull_current,
            git_local_changes,
            github_capabilities,
            github_context,
            github_list_pull_requests,
            github_merge_pull_request,
            github_post_review_comment,
            create_worktree,
            remove_worktree,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_stop,
            list_runs,
            process_spawn,
            process_stop,
            build_workflow_discover,
            build_workflow_start,
            build_workflow_cancel,
            watch_start,
            watch_stop,
            agent_harness_capabilities,
            agent_session_start,
            agent_session_stop,
            agent_turn_start,
            agent_turn_steer,
            agent_turn_interrupt,
            agent_cli_capabilities,
            agent_cli_session_start,
            agent_cli_session_stop,
            agent_cli_turn_start,
            agent_cli_turn_interrupt,
            verification_run,
            verification_cancel,
            verification_import_artifact,
        ])
        .build(tauri::generate_context!())
        .expect("error while building VirtualLab")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                app.state::<RunRegistry>().close();
                app.state::<WatchManager>().shutdown();
                app.state::<BuildWorkflowManager>().shutdown();
                app.state::<ProcessManager>().shutdown();
                app.state::<TerminalManager>().shutdown();
                app.state::<AgentManager>().shutdown();
                app.state::<CliAgentManager>().shutdown();
            }
        });
}
