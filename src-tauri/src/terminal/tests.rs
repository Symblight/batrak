//! Terminals against a real PTY running `/bin/sh`, in temp folders.

use std::sync::atomic::AtomicUsize;
use std::time::Instant;

use super::*;

#[derive(Default)]
struct Recorder {
    output: Mutex<Vec<u8>>,
    events: Mutex<Vec<TerminalEvent>>,
}

impl TerminalSink for Recorder {
    fn output(&self, bytes: &[u8]) -> bool {
        lock(&self.output).extend_from_slice(bytes);
        true
    }

    fn event(&self, event: &TerminalEvent) -> bool {
        lock(&self.events).push(event.clone());
        true
    }
}

impl Recorder {
    fn text(&self) -> String {
        String::from_utf8_lossy(&lock(&self.output)).into_owned()
    }

    /// Waits until the output contains `needle`; fails after 5s.
    fn wait_for(&self, needle: &str) {
        wait_until(&format!("{needle:?} in the output"), || self.text().contains(needle), || self.text());
    }

    fn wait_exit(&self) -> TerminalEvent {
        wait_until("an exit", || !lock(&self.events).is_empty(), || self.text());
        lock(&self.events)[0].clone()
    }
}

fn wait_until(what: &str, done: impl Fn() -> bool, context: impl Fn() -> String) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < Duration::from_secs(5), "no {what}; output: {}", context());
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct Fixture {
    dir: PathBuf,
    terminals: Terminals,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.terminals.stop_all(Duration::ZERO);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture(name: &str) -> Fixture {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brama-terminal-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("project/src")).unwrap();
    std::fs::write(dir.join("project/a.txt"), "a").unwrap();
    let dir = dunce::canonicalize(dir).unwrap();
    let terminals = Terminals::new(TerminalsOptions { shell: Some(PathBuf::from("/bin/sh")), version: "0.0.0".to_owned() });
    Fixture { dir, terminals }
}

impl Fixture {
    fn project(&self) -> PathBuf {
        self.dir.join("project")
    }

    /// Only the project counts as a folder a terminal may start in.
    fn open_in(&self, id: &str, group: &str, cwd: &Path, fallback: Option<&Path>) -> Result<Opened, String> {
        let project = self.project();
        let req = OpenRequest { id, group, cwd, fallback, cols: 80, rows: 24 };
        self.terminals.open(&req, &|path: &Path| path.starts_with(&project))
    }

    fn start(&self, id: &str) -> Arc<Recorder> {
        self.open_in(id, "main", &self.project(), None).unwrap();
        let recorder = Arc::new(Recorder::default());
        self.terminals.attach(id, recorder.clone()).unwrap();
        recorder
    }

