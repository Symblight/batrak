//! The app's [`ProgramRunner`]: a terminal tab of the calling window.

use std::path::Path;

use super::{OpenRequest, Program, TerminalEvent, Terminals};
use crate::session::program::{self, OnExit, ProgramExit, ProgramRunner};

/// A login's size until the page's tab attaches and resizes it.
const DEFAULT_SIZE: (u16, u16) = (80, 24);

pub struct WindowRunner {
    terminals: Terminals,
    window: String,
}

impl WindowRunner {
    pub fn new(terminals: Terminals, window: &str) -> WindowRunner {
        WindowRunner { terminals, window: window.to_owned() }
    }
}

impl ProgramRunner for WindowRunner {
    fn run(&self, id: &str, cwd: &Path, program: program::Program, size: Option<(u16, u16)>, on_exit: OnExit) -> Result<(), String> {
        let (cols, rows) = size.unwrap_or(DEFAULT_SIZE);
        let req = OpenRequest { id, group: &self.window, cwd, fallback: None, cols, rows };
        let on_exit = Box::new(move |exit: Option<&TerminalEvent>| {
            let exit = exit.map(|TerminalEvent::Exit { code, signal }| ProgramExit { code: *code, signal: signal.clone() });
            on_exit(exit.as_ref());
        });
        let running = Program { program: program.program, args: program.args, env: program.env };
        self.terminals.open_program(&req, running, on_exit)?;
        if let Some((text, wait)) = program.paste {
            self.terminals.paste_when_ready(id, &text, wait);
        }
        Ok(())
    }

    fn close(&self, id: &str) {
        self.terminals.close(&[id.to_owned()]);
    }

    fn busy(&self, id: &str) -> bool {
        !self.terminals.busy(&[id.to_owned()]).is_empty()
    }

    fn owns(&self, id: &str) -> bool {
        self.terminals.owns(&self.window, id)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;
    use crate::session::program::PasteWait;
    use crate::terminal::{TerminalSink, TerminalsOptions};

    fn program(script: &str, paste: Option<&str>) -> program::Program {
        let wait = PasteWait { quiet: Duration::from_millis(200), give_up: Duration::from_secs(5) };
        program::Program {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
            paste: paste.map(|text| (text.to_owned(), wait)),
        }
    }

    struct Screen(mpsc::Sender<String>);
    impl TerminalSink for Screen {
        fn output(&self, bytes: &[u8]) -> bool {
            let _ = self.0.send(String::from_utf8_lossy(bytes).into_owned());
            true
        }
        fn event(&self, _event: &TerminalEvent) -> bool {
            true
        }
    }

    /// In a real terminal: its window owns it, its exit and a close read as the core expects, and a
    /// program's first input gets there.
    #[test]
    fn a_program_runs_in_a_terminal_of_its_window_and_tells_how_it_ended() {
        let terminals = Terminals::new(TerminalsOptions { shell: None, version: "test".into() });
        let (main, other) = (WindowRunner::new(terminals.clone(), "main"), WindowRunner::new(terminals.clone(), "other"));
        let cwd = std::env::temp_dir();
        let run = |runner: &WindowRunner, id: &str, script: &str, paste| {
            let (tx, rx) = mpsc::channel();
            let on_exit: OnExit = Box::new(move |exit| tx.send(exit.cloned()).unwrap());
            runner.run(id, &cwd, program(script, paste), Some((100, 30)), on_exit).unwrap();
            rx
        };
        let ended = |rx: &mpsc::Receiver<Option<ProgramExit>>| rx.recv_timeout(Duration::from_secs(5)).expect("no end heard");

        let exited = run(&main, "exits", "exit 3", None);
        assert_eq!(ended(&exited), Some(ProgramExit { code: Some(3), signal: None }));

        let closed = run(&main, "waits", "sleep 30", None);
        assert!(main.owns("waits") && !other.owns("waits"));
        other.close("waits");
        assert_eq!(ended(&closed), None, "closed first, by any client");
        assert!(!main.owns("waits"));

        let _reader = run(&main, "reads", "stty -icanon; printf READY; dd bs=1 count=5 2>/dev/null; sleep 30", Some("hello"));
        let (tx, rx) = mpsc::channel();
        terminals.attach("reads", std::sync::Arc::new(Screen(tx))).unwrap();
        let mut shown = String::new();
        while !shown.contains("hello") {
            shown.push_str(&rx.recv_timeout(Duration::from_secs(5)).unwrap_or_else(|_| panic!("not pasted: {shown:?}")));
        }
        main.close("reads");
    }
}
