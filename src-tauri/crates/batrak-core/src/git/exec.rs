//! The one place that runs the `git` binary: closed stdin, pipes drained on their own threads,
//! a timeout, a cap on captured output, and an environment the parent can't leak into.

use std::ffi::OsStr;
use std::fmt;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

const LOCAL_TIMEOUT: Duration = Duration::from_secs(10);
/// A pre-commit hook may run a test suite.
const HOOKS_TIMEOUT: Duration = Duration::from_secs(600);
/// A fetch over a slow network, a credential helper waiting on the keychain.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// After SIGTERM on a timeout, how long git gets to remove its lock files before SIGKILL.
const TERM_GRACE: Duration = Duration::from_secs(3);
/// Captured stdout beyond this fails the call; the rest is drained so git can still exit.
pub const MAX_OUTPUT: usize = 32 * 1024 * 1024;
const MAX_STDERR: usize = 64 * 1024;
/// Start of the error for output over the cap; see `is_too_large`.
const TOO_LARGE: &str = "git output exceeded the limit";

/// Whether `run`/`run_with` failed because the output was over its cap.
pub fn is_too_large(err: &str) -> bool {
    err.starts_with(TOO_LARGE)
}

/// git processes alive at once, app-wide; more callers wait. Each one also costs two or three
/// pipe threads, and a burst (every restored tab asking for its baseline) must not fork dozens.
const MAX_CONCURRENT: usize = 4;

struct Permits {
    used: Mutex<usize>,
    freed: Condvar,
}

static PERMITS: Permits = Permits { used: Mutex::new(0), freed: Condvar::new() };

/// A slot for one git process, given back on drop.
struct Permit;

impl Permit {
    fn acquire() -> Permit {
        let mut used = PERMITS.used.lock().unwrap_or_else(PoisonError::into_inner);
        while *used >= MAX_CONCURRENT {
            used = PERMITS.freed.wait(used).unwrap_or_else(PoisonError::into_inner);
        }
        *used += 1;
        Permit
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        *PERMITS.used.lock().unwrap_or_else(PoisonError::into_inner) -= 1;
        PERMITS.freed.notify_one();
    }
}

#[cfg(test)]
thread_local! {
    /// A test's own timeout for the git calls of its thread: waiting out the real ones is no test.
    pub static TEST_TIMEOUT: std::cell::Cell<Option<Duration>> = const { std::cell::Cell::new(None) };
}

/// Inherited variables that would point git at another repository or index than `cwd`'s.
pub const SCRUBBED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CONFIG_PARAMETERS",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// A user-requested local operation.
    Local,
    /// A refresh the user didn't ask for (status, diffs): must not take `index.lock`,
    /// or it races the user's own git.
    Background,
    /// Runs the user's hooks or filters (a commit's `pre-commit`, LFS): a long timeout, and on it
    /// the whole process group is stopped, gently first, so git removes its `index.lock` and no
    /// hook keeps running.
    Hooks,
    /// Talks to a remote (a fetch the user asked for): credential helpers and ssh run, so like
    /// `Hooks` the whole process group is stopped on its timeout.
    Network,
}

impl Mode {
    /// git leads its own session and process group, stopped as a whole on a timeout: hooks and
    /// credential helpers it started hold our output pipes open and would outlive a kill of git alone.
    fn own_group(self) -> bool {
        matches!(self, Mode::Hooks | Mode::Network)
    }
}

#[derive(Debug, Default)]
pub struct Options<'a> {
    /// Written to git's stdin (then closed); without it stdin is null.
    pub input: Option<&'a [u8]>,
    /// Extra variables, applied after scrubbing (e.g. a temporary `GIT_INDEX_FILE`).
    pub env: &'a [(&'a str, &'a OsStr)],
    /// Cap on captured stdout; `MAX_OUTPUT` when `None`.
    pub max_output: Option<usize>,
    /// Once set, git is stopped as on a timeout and the call fails with `CANCELLED`.
    pub cancel: Option<&'a AtomicBool>,
}

/// The error of a call stopped through `Options::cancel`.
pub const CANCELLED: &str = "cancelled";

#[derive(Debug)]
pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn success(&self) -> bool {
        self.status.success()
    }

    pub fn stdout_str(&self) -> Result<&str, String> {
        std::str::from_utf8(&self.stdout).map_err(|_| "git printed non-UTF-8 output".to_owned())
    }
}

