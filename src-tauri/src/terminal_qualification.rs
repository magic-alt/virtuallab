//! Real Windows PTY qualification fixtures; never compiled into the application.
use super::*;
use std::sync::{atomic::{AtomicUsize, Ordering}, mpsc};
use std::time::Instant;

struct Fixture {
    session: TerminalSession,
    drained: mpsc::Receiver<()>,
    bytes: Arc<AtomicUsize>,
    markers: Arc<AtomicUsize>,
}
impl Fixture {
    fn start(command: CommandBuilder) -> Self {
        Self::start_delayed(command, Duration::ZERO)
    }
    fn start_delayed(command: CommandBuilder, delay: Duration) -> Self {
        let pair = native_pty_system().openpty(PtySize {
            rows: 24, cols: 80, pixel_width: 0, pixel_height: 0,
        }).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let (done, drained) = mpsc::channel();
        let bytes = Arc::new(AtomicUsize::new(0));
        let count = bytes.clone();
        let markers = Arc::new(AtomicUsize::new(0));
        let marker_count = markers.clone();
        let reply = writer.clone();
        thread::spawn(move || {
            thread::sleep(delay);
            let mut tail = Vec::new();
            // Exercise the production transport, including its native cursor
            // reply. The fixture must not hide UI/session locking races.
            let _ = read_terminal_output(&mut *reader, &reply, |chunk| {
                count.fetch_add(chunk.len(), Ordering::Relaxed);
                tail.extend_from_slice(chunk);
                marker_count.fetch_add(tail.windows(b"VIRTUALLAB_SOAK_OK".len())
                    .filter(|part| *part == b"VIRTUALLAB_SOAK_OK").count(), Ordering::Relaxed);
                let keep = tail.len().saturating_sub(b"VIRTUALLAB_SOAK_OK".len() - 1);
                tail.drain(..keep);
            });
            let _ = done.send(());
        });
        Self { session: TerminalSession { cwd: "/virtuallab-pty-fixture".into(), master: Some(pair.master),
            writer, child }, drained, bytes, markers }
    }
    fn stop(&mut self) {
        self.session.terminate().unwrap();
        self.drained.recv_timeout(Duration::from_secs(10)).expect("PTY reader must exit after stop");
    }
    fn send(&mut self, bytes: &[u8]) {
        let mut writer = self.session.writer.lock().unwrap();
        writer.write_all(bytes).unwrap();
        writer.flush().unwrap();
    }
}

