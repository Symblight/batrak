//! Programs a session runs where its client shows them: an agent's CLI, a sign-in's login. The app
//! gives each a terminal tab of the calling window; a command line runs it in its own terminal.

use std::path::Path;
use std::time::Duration;

/// A program to run, with its whole environment (it holds the agent's resolved secrets, so it
/// never reaches a page).
#[derive(Debug, Clone)]
pub struct Program {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Text the program should get as input once it reads (a first prompt too long for its
    /// command line). No Enter.
    pub paste: Option<(String, PasteWait)>,
}

/// When a program is taken as reading its input.
#[derive(Debug, Clone, Copy)]
pub struct PasteWait {
    /// After its last output: settled once bracketed paste is on; reading anyway without it (ConPTY
    /// may not pass `ESC[?2004h` through) after this much again.
    pub quiet: Duration,
    /// Given up, nothing pasted, when it has printed nothing this long after its start.
    pub give_up: Duration,
}

/// How a program ended on its own: its exit code, or the signal that ended it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgramExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

/// Hears how a program ended (`None`: closed first).
pub type OnExit = Box<dyn FnOnce(Option<&ProgramExit>) + Send>;

/// Where one client (a window, a terminal) shows programs. May block: called off the runtime.
pub trait ProgramRunner: Send + Sync {
    /// Runs `program` in `cwd` under `id`, at `size` (columns, rows; `None`: the client's default).
    fn run(&self, id: &str, cwd: &Path, program: Program, size: Option<(u16, u16)>, on_exit: OnExit) -> Result<(), String>;
    /// Ends the program, whichever client shows it.
    fn close(&self, id: &str);
    /// Whether what it runs now may be work the user would lose by closing it.
    fn busy(&self, id: &str) -> bool;
    /// Whether this client is the one showing it.
    fn owns(&self, id: &str) -> bool;
}
