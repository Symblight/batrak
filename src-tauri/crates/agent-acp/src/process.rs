//! The agent's OS process: its own process group (an `npx` agent is a tree of processes), stdio
//! piped for ACP, stderr appended to the session's log file, and the whole group stopped together.

use std::collections::HashSet;
use std::fs::File;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// After SIGTERM, how long the group gets before SIGKILL.
const TERM_GRACE: Duration = Duration::from_secs(2);

/// Groups of agents still running, so app exit can stop them even when their owner never gets to
/// run its cleanup (the event loop exits the process without running destructors).
static LIVE_GROUPS: Mutex<Option<HashSet<i32>>> = Mutex::new(None);

fn live_groups() -> std::sync::MutexGuard<'static, Option<HashSet<i32>>> {
    LIVE_GROUPS.lock().unwrap_or_else(PoisonError::into_inner)
}

fn register(pgid: i32) {
    live_groups().get_or_insert_with(HashSet::new).insert(pgid);
}

fn unregister(pgid: i32) {
    if let Some(groups) = live_groups().as_mut() {
        groups.remove(&pgid);
    }
}

/// Stops every agent process group still running: SIGTERM, up to `grace` for them to exit, then
/// SIGKILL. For app exit; blocking.
pub fn stop_all(grace: Duration) {
    let groups: Vec<i32> = live_groups().take().unwrap_or_default().into_iter().collect();
    if !groups.is_empty() {
        tracing::info!(count = groups.len(), "stopping agent processes");
        stop_groups(&groups, grace);
    }
}

fn stop_groups(groups: &[i32], grace: Duration) {
    for &pgid in groups {
        signal_group(pgid, Signal::Term);
    }
    let started = std::time::Instant::now();
    while started.elapsed() < grace && groups.iter().any(|&pgid| group_alive(pgid)) {
        std::thread::sleep(Duration::from_millis(20));
    }
    for &pgid in groups {
        signal_group(pgid, Signal::Kill);
    }
}

/// What to run. Built by the session environment; `env` is the complete environment.
pub struct AgentCommand<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
}

pub struct AgentProcess {
    child: Child,
    /// Group id (= the leader's pid); `None` once the group was killed or on Windows.
    pgid: Option<i32>,
}

/// The ends of the agent's stdio that ACP runs over.
pub struct AgentPipes {
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
}

/// Starts the agent as the leader of a new process group, with exactly `env`.
pub fn spawn(command: &AgentCommand, stderr: File) -> Result<(AgentProcess, AgentPipes), String> {
    let mut cmd = Command::new(command.program);
    cmd.args(command.args)
        .current_dir(command.cwd)
        .env_clear()
        .envs(command.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr))
        // The leader at least, should our own cleanup never run.
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to start {}: {e}", command.program))?;
    let pgid = child.id().and_then(|pid| i32::try_from(pid).ok());
    if let Some(pgid) = pgid {
        register(pgid);
    }
    let stdin = child.stdin.take().ok_or("agent stdin is not piped")?;
    let stdout = child.stdout.take().ok_or("agent stdout is not piped")?;
    Ok((AgentProcess { child, pgid }, AgentPipes { stdin, stdout }))
}

impl AgentProcess {
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// Waits for the leader to exit, then stops whatever it left in its group.
    pub async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let status = self.child.wait().await;
        if let Some(pgid) = self.pgid.take() {
            signal_group(pgid, Signal::Kill);
            unregister(pgid);
        }
        status
    }

    /// SIGTERM to the group, SIGKILL to whatever is left after a grace period. Waits for the
    /// leader so it isn't left a zombie.
    pub async fn stop(&mut self) {
        let Some(pgid) = self.pgid.take() else {
            let _ = self.child.kill().await;
            return;
        };
        signal_group(pgid, Signal::Term);
        let _ = tokio::time::timeout(TERM_GRACE, self.child.wait()).await;
        // Children (npx → node) may outlive the leader: the group goes whatever the leader did.
        signal_group(pgid, Signal::Kill);
        unregister(pgid);
        let _ = self.child.wait().await;
    }

    /// Blocking variant for app exit, where there is no runtime to wait on: TERM, a short grace,
    /// then KILL.
    pub fn stop_now(&mut self, grace: Duration) {
        let Some(pgid) = self.pgid.take() else {
            let _ = self.child.start_kill();
            return;
        };
        signal_group(pgid, Signal::Term);
        let started = std::time::Instant::now();
        while started.elapsed() < grace {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        signal_group(pgid, Signal::Kill);
        unregister(pgid);
        let _ = self.child.try_wait();
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        if let Some(pgid) = self.pgid.take() {
            signal_group(pgid, Signal::Kill);
            unregister(pgid);
        }
    }
}

enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
fn signal_group(pgid: i32, signal: Signal) {
    let signal = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    // SAFETY: a plain syscall on a process group we created; a gone group fails with ESRCH.
    unsafe { libc::kill(-pgid, signal) };
}

