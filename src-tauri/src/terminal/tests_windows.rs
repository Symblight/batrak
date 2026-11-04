//! A real ConPTY and `cmd.exe`, on Windows only (`tests.rs` needs `/bin/sh`).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;

#[derive(Default)]
struct Recorder {
    output: Mutex<Vec<u8>>,
    exit: Mutex<Option<TerminalEvent>>,
}

impl TerminalSink for Recorder {
    fn output(&self, bytes: &[u8]) -> bool {
        lock(&self.output).extend_from_slice(bytes);
        true
    }

    fn event(&self, event: &TerminalEvent) -> bool {
        *lock(&self.exit) = Some(event.clone());
        true
    }
}

fn until(what: &str, done: impl Fn() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < Duration::from_secs(20), "{what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn start(terminals: &Terminals) -> Arc<Recorder> {
    let cwd = std::env::temp_dir();
    let req = OpenRequest { id: "t", group: "main", cwd: &cwd, fallback: None, cols: 80, rows: 24 };
    terminals.open(&req, &|_| true).unwrap();
    let recorder = Arc::new(Recorder::default());
    terminals.attach("t", recorder.clone()).unwrap();
    recorder
}

fn terminals() -> Terminals {
    Terminals::new(TerminalsOptions { shell: Some(PathBuf::from("cmd.exe")), version: "0.0.0".to_owned() })
}

#[test]
fn a_shell_runs_what_is_typed_and_its_exit_code_is_reported() {
    let terminals = terminals();
    let out = start(&terminals);
    terminals.write("t", b"exit 3\r\n").unwrap();
    until("the exit", || lock(&out.exit).is_some());
    assert_eq!(*lock(&out.exit), Some(TerminalEvent::Exit { code: Some(3), signal: None }));
}

#[test]
fn closing_a_running_shell_doesnt_wait_for_it() {
    let terminals = terminals();
    let out = start(&terminals);
    until("the prompt", || !lock(&out.output).is_empty());
    let started = Instant::now();
    terminals.close(&["t".to_owned()]);
    assert!(started.elapsed() < Duration::from_secs(1), "took {:?}", started.elapsed());
    assert!(!terminals.owns("main", "t"));
}
