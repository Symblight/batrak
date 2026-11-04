//! Terminal tabs: the user's shell in a pseudo-terminal, one per tab, owned by the window that
//! opened it. A reader thread per terminal keeps its last output (`OUTPUT_KEPT`) and streams it to
//! the page attached, if any, pausing while the page is behind (`ack`); a waiter thread reports the
//! shell's exit. The shell outlives its tab's DOM until the tab closes. Input and output are never
//! logged (they hold passwords typed at prompts).

pub mod shell;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

#[cfg(not(unix))]
use portable_pty::ChildKiller;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

/// Output kept per terminal for a page that attaches later.
pub const OUTPUT_KEPT: usize = 1024 * 1024;
/// After SIGHUP on close, how long the shell's groups get before SIGKILL.
const HANGUP_GRACE: Duration = Duration::from_secs(2);
const READ_CHUNK: usize = 64 * 1024;
/// Output sent to the page and not yet acknowledged (`ack`) past which reading pauses...
pub const FLOW_PAUSE_AT: usize = 256 * 1024;
/// ...until no more than this is left. The page acknowledges in smaller steps.
const FLOW_RESUME_AT: usize = 32 * 1024;
/// How long the shell's last output gets to arrive before its exit is reported: a background job
/// may hold the terminal open after the shell is gone (and ConPTY's never ends while it's open).
const EXIT_DRAIN: Duration = Duration::from_millis(100);
/// How often the waiter looks whether the shell ended, where it can't wait without reaping it.
#[cfg(not(unix))]
const EXIT_POLL: Duration = Duration::from_millis(50);
/// A program turns bracketed paste on (`ESC[?2004h`) when it reads its input, and off (`…l`).
const BRACKETED_ON: &[u8] = b"\x1b[?2004h";
const BRACKETED_OFF: &[u8] = b"\x1b[?2004l";
const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";
/// How often `paste_when_ready` looks whether the program reads.
const READY_POLL: Duration = Duration::from_millis(50);

/// When `paste_when_ready` takes a program as reading its input.
#[derive(Debug, Clone, Copy)]
pub struct PasteWait {
    /// After its last output: settled once bracketed paste is on; reading anyway without it (ConPTY
    /// may not pass `ESC[?2004h` through) after this much again.
    pub quiet: Duration,
    /// Given up, nothing pasted, when it has printed nothing this long after its start.
    pub give_up: Duration,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// The shell ended: its exit code, or the signal that ended it (`SIGKILL`).
    Exit { code: Option<i32>, signal: Option<String> },
}

/// Where an attached terminal's output and events go: the page's channels, a recorder in tests.
/// `false` means the receiver is gone.
pub trait TerminalSink: Send + Sync {
    fn output(&self, bytes: &[u8]) -> bool;
    fn event(&self, event: &TerminalEvent) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// The shell's file name (`zsh`).
    pub shell: String,
    /// The folder it started in.
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Busy {
    pub id: String,
    /// The foreground program's name (`vim`).
    pub process: String,
}

pub struct OpenRequest<'a> {
    pub id: &'a str,
    /// The window that owns it.
    pub group: &'a str,
    pub cwd: &'a Path,
    /// Used when `cwd` doesn't exist.
    pub fallback: Option<&'a Path>,
    pub cols: u16,
    pub rows: u16,
}

