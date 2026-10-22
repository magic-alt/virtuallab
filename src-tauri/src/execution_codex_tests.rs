use super::*;
use std::path::{Path, PathBuf};

fn argv(command: &CommandBuilder) -> Vec<String> {
    command.get_argv().iter().map(|value| value.to_string_lossy().into_owned()).collect()
}

#[test]
fn codex_terminal_without_references_preserves_existing_permissions_and_notifications() {
    let command = codex_terminal_command("codex", "/primary space 中文", &[], None).unwrap();
    assert_eq!(argv(&command), vec![
        "codex",
        "-c", "tui.notifications=true",
        "-c", "tui.notification_method=osc9",
        "-c", "tui.notification_condition=always",
    ]);
    assert_eq!(command.get_cwd().map(|path| path.as_os_str()), Some(std::ffi::OsStr::new("/primary space 中文")));
}

#[test]
fn codex_terminal_preserves_selected_executable_and_context_as_single_literal_arguments() {
    let program = "/tools space 中文 & %/codex";
    let references = vec![crate::workspace_context::ContextRepository {
        repository_root: "/reference 中文/a&b|c>100% 'quoted'\" $(ignored)".into(),
        workspace_root: "/reference 中文/worktree a&b;$(ignored)\nnext\\tail".into(),
    }];
    let configuration = crate::agent::CodexContextConfiguration {
        sandbox: crate::agent::CodexContextSandbox::WorkspaceWrite,
        developer_instructions: None,
    };
    let command = codex_terminal_command(program, "/primary & 中文", &references, Some(&configuration)).unwrap();
    let args = argv(&command);
    assert_eq!(args[0], program);
    assert_eq!(&args[1..13], [
        "-c", "sandbox_workspace_write.writable_roots=[]",
        "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
        "-c", "tui.notifications=true",
        "-c", "tui.notification_method=osc9",
        "-c", "tui.notification_condition=always",
    ]);
    assert_eq!(args.len(), 15, "reference instructions must remain one config value, without a startup prompt");
    assert_eq!(args[13], "-c");
    let instructions: String = serde_json::from_str(args[14].strip_prefix("developer_instructions=").unwrap()).unwrap();
    assert_eq!(instructions, crate::workspace_context::context_instructions(&references));
    assert!(!args.iter().any(|arg| arg == "--sandbox" || arg == "--ask-for-approval" || arg == "--add-dir" || arg == "danger-full-access" || arg == "--dangerously-bypass-approvals-and-sandbox"));
}

#[test]
fn codex_terminal_context_preserves_inherited_permissions_and_existing_developer_instructions() {
    let references = vec![ContextRepository { repository_root: "/reference".into(), workspace_root: "/reference".into() }];
    let existing = "Keep the configured restriction.\n\"quoted\" instructions & 中文";
    for sandbox in [crate::agent::CodexContextSandbox::Inherit, crate::agent::CodexContextSandbox::ReadOnly, crate::agent::CodexContextSandbox::WorkspaceWrite] {
        let configuration = crate::agent::CodexContextConfiguration { sandbox, developer_instructions: Some(existing.into()) };
        let command = codex_terminal_command("codex", "/primary", &references, Some(&configuration)).unwrap();
        let args = argv(&command);
        assert!(!args.iter().any(|arg| arg == "--sandbox" || arg == "--ask-for-approval"));
        let instruction_arg = args.iter().find_map(|arg| arg.strip_prefix("developer_instructions=")).unwrap();
        let instructions: String = serde_json::from_str(instruction_arg).unwrap();
        assert_eq!(instructions, format!("{existing}\n\n{}", context_instructions(&references)));
    }
}

#[test]
fn codex_terminal_context_requires_qualified_configuration_before_building_arguments() {
    let references = vec![ContextRepository { repository_root: "/reference".into(), workspace_root: "/reference".into() }];
    let error = match codex_terminal_command("codex", "/primary", &references, None) {
        Err(error) => error,
        Ok(_) => panic!("unqualified configuration unexpectedly prepared a terminal"),
    };
    assert!(error.contains("configuration"), "{error}");
}

#[test]
fn codex_terminal_request_reads_camel_case_and_defaults_old_context() {
    let base = serde_json::json!({"id":"codex-1","cwd":"/repo","cols":100,"rows":30,"executablePath":"/tools/codex"});
    let old: TerminalSpawnCodexRequest = serde_json::from_value(base.clone()).unwrap();
    assert_eq!(old.executable_path.as_deref(), Some("/tools/codex"));
    assert!(old.context_repositories.is_empty());
    let mut with_context = base;
    with_context["contextRepositories"] = serde_json::json!([{"repositoryRoot":"/reference","workspaceRoot":"/selected worktree"}]);
    let request: TerminalSpawnCodexRequest = serde_json::from_value(with_context).unwrap();
    assert_eq!(request.context_repositories[0].workspace_root, "/selected worktree");
}