#[cfg(unix)]
fn group_alive(pgid: i32) -> bool {
    // SAFETY: signal 0 only checks that a member of the group exists.
    unsafe { libc::kill(-pgid, 0) == 0 }
}

#[cfg(windows)]
fn group_alive(_pgid: i32) -> bool {
    false
}

/// No process groups to signal on Windows: the tree is ended with `taskkill /T`.
#[cfg(windows)]
fn signal_group(pgid: i32, _signal: Signal) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pgid.to_string()])
        .creation_flags(0x0800_0000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Like `npx`: the agent starts a child that keeps running, and ignores SIGTERM itself.
    #[tokio::test]
    async fn stopping_kills_the_whole_group() {
        let env: Vec<(String, String)> = vec![("PATH".into(), "/usr/bin:/bin".into())];
        let args = vec!["-c".to_owned(), "trap '' TERM; sleep 60 & echo $!; wait".to_owned()];
        let cwd = std::env::temp_dir();
        let command = AgentCommand { program: "sh", args: &args, cwd: &cwd, env: &env };
        let log = tempfile_in_temp("group");
        let (mut process, pipes) = spawn(&command, File::create(&log).unwrap()).unwrap();
        let mut line = String::new();
        tokio::io::BufReader::new(pipes.stdout).read_line(&mut line).await.unwrap();
        let child: i32 = line.trim().parse().unwrap();
        let leader = process.pid().unwrap() as i32;
        assert!(alive(child));

        process.stop().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!alive(child), "the agent's child is gone");
        assert!(!alive(leader), "the agent is gone");
        let _ = std::fs::remove_file(log);
    }

    #[test]
    fn stop_now_kills_the_group_without_a_runtime_wait() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (mut process, child) = rt.block_on(async {
            let env: Vec<(String, String)> = vec![("PATH".into(), "/usr/bin:/bin".into())];
            let args = vec!["-c".to_owned(), "sleep 60 & echo $!; wait".to_owned()];
            let cwd = std::env::temp_dir();
            let command = AgentCommand { program: "sh", args: &args, cwd: &cwd, env: &env };
            let log = tempfile_in_temp("stop-now");
            let (process, pipes) = spawn(&command, File::create(&log).unwrap()).unwrap();
            let mut line = String::new();
            tokio::io::BufReader::new(pipes.stdout).read_line(&mut line).await.unwrap();
            let _ = std::fs::remove_file(log);
            (process, line.trim().parse::<i32>().unwrap())
        });
        process.stop_now(Duration::from_millis(500));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!alive(child));
    }

    #[test]
    fn dropping_the_process_kills_the_group() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let child = rt.block_on(async {
            let env: Vec<(String, String)> = vec![("PATH".into(), "/usr/bin:/bin".into())];
            let args = vec!["-c".to_owned(), "sleep 60 & echo $!; wait".to_owned()];
            let cwd = std::env::temp_dir();
            let command = AgentCommand { program: "sh", args: &args, cwd: &cwd, env: &env };
            let log = tempfile_in_temp("drop");
            let (process, pipes) = spawn(&command, File::create(&log).unwrap()).unwrap();
            let mut line = String::new();
            tokio::io::BufReader::new(pipes.stdout).read_line(&mut line).await.unwrap();
            let _ = std::fs::remove_file(log);
            drop(process);
            line.trim().parse::<i32>().unwrap()
        });
        std::thread::sleep(Duration::from_millis(100));
        assert!(!alive(child));
    }

    #[test]
    fn stopping_groups_needs_no_owner() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (process, child) = rt.block_on(async {
            let env: Vec<(String, String)> = vec![("PATH".into(), "/usr/bin:/bin".into())];
            let args = vec!["-c".to_owned(), "sleep 60 & echo $!; wait".to_owned()];
            let cwd = std::env::temp_dir();
            let command = AgentCommand { program: "sh", args: &args, cwd: &cwd, env: &env };
            let log = tempfile_in_temp("stop-all");
            let (process, pipes) = spawn(&command, File::create(&log).unwrap()).unwrap();
            let mut line = String::new();
            tokio::io::BufReader::new(pipes.stdout).read_line(&mut line).await.unwrap();
            let _ = std::fs::remove_file(log);
            (process, line.trim().parse::<i32>().unwrap())
        });
        // Like app exit: the owner is never dropped. (Only this group: other tests' run in parallel.)
        let pgid = process.pgid.unwrap();
        assert!(live_groups().as_ref().is_some_and(|g| g.contains(&pgid)), "registered");
        std::mem::forget(process);
        stop_groups(&[pgid], Duration::from_millis(500));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!alive(child));
    }

    fn tempfile_in_temp(kind: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("brama-agent-{kind}-{}.log", std::process::id()))
    }
}