/// A program a terminal runs instead of the shell (a sign-in's login), with its whole environment.
pub struct Program {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// How a program's terminal ended: its exit, or `None` when it was closed first.
pub type OnExit = Box<dyn FnOnce(Option<&TerminalEvent>) + Send>;

pub struct TerminalsOptions {
    /// The shell to run; `None` = the user's default (`shell::default_shell()`).
    pub shell: Option<PathBuf>,
    /// `TERM_PROGRAM_VERSION`.
    pub version: String,
}

#[derive(Clone)]
pub struct Terminals {
    inner: Arc<Inner>,
}

struct Inner {
    opts: TerminalsOptions,
    terminals: Mutex<HashMap<String, Arc<Terminal>>>,
    /// Held through `open`, so one id never starts two shells.
    opening: Mutex<()>,
}

struct Terminal {
    group: String,
    opened: Opened,
    shell: Mutex<ShellGroup>,
    /// Wakes the waiter held back by `ShellGroup::kill_due`.
    killed: Condvar,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    /// Stops the shell where there are no process groups to signal.
    #[cfg(not(unix))]
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    stream: Mutex<Stream>,
    /// Wakes the reader paused on `Stream::unacked`.
    flow: Condvar,
    closed: AtomicBool,
}

/// The shell's pid, which is also its session and process group id, while it may be signalled:
/// until the shell is reaped, which frees the id for another process (group).
struct ShellGroup {
    pid: Option<i32>,
    /// A close's SIGKILL is still to come: the shell stays unreaped (its group's id ours) until then.
    kill_due: bool,
}

#[derive(Default)]
struct Stream {
    output: Ring,
    sink: Option<Arc<dyn TerminalSink>>,
    exit: Option<TerminalEvent>,
    attached_before: bool,
    /// Bytes sent to `sink` that the page hasn't acknowledged.
    unacked: usize,
    /// The reader waits for the page.
    paused: bool,
    /// The program last turned bracketed paste on (it reads its input), not off.
    bracketed: bool,
    /// The last output's end, where a mode switch cut between two reads begins.
    mode_tail: Vec<u8>,
    /// When the program last printed something.
    last_output: Option<std::time::Instant>,
}

impl Stream {
    /// Follows the program's bracketed paste mode through `bytes`, the last switch winning.
    fn note_modes(&mut self, bytes: &[u8]) {
        let mut seen = std::mem::take(&mut self.mode_tail);
        seen.extend_from_slice(&bytes[..bytes.len().min(BRACKETED_ON.len())]);
        let head = last_switch(&seen);
        let body = last_switch(bytes);
        if let Some(on) = body.or(head) {
            self.bracketed = on;
        }
        let keep = bytes.len().min(BRACKETED_ON.len() - 1);
        self.mode_tail = bytes[bytes.len() - keep..].to_vec();
    }
}

/// Whether `bytes`' last bracketed paste switch turns it on; `None` without one.
fn last_switch(bytes: &[u8]) -> Option<bool> {
    let at = |needle: &[u8]| bytes.windows(needle.len()).rposition(|w| w == needle);
    match (at(BRACKETED_ON), at(BRACKETED_OFF)) {
        (Some(on), Some(off)) => Some(on > off),
        (on, off) => on.map(|_| true).or(off.map(|_| false)),
    }
}

/// `text` as a paste: bracketed (with any end marker inside it defused) while the program reads
/// bracketed pastes, else on one line (line breaks would each be an Enter).
fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
    if !bracketed {
        return text.replace("\r\n", " ").replace(['\n', '\r'], " ").replace('\x1b', "").into_bytes();
    }
    let mut bytes = PASTE_START.to_vec();
    bytes.extend_from_slice(text.replace('\x1b', "").as_bytes());
    bytes.extend_from_slice(PASTE_END);
    bytes
}

impl Terminals {
    pub fn new(opts: TerminalsOptions) -> Terminals {
        Terminals { inner: Arc::new(Inner { opts, terminals: Mutex::default(), opening: Mutex::default() }) }
    }

    fn get(&self, id: &str) -> Result<Arc<Terminal>, String> {
        lock(&self.inner.terminals).get(id).cloned().ok_or_else(|| format!("unknown terminal {id}"))
    }

    /// Whether `id` is a terminal the window `group` opened: a window reaches only its own.
    pub fn owns(&self, group: &str, id: &str) -> bool {
        lock(&self.inner.terminals).get(id).is_some_and(|t| t.group == group)
    }

    /// The terminals among `ids` that the window `group` opened.
    pub fn of_group(&self, group: &str, ids: &[String]) -> Vec<String> {
        let terminals = lock(&self.inner.terminals);
        ids.iter().filter(|id| terminals.get(id.as_str()).is_some_and(|t| t.group == group)).cloned().collect()
    }

