//! A child must not retain another workspace's capture pipes after exec.

use std::io;
use std::os::unix::process::CommandExt;
use std::process::Command;

pub(super) fn prevent_inheritance(command: &mut Command) {
    // Darwin has no pipe2(O_CLOEXEC): a concurrent spawn can copy std's pipe
    // between pipe() and fcntl(FD_CLOEXEC). Isolate descriptors in the child,
    // after std has mapped the requested stdin/stdout/stderr onto 0/1/2.
    // A spawn-only mutex would miss pipes opened by native dependencies.
    //
    // SAFETY: the hook only uses stack data and syscall wrappers, with no
    // allocation, locks, environment access or formatting after fork. Darwin's
    // proc_pidinfo is an audited direct __proc_info wrapper (see below).
    unsafe {
        command.pre_exec(|| {
            for fd in 3..descriptor_table_limit()? {
                // Mark, do not close: Rust's exec-error pipe must remain usable
                // if a later pre_exec hook or exec itself fails. Successful exec
                // closes it along with any unrelated inherited pipe endpoints.
                if libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) == -1 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(libc::EBADF) {
                        return Err(error);
                    }
                }
            }
            Ok(())
        });
    }
}

#[cfg(target_os = "macos")]
fn descriptor_table_limit() -> io::Result<i32> {
    // Query this single-threaded child's actual table, not a parent-side
    // snapshot or RLIMIT_NOFILE: a lowered limit can leave higher FDs open.
    // XNU exposes allocated slot capacity in pbi_nfiles, not the open count.
    // proc_pidinfo contains only the __proc_info syscall and return handling:
    // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/libsyscall/wrappers/libproc/libproc.c
    // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c
    // SAFETY: initialized stack buffer with the exact ABI size; self PID only.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let pid = unsafe { libc::getpid() };
    let read = unsafe {
        libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0,
            &mut info as *mut _ as *mut libc::c_void, size)
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    if read != size || info.pbi_pid != pid as u32 || info.pbi_nfiles < 3 {
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
    i32::try_from(info.pbi_nfiles).map_err(|_| io::Error::from_raw_os_error(libc::EOVERFLOW))
}

// Linux already creates std's pipes with atomic O_CLOEXEC. Exercise the same
// child-side fcntl loop there only in the deterministic inheritance regressions.
#[cfg(all(test, not(target_os = "macos")))]
fn descriptor_table_limit() -> io::Result<i32> {
    let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == -1 {
        return Err(io::Error::last_os_error());
    }
    i32::try_from(limit.rlim_cur).map_err(|_| io::Error::from_raw_os_error(libc::EOVERFLOW))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    fn isolated_command(program: impl AsRef<OsStr>) -> Command {
        #[allow(unused_mut)]
        let mut command = super::super::background_command(program);
        #[cfg(not(target_os = "macos"))]
        super::prevent_inheritance(&mut command);
        command
    }

    fn run_in_own_test_process(test: &str) -> bool {
        const KEY: &str = "VIRTUALLAB_DESCRIPTOR_INHERITANCE_TEST";
        if std::env::var(KEY).as_deref() == Ok(test) {
            return false;
        }
        // A deliberately inheritable FD is process-global. Keep fault injection
        // away from parallel tests and dependencies that launch their own child.
        let output = isolated_command(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env(KEY, test).output().unwrap();
        assert!(output.status.success(), "isolated descriptor regression failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        true
    }

    struct RunningChild(Child);
    impl Drop for RunningChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn inherited(fd: i32, enabled: bool) {
        // Deliberately hold open the pipe()/fcntl() race window observed on
        // macOS. The child must close this descriptor regardless of its flag
        // in the parent; unrelated descriptors must not be closed in the parent.
        let flags = if enabled { 0 } else { libc::FD_CLOEXEC };
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFD, flags) }, 0);
    }

    #[test]
    fn unrelated_child_cannot_retain_a_providers_stdin_reader() {
        if run_in_own_test_process("process::inheritance::tests::unrelated_child_cannot_retain_a_providers_stdin_reader") {
            return;
        }
        let (reader, mut writer) = std::io::pipe().unwrap();
        inherited(reader.as_raw_fd(), true);
        let mut unrelated = RunningChild(isolated_command("/bin/sleep").arg("30").spawn().unwrap());
        inherited(reader.as_raw_fd(), false);
        drop(reader);
        let (tx, rx) = mpsc::channel();
        let blocked = std::thread::spawn(move || {
            let _ = tx.send(writer.write_all(&vec![0; 4 * 1024 * 1024]));
        });
        let outcome = rx.recv_timeout(Duration::from_secs(3));
        let unrelated_still_running = unrelated.0.try_wait().unwrap().is_none();
        // Even a red regression must reap the retaining child and join the
        // writer before asserting, just like a real provider cancellation.
        drop(unrelated);
        blocked.join().unwrap();
        assert!(unrelated_still_running);
        assert!(matches!(outcome, Ok(Err(error)) if error.kind() == std::io::ErrorKind::BrokenPipe),
            "an unrelated child retained the provider pipe and delayed its blocked writer");
    }

    #[test]
    fn unrelated_child_cannot_hold_an_inspectors_output_open() {
        if run_in_own_test_process("process::inheritance::tests::unrelated_child_cannot_hold_an_inspectors_output_open") {
            return;
        }
        let (mut reader, writer) = std::io::pipe().unwrap();
        inherited(writer.as_raw_fd(), true);
        let mut unrelated = RunningChild(isolated_command("/bin/sleep").arg("30").spawn().unwrap());
        inherited(writer.as_raw_fd(), false);
        drop(writer);
        let (tx, rx) = mpsc::channel();
        let drain = std::thread::spawn(move || {
            let _ = tx.send(reader.read_to_end(&mut Vec::new()));
        });
        let outcome = rx.recv_timeout(Duration::from_secs(3));
        let unrelated_still_running = unrelated.0.try_wait().unwrap().is_none();
        drop(unrelated);
        drain.join().unwrap();
        assert!(unrelated_still_running);
        assert!(matches!(outcome, Ok(Ok(0))),
            "an unrelated child retained the inspector pipe and prevented EOF");
    }

    #[test]
    fn explicit_standard_streams_and_exit_status_survive_isolation() {
        let mut child = RunningChild(isolated_command("/bin/sh")
            .args(["-c", "IFS= read -r value; printf '%s' \"$value\"; printf 'diagnostic' >&2; exit 7"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().unwrap());
        child.0.stdin.take().unwrap().write_all(b"workspace input\n").unwrap();
        let mut stdout = String::new();
        let mut stderr = String::new();
        child.0.stdout.take().unwrap().read_to_string(&mut stdout).unwrap();
        child.0.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();
        assert_eq!(child.0.wait().unwrap().code(), Some(7));
        assert_eq!(stdout, "workspace input");
        assert_eq!(stderr, "diagnostic");
    }

    #[test]
    fn spawn_errors_survive_descriptor_isolation() {
        use std::os::unix::process::CommandExt;
        let error = isolated_command("/virtuallab-missing-executable").spawn().unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        let mut command = isolated_command("/bin/sleep");
        // A later hook must still be able to report its error through Rust's
        // internal pipe; closing unknown descriptors before exec loses it.
        unsafe {
            command.pre_exec(|| Err(std::io::Error::from_raw_os_error(libc::EACCES)));
        }
        assert_eq!(command.spawn().unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn lowered_resource_limit_does_not_hide_inherited_high_descriptors() {
        use std::os::fd::{FromRawFd, OwnedFd};
        if run_in_own_test_process("process::inheritance::tests::lowered_resource_limit_does_not_hide_inherited_high_descriptors") {
            return;
        }
        let (mut reader, writer) = std::io::pipe().unwrap();
        let high = unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_DUPFD, 128) };
        assert!(high >= 128);
        let high = unsafe { OwnedFd::from_raw_fd(high) };
        drop(writer);
        let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) }, 0);
        let previous = limit;
        limit.rlim_cur = 64;
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
        let spawned = isolated_command("/bin/sleep").arg("30").spawn();
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &previous) }, 0);
        let mut unrelated = RunningChild(spawned.unwrap());
        drop(high);
        let (tx, rx) = mpsc::channel();
        let drain = std::thread::spawn(move || {
            let _ = tx.send(reader.read_to_end(&mut Vec::new()));
        });
        let outcome = rx.recv_timeout(Duration::from_secs(3));
        let unrelated_still_running = unrelated.0.try_wait().unwrap().is_none();
        drop(unrelated);
        drain.join().unwrap();
        assert!(unrelated_still_running);
        assert!(matches!(outcome, Ok(Ok(0))), "FDs above a lowered resource limit still need isolation");
    }
}