/// Runs git and returns stdout; a non-zero exit is an error carrying git's message.
pub fn run(git: &Path, cwd: &Path, args: &[&OsStr], mode: Mode) -> Result<Vec<u8>, String> {
    let out = run_with(git, cwd, args, mode, &Options::default())?;
    if out.success() {
        Ok(out.stdout)
    } else {
        Err(failure_message(&out))
    }
}

/// Runs git and returns its output whatever the exit code, for commands whose exit code is data
/// (`diff --exit-code`, `apply --3way` with conflicts).
pub fn run_with(git: &Path, cwd: &Path, args: &[&OsStr], mode: Mode, opts: &Options) -> Result<Output, String> {
    let started = Instant::now();
    let result = spawn_and_wait(git, cwd, args, mode, opts);
    // `elapsed` includes the wait for a permit: it's how long the caller was blocked.
    let elapsed = started.elapsed();
    match &result {
        Ok(out) => tracing::debug!(cwd = %cwd.display(), args = %Args(args), status = %out.status, ?elapsed, "git"),
        // Stopped on purpose (a workspace deleted while it checks out): nothing the user must hear of.
        Err(e) if e == CANCELLED => tracing::debug!(cwd = %cwd.display(), args = %Args(args), ?elapsed, "git cancelled"),
        // The first line: a timeout's error goes on with git's output, which may hold anything.
        Err(e) => tracing::warn!(cwd = %cwd.display(), args = %Args(args), ?elapsed, "git failed: {}", e.lines().next().unwrap_or_default()),
    }
    result
}

/// Arguments joined by spaces, for the log.
struct Args<'a>(&'a [&'a OsStr]);

impl fmt::Display for Args<'_> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        for (i, arg) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str(" ")?;
            }
            f.write_str(&arg.to_string_lossy())?;
        }
        Ok(())
    }
}

fn spawn_and_wait(git: &Path, cwd: &Path, args: &[&OsStr], mode: Mode, opts: &Options) -> Result<Output, String> {
    let mut command = Command::new(git);
    // Paths with non-ASCII names print as-is instead of octal-escaped.
    command.args(["-c", "core.quotepath=off"]).args(args).current_dir(cwd);
    for key in SCRUBBED_ENV {
        command.env_remove(key);
    }
    // Never block on a credential prompt nobody can answer; parse English output.
    command.env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    if mode == Mode::Background {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    for (key, value) in opts.env {
        command.env(key, value);
    }
    command
        .stdin(if opts.input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut command);
    #[cfg(unix)]
    if mode.own_group() {
        use std::os::unix::process::CommandExt;
        // A session of its own: it leads its process group, and has no controlling terminal, so ssh
        // fails at once instead of asking for a passphrase or a host key on the tty we were run from
        // (`GIT_TERMINAL_PROMPT` doesn't reach ssh). The user's ssh settings stay as they are.
        // SAFETY: `setsid` is async-signal-safe and touches nothing of the parent.
        unsafe {
            command.pre_exec(|| if libc::setsid() == -1 { Err(io::Error::last_os_error()) } else { Ok(()) });
        }
    }

    // Held until the process is reaped and its pipes drained; the timeout starts once it runs.
    let _permit = Permit::acquire();
    let mut child = command.spawn().map_err(|e| format!("failed to run git: {e}"))?;
    let writer = opts.input.map(|input| {
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let input = input.to_vec();
        // A broken pipe means git stopped reading; its exit status tells why.
        thread::spawn(move || drop(stdin.write_all(&input)))
    });
    let max_output = opts.max_output.unwrap_or(MAX_OUTPUT);
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let stdout = thread::spawn(move || read_capped(stdout, max_output));
    let stderr = thread::spawn(move || read_capped(stderr, MAX_STDERR));

    let timeout = match mode {
        Mode::Local | Mode::Background => LOCAL_TIMEOUT,
        Mode::Hooks => HOOKS_TIMEOUT,
        Mode::Network => NETWORK_TIMEOUT,
    };
    #[cfg(test)]
    let timeout = TEST_TIMEOUT.get().unwrap_or(timeout);
    let status = wait_with_timeout(&mut child, timeout, mode.own_group(), opts.cancel);
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let (stdout, truncated) = stdout.join().unwrap_or_default();
    let (stderr, _) = stderr.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr).trim().to_owned();
    let status = status.map_err(|e| stopped_message(e, &stderr))?;
    if truncated {
        return Err(format!("{TOO_LARGE} ({max_output} bytes)"));
    }
    Ok(Output { status, stdout, stderr })
}