fn run_native_soak(duration: Duration) {
    use notify::Watcher;
    use std::process::Stdio;
    let root = std::env::temp_dir().join(format!("vl soak 中文 {} {}", std::process::id(), now_ms()));
    let repo = root.join("repository");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&std::ffi::OsStr]| {
        let status = crate::process::background_command("git").current_dir(&repo)
            .args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
        assert!(status.success(), "fixture Git operation failed");
    };
    let args = |values: &[&str]| values.iter().map(std::ffi::OsStr::new).map(|s| s.to_os_string()).collect::<Vec<_>>();
    let init = args(&["init", "-b", "main"]); git(&init.iter().map(|s| s.as_os_str()).collect::<Vec<_>>());
    std::fs::write(repo.join("README.md"), "Disposable system qualification fixture\n").unwrap();
    git(&["add".as_ref(), "README.md".as_ref()]);
    let commit = args(&["-c", "user.name=VirtualLab QA", "-c", "user.email=qa@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
    git(&commit.iter().map(|s| s.as_os_str()).collect::<Vec<_>>());
    let roots: Vec<_> = (0..4).map(|index| root.join(format!("worktree {index}"))).collect();
    for path in &roots { git(&["worktree".as_ref(), "add".as_ref(), "--detach".as_ref(), path.as_os_str()]); }
    let changes = Arc::new(AtomicUsize::new(0));
    let observed = changes.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_ok() { observed.fetch_add(1, Ordering::Relaxed); }
    }).unwrap();
    for path in &roots { watcher.watch(path, notify::RecursiveMode::Recursive).unwrap(); }
    let mut terminals: Vec<_> = (0..8).map(|index| {
        let (shell, shell_args) = default_shell();
        assert!(shell.to_ascii_lowercase().contains("powershell") || shell.eq_ignore_ascii_case("pwsh.exe"),
            "this soak fixture requires the default PowerShell; cmd requires a separate fixture");
        let mut command = CommandBuilder::new(shell);
        command.args(shell_args); command.cwd(&roots[index % 4]);
        Fixture::start(command)
    }).collect();
    for terminal in &mut terminals {
        terminal.send(b"Write-Output ('VIRTUALLAB_'+'SOAK_OK')\r");
    }
    let startup = Instant::now();
    while terminals.iter().any(|terminal| terminal.markers.load(Ordering::Relaxed) == 0) {
        assert!(startup.elapsed() < Duration::from_secs(25), "all eight real shells must execute the roundtrip");
        thread::sleep(Duration::from_millis(100));
    }
    for terminal in &terminals {
        use windows_sys::Win32::{Foundation::FILETIME, System::Threading::GetProcessTimes};
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let mut exited = created; let mut kernel = created; let mut user = created;
        let handle = terminal.session.child.as_raw_handle().unwrap();
        assert_ne!(unsafe { GetProcessTimes(handle as _, &mut created, &mut exited, &mut kernel, &mut user) }, 0);
        let started = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        println!("QUALIFICATION_SHELL pid={} filetime={started}", terminal.session.child.process_id().unwrap());
    }
    let registry = crate::run_registry::RunRegistry::default();
    let start = Instant::now();
    let mut cycles = 0;
    println!("QUALIFICATION_SOAK started duration_secs={} worktrees=4 terminals=8 pid={}", duration.as_secs(), std::process::id());
    while start.elapsed() < duration {
        for (index, path) in roots.iter().enumerate() {
            let id = format!("soak-{cycles}-{index}");
            let cwd = path.to_str().unwrap();
            registry.begin(&id, cwd, "native soak", false, None).unwrap();
            assert!(registry.begin(&format!("duplicate-{id}"), cwd, "blocked", true, None).is_err());
            let mut command = crate::process::background_command("node.exe");
            command.args(["-e", "process.stdout.write('fixture output\\n'.repeat(4096))"])
                .current_dir(path).stdout(Stdio::piped()).stderr(Stdio::null());
            let mut child = crate::managed_process::spawn(&mut command).unwrap();
            let mut output = child.stdout.take().unwrap();
            let mut buffer = [0; 8192];
            loop {
                let size = output.read(&mut buffer).unwrap();
                if size == 0 { break; }
                registry.record(serde_json::json!({"id":id,"eventType":"process.output",
                    "data": String::from_utf8_lossy(&buffer[..size])}));
            }
            assert!(child.wait().unwrap().success());
            child.terminate_remaining().unwrap();
            registry.record(serde_json::json!({"id":id,"eventType":"process.exited","exitCode":0}));
            std::fs::write(path.join("watcher-fixture.txt"), format!("cycle {cycles}\n")).unwrap();
        }
        for terminal in &mut terminals {
            assert!(terminal.markers.load(Ordering::Relaxed) >= cycles as usize,
                "each terminal must continue executing commands during the soak");
            terminal.session.master.as_ref().unwrap().resize(PtySize {
                rows: 24 + cycles % 8, cols: 80 + cycles % 16, pixel_width: 0, pixel_height: 0,
            }).unwrap();
            assert!(terminal.session.child.try_wait().unwrap().is_none());
            terminal.send(b"Write-Output ('VIRTUALLAB_'+'SOAK_OK')\r");
        }
        cycles += 1;
        if cycles % 12 == 0 { println!("QUALIFICATION_SOAK elapsed_secs={} cycles={cycles}", start.elapsed().as_secs()); }
        thread::sleep(Duration::from_secs(5).min(duration.saturating_sub(start.elapsed())));
    }
    for terminal in &mut terminals {
        assert!(terminal.markers.load(Ordering::Relaxed) >= 1);
        assert!(terminal.bytes.load(Ordering::Relaxed) > 0);
        terminal.stop();
    }
    assert!(changes.load(Ordering::Relaxed) > 0, "native watcher must receive fixture edits");
    registry.close();
    assert!(registry.begin("after-close", "other", "blocked", false, None).is_err());
    drop(terminals); drop(watcher);
    assert!(root.starts_with(std::env::temp_dir()) && root.file_name().unwrap().to_string_lossy().starts_with("vl soak 中文 "));
    std::fs::remove_dir_all(&root).unwrap();
    println!("QUALIFICATION_SOAK passed elapsed_secs={} cycles={cycles} readers_exited=8", start.elapsed().as_secs());
}