    /// Starts a shell in `req.cwd` (or the fallback when it doesn't exist), which `allowed` must
    /// accept. A running id answers with what it runs; an exited one starts a fresh shell.
    /// Blocking.
    pub fn open(&self, req: &OpenRequest, allowed: &dyn Fn(&Path) -> bool) -> Result<Opened, String> {
        self.start(req, allowed, None, None)
    }

    /// Like `open`, but runs `program` instead of the shell, in `req.cwd` (which the caller chose:
    /// no folder check); `on_exit` hears how it ended. Blocking.
    pub fn open_program(&self, req: &OpenRequest, program: Program, on_exit: OnExit) -> Result<Opened, String> {
        self.start(req, &|_| true, Some(program), Some(on_exit))
    }

    fn start(&self, req: &OpenRequest, allowed: &dyn Fn(&Path) -> bool, program: Option<Program>, on_exit: Option<OnExit>) -> Result<Opened, String> {
        let _opening = lock(&self.inner.opening);
        if let Some(existing) = lock(&self.inner.terminals).get(req.id) {
            if existing.group != req.group {
                return Err(format!("terminal {} belongs to another window", req.id));
            }
            if lock(&existing.stream).exit.is_none() {
                return Ok(existing.opened.clone());
            }
        }
        let cwd = resolve_cwd(req.cwd, req.fallback, allowed)?;
        let shell = match &program {
            Some(program) => PathBuf::from(&program.program),
            None => self.inner.opts.shell.clone().unwrap_or_else(shell::default_shell),
        };
        let shell_name = shell.file_name().map_or_else(|| shell.to_string_lossy(), |n| n.to_string_lossy()).into_owned();
        let size = PtySize { rows: req.rows.max(1), cols: req.cols.max(1), pixel_width: 0, pixel_height: 0 };
        let pair = portable_pty::native_pty_system()
            .openpty(size)
            .map_err(|e| format!("Couldn't start {shell_name}: {e}"))?;
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&cwd);
        cmd.env_clear();
        match program {
            Some(program) => {
                cmd.args(&program.args);
                let env = program.env.into_iter().map(|(k, v)| (k.into(), v.into()));
                for (k, v) in shell::terminal_env(env, &self.inner.opts.version) {
                    cmd.env(k, v);
                }
            }
            None => {
                if cfg!(unix) {
                    cmd.arg("-l");
                }
                for (k, v) in shell::terminal_env(std::env::vars_os(), &self.inner.opts.version) {
                    cmd.env(k, v);
                }
            }
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
            tracing::warn!(shell = %shell.display(), "terminal didn't start: {e}");
            format!("Couldn't start {shell_name}: {e}")
        })?;
        // Our copy of the slave would keep the master from reading EOF once the shell is gone.
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string());
        let writer = pair.master.take_writer().map_err(|e| e.to_string());
        let (mut reader, writer) = match (reader, writer) {
            (Ok(r), Ok(w)) => (r, w),
            (Err(e), _) | (_, Err(e)) => {
                let _ = child.kill();
                return Err(format!("Couldn't start {shell_name}: {e}"));
            }
        };
        let pid = child.process_id().and_then(|p| i32::try_from(p).ok());
        #[cfg(not(unix))]
        let killer = child.clone_killer();
        let cwd_text = cwd.to_string_lossy().into_owned();
        tracing::info!(id = req.id, shell = %shell.display(), cwd = %cwd_text, "terminal started");
        let terminal = Arc::new(Terminal {
            group: req.group.to_owned(),
            opened: Opened { shell: shell_name, cwd: cwd_text },
            shell: Mutex::new(ShellGroup { pid, kill_due: false }),
            killed: Condvar::new(),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            #[cfg(not(unix))]
            killer: Mutex::new(killer),
            stream: Mutex::default(),
            flow: Condvar::new(),
            closed: AtomicBool::new(false),
        });
        // A restart keeps the page's attachment.
        if let Some(old) = lock(&self.inner.terminals).insert(req.id.to_owned(), terminal.clone()) {
            let sink = lock(&old.stream).sink.take();
            old.flow.notify_all();
            lock(&terminal.stream).sink = sink;
        }
        let (read_all, read_done) = mpsc::channel::<()>();
        let reading = terminal.clone();
        let id = req.id.to_owned();
        std::thread::Builder::new()
            .name(format!("terminal-{id}"))
            .spawn(move || {
                let mut buf = vec![0u8; READ_CHUNK];
                loop {
                    reading.wait_for_page();
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut stream = lock(&reading.stream);
                            stream.output.push(&buf[..n]);
                            stream.note_modes(&buf[..n]);
                            stream.last_output = Some(std::time::Instant::now());
                            match stream.sink.as_ref().map(|sink| sink.output(&buf[..n])) {
                                Some(true) => stream.unacked += n,
                                Some(false) => stream.sink = None,
                                None => {}
                            }
                        }
                    }
                }
                let _ = read_all.send(());
            })
            .map_err(|e| e.to_string())?;
        let waiting = terminal.clone();
        let id = req.id.to_owned();
        let mut on_exit = on_exit;
        std::thread::Builder::new()
            .name(format!("terminal-{id}-wait"))
            .spawn(move || {
                // Before taking the shell's lock, which a close needs while the shell runs.
                #[cfg(unix)]
                if let Some(pid) = pid {
                    wait_exited(pid);
                }
                #[cfg(not(unix))]
                while matches!(child.try_wait(), Ok(None)) {
                    std::thread::sleep(EXIT_POLL);
                }
                // Closed and gone: heard now, not once the close's grace is over.
                if waiting.closed.load(Ordering::SeqCst) {
                    if let Some(on_exit) = on_exit.take() {
                        on_exit(None);
                    }
                }
                let exit = {
                    let mut shell = lock(&waiting.shell);
                    while shell.kill_due {
                        shell = waiting.killed.wait(shell).unwrap_or_else(PoisonError::into_inner);
                    }
                    shell.pid = None;
                    exit_event(child.as_mut())
                };
                // Its last output first, however long the page takes to draw it.
                while let Err(mpsc::RecvTimeoutError::Timeout) = read_done.recv_timeout(EXIT_DRAIN) {
                    if !lock(&waiting.stream).paused {
                        break;
                    }
                }
                if waiting.closed.load(Ordering::SeqCst) {
                    if let Some(on_exit) = on_exit.take() {
                        on_exit(None);
                    }
                    return;
                }
                tracing::info!(id, ?exit, "terminal exited");
                lock(&waiting.writer).take();
                lock(&waiting.master).take();
                {
                    let mut stream = lock(&waiting.stream);
                    if let Some(sink) = &stream.sink {
                        sink.event(&exit);
                    }
                    stream.exit = Some(exit.clone());
                }
                if let Some(on_exit) = on_exit {
                    on_exit(Some(&exit));
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(terminal.opened.clone())
    }

    /// Sends the kept output, then streams to `sink` (replacing an earlier attachment). An exited
    /// terminal also gets its exit again. A reattached one is told its size again (`SIGWINCH`),
    /// so full-screen programs redraw.
    pub fn attach(&self, id: &str, sink: Arc<dyn TerminalSink>) -> Result<(), String> {
        let terminal = self.get(id)?;
        let mut stream = lock(&terminal.stream);
        let kept = stream.output.contents();
        let replayed = kept.len();
        if replayed > 0 {
            sink.output(kept);
        }
        if let Some(exit) = &stream.exit {
            sink.event(exit);
        } else if stream.attached_before {
            if let Some(group) = terminal.foreground() {
                signal_group(group, Signal::Winch);
            }
        }
        stream.attached_before = true;
        stream.sink = Some(sink);
        stream.unacked = replayed;
        terminal.flow.notify_all();
        Ok(())
    }

    /// Input for the shell. Blocking (a shell that doesn't read fills the PTY).
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        self.get(id)?.write(data)
    }

    /// Pastes `text` once the program reads its input (`wait`), into the terminal open now (never a
    /// later one under the same id). No Enter: a dialog the program shows first (a folder's trust)
    /// mustn't be answered for the user. In the background; given up if the terminal ends first.
    pub fn paste_when_ready(&self, id: &str, text: &str, wait: PasteWait) {
        let Ok(terminal) = self.get(id) else { return };
        let (id, text) = (id.to_owned(), text.to_owned());
        let spawned = std::thread::Builder::new().name(format!("terminal-{id}-paste")).spawn(move || {
            let started = std::time::Instant::now();
            let bracketed = loop {
                if terminal.closed.load(Ordering::SeqCst) {
                    return;
                }
                let (exited, bracketed, last_output) = {
                    let stream = lock(&terminal.stream);
                    (stream.exit.is_some(), stream.bracketed, stream.last_output)
                };
                if exited {
                    return;
                }
                match last_output {
                    Some(at) if bracketed && at.elapsed() >= READY_POLL * 4 => break true,
                    Some(at) if at.elapsed() >= wait.quiet => break false,
                    None if started.elapsed() >= wait.give_up => {
                        tracing::warn!(id, "the agent's CLI printed nothing; its first prompt wasn't pasted");
                        return;
                    }
                    _ => {}
                }
                std::thread::sleep(READY_POLL);
            };
            if let Err(e) = terminal.write(&paste_bytes(&text, bracketed)) {
                tracing::warn!(id, "pasting the first prompt failed: {e}");
            }
        });
        if let Err(e) = spawned {
            tracing::warn!(%e, "couldn't wait to paste into a terminal");
        }
    }

    /// The page has drawn `bytes` of what it was sent.
    pub fn ack(&self, id: &str, bytes: usize) {
        let Ok(terminal) = self.get(id) else { return };
        let mut stream = lock(&terminal.stream);
        stream.unacked = stream.unacked.saturating_sub(bytes);
        terminal.flow.notify_all();
    }

    /// Forgets the output kept for the next attach, but the line being written (a prompt, say).
    pub fn clear_output(&self, id: &str) -> Result<(), String> {
        lock(&self.get(id)?.stream).output.clear();
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let terminal = self.get(id)?;
        let master = lock(&terminal.master);
        let master = master.as_ref().ok_or("the terminal is closed")?;
        let size = PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 };
        master.resize(size).map_err(|e| e.to_string())
    }

    /// The terminals among `ids` running something other than their shell in the foreground.
    pub fn busy(&self, ids: &[String]) -> Vec<Busy> {
        ids.iter()
            .filter_map(|id| {
                let terminal = self.get(id).ok()?;
                let foreground = terminal.foreground()?;
                if Some(foreground) == lock(&terminal.shell).pid || lock(&terminal.stream).exit.is_some() {
                    return None;
                }
                Some(Busy { id: id.clone(), process: process_name(foreground)? })
            })
            .collect()
    }

    /// Hangs up each terminal's shell and foreground job, kills what's left after a grace period.
    pub fn close(&self, ids: &[String]) {
        let closing: Vec<_> = {
            let mut terminals = lock(&self.inner.terminals);
            ids.iter().filter_map(|id| terminals.remove(id).map(|t| (id.clone(), t))).collect()
        };
        for (id, terminal) in closing {
            tracing::info!(id, "terminal closed");
            let foreground = terminal.hang_up();
            std::thread::spawn(move || {
                std::thread::sleep(HANGUP_GRACE);
                terminal.kill(foreground);
            });
        }
    }

    /// Closes every terminal a window opened: when it is destroyed or its page loads again.
    pub fn close_group(&self, group: &str) {
        let ids: Vec<String> =
            lock(&self.inner.terminals).iter().filter(|(_, t)| t.group == group).map(|(id, _)| id.clone()).collect();
        self.close(&ids);
    }

    /// App exit: every terminal hung up, then killed after `grace`. Blocking.
    pub fn stop_all(&self, grace: Duration) {
        let all: Vec<_> = lock(&self.inner.terminals).drain().map(|(_, t)| t).collect();
        if all.is_empty() {
            return;
        }
        tracing::info!(count = all.len(), "stopping terminals");
        let foregrounds: Vec<_> = all.iter().map(|t| t.hang_up()).collect();
        std::thread::sleep(grace);
        for (terminal, foreground) in all.iter().zip(foregrounds) {
            terminal.kill(foreground);
        }
    }
}