/// The error of a git that was stopped (`wait_with_timeout`'s), with what it printed before: where it
/// got stuck.
fn stopped_message(error: String, stderr: &str) -> String {
    if stderr.is_empty() {
        error
    } else {
        format!("{error}\n{stderr}")
    }
}

/// git's own message for a failed call, or its exit status when it printed nothing.
pub fn failure_message(out: &Output) -> String {
    if out.stderr.is_empty() {
        format!("git exited with {}", out.status)
    } else {
        out.stderr.clone()
    }
}

/// Reads up to `cap` bytes, then drains the rest so the writer never blocks on a full pipe.
fn read_capped(pipe: impl Read, cap: usize) -> (Vec<u8>, bool) {
    let mut bytes = Vec::new();
    let mut pipe = pipe;
    if (&mut pipe).take(cap as u64 + 1).read_to_end(&mut bytes).is_err() {
        return (bytes, false);
    }
    let truncated = bytes.len() > cap;
    if truncated {
        bytes.truncate(cap);
        let _ = io::copy(&mut pipe, &mut io::sink());
    }
    (bytes, truncated)
}

/// `group`: the child leads its own process group (`Mode::own_group`), stopped as a whole on
/// timeout or once `cancel` is set.
fn wait_with_timeout(child: &mut Child, timeout: Duration, group: bool, cancel: Option<&AtomicBool>) -> Result<ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() > timeout || cancel.is_some_and(|c| c.load(Ordering::SeqCst)) => {
                let timed_out = started.elapsed() > timeout;
                if group {
                    stop_group(child);
                } else {
                    let _ = child.kill();
                }
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
fn stop_group(child: &mut Child) {
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

/// Windows has no process groups to signal here: the git process alone is killed.
#[cfg(not(unix))]
fn stop_group(child: &mut Child) {
    let _ = child.kill();
}

/// A path in the temp directory for a file git reads or writes (a temporary index, a commit
/// message); removed on drop.
pub struct TempFile {
    pub path: PathBuf,
}

impl TempFile {
    pub fn new(kind: &str) -> TempFile {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        TempFile { path: std::env::temp_dir().join(format!("brama-{kind}-{}-{n}", std::process::id())) }
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(windows)]
fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_command: &mut Command) {}

/// `OsStr` arguments from anything path- or string-like, for `run` call sites.
pub fn args<'a>(parts: &'a [&'a dyn AsRef<OsStr>]) -> Vec<&'a OsStr> {
    parts.iter().map(|p| p.as_ref()).collect()
}

/// Canonical form of a path git printed, so it compares with our roots (`/private/var` vs `/var`).
pub fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn stopping_a_group_stops_the_children_too() {
        use std::io::BufRead;
        use std::os::unix::process::CommandExt;
        // Like a hook: a child of the process we wait on, holding its output pipe.
        let mut child = Command::new("sh")
            .args(["-c", "sleep 60 & echo $!; wait"])
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut line = String::new();
        io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let sleeper: libc::pid_t = line.trim().parse().unwrap();
        stop_group(&mut child);
        child.wait().unwrap();
        thread::sleep(Duration::from_millis(100));
        // SAFETY: signal 0 only checks that the process exists.
        assert_ne!(unsafe { libc::kill(sleeper, 0) }, 0, "the hook's child is gone");
    }

    #[cfg(unix)]
    #[test]
    fn a_git_running_hooks_has_no_terminal_and_leads_its_own_process_group() {
        use std::os::unix::fs::PermissionsExt;
        // Arrange: a git that notes its pid, then runs a while
        let dir = crate::git::test_repo::temp_dir("hooks-session");
        let (git, pid_file) = (dir.join("git"), dir.join("pid"));
        std::fs::write(&git, format!("#!/bin/sh\necho $$ > '{}'\nsleep 1\n", pid_file.display())).unwrap();
        std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();

        thread::scope(|scope| {
            // Act
            let running = scope.spawn(|| run(&git, &dir, &[OsStr::new("commit")], Mode::Hooks));
            let pid = loop {
                if let Some(pid) = std::fs::read_to_string(&pid_file).ok().and_then(|t| t.trim().parse::<libc::pid_t>().ok()) {
                    break pid;
                }
                thread::sleep(Duration::from_millis(5));
            };
            // SAFETY: plain queries of a process that is still running.
            let (session, group) = unsafe { (libc::getsid(pid), libc::getpgid(pid)) };

            // Assert: a session of its own has no terminal for ssh to prompt on; the group is stopped on a timeout
            assert_eq!((session, group), (pid, pid), "session and process group of {pid}");
            running.join().unwrap().unwrap();
        });
    }
    use crate::git::test_repo::{git_bin, TestRepo};

    #[test]
    fn caps_output_and_still_lets_git_exit() {
        let repo = TestRepo::new("cap");
        repo.write("big.txt", &"x".repeat(4096));
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "big"]);
        let opts = Options { max_output: Some(1024), ..Default::default() };
        let err = run_with(&git_bin(), &repo.path, &args(&[&"show", &"HEAD:big.txt"]), Mode::Local, &opts)
            .unwrap_err();
        assert!(is_too_large(&err), "{err}");
    }

    #[test]
    fn non_zero_exit_carries_git_message() {
        let repo = TestRepo::new("fail");
        let err = run(&git_bin(), &repo.path, &args(&[&"rev-parse", &"no-such-ref"]), Mode::Local).unwrap_err();
        assert!(err.contains("no-such-ref"), "{err}");
    }

    #[test]
    fn scrubbed_variables_include_repository_redirects() {
        // Setting them process-wide would leak into tests running in parallel, so check the list.
        for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] {
            assert!(SCRUBBED_ENV.contains(&key), "{key}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_timeout_keeps_what_git_said() {
        use std::os::unix::fs::PermissionsExt;
        let cases = [("echo 'Connecting to h' >&2; sleep 30", Some("Connecting to h")), ("exec sleep 30", None)];
        for (body, said) in cases {
            // Arrange: a git that outlives a short timeout
            let dir = crate::git::test_repo::temp_dir("timeout");
            let git = dir.join("git");
            std::fs::write(&git, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
            TEST_TIMEOUT.set(Some(Duration::from_millis(1500)));

            // Act
            let err = run(&git, &dir, &[OsStr::new("status")], Mode::Local).unwrap_err();
            TEST_TIMEOUT.set(None);

            // Assert
            assert!(err.contains("timed out"), "{err}");
            assert!(said.is_none_or(|s| err.contains(s)), "{body}: {err}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_cancelled_call_is_no_failure_the_user_hears_of() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::layer::SubscriberExt;
        /// The levels of the events logged while it's the default subscriber.
        struct Levels(Arc<Mutex<Vec<tracing::Level>>>);
        impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Levels {
            fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
                self.0.lock().unwrap().push(*event.metadata().level());
            }
        }
        // Arrange: a git that would run for long, already cancelled
        let dir = crate::git::test_repo::temp_dir("cancelled");
        let git = dir.join("git");
        std::fs::write(&git, "#!/bin/sh
exec sleep 30
").unwrap();
        std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cancel = AtomicBool::new(true);
        let levels = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry().with(Levels(Arc::clone(&levels)));

        // Act
        let result = tracing::subscriber::with_default(subscriber, || {
            run_with(&git, &dir, &[OsStr::new("status")], Mode::Hooks, &Options { cancel: Some(&cancel), ..Options::default() })
        });

        // Assert
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert!(!levels.lock().unwrap().iter().any(|l| *l <= tracing::Level::WARN), "no warn, so no snackbar: {:?}", levels.lock().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn at_most_max_concurrent_processes_at_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..MAX_CONCURRENT * 3)
            .map(|_| {
                let (active, peak) = (Arc::clone(&active), Arc::clone(&peak));
                thread::spawn(move || {
                    let _permit = Permit::acquire();
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(20));
                    active.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        // Other tests may hold permits too, so the peak here can only be lower.
        assert!(peak.load(Ordering::SeqCst) <= MAX_CONCURRENT);
        assert!(peak.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn input_reaches_stdin() {
        let repo = TestRepo::new("stdin");
        let opts = Options { input: Some(b"hello"), ..Default::default() };
        let out =
            run_with(&git_bin(), &repo.path, &args(&[&"hash-object", &"--stdin"]), Mode::Local, &opts).unwrap();
        assert_eq!(out.stdout_str().unwrap().trim(), "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
    }
}