#[test]
#[ignore = "explicit native qualification smoke; opens eight real PowerShell terminals"]
fn native_four_worktree_eight_terminal_smoke() { run_native_soak(Duration::from_secs(15)); }

#[test]
#[ignore = "explicit one-hour native qualification; never part of default CI"]
fn native_four_worktree_eight_terminal_one_hour_soak() { run_native_soak(Duration::from_secs(3600)); }
impl Drop for Fixture {
    fn drop(&mut self) { let _ = self.session.terminate(); }
}

#[test]
fn windows_terminal_stop_releases_pty_reader_without_dropping_session() {
    let mut command = CommandBuilder::new("node.exe");
    command.args(["-e", "setInterval(()=>{},1000)"]);
    let mut fixture = Fixture::start(command);
    fixture.stop();
}

#[test]
fn windows_startup_cursor_reply_survives_stop_before_ui_attachment() {
    let (shell, args) = default_shell();
    let mut command = CommandBuilder::new(shell);
    command.args(args);
    let fixture = Mutex::new(Fixture::start_delayed(command, Duration::from_millis(250)));
    let started = Instant::now();
    fixture.lock().unwrap().stop();
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn windows_terminal_reaps_descendants_when_leader_exits_first() {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_TERMINATE,
    }};
    let root = std::env::temp_dir().join(format!("vl terminal qualification 中文 {}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let pid_file = root.join("descendant.pid");
    let mut command = CommandBuilder::new("node.exe");
    command.args(["-e", "const fs=require('fs');const {spawn}=require('child_process');spawn(process.execPath,['-e',\"require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)\",process.argv[1]],{stdio:'inherit'});const t=setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0)},10);setTimeout(()=>process.exit(2),8000)"]);
    command.arg(&pid_file);
    let mut fixture = Fixture::start(command);
    let deadline = Instant::now() + Duration::from_secs(10);
    while !pid_file.is_file() && Instant::now() < deadline { thread::sleep(Duration::from_millis(10)); }
    let pid = std::fs::read_to_string(&pid_file).unwrap().parse::<u32>().unwrap();
    // Own a handle throughout verification, so PID reuse cannot affect the check/cleanup.
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE | 0x0010_0000, 0, pid) };
    assert!(!handle.is_null());
    while fixture.session.child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(fixture.session.child.try_wait().unwrap().is_some(), "fixture leader must exit first");
    fixture.session.terminate().unwrap();
    let exited = unsafe { WaitForSingleObject(handle, 1000) } == 0;
    // Always clean the fixture even when the regression assertion fails.
    if !exited { unsafe { TerminateProcess(handle, 1); WaitForSingleObject(handle, 3000); } }
    unsafe { CloseHandle(handle); }
    let drained = std::mem::replace(&mut fixture.drained, mpsc::channel().1);
    drop(fixture);
    drained.recv_timeout(Duration::from_secs(10)).unwrap();
    std::fs::remove_file(pid_file).unwrap();
    std::fs::remove_dir(root).unwrap();
    assert!(exited, "an exited terminal leader must not leave a live descendant holding the PTY");
}