impl Terminal {
    fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = lock(&self.writer);
        let writer = writer.as_mut().ok_or("the terminal is closed")?;
        writer.write_all(data).and_then(|()| writer.flush()).map_err(|e| e.to_string())
    }

    /// Once the page is `FLOW_PAUSE_AT` behind, waits until it's caught up to `FLOW_RESUME_AT` (or
    /// is gone), leaving the shell's output in the PTY meanwhile.
    fn wait_for_page(&self) {
        let mut stream = lock(&self.stream);
        if stream.unacked <= FLOW_PAUSE_AT {
            return;
        }
        stream.paused = true;
        while stream.sink.is_some() && stream.unacked > FLOW_RESUME_AT && !self.closed.load(Ordering::SeqCst) {
            stream = self.flow.wait(stream).unwrap_or_else(PoisonError::into_inner);
        }
        stream.paused = false;
    }

    #[cfg(unix)]
    fn foreground(&self) -> Option<i32> {
        lock(&self.master).as_ref()?.process_group_leader()
    }

    /// Windows has no foreground process group to ask a console for.
    #[cfg(not(unix))]
    fn foreground(&self) -> Option<i32> {
        None
    }

    /// SIGHUP to the shell's group and the foreground group, then the PTY dropped; `kill` is due
    /// next. Never waits for a write in flight, which a job that doesn't read can block until it's
    /// killed. Returns the foreground group signalled, if it isn't the shell's.
    fn hang_up(&self) -> Option<i32> {
        self.closed.store(true, Ordering::SeqCst);
        let shell = {
            let mut shell = lock(&self.shell);
            shell.kill_due = shell.pid.is_some();
            shell.pid
        };
        let foreground = self.foreground().filter(|&g| Some(g) != shell);
        for group in shell.into_iter().chain(foreground) {
            signal_group(group, Signal::Hangup);
        }
        #[cfg(not(unix))]
        let _ = lock(&self.killer).kill();
        // A blocked write ends once the job is gone; later ones find the terminal forgotten.
        match self.writer.try_lock() {
            Ok(mut writer) => drop(writer.take()),
            Err(std::sync::TryLockError::Poisoned(e)) => drop(e.into_inner().take()),
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        lock(&self.master).take();
        lock(&self.stream).sink = None;
        self.flow.notify_all();
        foreground
    }

    /// After `hang_up`'s grace: SIGKILL to what's left of the shell's group (if the shell wasn't
    /// reaped meanwhile, which only `kill_due` holds back once it has ended) and of `foreground`.
    fn kill(&self, foreground: Option<i32>) {
        let mut shell = lock(&self.shell);
        for group in shell.pid.into_iter().chain(foreground) {
            signal_group(group, Signal::Kill);
        }
        shell.kill_due = false;
        self.killed.notify_all();
    }
}

