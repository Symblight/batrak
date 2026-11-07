//! Waiting for git, and stopping it and what it started.

use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use super::CANCELLED;

/// After SIGTERM on a timeout, how long git gets to remove its lock files before SIGKILL.
#[cfg(unix)]
const TERM_GRACE: Duration = Duration::from_secs(3);

/// Stops the child's whole process group on timeout or once `cancel` is set.
pub(super) fn wait_with_timeout(child: &mut Child, timeout: Duration, cancel: Option<&AtomicBool>) -> Result<ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() > timeout || cancel.is_some_and(|c| c.load(Ordering::SeqCst)) => {
                let timed_out = started.elapsed() > timeout;
                stop_group(child);
                let _ = child.wait();
                return Err(if timed_out { format!("git timed out after {}s", timeout.as_secs()) } else { CANCELLED.to_owned() });
            }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to wait for git: {e}"));
            }
        }
    }
}

/// SIGTERM to the child's process group: git's signal handler removes its lock files, and hooks
/// it started stop too (they also hold our output pipes open). SIGKILL if it outlives the grace.
#[cfg(unix)]
pub(super) fn stop_group(child: &mut Child) {
    let Ok(pid) = libc::pid_t::try_from(child.id()) else {
        let _ = child.kill();
        return;
    };
    // SAFETY: plain syscalls on a process group we created; a stale id at worst fails with ESRCH.
    unsafe { libc::kill(-pid, libc::SIGTERM) };
    let started = Instant::now();
    while started.elapsed() < TERM_GRACE {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    // Hooks that ignored SIGTERM, and git itself if it did.
    unsafe { libc::kill(-pid, libc::SIGKILL) };
}

/// Windows has no process groups to signal here: the git process alone is killed, and a child it
/// left behind runs on (`Capture::finish` doesn't wait for it).
#[cfg(not(unix))]
pub(super) fn stop_group(child: &mut Child) {
    let _ = child.kill();
}
