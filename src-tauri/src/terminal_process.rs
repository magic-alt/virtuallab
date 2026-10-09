//! Ownership of an isolated portable-pty Unix session. Keep its leader unreaped
//! until cleanup completes: this pins the session ID against reuse.
#[derive(Debug)]
pub(crate) struct TerminalProcess {
    session: i32,
    cleaned: bool,
}
impl TerminalProcess {
    pub(crate) fn capture(pid: u32) -> Result<Self, String> {
        let session = i32::try_from(pid).map_err(|_| "Invalid terminal PID")?;
        if session <= 1
            || session == unsafe { libc::getsid(0) }
            || unsafe { libc::getsid(session) } != session
        {
            return Err("Terminal does not own an isolated Unix session".into());
        }
        Ok(Self {
            session,
            cleaned: false,
        })
    }
    pub(crate) fn leader_exited(&self) -> Result<bool, String> {
        if self.cleaned {
            return Ok(true);
        }
        // WNOWAIT observes exit without releasing the PID/session identity.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                self.session as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == -1 {
            return Err(format!(
                "Cannot observe terminal shell exit: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(unsafe { info.si_pid() } == self.session)
    }
    pub(crate) fn cleanup_due(&self, cancelled: bool) -> Result<bool, String> {
        if cancelled {
            Ok(true)
        } else {
            self.leader_exited()
        }
    }
    pub(crate) fn terminate(&mut self) -> Result<(), String> {
        if self.cleaned {
            return Ok(());
        }
        let start = std::time::Instant::now();
        loop {
            // The caller must not poll/wait/reap the leader until this succeeds.
            // An unreaped leader (including a zombie) pins the session identity.
            if unsafe { libc::getsid(self.session) } != self.session {
                return Err("Terminal session ownership lost before cleanup".into());
            }
            let members = self.members(start + std::time::Duration::from_secs(3))?;
            if members.is_empty() {
                self.cleaned = true;
                return Ok(());
            }
            if start.elapsed() >= std::time::Duration::from_secs(3) {
                return Err("Terminal session exit not confirmed within 3 seconds".into());
            }
            let signal = if start.elapsed() < std::time::Duration::from_millis(250) {
                libc::SIGTERM
            } else {
                libc::SIGKILL
            };
            for pid in members {
                if start.elapsed() >= std::time::Duration::from_secs(3) {
                    return Err("Terminal session exit not confirmed within 3 seconds".into());
                }
                signal_member(self.session, pid, signal)?;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    fn members(&self, deadline: std::time::Instant) -> Result<Vec<i32>, String> {
        // PID/state only: no command lines, arguments or environments. Unlike
        // negative-PGID kill this includes foreground/background job groups.
        let mut command = crate::process::background_command("/bin/ps");
        command.args(["-A", "-o", "pid=", "-o", "stat="]);
        let text = inspect_processes(&mut command, deadline)?;
        let mut members = Vec::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let mut fields = line.split_whitespace();
            let pid: i32 = fields
                .next()
                .and_then(|s| s.parse().ok())
                .ok_or("Invalid process ID")?;
            let state = fields.next().ok_or("Missing process state")?;
            // Zombies cannot execute or retain PTY handles. Reap our leader only
            // after this loop; adopted grandchildren are reaped by their parent.
            if !state.starts_with(['Z', 'X']) && unsafe { libc::getsid(pid) } == self.session {
                members.push(pid);
            }
        }
        Ok(members)
    }
}

fn signal_member(session: i32, pid: i32, signal: i32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        // Pin the target before rechecking membership: PID reuse cannot redirect
        // pidfd_send_signal to a different process. Linux 5.3+ is required.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd == -1 {
            return missing_process_or_error();
        }
        let fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd as i32) };
        if unsafe { libc::getsid(pid) } != session {
            return Ok(());
        }
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        } == -1
        {
            return missing_process_or_error();
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        // POSIX platforms without pidfds provide best-effort membership checking;
        // there is no atomic identity-checked signal through portable kill(2).
        if unsafe { libc::getsid(pid) } != session {
            return Ok(());
        }
        if unsafe { libc::kill(pid, signal) } == -1 {
            return missing_process_or_error();
        }
    }
    Ok(())
}
fn missing_process_or_error() -> Result<(), String> {
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error.to_string())
    }
}
fn inspect_processes(
    command: &mut std::process::Command,
    deadline: std::time::Instant,
) -> Result<String, String> {
    use std::io::Read;
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot inspect terminal session: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("Missing inspector output")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .by_ref()
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())
            .and_then(|_| {
                if bytes.len() > 8 * 1024 * 1024 {
                    Err("Process table exceeds inspection budget".into())
                } else {
                    String::from_utf8(bytes).map_err(|_| "Invalid process table".into())
                }
            });
        let _ = sender.send(result);
    });
    // Poll both output and exit with the same cleanup deadline; never block in
    // output()/wait() while owning the terminal mutex.
    let mut output = None;
    loop {
        if output.is_none() {
            if let Ok(result) = receiver.try_recv() {
                output = Some(result);
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if output.is_some() => {
                if !status.success() {
                    return Err("Cannot inspect terminal session".into());
                }
                return output.unwrap();
            }
            Ok(_) => {}
            Err(error) => {
                let _ = child.kill();
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Err(error.to_string());
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Err("Terminal process inspection timed out".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::{
        io::Write,
        time::{Duration, Instant},
    };

    struct Fixture {
        child: Box<dyn portable_pty::Child + Send + Sync>,
        _master: Box<dyn portable_pty::MasterPty + Send>,
        _reader: std::thread::JoinHandle<()>,
        owner: TerminalProcess,
        jobs: Vec<i32>,
        directory: std::path::PathBuf,
    }
    impl Fixture {
        fn start(exit_shell: bool) -> Self {
            let pair = native_pty_system().openpty(PtySize::default()).unwrap();
            let mut command = CommandBuilder::new("/bin/bash");
            command.args(["--noprofile", "--norc", "-i"]);
            command.env("PS1", "VIRTUALLAB_PTY_READY> ");
            command.env("PROMPT_COMMAND", "");
            let mut reader = pair.master.try_clone_reader().unwrap();
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let reader = std::thread::spawn(move || {
                use std::io::Read;
                let mut tail = Vec::new();
                let mut buffer = [0u8; 2048];
                let mut ready = false;
                while let Ok(read) = reader.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    if !ready {
                        tail.extend_from_slice(&buffer[..read]);
                        if tail
                            .windows(b"VIRTUALLAB_PTY_READY> ".len())
                            .any(|s| s == b"VIRTUALLAB_PTY_READY> ")
                        {
                            let _ = ready_tx.send(());
                            ready = true;
                        }
                        if tail.len() > 512 {
                            tail.drain(..tail.len() - 512);
                        }
                    }
                }
            });
            let child = pair.slave.spawn_command(command).unwrap();
            drop(pair.slave);
            let owner = TerminalProcess::capture(child.process_id().unwrap()).unwrap();
            let directory = std::env::temp_dir().join(format!("virtuallab-pty-{}", owner.session));
            std::fs::create_dir_all(&directory).unwrap();
            let file = directory.join("jobs");
            // The interactive shell assigns separate groups to both jobs.
            fn quote(text: &str) -> String {
                format!("'{}'", text.replace('\'', "'\\''"))
            }
            let job = format!(
                "/bin/sh -c {}",
                quote(&format!(
                    "trap '' HUP TERM; echo $$ >> {}; exec sleep 60",
                    quote(file.to_str().unwrap())
                ))
            );
            let finish = if exit_shell { "exit" } else { &job };
            let script = format!("trap '' HUP TERM; {job} & {finish}\n");
            let mut writer = pair.master.take_writer().unwrap();
            let mut fixture = Self {
                child,
                _master: pair.master,
                _reader: reader,
                owner,
                jobs: vec![],
                directory,
            };
            // Wait for readline to enter interactive mode. macOS has a small
            // canonical input queue; writing a long line before the prompt can
            // truncate it. Continuously drain output just like a real terminal.
            ready_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("shell prompt not ready");
            writer.write_all(script.as_bytes()).unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                fixture.jobs = std::fs::read_to_string(&file)
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|s| s.parse().ok())
                    .collect();
                if fixture.jobs.len() == if exit_shell { 1 } else { 2 } {
                    break;
                }
                assert!(Instant::now() < deadline, "shell jobs did not start");
                std::thread::sleep(Duration::from_millis(20));
            }
            for pid in &fixture.jobs {
                assert_eq!(unsafe { libc::getsid(*pid) }, fixture.owner.session);
                assert_ne!(unsafe { libc::getpgid(*pid) }, fixture.owner.session);
            }
            fixture
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for pid in &self.jobs {
                if unsafe { libc::getsid(*pid) } == self.owner.session {
                    unsafe {
                        libc::kill(*pid, libc::SIGKILL);
                    }
                }
            }
            // Test failure cleanup must itself be bounded so CI can print the
            // original failure instead of waiting forever in a destructor.
            if unsafe { libc::getsid(self.owner.session) } == self.owner.session {
                unsafe {
                    libc::kill(self.owner.session, libc::SIGKILL);
                }
            }
            let deadline = Instant::now() + Duration::from_secs(1);
            while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    fn live(pid: i32) -> bool {
        let result = std::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .unwrap();
        let state = String::from_utf8(result.stdout).unwrap();
        !state.trim().is_empty() && !state.trim().starts_with(['Z', 'X'])
    }
    #[test]
    fn stop_cleans_foreground_and_background_groups_without_touching_other_sessions() {
        let mut fixture = Fixture::start(false);
        let unrelated = Fixture::start(false);
        fixture.owner.terminate().unwrap();
        assert!(
            fixture.jobs.iter().all(|pid| !live(*pid)),
            "cross-group jobs survived terminal Stop"
        );
        assert!(
            unrelated.jobs.iter().all(|pid| live(*pid)),
            "another terminal was signalled"
        );
    }
    #[test]
    fn eof_cleans_background_jobs_after_shell_exits_before_reaping() {
        let mut fixture = Fixture::start(true);
        std::thread::sleep(Duration::from_millis(100));
        fixture.owner.terminate().unwrap();
        assert!(
            fixture.jobs.iter().all(|pid| !live(*pid)),
            "orphan jobs survived shell exit"
        );
    }
    #[test]
    fn observes_shell_exit_without_reaping_while_background_keeps_pty_open() {
        let mut fixture = Fixture::start(true);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !fixture.owner.leader_exited().unwrap() {
            assert!(Instant::now() < deadline, "shell exit was not observed");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            unsafe { libc::getsid(fixture.owner.session) },
            fixture.owner.session,
            "exit detection must leave the leader unreaped"
        );
        fixture.owner.terminate().unwrap();
        assert!(fixture.jobs.iter().all(|pid| !live(*pid)));
    }
    #[test]
    fn stalled_inspector_does_not_block_terminal_cleanup_deadline() {
        let mut command = crate::process::background_command("/bin/sleep");
        command.arg("0.4");
        let start = Instant::now();
        assert!(inspect_processes(&mut command, start + Duration::from_millis(50)).is_err());
        assert!(
            start.elapsed() < Duration::from_millis(250),
            "inspector exceeded cleanup budget"
        );
    }
    #[test]
    fn signal_rechecks_session_membership_on_the_pinned_target() {
        let fixture = Fixture::start(false);
        let unrelated = Fixture::start(false);
        signal_member(fixture.owner.session, unrelated.jobs[0], libc::SIGKILL).unwrap();
        assert!(
            live(unrelated.jobs[0]),
            "signal reached an unrelated session"
        );
    }
    #[test]
    fn cancelled_live_session_retries_cleanup_without_waiting_for_exit_or_eof() {
        let mut fixture = Fixture::start(false);
        assert!(!fixture.owner.cleanup_due(false).unwrap());
        assert!(
            fixture.owner.cleanup_due(true).unwrap(),
            "cancelled live shell must request cleanup retry"
        );
        fixture.owner.terminate().unwrap();
        assert!(fixture.jobs.iter().all(|pid| !live(*pid)));
    }

    #[test]
    fn refuses_unowned_session() {
        assert!(TerminalProcess::capture(std::process::id()).is_err());
        assert!(TerminalProcess::capture(0).is_err());
        assert!(TerminalProcess::capture(1).is_err());
    }
}
