//! Own a process tree, including descendants holding inherited output pipes.
use std::{io, ops::{Deref, DerefMut}, process::{Child, Command}};

pub(crate) struct ManagedChild {
    child: Child,
    #[cfg(windows)]
    job: windows_job::Job,
}
impl Deref for ManagedChild { type Target = Child; fn deref(&self) -> &Child { &self.child } }
impl DerefMut for ManagedChild { fn deref_mut(&mut self) -> &mut Child { &mut self.child } }
impl ManagedChild {
    pub fn terminate_remaining(&mut self) -> io::Result<()> {
        #[cfg(windows)] { self.job.terminate() }
        #[cfg(unix)] {
            let pid = self.child.id();
            crate::process::terminate_pid(pid).map_err(io::Error::other)?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                let _ = self.child.try_wait()?; // Reap the leader, so kill(0) cannot mistake it for a live group.
                if crate::process::group_exited(pid).map_err(io::Error::other)? { return Ok(()); }
                if std::time::Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "Process group exit not confirmed")); }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
}
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.terminate_remaining();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub(crate) fn spawn(command: &mut Command) -> io::Result<ManagedChild> {
    crate::process::configure_process_tree(command);
    #[cfg(windows)] {
        use std::os::windows::{io::AsRawHandle, process::CommandExt};
        use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
        let job = windows_job::Job::new()?;
        // The process cannot create descendants until assignment succeeds.
        command.creation_flags(0x0800_0000 | CREATE_SUSPENDED);
        let child = command.spawn()?;
        let mut owned = ManagedChild { child, job };
        if let Err(error) = owned.job.assign(owned.child.as_raw_handle())
            .and_then(|_| windows_job::resume(owned.child.id())) {
            let _ = owned.child.kill();
            let _ = owned.child.wait();
            return Err(error);
        }
        Ok(owned)
    }
    #[cfg(not(windows))] { Ok(ManagedChild { child: command.spawn()? }) }
}

#[cfg(windows)]
mod windows_job {
    use std::{io, mem::size_of, ptr};
    use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE}, System::{
        JobObjects::*, Diagnostics::ToolHelp::*, Threading::*
    }};
    pub(super) struct Job(HANDLE);
    // Owned kernel handle, closed exactly once; Win32 job operations are thread safe.
    unsafe impl Send for Job {}
    impl Job {
        pub fn new() -> io::Result<Self> {
            // SAFETY: null optional security/name pointers; initialized limit structure.
            unsafe {
                let handle = CreateJobObjectW(ptr::null(), ptr::null());
                if handle.is_null() { return Err(io::Error::last_os_error()); }
                let job = Self(handle);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(handle, JobObjectExtendedLimitInformation,
                    &limits as *const _ as _, size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }
        pub fn assign(&self, child: HANDLE) -> io::Result<()> {
            // SAFETY: both handles are live for this call.
            if unsafe { AssignProcessToJobObject(self.0, child) } == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
        }
        pub fn terminate(&self) -> io::Result<()> {
            // SAFETY: owned live handle; no external process IDs are accepted.
            if unsafe { TerminateJobObject(self.0, 1) } == 0 { return Err(io::Error::last_os_error()); }
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
                // SAFETY: correctly sized writable query buffer and a live job.
                if unsafe { QueryInformationJobObject(self.0, JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _, size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, ptr::null_mut()) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                if info.ActiveProcesses == 0 { return Ok(()); }
                if std::time::Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "Process tree exit not confirmed")); }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
    impl Drop for Job { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    pub fn resume(pid: u32) -> io::Result<()> {
        // SAFETY: initialized THREADENTRY32 with correct size; every acquired handle is closed.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            let mut found = Thread32First(snapshot, &mut entry);
            let mut result = Err(io::Error::new(io::ErrorKind::NotFound, "Suspended process thread unavailable"));
            while found != 0 {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if thread.is_null() { result = Err(io::Error::last_os_error()); }
                    else {
                        result = if ResumeThread(thread) == u32::MAX { Err(io::Error::last_os_error()) } else { Ok(()) };
                        CloseHandle(thread);
                    }
                    break;
                }
                found = Thread32Next(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            result
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    #[test]
    fn exited_leader_does_not_leave_descendants_holding_output_open() {
        let mut command = crate::process::background_command("node");
        command.args(["-e", "const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]}); console.log(c.pid); process.exit(0)"])
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        let mut child = spawn(&mut command).unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert!(line.trim().parse::<u32>().is_ok());
        assert!(child.wait().unwrap().success());
        child.terminate_remaining().unwrap();
        line.clear();
        assert_eq!(output.read_line(&mut line).unwrap(), 0);
    }
    #[test]
    fn stop_reaps_tree_and_closes_descendant_output_pipes() {
        let mut command = crate::process::background_command("node");
        command.args(["-e", "const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]}); console.log(c.pid); setInterval(()=>{},1000)"])
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        let mut child = spawn(&mut command).unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert!(line.trim().parse::<u32>().unwrap() > 0);
        crate::process::terminate_tree(&mut child).unwrap();
        assert!(child.try_wait().unwrap().is_some());
        line.clear();
        assert_eq!(output.read_line(&mut line).unwrap(), 0);
    }
}