/// `cwd` canonicalized, or `fallback` when `cwd` doesn't exist; a directory `allowed` accepts.
fn resolve_cwd(cwd: &Path, fallback: Option<&Path>, allowed: &dyn Fn(&Path) -> bool) -> Result<PathBuf, String> {
    let resolved = match dunce::canonicalize(cwd) {
        Ok(path) => path,
        Err(e) => {
            let fallback = fallback.ok_or_else(|| format!("{}: {e}", cwd.display()))?;
            dunce::canonicalize(fallback).map_err(|e| format!("{}: {e}", fallback.display()))?
        }
    };
    if !resolved.is_dir() {
        return Err(format!("{}: not a folder", resolved.display()));
    }
    if !allowed(&resolved) {
        return Err(format!("{}: not a project, session or home folder", resolved.display()));
    }
    Ok(resolved)
}

/// Waits for our child `pid` to end, leaving it unreaped, so its pid stays ours to signal.
#[cfg(unix)]
fn wait_exited(pid: i32) {
    let Ok(id) = libc::id_t::try_from(pid) else { return };
    loop {
        // SAFETY: zeroed `siginfo_t` is valid; waitid only writes into it.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: a plain syscall on our own child; WNOWAIT leaves it for `wait()` to reap.
        let done = unsafe { libc::waitid(libc::P_PID, id, &mut info, libc::WEXITED | libc::WNOWAIT) };
        if done == 0 || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return;
        }
    }
}