    fn run(&self, id: &str, line: &str) {
        self.terminals.write(id, format!("{line}\n").as_bytes()).unwrap();
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// The number printed right after `marker` (a command line's own `marker$$` doesn't count).
fn number_after(text: &str, marker: &str) -> Option<i32> {
    text.match_indices(marker)
        .filter_map(|(at, _)| text[at + marker.len()..].chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok())
        .last()
}

impl Recorder {
    fn wait_number(&self, marker: &str) -> i32 {
        wait_until(&format!("a number after {marker}"), || number_after(&self.text(), marker).is_some(), || self.text());
        number_after(&self.text(), marker).unwrap()
    }
}

#[test]
fn a_shell_starts_in_its_folder_and_runs_what_is_typed() {
    let f = fixture("pwd");
    let opened = f.open_in("t", "main", &f.project().join("src"), None).unwrap();
    assert_eq!(opened, Opened { shell: "sh".to_owned(), cwd: f.project().join("src").to_string_lossy().into_owned() });
    let out = Arc::new(Recorder::default());
    f.terminals.attach("t", out.clone()).unwrap();
    f.run("t", r#"echo "[$(pwd)]""#);
    out.wait_for(&format!("[{}]", f.project().join("src").display()));
    assert!(out.text().contains(r#"echo "[$(pwd)]""#), "input is echoed");
}

#[test]
fn opening_a_running_terminal_again_keeps_its_shell() {
    let f = fixture("idempotent");
    let out = f.start("t");
    f.run("t", "echo pid:$$");
    let pid = out.wait_number("pid:");
    f.open_in("t", "main", &f.project().join("src"), None).unwrap();
    f.run("t", "echo again:$$");
    out.wait_for(&format!("again:{pid}"));
}

#[test]
fn a_second_attach_first_gets_the_output_so_far() {
    let f = fixture("reattach");
    let first = f.start("t");
    f.run("t", "echo one-$((2+3))");
    first.wait_for("one-5");
    let second = Arc::new(Recorder::default());
    f.terminals.attach("t", second.clone()).unwrap();
    assert!(second.text().contains("one-5"), "replayed: {}", second.text());
    f.run("t", "echo two-$((3+4))");
    second.wait_for("two-7");
    std::thread::sleep(Duration::from_millis(100));
    assert!(!first.text().contains("two-7"), "the first attachment was replaced");
}

#[test]
fn kept_output_is_the_last_mebibyte_from_a_line_start() {
    let mut ring = Ring::default();
    let line = format!("{}\n", "é".repeat(50));
    let mut pushed = 0;
    let mut n = 0;
    while pushed < 3 * OUTPUT_KEPT {
        let chunk = format!("{n:08} {line}");
        ring.push(chunk.as_bytes());
        pushed += chunk.len();
        n += 1;
    }
    let kept = ring.contents();
    assert!(kept.len() <= OUTPUT_KEPT && kept.len() > OUTPUT_KEPT - 200, "{}", kept.len());
    let text = std::str::from_utf8(kept).expect("no character cut");
    assert!(text.starts_with(|c: char| c.is_ascii_digit()), "starts at a line: {:?}", &text[..20]);
    assert!(text.ends_with(&format!("{:08} {line}", n - 1)));
}

#[test]
fn kept_output_without_line_breaks_starts_at_a_character() {
    let text = "é".repeat(10);
    let start = tail_start(text.as_bytes(), 5);
    assert!(std::str::from_utf8(&text.as_bytes()[start..]).is_ok());
}

#[test]
fn a_resize_changes_the_terminals_size() {
    let f = fixture("resize");
    let out = f.start("t");
    f.terminals.resize("t", 100, 30).unwrap();
    f.run("t", r#"echo "<$(stty size)>""#);
    out.wait_for("<30 100>");
}

#[test]
fn the_shells_exit_code_is_reported() {
    let f = fixture("exit");
    let out = f.start("t");
    f.run("t", "exit 3");
    assert_eq!(out.wait_exit(), TerminalEvent::Exit { code: Some(3), signal: None });

    let out = f.start("u");
    f.run("u", "exit");
    assert_eq!(out.wait_exit(), TerminalEvent::Exit { code: Some(0), signal: None });
    let late = Arc::new(Recorder::default());
    f.terminals.attach("u", late.clone()).unwrap();
    assert_eq!(late.wait_exit(), TerminalEvent::Exit { code: Some(0), signal: None }, "told again on attach");
}

#[test]
fn opening_an_exited_terminal_starts_a_fresh_shell() {
    let f = fixture("restart");
    let out = f.start("t");
    f.run("t", "exit 2");
    out.wait_exit();
    f.open_in("t", "main", &f.project(), None).unwrap();
    f.run("t", "echo back-$((1+1))");
    out.wait_for("back-2");
}

#[test]
fn a_signal_that_ends_the_shell_is_named() {
    let f = fixture("signal");
    let out = f.start("t");
    f.run("t", "kill -KILL $$");
    assert_eq!(out.wait_exit(), TerminalEvent::Exit { code: None, signal: Some("SIGKILL".to_owned()) });
}

#[test]
fn busy_names_the_foreground_program_but_not_the_shell() {
    let f = fixture("busy");
    let out = f.start("t");
    f.run("t", "echo ready-$((1+1))");
    out.wait_for("ready-2");
    let ids = vec!["t".to_owned(), "unknown".to_owned()];
    assert_eq!(f.terminals.busy(&ids), vec![]);
    f.run("t", "sleep 30");
    // Until it execs, the forked job is still named `sh`.
    let sleeping = vec![Busy { id: "t".to_owned(), process: "sleep".to_owned() }];
    wait_until("sleep in the foreground", || f.terminals.busy(&ids) == sleeping, || format!("{:?}", f.terminals.busy(&ids)));
}

#[test]
fn closing_stops_the_shell_and_its_foreground_job() {
    let f = fixture("close");
    let out = f.start("t");
    f.run("t", "echo shell:$$");
    let shell = out.wait_number("shell:");
    f.run("t", r#"sh -c 'echo "job:$$"; exec sleep 30'"#);
    let job = out.wait_number("job:");
    assert!(alive(job));
    f.terminals.close(&["t".to_owned()]);
    wait_until("the shell and its job gone", || !alive(job) && !alive(shell), String::new);
    assert!(f.terminals.write("t", b"x").is_err(), "forgotten");
    std::thread::sleep(Duration::from_millis(100));
    assert!(lock(&out.events).is_empty(), "a closed terminal reports no exit");
}

#[test]
fn a_folder_outside_every_root_or_a_file_is_refused_and_a_missing_one_falls_back() {
    let f = fixture("cwd");
    let outside = f.open_in("a", "main", &f.dir, None).unwrap_err();
    assert!(outside.contains("not a project"), "{outside}");
    let file = f.open_in("b", "main", &f.project().join("a.txt"), None).unwrap_err();
    assert!(file.contains("not a folder"), "{file}");
    let opened = f.open_in("c", "main", &f.project().join("gone"), Some(&f.project())).unwrap();
    assert_eq!(opened.cwd, f.project().to_string_lossy());
    assert!(f.open_in("d", "main", &f.project().join("gone"), None).is_err());
}

#[test]
fn closing_a_windows_terminals_leaves_the_others() {
    let f = fixture("group");
    f.open_in("a", "one", &f.project(), None).unwrap();
    f.open_in("b", "two", &f.project(), None).unwrap();
    f.terminals.close_group("one");
    assert!(f.terminals.resize("a", 80, 24).is_err());
    assert!(f.terminals.resize("b", 80, 24).is_ok());
}

#[test]
fn a_terminal_is_only_its_windows() {
    let f = fixture("owner");
    f.open_in("a", "one", &f.project(), None).unwrap();
    f.open_in("b", "two", &f.project(), None).unwrap();
    assert!(f.terminals.owns("one", "a") && !f.terminals.owns("two", "a") && !f.terminals.owns("one", "gone"));
    let ids = ["a", "b", "gone"].map(String::from);
    assert_eq!(f.terminals.of_group("one", &ids), ["a"], "the window's own, running");
    let taken = f.open_in("a", "two", &f.project(), None).unwrap_err();
    assert!(taken.contains("another window"), "{taken}");
}

#[test]
fn opening_one_terminal_twice_at_once_starts_one_shell() {
    let f = fixture("race");
    // A shell that notes each start, then is `sh`.
    let starts = f.dir.join("starts");
    let script = f.dir.join("shell");
    std::fs::write(&script, format!("#!/bin/sh\necho x >> '{}'\nexec /bin/sh \"$@\"\n", starts.display())).unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let terminals = Terminals::new(TerminalsOptions { shell: Some(script), version: "0.0.0".to_owned() });
    let project = f.project();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|s| {
        for _ in 0..2 {
            s.spawn(|| {
                barrier.wait();
                let req = OpenRequest { id: "t", group: "main", cwd: &project, fallback: None, cols: 80, rows: 24 };
                terminals.open(&req, &|_: &Path| true).unwrap();
            });
        }
    });
    let out = Arc::new(Recorder::default());
    terminals.attach("t", out.clone()).unwrap();
    terminals.write("t", b"echo up-$((1+1))\n").unwrap();
    out.wait_for("up-2");
    let started = std::fs::read_to_string(&starts).unwrap();
    terminals.stop_all(Duration::ZERO);
    assert_eq!(started.lines().count(), 1, "one shell");
}

#[test]
fn the_exit_is_reported_while_a_background_job_still_holds_the_terminal() {
    let f = fixture("background");
    let out = f.start("t");
    // Like `nohup`: deaf to the hangup, still holding the terminal.
    f.run("t", "(trap '' HUP; exec sleep 30) & echo bg:$!");
    let job = out.wait_number("bg:");
    f.run("t", "exit 4");
    let exit = out.wait_exit();
    // SAFETY: signalling the job this test started.
    unsafe { libc::kill(job, libc::SIGKILL) };
    assert_eq!(exit, TerminalEvent::Exit { code: Some(4), signal: None });
}

#[test]
fn output_waits_for_the_page_to_take_what_it_was_sent() {
    let f = fixture("flow");
    let out = f.start("t");
    f.run("t", "head -c 3000000 /dev/zero | tr '\\0' x; echo; echo END-$((1+1))");
    out.wait_for("xxxx");
    std::thread::sleep(Duration::from_millis(300));
    let sent = lock(&out.output).len();
    assert!(sent <= FLOW_PAUSE_AT + READ_CHUNK, "paused unacknowledged: {sent} bytes sent");
    let acked = std::cell::Cell::new(0);
    wait_until(
        "the rest once acknowledged",
        || {
            let len = lock(&out.output).len();
            f.terminals.ack("t", len - acked.get());
            acked.set(len);
            out.text().contains("END-2")
        },
        String::new,
    );
}

/// Starts a job in the shell's own process group (no job control), deaf to the hangup; its pid.
fn start_group_mate(f: &Fixture, out: &Recorder) -> i32 {
    f.run("t", "set +m; (trap '' HUP; exec sleep 10) & echo mate:$!");
    let mate = out.wait_number("mate:");
    f.run("t", "echo shell:$$");
    let shell = out.wait_number("shell:");
    // SAFETY: getpgid only reads the job's process group.
    assert_eq!(unsafe { libc::getpgid(mate) }, shell, "in the shell's group");
    mate
}

fn kill(pid: i32) {
    // SAFETY: signalling a process the test started.
    unsafe { libc::kill(pid, libc::SIGKILL) };
}

#[test]
fn closing_kills_what_is_left_in_the_shells_group_after_the_grace() {
    let f = fixture("close-group");
    let out = f.start("t");
    let mate = start_group_mate(&f, &out);
    f.terminals.close(&["t".to_owned()]);
    std::thread::sleep(HANGUP_GRACE / 2);
    let early = alive(mate);
    wait_until("the job killed", || !alive(mate), String::new);
    assert!(early, "the hangup's grace first");
}

#[test]
fn closing_an_exited_terminal_signals_nothing() {
    // Its shell was reaped: its pid, and so its group's id, may belong to someone else by now.
    let f = fixture("close-exited");
    let out = f.start("t");
    let mate = start_group_mate(&f, &out);
    f.run("t", "exit 3");
    out.wait_exit();
    f.terminals.close(&["t".to_owned()]);
    std::thread::sleep(HANGUP_GRACE + Duration::from_millis(500));
    let survived = alive(mate);
    kill(mate);
    assert!(survived, "its old group wasn't signalled");
}

#[test]
fn closing_doesnt_wait_for_a_write_the_shell_doesnt_read() {
    let f = fixture("close-write");
    let out = f.start("t");
    // The shell and its foreground job deaf to the hangup (a shell that exits revokes the PTY,
    // which ends the write), the job reading nothing: input fills the PTY (raw: canonical input
    // past a line's limit is dropped, not waited for).
    f.run("t", "trap '' HUP");
    f.run("t", r#"sh -c 'stty raw -echo; echo "deaf:$$"; exec sleep 10'"#);
    let deaf = out.wait_number("deaf:");
    let terminals = f.terminals.clone();
    let writing = std::thread::spawn(move || terminals.write("t", &vec![b'x'; 1024 * 1024]));
    std::thread::sleep(Duration::from_millis(300));
    assert!(!writing.is_finished(), "the write is blocked");
    let started = Instant::now();
    f.terminals.close(&["t".to_owned()]);
    let took = started.elapsed();
    assert!(took < Duration::from_millis(500), "close took {took:?}");
    wait_until("the job killed", || !alive(deaf), String::new);
    assert!(writing.join().unwrap().is_err(), "the write fails once the terminal is gone");
}

/// Runs `/bin/sh -c script` as a terminal's program; returns its output and how it ended.
fn run_program(f: &Fixture, id: &str, script: &str) -> (Arc<Recorder>, mpsc::Receiver<Option<TerminalEvent>>) {
    let (tx, rx) = mpsc::channel();
    let req = OpenRequest { id, group: "main", cwd: &f.project(), fallback: None, cols: 80, rows: 24 };
    let program = Program {
        program: "/bin/sh".to_owned(),
        args: vec!["-c".to_owned(), script.to_owned()],
        env: vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned()), ("LOGIN_SAYS".to_owned(), "hi".to_owned())],
    };
    let opened = f.terminals.open_program(&req, program, Box::new(move |exit| tx.send(exit.cloned()).unwrap())).unwrap();
    assert_eq!(opened.shell, "sh");
    let out = Arc::new(Recorder::default());
    f.terminals.attach(id, out.clone()).unwrap();
    (out, rx)
}

#[test]
fn a_program_runs_with_its_env_and_reports_its_exit() {
    let f = fixture("program");
    let (out, ended) = run_program(&f, "login", "echo \"says:$LOGIN_SAYS:$TERM\"; read answer; exit $answer");
    out.wait_for("says:hi:xterm-256color");
    f.run("login", "3");
    let exit = ended.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(exit, Some(TerminalEvent::Exit { code: Some(3), signal: None }));
    assert_eq!(out.wait_exit(), TerminalEvent::Exit { code: Some(3), signal: None }, "the page hears it too");
}

#[test]
fn closing_a_programs_terminal_reports_no_exit() {
    let f = fixture("program-close");
    let (out, ended) = run_program(&f, "login", "echo waiting; sleep 30");
    out.wait_for("waiting");
    f.terminals.close(&["login".to_owned()]);
    let started = std::time::Instant::now();
    assert_eq!(ended.recv_timeout(Duration::from_secs(5)).unwrap(), None);
    assert!(started.elapsed() < Duration::from_secs(1), "heard once it's gone, not after the kill's grace: {:?}", started.elapsed());
}