#[test]
fn codex_terminal_request_rejects_arbitrary_shell_command_fields() {
    for field in ["command", "program", "args"] {
        let mut request = serde_json::json!({"id":"codex-1","cwd":"/repo","cols":100,"rows":30});
        request[field] = serde_json::json!("unapproved command");
        assert!(serde_json::from_value::<TerminalSpawnCodexRequest>(request).is_err(), "unexpected command field: {field}");
    }
}

#[test]
fn ordinary_terminal_keeps_the_existing_shell_arguments_and_has_no_reference_leases() {
    let lifecycle = WorkspaceLifecycle::default();
    let (shell, args) = default_shell();
    let (command, activities) = prepare_terminal_command(TerminalLaunch::Shell, "/ordinary workspace", &lifecycle).unwrap();
    let mut expected = vec![shell];
    expected.extend(args);
    assert_eq!(argv(&command), expected);
    assert!(activities.is_empty());
    assert_eq!(command.get_env("TERM"), Some(std::ffi::OsStr::new("xterm-256color")));
}

#[test]
fn codex_terminal_retains_native_adapter_interpreter_environment_without_shell_flags() {
    let mut launcher = background_command("/tools/codex");
    launcher.env("PATH", "/existing:/toolchain 中文/node");
    launcher.env_remove("VIRTUALLAB_ENV_REMOVAL_FIXTURE");
    let mut command = CommandBuilder::new("/tools/codex");
    command.env("VIRTUALLAB_ENV_REMOVAL_FIXTURE", "remove me");
    configure_codex_pty_environment(&mut command, &launcher);
    assert_eq!(command.get_env("PATH"), Some(std::ffi::OsStr::new("/existing:/toolchain 中文/node")));
    assert_eq!(command.get_env("VIRTUALLAB_ENV_REMOVAL_FIXTURE"), None);
    assert_eq!(argv(&command), ["/tools/codex"]);
}

struct LauncherFixture(PathBuf);

impl LauncherFixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("virtuallab codex 中文 & 100% {}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn file(&self, relative: &str, contents: &str) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn npm_package(&self, relative: &str) {
        self.file(&format!("{relative}/package.json"), r#"{"name":"@openai/codex","bin":{"codex":"bin/codex.js"}}"#);
        self.file(&format!("{relative}/bin/codex.js"), "// fixture launcher");
    }

    fn codex(&self, contents: &str) -> PathBuf {
        #[cfg(windows)]
        let filename = "tools & 中文/codex.exe";
        #[cfg(not(windows))]
        let filename = "tools & 中文/codex";
        let executable = self.file(filename, contents);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        executable
    }

    fn workspace(&self, name: &str) -> PathBuf {
        let root = self.0.join(name);
        std::fs::create_dir_all(&root).unwrap();
        let result = background_command("git").args(["init", "--initial-branch=main"])
            .current_dir(&root).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        root
    }
}

impl Drop for LauncherFixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

