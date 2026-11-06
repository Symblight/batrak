//! The one place that runs the `git` binary: closed stdin, pipes drained on their own threads,
//! a timeout, a cap on captured output, and an environment the parent can't leak into.

use std::ffi::OsStr;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use self::permit::Permit;
use self::pipes::{Capture, Feed, PIPE_GRACE};
use self::stop::wait_with_timeout;

mod permit;
mod pipes;
mod stop;
#[cfg(test)]
mod tests;

const LOCAL_TIMEOUT: Duration = Duration::from_secs(10);
/// A pre-commit hook may run a test suite.
const HOOKS_TIMEOUT: Duration = Duration::from_secs(600);
/// A fetch over a slow network, a credential helper waiting on the keychain.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// Captured stdout beyond this fails the call; the rest is drained so git can still exit.
pub const MAX_OUTPUT: usize = 32 * 1024 * 1024;
const MAX_STDERR: usize = 64 * 1024;
/// Start of the error for output over the cap; see `is_too_large`.
const TOO_LARGE: &str = "git output exceeded the limit";

/// Whether `run`/`run_with` failed because the output was over its cap.
pub fn is_too_large(err: &str) -> bool {
    err.starts_with(TOO_LARGE)
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
    /// Runs the user's hooks or filters (a commit's `pre-commit`, a checkout, LFS): a long timeout.
    Hooks,
    /// Talks to a remote (a fetch the user asked for): credential helpers and ssh run.
    Network,
}

impl Mode {
    /// Takes a slot of `MAX_CONCURRENT`.
    fn short(self) -> bool {
        matches!(self, Mode::Local | Mode::Background)
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
        // Nobody asked for it, and its caller shows the error where the answer would be: a slow repository
        // must not raise a snackbar on every refresh.
        Err(e) if mode == Mode::Background => tracing::debug!(cwd = %cwd.display(), args = %Args(args), ?elapsed, "git failed: {}", e.lines().next().unwrap_or_default()),
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
    command.args(["-c", "core.quotepath=off"]);
    // `core.fsmonitor` can name a program in the repository's config: a refresh nobody asked for must
    // not run code from a folder that was only opened. A later `-c` wins: see `status::status_in`.
    if mode == Mode::Background {
        command.args(["-c", "core.fsmonitor=false"]);
    }
    command.args(args).current_dir(cwd);
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
    {
        use std::io;
        use std::os::unix::process::CommandExt;
        // A session of its own: it leads its process group, stopped as a whole on a timeout, gently
        // first so git removes its `index.lock` (hooks, filters and credential helpers hold our pipes
        // and would outlive a kill of git alone), and has no controlling terminal, so ssh fails at
        // once instead of asking for a passphrase or a host key on the tty we were run from
        // (`GIT_TERMINAL_PROMPT` doesn't reach ssh). The user's ssh settings stay as they are.
        // SAFETY: `setsid` is async-signal-safe and touches nothing of the parent.
        unsafe {
            command.pre_exec(|| if libc::setsid() == -1 { Err(io::Error::last_os_error()) } else { Ok(()) });
        }
    }

    // Held until the process is reaped and its pipes drained; the timeout starts once it runs.
    let _permit = mode.short().then(Permit::acquire);
    let mut child = command.spawn().map_err(|e| format!("failed to run git: {e}"))?;
    let feed = opts.input.map(|input| Feed::start(child.stdin.take().expect("stdin is piped"), input.to_vec()));
    let max_output = opts.max_output.unwrap_or(MAX_OUTPUT);
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let stdout = Capture::start(stdout, max_output);
    let stderr = Capture::start(stderr, MAX_STDERR);

    let timeout = match mode {
        Mode::Local | Mode::Background => LOCAL_TIMEOUT,
        Mode::Hooks => HOOKS_TIMEOUT,
        Mode::Network => NETWORK_TIMEOUT,
    };
    #[cfg(test)]
    let timeout = TEST_TIMEOUT.get().unwrap_or(timeout);
    let status = wait_with_timeout(&mut child, timeout, opts.cancel);
    // One grace from here for all that's still open, so a left-behind child can't make it add up.
    let deadline = Instant::now() + PIPE_GRACE;
    if let Some(feed) = feed {
        feed.finish(deadline);
    }
    let (stdout, truncated) = stdout.finish(deadline);
    let (stderr, _) = stderr.finish(deadline);
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