fn exit_event(child: &mut (dyn portable_pty::Child + Send + Sync)) -> TerminalEvent {
    #[cfg(unix)]
    if let Some(child) = (child as &mut dyn portable_pty::Child).downcast_mut::<std::process::Child>() {
        use std::os::unix::process::ExitStatusExt;
        return match child.wait() {
            Ok(status) => match status.signal() {
                Some(signal) => TerminalEvent::Exit { code: None, signal: Some(signal_name(signal)) },
                None => TerminalEvent::Exit { code: status.code(), signal: None },
            },
            Err(_) => TerminalEvent::Exit { code: None, signal: None },
        };
    }
    match child.wait() {
        Ok(status) => match status.signal() {
            Some(signal) => TerminalEvent::Exit { code: None, signal: Some(signal.to_owned()) },
            None => TerminalEvent::Exit { code: i32::try_from(status.exit_code()).ok(), signal: None },
        },
        Err(_) => TerminalEvent::Exit { code: None, signal: None },
    }
}

#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGUSR2 => "SIGUSR2",
        other => return format!("signal {other}"),
    };
    name.to_owned()
}

#[cfg(target_os = "macos")]
fn process_name(pid: i32) -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: proc_name writes at most `buf.len()` bytes into `buf` and returns the length.
    let len = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    let len = usize::try_from(len).ok().filter(|&n| n > 0)?;
    Some(String::from_utf8_lossy(&buf[..len]).into_owned())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn process_name(pid: i32) -> Option<String> {
    let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    Some(name.trim_end().to_owned()).filter(|n| !n.is_empty())
}