#[test]
fn codex_terminal_resolves_npm_batch_launcher_to_native_optional_dependency() {
    let fixture = LauncherFixture::new();
    let shim = fixture.file("codex.cmd", "@echo off\r\nnode.exe \"%~dp0node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n");
    fixture.npm_package("node_modules/@openai/codex");
    fixture.file("node_modules/@openai/codex-win32-x64/package.json", r#"{"name":"@openai/codex"}"#);
    let binary = fixture.file("node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe", "fixture");
    let resolved = resolve_windows_codex_pty_program(shim.to_str().unwrap(), "x86_64").unwrap();
    assert_eq!(Path::new(&resolved), std::fs::canonicalize(binary).unwrap());
    assert!(!resolved.ends_with(".cmd"));
}

#[test]
fn codex_terminal_resolves_local_npm_and_legacy_bundled_binary() {
    let fixture = LauncherFixture::new();
    let shim = fixture.file("node_modules/.bin/codex.cmd", "@echo off\r\nnode.exe \"%~dp0..\\@openai\\codex\\bin\\codex.js\" %*\r\n");
    fixture.npm_package("node_modules/@openai/codex");
    let binary = fixture.file("node_modules/@openai/codex/vendor/aarch64-pc-windows-msvc/codex/codex.exe", "fixture");
    let resolved = resolve_windows_codex_pty_program(shim.to_str().unwrap(), "aarch64").unwrap();
    assert_eq!(Path::new(&resolved), std::fs::canonicalize(binary).unwrap());
}

#[test]
fn codex_terminal_rejects_unqualified_batch_wrapper_with_native_selection_hint() {
    let fixture = LauncherFixture::new();
    let shim = fixture.file("codex.cmd", "@echo off\r\necho arbitrary wrapper\r\n");
    let error = resolve_windows_codex_pty_program(shim.to_str().unwrap(), "x86_64").unwrap_err();
    assert!(error.contains("codex.exe"), "{error}");
    assert!(error.contains("launcher"), "{error}");
}

#[test]
fn codex_terminal_does_not_guess_an_unrelated_package_or_architecture() {
    let fixture = LauncherFixture::new();
    let shim = fixture.file("codex.cmd", "@echo off\r\necho arbitrary wrapper\r\n");
    fixture.npm_package("node_modules/@openai/codex");
    fixture.file("node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe", "fixture");
    assert!(resolve_windows_codex_pty_program(shim.to_str().unwrap(), "x86_64").is_err());
    std::fs::write(&shim, "@echo off\r\nnode.exe \"%~dp0node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n").unwrap();
    assert!(resolve_windows_codex_pty_program(shim.to_str().unwrap(), "aarch64").is_err());
    fixture.file("node_modules/@openai/codex/package.json", r#"{"name":"some-other-cli","bin":{"codex":"bin/codex.js"}}"#);
    assert!(resolve_windows_codex_pty_program(shim.to_str().unwrap(), "x86_64").is_err());
}

#[test]
fn codex_terminal_failed_executable_selection_releases_acquired_references() {
    let fixture = LauncherFixture::new();
    let primary = fixture.workspace("primary");
    let reference = fixture.workspace("reference");
    let lifecycle = WorkspaceLifecycle::default();
    let result = prepare_terminal_command(TerminalLaunch::Codex {
        executable_path: Some(fixture.0.join("missing/codex").to_string_lossy().into_owned()),
        context_repositories: vec![crate::workspace_context::ContextRepository {
            repository_root: reference.to_string_lossy().into_owned(),
            workspace_root: reference.to_string_lossy().into_owned(),
        }],
    }, primary.to_str().unwrap(), &lifecycle);
    let error = match result { Err(error) => error, Ok(_) => panic!("missing executable unexpectedly launched") };
    assert!(error.contains("existing absolute Codex launcher"), "{error}");
    lifecycle.detach_repository(&[reference.to_string_lossy().into_owned()], || Ok(())).unwrap();
}

#[test]
fn codex_terminal_without_context_does_not_probe_or_override_configuration() {
    let fixture = LauncherFixture::new();
    let primary = fixture.workspace("primary");
    let executable = fixture.codex("fixture executable; must never be run during preparation");
    let lifecycle = WorkspaceLifecycle::default();
    let (command, activities) = prepare_terminal_command_with_configuration_probe(TerminalLaunch::Codex {
        executable_path: Some(executable.to_string_lossy().into_owned()),
        context_repositories: Vec::new(),
    }, primary.to_str().unwrap(), &lifecycle, |_, _| panic!("context-free terminal must not probe Codex configuration")).unwrap();
    assert_eq!(argv(&command), vec![
        executable.to_string_lossy().into_owned(), "-c".into(), "tui.notifications=true".into(),
        "-c".into(), "tui.notification_method=osc9".into(), "-c".into(), "tui.notification_condition=always".into(),
    ]);
    assert!(activities.is_empty());
}

#[test]
fn codex_terminal_failed_configuration_probe_releases_acquired_references() {
    let fixture = LauncherFixture::new();
    let primary = fixture.workspace("primary");
    let reference = fixture.workspace("reference");
    let executable = fixture.codex("fixture executable; must never be run during preparation");
    let lifecycle = WorkspaceLifecycle::default();
    let reference_paths = vec![reference.to_string_lossy().into_owned()];
    let result = prepare_terminal_command_with_configuration_probe(TerminalLaunch::Codex {
        executable_path: Some(executable.to_string_lossy().into_owned()),
        context_repositories: vec![ContextRepository { repository_root: reference_paths[0].clone(), workspace_root: reference_paths[0].clone() }],
    }, primary.to_str().unwrap(), &lifecycle, |selected, selected_cwd| {
        assert_eq!(selected, executable.to_str().unwrap());
        assert_eq!(selected_cwd, primary.to_str().unwrap());
        assert!(lifecycle.detach_repository(&reference_paths, || Ok(())).is_err(), "reference must stay leased while configuration is being inspected");
        Err("Configured custom permission profile cannot be preserved".into())
    });
    let error = match result { Err(error) => error, Ok(_) => panic!("unqualified configuration unexpectedly prepared a terminal") };
    assert_eq!(error, "Configured custom permission profile cannot be preserved");
    lifecycle.detach_repository(&reference_paths, || Ok(())).unwrap();
}

#[cfg(unix)]
#[test]
fn codex_terminal_environment_launches_env_interpreter_from_gui_path() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = LauncherFixture::new();
    let interpreter_directory = fixture.0.join("node toolchain 中文");
    std::fs::create_dir_all(&interpreter_directory).unwrap();
    symlink("/bin/sh", interpreter_directory.join("vl-codex-fixture-interpreter")).unwrap();
    let executable = fixture.file("tools/codex", "#!/usr/bin/env vl-codex-fixture-interpreter\nprintf 'interpreter-found' > \"$VL_CODEX_FIXTURE_RESULT\"\n");
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let result_path = fixture.0.join("result.txt");
    let mut launcher = background_command(&executable);
    launcher.env("PATH", std::env::join_paths([PathBuf::from("/usr/bin"), interpreter_directory]).unwrap());
    launcher.env("VL_CODEX_FIXTURE_RESULT", &result_path);
    let mut command = CommandBuilder::new(launcher.get_program());
    configure_codex_pty_environment(&mut command, &launcher);
    configure_terminal_command(&mut command, fixture.0.to_str().unwrap());
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    let status = child.wait().unwrap();
    assert!(status.success(), "Codex script must receive the native adapter's GUI interpreter PATH");
    assert_eq!(std::fs::read_to_string(result_path).unwrap(), "interpreter-found");
}

#[cfg(unix)]
#[test]
fn codex_terminal_real_pty_preserves_arguments_and_keeps_references_until_session_release() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::Ordering;
    use std::time::Instant;

    let fixture = LauncherFixture::new();
    let primary = fixture.workspace("primary");
    let reference = fixture.workspace("reference & 中文");
    let executable = fixture.file("tools & 中文/codex", "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$VL_CODEX_ARGV_FILE\"\nwhile IFS= read -r line; do :; done\n");
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let lifecycle = WorkspaceLifecycle::default();
    let reservation = lifecycle.reserve_terminal(primary.to_str().unwrap()).unwrap();
    let released = reservation.release_observer();
    let (mut command, activities) = prepare_terminal_command_with_configuration_probe(TerminalLaunch::Codex {
        executable_path: Some(executable.to_string_lossy().into_owned()),
        context_repositories: vec![crate::workspace_context::ContextRepository {
            repository_root: reference.to_string_lossy().into_owned(),
            workspace_root: reference.to_string_lossy().into_owned(),
        }],
    }, primary.to_str().unwrap(), &lifecycle, |selected, selected_cwd| {
        assert_eq!(selected, executable.to_str().unwrap());
        assert_eq!(selected_cwd, primary.to_str().unwrap());
        Ok(crate::agent::CodexContextConfiguration {
            sandbox: crate::agent::CodexContextSandbox::WorkspaceWrite,
            developer_instructions: Some("Keep existing fixture instructions".into()),
        })
    }).unwrap();
    let expected = argv(&command);
    let recorded = fixture.0.join("literal args.bin");
    command.env("VL_CODEX_ARGV_FILE", &recorded);
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
    let child = pair.slave.spawn_command(command).unwrap();
    let process = crate::terminal_process::TerminalProcess::capture(child.process_id().unwrap()).unwrap();
    drop(pair.slave);
    let session = Arc::new(Mutex::new(TerminalSession {
        cwd: primary.to_string_lossy().into_owned(), process, master: Some(pair.master), writer, child,
        _context_activities: activities, _reservation: reservation,
    }));
    let deadline = Instant::now() + Duration::from_secs(5);
    let actual = loop {
        if let Ok(bytes) = std::fs::read(&recorded) {
            let args: Vec<_> = bytes.split(|byte| *byte == 0).filter(|part| !part.is_empty())
                .map(|part| String::from_utf8(part.to_vec()).unwrap()).collect();
            if args.len() == expected.len() - 1 { break args; }
        }
        if Instant::now() >= deadline {
            session.lock().unwrap().terminate().unwrap();
            panic!("fixture did not record Codex arguments");
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(actual, expected[1..]);
    let reference_paths = vec![reference.to_string_lossy().into_owned()];
    assert!(lifecycle.detach_repository(&reference_paths, || Ok(())).is_err());
    let final_owner = session.clone();
    session.lock().unwrap().terminate().unwrap();
    drop(session);
    assert!(!released.load(Ordering::Acquire));
    assert!(lifecycle.detach_repository(&reference_paths, || Ok(())).is_err(), "observed process exit still has a session owner");
    drop(final_owner);
    assert!(released.load(Ordering::Acquire));
    lifecycle.detach_repository(&reference_paths, || Ok(())).expect("primary release must follow reference release");
}
