use std::io::{self, Read};
use std::sync::{Arc, Mutex};
use std::thread;

use super::permit::{Permit, MAX_CONCURRENT};
use super::pipes::Capture;
#[cfg(unix)]
use super::stop::stop_group;
use super::*;

/// A git that runs `script`, in a temp folder returned with it.
#[cfg(unix)]
fn fake_git(name: &str, script: &str) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir = crate::git::test_repo::temp_dir(name);
    let git = dir.join("git");
    std::fs::write(&git, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
    (git, dir)
}

#[cfg(unix)]
#[test]
fn a_background_child_holding_the_pipes_doesnt_hold_the_call() {
    // Left running by a hook or a filter, it keeps our pipes open after git is done.
    let (git, dir) = fake_git("child-holds", "echo printed\nsleep 20 &\nexit 0");
    let started = Instant::now();
    let out = run(&git, &dir, &[OsStr::new("status")], Mode::Background).unwrap();
    assert_eq!(out, b"printed\n", "what git printed is kept");
    assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    std::fs::remove_dir_all(dir).unwrap();
}

/// What a left-behind child may add to a call: one `PIPE_GRACE` (2 s) with some room for a loaded
/// machine, below the 4 s that waiting the grace twice can't take less than. `Mode::Hooks` takes no
/// permit, so the time is all spawn and grace.
#[cfg(unix)]
const ONE_GRACE: Duration = Duration::from_millis(3500);

/// More than a pipe buffer: the writer blocks until someone reads or the last reader is gone.
#[cfg(unix)]
const BIG_INPUT: &[u8] = &[b'x'; 1024 * 1024];

// The saved fd because a background job's stdin is /dev/null before its redirects in some shells (dash).
#[cfg(unix)]
#[test]
fn a_child_holding_stdin_doesnt_hold_the_call() {
    let (git, dir) = fake_git("stdin-held", "exec 3<&0\nsleep 20 <&3 >/dev/null 2>&1 &\nexit 0");
    let started = Instant::now();
    let opts = Options { input: Some(BIG_INPUT), ..Options::default() };
    let out = run_with(&git, &dir, &[OsStr::new("hash-object")], Mode::Hooks, &opts).unwrap();
    assert!(out.success(), "{:?}", out.status);
    assert!(started.elapsed() < ONE_GRACE, "took {:?}", started.elapsed());
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn a_child_holding_stdout_and_stderr_waits_one_grace_not_two() {
    let (git, dir) = fake_git("both-held", "echo printed\necho said >&2\nsleep 20 &\nexit 0");
    let started = Instant::now();
    let out = run_with(&git, &dir, &[OsStr::new("status")], Mode::Hooks, &Options::default()).unwrap();
    assert!(started.elapsed() < ONE_GRACE, "took {:?}", started.elapsed());
    assert_eq!((out.stdout.as_slice(), out.stderr.as_str()), (&b"printed\n"[..], "said"), "what git printed is kept");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn a_child_holding_every_pipe_waits_one_grace() {
    let (git, dir) = fake_git("all-held", "echo printed\nexec 3<&0\nsleep 20 <&3 &\nexit 0");
    let started = Instant::now();
    let opts = Options { input: Some(BIG_INPUT), ..Options::default() };
    let out = run_with(&git, &dir, &[OsStr::new("hash-object")], Mode::Hooks, &opts).unwrap();
    assert!(started.elapsed() < ONE_GRACE, "took {:?}", started.elapsed());
    assert_eq!(out.stdout, b"printed\n", "what git printed is kept");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn a_timeout_in_any_mode_stops_the_children_of_git() {
    let (git, dir) = fake_git("timeout-children", "sleep 20 &\nwait");
    TEST_TIMEOUT.set(Some(Duration::from_millis(1500)));
    let started = Instant::now();
    let err = run(&git, &dir, &[OsStr::new("status")], Mode::Background).unwrap_err();
    TEST_TIMEOUT.set(None);
    assert!(err.contains("timed out"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn long_calls_leave_the_short_ones_their_slots() {
    let (slow, dir) = fake_git("long-calls", "sleep 3");
    let real = crate::git::test_repo::git_bin();
    thread::scope(|scope| {
        for _ in 0..MAX_CONCURRENT {
            scope.spawn(|| run(&slow, &dir, &[OsStr::new("commit")], Mode::Hooks));
        }
        thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        run(&real, &dir, &[OsStr::new("--version")], Mode::Background).unwrap();
        assert!(started.elapsed() < Duration::from_secs(2), "waited {:?}", started.elapsed());
    });
    std::fs::remove_dir_all(dir).unwrap();
}

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
    for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NAMESPACE"] {
        assert!(SCRUBBED_ENV.contains(&key), "{key}");
    }
}

#[test]
fn scrubbed_variables_cover_what_git_itself_calls_repository_local() {
    // Against the real git, so that an upgrade adding a variable shows up here.
    let args = [OsStr::new("rev-parse"), OsStr::new("--local-env-vars")];
    let out = run(&crate::git::test_repo::git_bin(), &std::env::temp_dir(), &args, Mode::Local).unwrap();
    let out = String::from_utf8(out).unwrap();

    let missing: Vec<&str> = out.lines().filter(|name| !SCRUBBED_ENV.contains(name)).collect();

    assert!(out.lines().any(|name| name == "GIT_DIR"), "git printed: {out}");
    assert!(missing.is_empty(), "repository-local in this git, missing from SCRUBBED_ENV: {missing:?}");
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

/// The levels of the events logged while it's the default subscriber.
struct Levels(Arc<Mutex<Vec<tracing::Level>>>);
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Levels {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        self.0.lock().unwrap().push(*event.metadata().level());
    }
}

#[test]
fn only_a_call_the_user_asked_for_warns_when_it_fails() {
    use tracing_subscriber::layer::SubscriberExt;
    for (mode, warns) in [(Mode::Background, false), (Mode::Local, true)] {
        let levels = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry().with(Levels(Arc::clone(&levels)));
        let result = tracing::subscriber::with_default(subscriber, || {
            run_with(Path::new("/no/such/git"), &std::env::temp_dir(), &[OsStr::new("status")], mode, &Options::default())
        });
        assert!(result.is_err());
        let warned = levels.lock().unwrap().iter().any(|l| *l <= tracing::Level::WARN);
        assert_eq!(warned, warns, "{mode:?}");
    }
}

#[cfg(unix)]
#[test]
fn a_cancelled_call_is_no_failure_the_user_hears_of() {
    use std::os::unix::fs::PermissionsExt;
    use tracing_subscriber::layer::SubscriberExt;
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

#[test]
fn a_read_interrupted_by_a_signal_goes_on() {
    struct Interrupted(u8);
    impl Read for Interrupted {
        fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
            self.0 += 1;
            match self.0 {
                1 => Err(io::ErrorKind::Interrupted.into()),
                2 => {
                    into[..4].copy_from_slice(b"rest");
                    Ok(4)
                }
                _ => Ok(0),
            }
        }
    }

    let deadline = Instant::now() + Duration::from_secs(10);
    assert_eq!(Capture::start(Interrupted(0), 100).finish(deadline), (b"rest".to_vec(), false));
}