#[cfg(not(unix))]
fn process_name(_pid: i32) -> Option<String> {
    None
}

enum Signal {
    Hangup,
    Kill,
    Winch,
}

#[cfg(unix)]
fn signal_group(group: i32, signal: Signal) {
    let signal = match signal {
        Signal::Hangup => libc::SIGHUP,
        Signal::Kill => libc::SIGKILL,
        Signal::Winch => libc::SIGWINCH,
    };
    // SAFETY: a plain syscall on a process group; a gone group fails with ESRCH.
    unsafe { libc::kill(-group, signal) };
}

#[cfg(not(unix))]
fn signal_group(_group: i32, _signal: Signal) {}

/// The last `OUTPUT_KEPT` bytes of output, starting at a line start (so no escape sequence or
/// UTF-8 character is cut). Trimmed only once it holds twice that, so a push rarely moves memory.
#[derive(Default)]
struct Ring {
    bytes: Vec<u8>,
}

impl Ring {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > 2 * OUTPUT_KEPT {
            let start = tail_start(&self.bytes, OUTPUT_KEPT);
            self.bytes.drain(..start);
        }
    }

    /// Keeps only what comes after the last line break.
    fn clear(&mut self) {
        let start = self.bytes.iter().rposition(|&b| b == b'\n').map_or(0, |at| at + 1);
        self.bytes.drain(..start);
    }

    fn contents(&self) -> &[u8] {
        &self.bytes[tail_start(&self.bytes, OUTPUT_KEPT)..]
    }
}

/// Where the last `limit` bytes of `bytes` start, moved on to the next line start (or, with no
/// line break left, the next UTF-8 character).
fn tail_start(bytes: &[u8], limit: usize) -> usize {
    if bytes.len() <= limit {
        return 0;
    }
    let cut = bytes.len() - limit;
    // Already at a line start?
    if bytes[cut - 1] == b'\n' {
        return cut;
    }
    match bytes[cut..].iter().position(|&b| b == b'\n') {
        Some(at) => cut + at + 1,
        None => cut + bytes[cut..].iter().take_while(|&&b| b & 0xC0 == 0x80).count(),
    }
}

#[cfg(all(test, unix))]
mod tests;
#[cfg(all(test, windows))]
mod tests_windows;
