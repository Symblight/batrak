//! The update flow from a command's side: states, events and files on disk, over a fake `Installer`,
//! a fake `Source` and a temp folder.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use bt_core::release::{Manifest, Source};
use serde_json::{json, Value};
use tracing_subscriber::layer::SubscriberExt;

use super::installer::{Found, InstallError, Installer};
use super::pending::{Files, Launch, Pending, DID_NOT_INSTALL};
use super::*;

const GOOD: &[u8] = b"a signed package";
const OTHER_GOOD: &[u8] = b"another signed package";
const REACH: &str = "couldn't reach GitHub";
const SIGNATURE: &str = "the download failed its signature check";
const DISK: &str = "couldn't save the update";
const REPLACE: &str = "couldn't replace the app";

type Log = Arc<Mutex<Vec<String>>>;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap()
}

fn manifest(version: &str) -> Value {
    json!({ "version": version, "platforms": {} })
}

fn found(version: &str) -> Found {
    Found { version: version.parse().unwrap(), current: "0.9.2".to_owned(), url: format!("https://x/{version}"), manifest: manifest(version) }
}

fn available(version: &str) -> AppUpdateState {
    AppUpdateState::Available { version: version.to_owned(), current: "0.9.2".to_owned(), manual: false }
}

fn ready(version: &str) -> AppUpdateState {
    AppUpdateState::Ready { version: version.to_owned(), on_next_launch: false }
}

fn failed(version: &str, reason: &str) -> AppUpdateState {
    AppUpdateState::Failed { version: version.to_owned(), reason: reason.to_owned() }
}

fn installing(version: &str) -> AppUpdateState {
    AppUpdateState::Installing { version: version.to_owned() }
}

/// Takes `GOOD` and `OTHER_GOOD` as signed. Logs each call, and whether `attempted` was on disk when an
/// install started.
struct FakeInstaller {
    log: Log,
    files: Files,
    checks: Mutex<VecDeque<Result<Option<Found>, String>>>,
    install_fails: Mutex<Option<InstallError>>,
    install_panics: Mutex<bool>,
    during_verify: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl FakeInstaller {
    fn signed(bytes: &[u8]) -> bool {
        bytes == GOOD || bytes == OTHER_GOOD
    }
}

impl Installer for FakeInstaller {
    fn check(&self) -> Result<Option<Found>, String> {
        lock(&self.log).push("check".to_owned());
        lock(&self.checks).pop_front().unwrap_or(Ok(None))
    }

    fn verify(&self, _: &Value, bytes: &[u8]) -> Result<(), String> {
        lock(&self.log).push("verify".to_owned());
        if let Some(during) = lock(&self.during_verify).take() {
            during();
        }
        if Self::signed(bytes) { Ok(()) } else { Err("bad signature".to_owned()) }
    }

    fn install(&self, _: &Value, bytes: &[u8]) -> Result<(), InstallError> {
        let attempted = self.files.read_pending().is_some_and(|pending| pending.attempted);
        lock(&self.log).push(format!("install attempted={attempted}"));
        assert!(!*lock(&self.install_panics), "the plugin panicked");
        if !Self::signed(bytes) {
            return Err(InstallError { failure: Failure::Signature, detail: "bad signature".to_owned() });
        }
        lock(&self.install_fails).take().map_or(Ok(()), Err)
    }
}

/// Hands out what its next `Answer` says; `Good` when none is left.
#[derive(Clone)]
enum Answer {
    Package { chunks: Vec<Vec<u8>>, total: Option<u64> },
    Fails(&'static str),
    /// Says it has started, waits to be released, then sends `GOOD`.
    Held { started: Sender<()>, release: Arc<Mutex<Receiver<()>>> },
}

fn package(bytes: &[u8]) -> Answer {
    Answer::Package { chunks: vec![bytes.to_vec()], total: Some(bytes.len() as u64) }
}

struct FakeSource {
    log: Log,
    answers: Mutex<VecDeque<Answer>>,
}

impl Source for FakeSource {
    fn manifest(&self) -> Result<Manifest, String> {
        Err("the desktop's checks go through the installer".to_owned())
    }

    fn package(&self, url: &str, sink: &mut dyn FnMut(&[u8]) -> Result<(), String>, total: &mut dyn FnMut(Option<u64>)) -> Result<(), String> {
        lock(&self.log).push(format!("package {url}"));
        let answer = lock(&self.answers).pop_front().unwrap_or_else(|| package(GOOD));
        match answer {
            Answer::Package { chunks, total: size } => {
                total(size);
                chunks.iter().try_for_each(|chunk| sink(chunk))
            }
            Answer::Fails(message) => Err(message.to_owned()),
            Answer::Held { started, release } => {
                total(Some(GOOD.len() as u64));
                started.send(()).unwrap();
                lock(&release).recv().unwrap();
                sink(GOOD)
            }
        }
    }
}

struct FakeHost(Log);

impl Host for FakeHost {
    fn stop_everything(&self) {
        lock(&self.0).push("stop".to_owned());
    }

    fn restart(&self) {
        lock(&self.0).push("restart".to_owned());
    }

    fn show_window(&self) {
        lock(&self.0).push("show".to_owned());
    }
}

struct Fixture {
    root: PathBuf,
    log: Log,
    events: Arc<Mutex<Vec<AppUpdateState>>>,
    installer: Arc<FakeInstaller>,
    source: Arc<FakeSource>,
    updates: AppUpdates,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

static NEXT_FOLDER: AtomicUsize = AtomicUsize::new(0);

fn fixture_with(manual: bool, updates_enabled: bool, running: &str) -> Fixture {
    let root = std::env::temp_dir().join(format!("batrak-app-update-{}-{}", std::process::id(), NEXT_FOLDER.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let dir = root.join("app-update");
    let log = Log::default();
    let events = Arc::new(Mutex::new(Vec::new()));
    let installer = Arc::new(FakeInstaller {
        log: log.clone(),
        files: Files::new(dir.clone()),
        checks: Mutex::default(),
        install_fails: Mutex::default(),
        install_panics: Mutex::default(),
        during_verify: Mutex::default(),
    });
    let source = Arc::new(FakeSource { log: log.clone(), answers: Mutex::default() });
    let heard = events.clone();
    let updates = AppUpdates::new(Options {
        dir,
        running: running.parse().unwrap(),
        manual,
        updates_enabled,
        installer: installer.clone(),
        source: source.clone(),
        host: Arc::new(FakeHost(log.clone())),
        sink: Arc::new(move |state: &AppUpdateState| lock(&heard).push(state.clone())),
    });
    Fixture { root, log, events, installer, source, updates }
}

fn fixture() -> Fixture {
    fixture_with(false, true, "0.9.2")
}

impl Fixture {
    fn files(&self) -> Files {
        Files::new(self.root.join("app-update"))
    }

    fn state(&self) -> AppUpdateState {
        self.updates.state()
    }

    fn logged(&self) -> Vec<String> {
        lock(&self.log).clone()
    }

    fn logged_any(&self, what: &str) -> bool {
        self.logged().iter().any(|line| line.starts_with(what))
    }

    fn forget_log(&self) {
        lock(&self.log).clear();
    }

    fn check_finds(&self, answer: Result<Option<Found>, String>) {
        lock(&self.installer.checks).push_back(answer);
    }

    fn answer(&self, answer: Answer) {
        lock(&self.source.answers).push_back(answer);
    }

    /// What's on disk under `app-update/`, sorted.
    fn on_disk(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.root.join("app-update")) else { return Vec::new() };
        let mut names: Vec<String> = entries.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn package_on_disk(&self) -> Vec<u8> {
        std::fs::read(self.files().package()).unwrap()
    }

    fn available_after_a_check(&self, version: &str) {
        self.check_finds(Ok(Some(found(version))));
        assert_eq!(self.updates.check(CheckBy::Schedule), Ok(available(version)));
    }

    fn download(&self) {
        let job = self.updates.begin_download().unwrap().expect("a download starts");
        self.updates.run_download(job);
    }

    fn ready_with(&self, version: &str, bytes: &[u8]) {
        self.available_after_a_check(version);
        self.answer(package(bytes));
        self.download();
        assert_eq!(self.state(), ready(version));
    }

    /// As a previous run left it.
    fn left_by_a_previous_run(&self, pending: &Pending, bytes: &[u8]) {
        self.files().write_pending(pending).unwrap();
        std::fs::write(self.files().package(), bytes).unwrap();
    }

    fn launch(&self) -> Launch {
        let launch = self.updates.plan_launch();
        self.updates.run_launch(launch.clone());
        launch
    }

    /// A download held inside its transfer, on its own thread, and what releases it.
    fn held_download(&self) -> (std::thread::JoinHandle<()>, Sender<()>) {
        let (started, has_started) = channel();
        let (release, released) = channel();
        self.answer(Answer::Held { started, release: Arc::new(Mutex::new(released)) });
        let job = self.updates.begin_download().unwrap().expect("a download starts");
        let updates = self.updates.clone();
        let worker = std::thread::spawn(move || updates.run_download(job));
        has_started.recv().unwrap();
        (worker, release)
    }
}

fn pending(version: &str, on_next_launch: bool, attempted: bool) -> Pending {
    Pending { version: version.parse().unwrap(), manifest: manifest(version), on_next_launch, attempted }
}

/// Counts the lines at `warn!` and above, which reach the user as snackbars.
#[derive(Clone, Default)]
struct Warnings(Arc<AtomicUsize>);

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Warnings {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        if *event.metadata().level() <= tracing::Level::WARN {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn warnings_during(work: impl FnOnce()) -> usize {
    let warnings = Warnings::default();
    let subscriber = tracing_subscriber::registry().with(warnings.clone());
    tracing::subscriber::with_default(subscriber, work);
    warnings.0.load(Ordering::Relaxed)
}

// ---- download

#[test]
fn a_download_reaches_ready_and_leaves_a_verified_package_named_by_pending_json() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    f.answer(package(GOOD));

    f.download();

    assert_eq!(f.state(), ready("0.9.3"));
    assert_eq!(f.on_disk(), ["package", "pending.json"]);
    assert_eq!(f.package_on_disk(), GOOD);
    assert_eq!(f.files().read_pending(), Some(pending("0.9.3", false, false)));
    assert_eq!(lock(&f.events).last(), Some(&ready("0.9.3")));
    assert!(lock(&f.events).iter().any(|s| matches!(s, AppUpdateState::Downloading { received: 0, .. })), "the button moves at once");
    assert!(f.logged_any("package https://x/0.9.3"));
}

#[test]
fn a_bad_signature_gives_failed_and_no_package() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    f.answer(package(b"tampered"));

    f.download();

    assert_eq!(f.state(), failed("0.9.3", SIGNATURE));
    assert!(f.on_disk().is_empty(), "{:?}", f.on_disk());
}

#[test]
fn a_network_failure_and_a_disk_failure_read_as_what_the_user_can_do_about_them() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    f.answer(Answer::Fails("connection reset"));

    f.download();
    assert_eq!(f.state(), failed("0.9.3", REACH));

    // A file where the folder should be.
    std::fs::remove_dir_all(f.root.join("app-update")).unwrap();
    std::fs::write(f.root.join("app-update"), b"").unwrap();
    f.download();
    assert_eq!(f.state(), failed("0.9.3", DISK));
}

#[test]
fn a_failure_the_user_started_shows_on_the_button_and_as_no_snackbar() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    f.answer(Answer::Fails("connection reset"));

    let warnings = warnings_during(|| f.download());

    assert_eq!(warnings, 0);
}

#[test]
fn downloading_twice_starts_one_download() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    let (worker, release) = f.held_download();

    let second = f.updates.begin_download().unwrap();

    assert!(second.is_none());
    release.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(f.state(), ready("0.9.3"));
    assert_eq!(f.logged().iter().filter(|line| line.starts_with("package")).count(), 1);
}

#[test]
fn a_manual_install_refuses_to_download() {
    let f = fixture_with(true, true, "0.9.2");
    f.check_finds(Ok(Some(found("0.9.3"))));
    let state = f.updates.check(CheckBy::User).unwrap();
    assert_eq!(state, AppUpdateState::Available { version: "0.9.3".to_owned(), current: "0.9.2".to_owned(), manual: true });

    let refused = f.updates.begin_download();

    assert!(refused.is_err());
    assert_eq!(f.state(), state);
    assert!(!f.logged_any("package"));
}

// ---- cancel

#[test]
fn a_cancel_returns_to_available_and_leaves_no_files() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    let (worker, release) = f.held_download();

    let state = f.updates.cancel();

    assert_eq!(state, available("0.9.3"), "at once, though the transfer sees it only at its next chunk");
    release.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(f.state(), available("0.9.3"));
    assert!(f.on_disk().is_empty(), "{:?}", f.on_disk());
}

#[test]
fn a_download_started_right_after_a_cancel_waits_for_the_old_one_to_be_gone() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    let (first, release) = f.held_download();
    f.updates.cancel();
    f.answer(package(OTHER_GOOD));

    let job = f.updates.begin_download().unwrap().expect("a new download");
    let updates = f.updates.clone();
    let second = std::thread::spawn(move || updates.run_download(job));
    release.send(()).unwrap();
    first.join().unwrap();
    second.join().unwrap();

    assert_eq!(f.state(), ready("0.9.3"));
    assert_eq!(f.package_on_disk(), OTHER_GOOD);
    assert_eq!(f.on_disk(), ["package", "pending.json"]);
}

#[test]
fn a_cancel_while_the_package_is_verified_wins_and_leaves_no_files() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    f.answer(package(GOOD));
    let updates = f.updates.clone();
    *lock(&f.installer.during_verify) = Some(Box::new(move || {
        updates.cancel();
    }));

    f.download();

    assert_eq!(f.state(), available("0.9.3"));
    assert!(f.on_disk().is_empty(), "{:?}", f.on_disk());
}

#[test]
fn a_cancel_after_the_download_finished_changes_nothing() {
    let f = fixture();
    f.ready_with("0.9.3", GOOD);

    assert_eq!(f.updates.cancel(), ready("0.9.3"));
    assert_eq!(f.on_disk(), ["package", "pending.json"]);
}

#[test]
fn a_retry_after_a_failed_download_asks_github_nothing_new() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    f.answer(Answer::Fails("connection reset"));
    f.download();
    f.forget_log();

    f.download();

    assert_eq!(f.state(), ready("0.9.3"));
    assert!(!f.logged_any("check"), "what it failed with is still known");
}

// ---- progress

#[test]
fn progress_reaches_the_page_only_when_the_whole_percent_changes() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    // 1000 chunks of one byte each: 0.1% per chunk.
    let chunks = vec![vec![b'x']; 1000];
    f.answer(Answer::Package { chunks, total: Some(1000) });
    lock(&f.events).clear();

    f.download();

    let downloading: Vec<u64> = lock(&f.events)
        .iter()
        .filter_map(|s| match s {
            AppUpdateState::Downloading { received, total: Some(1000), .. } => Some(*received),
            _ => None,
        })
        .collect();
    assert_eq!(downloading.len(), 101, "0% to 100%: {downloading:?}");
    assert_eq!(downloading.last(), Some(&1000));
}

#[test]
fn progress_of_an_unknown_size_reaches_the_page_at_most_per_whole_megabyte() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    let chunks = vec![vec![b'x'; 64 * 1024]; 16 * 3];
    f.answer(Answer::Package { chunks, total: None });
    lock(&f.events).clear();

    f.download();

    let downloading: Vec<u64> = lock(&f.events)
        .iter()
        .filter_map(|s| match s {
            AppUpdateState::Downloading { received, total: None, .. } => Some(*received),
            _ => None,
        })
        .collect();
    let megabyte = 1024 * 1024;
    assert_eq!(downloading.iter().filter(|&&received| received >= megabyte).count(), 3, "{downloading:?}");
    assert!(downloading.len() <= 5, "{downloading:?}");
}

// ---- check

#[test]
fn a_check_finds_an_update_and_then_a_release_pulled_from_github_takes_the_button_away() {
    let f = fixture();

    assert_eq!(f.updates.check(CheckBy::Schedule), Ok(AppUpdateState::None), "nothing yet");
    f.available_after_a_check("0.9.3");

    f.check_finds(Ok(None));
    assert_eq!(f.updates.check(CheckBy::Schedule), Ok(AppUpdateState::None));
    assert_eq!(lock(&f.events).last(), Some(&AppUpdateState::None));
}

#[test]
fn a_check_that_finds_nothing_clears_failed_too() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    f.answer(Answer::Fails("connection reset"));
    f.download();

    f.check_finds(Ok(None));

    assert_eq!(f.updates.check(CheckBy::Schedule), Ok(AppUpdateState::None));
}

#[test]
fn a_check_of_the_failed_version_leaves_failed_and_of_a_newer_one_offers_it() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    f.answer(Answer::Fails("connection reset"));
    f.download();

    f.check_finds(Ok(Some(found("0.9.3"))));
    assert_eq!(f.updates.check(CheckBy::Schedule), Ok(failed("0.9.3", REACH)));

    f.check_finds(Ok(Some(found("0.9.4"))));
    assert_eq!(f.updates.check(CheckBy::Schedule), Ok(available("0.9.4")));
}

#[test]
fn a_failed_check_changes_nothing_says_so_only_to_who_asked_and_shows_no_snackbar() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    lock(&f.events).clear();
    f.check_finds(Err("dns".to_owned()));
    f.check_finds(Err("dns".to_owned()));

    let warnings = warnings_during(|| {
        assert_eq!(f.updates.check(CheckBy::User), Err(REACH.to_owned()));
        assert_eq!(f.updates.check(CheckBy::Schedule), Err(REACH.to_owned()));
    });

    assert_eq!(warnings, 0);
    assert_eq!(f.state(), available("0.9.3"));
    assert!(lock(&f.events).is_empty());
}

#[test]
fn asking_by_hand_during_a_download_a_ready_update_or_an_install_makes_no_request() {
    let f = fixture();
    f.available_after_a_check("0.9.3");

    let (worker, release) = f.held_download();
    f.forget_log();
    assert!(matches!(f.updates.check(CheckBy::User), Ok(AppUpdateState::Downloading { .. })));
    assert!(matches!(f.updates.check(CheckBy::Schedule), Ok(AppUpdateState::Downloading { .. })), "nor does the schedule");
    assert!(!f.logged_any("check"));
    release.send(()).unwrap();
    worker.join().unwrap();

    f.forget_log();
    assert_eq!(f.updates.check(CheckBy::User), Ok(ready("0.9.3")));
    assert!(!f.logged_any("check"));

    assert!(f.updates.begin_restart());
    assert_eq!(f.updates.check(CheckBy::User), Ok(installing("0.9.3")));
    assert_eq!(f.updates.check(CheckBy::Schedule), Ok(installing("0.9.3")));
    assert!(!f.logged_any("check"));
}

#[test]
fn asking_by_hand_is_refused_where_there_is_no_row_for_it() {
    let f = fixture_with(false, false, "0.9.2");

    assert!(f.updates.check(CheckBy::User).is_err());

    assert!(!f.logged_any("check"));
}

#[test]
fn a_newer_release_while_ready_offers_it_and_the_old_package_stays_until_the_new_one_is_in() {
    let f = fixture();
    f.ready_with("0.9.3", GOOD);

    f.check_finds(Ok(Some(found("0.9.3"))));
    assert_eq!(f.updates.check(CheckBy::Schedule), Ok(ready("0.9.3")), "the same one changes nothing");
    f.check_finds(Ok(None));
    assert_eq!(f.updates.check(CheckBy::Schedule), Ok(ready("0.9.3")), "what's on disk is still good");

    f.check_finds(Ok(Some(found("0.9.4"))));
    assert_eq!(f.updates.check(CheckBy::Schedule), Ok(available("0.9.4")));
    assert_eq!(f.package_on_disk(), GOOD);

    f.answer(package(b"tampered"));
    f.download();
    assert_eq!(f.state(), failed("0.9.4", SIGNATURE));
    assert_eq!(f.package_on_disk(), GOOD, "a bad download doesn't cost the good one");
    assert_eq!(f.files().read_pending(), Some(pending("0.9.3", false, false)));

    f.answer(package(OTHER_GOOD));
    f.download();
    assert_eq!(f.state(), ready("0.9.4"));
    assert_eq!(f.package_on_disk(), OTHER_GOOD);
    assert_eq!(f.files().read_pending(), Some(pending("0.9.4", false, false)));
    assert_eq!(f.on_disk(), ["package", "pending.json"]);
}

// ---- retry after a relaunch, which knows no `Found`

#[test]
fn a_retry_after_a_relaunch_checks_first() {
    let f = fixture();
    f.left_by_a_previous_run(&pending("0.9.3", false, true), GOOD);
    f.launch();
    assert_eq!(f.state(), failed("0.9.3", DID_NOT_INSTALL));
    f.forget_log();
    f.check_finds(Ok(Some(found("0.9.4"))));

    f.download();

    assert_eq!(f.logged()[0], "check");
    assert!(f.logged_any("package https://x/0.9.4"));
    assert_eq!(f.state(), ready("0.9.4"));
}

#[test]
fn a_retry_after_a_relaunch_that_finds_nothing_or_cant_ask_ends_where_the_user_can_see() {
    let f = fixture();
    f.left_by_a_previous_run(&pending("0.9.3", false, true), GOOD);
    f.launch();

    f.check_finds(Err("dns".to_owned()));
    f.download();
    assert_eq!(f.state(), failed("0.9.3", REACH));
    assert!(!f.logged_any("package"));

    f.check_finds(Ok(None));
    f.download();
    assert_eq!(f.state(), AppUpdateState::None);
}

// ---- update on next launch

#[test]
fn on_next_launch_is_saved_at_once_and_only_while_ready() {
    let f = fixture();
    assert_eq!(f.updates.set_on_next_launch(true), Ok(AppUpdateState::None), "nothing to apply it to");
    f.ready_with("0.9.3", GOOD);

    let state = f.updates.set_on_next_launch(true).unwrap();

    assert_eq!(state, AppUpdateState::Ready { version: "0.9.3".to_owned(), on_next_launch: true });
    assert_eq!(f.files().read_pending(), Some(pending("0.9.3", true, false)));

    assert_eq!(f.updates.set_on_next_launch(false), Ok(ready("0.9.3")));
    assert_eq!(f.files().read_pending(), Some(pending("0.9.3", false, false)));
}

// ---- restart

#[test]
fn a_restart_outside_ready_does_nothing() {
    let f = fixture();
    assert!(!f.updates.begin_restart());

    f.available_after_a_check("0.9.3");
    assert!(!f.updates.begin_restart());
    assert_eq!(f.state(), available("0.9.3"));
}

#[test]
fn a_restart_shows_installing_then_marks_the_attempt_installs_stops_everything_and_restarts() {
    let f = fixture();
    f.ready_with("0.9.3", GOOD);
    f.forget_log();

    assert!(f.updates.begin_restart());
    assert!(!f.updates.begin_restart(), "one install");
    assert_eq!(lock(&f.events).last(), Some(&installing("0.9.3")), "before any work");
    f.updates.run_restart();

    assert_eq!(f.logged(), ["install attempted=true", "stop", "restart"]);
}

#[test]
fn a_failed_install_leaves_everything_running_and_the_attempt_cleared() {
    let f = fixture();
    f.ready_with("0.9.3", GOOD);
    f.updates.set_on_next_launch(true).unwrap();
    f.forget_log();
    *lock(&f.installer.install_fails) = Some(InstallError { failure: Failure::Replace, detail: "permission denied".to_owned() });

    assert!(f.updates.begin_restart());
    let warnings = warnings_during(|| f.updates.run_restart());

    assert_eq!(warnings, 0);
    // The plugin's hook hides the windows on Windows before the installer can fail to start.
    assert_eq!(f.logged(), ["install attempted=true", "show"], "nothing stopped, and the window is back");
    assert_eq!(f.state(), failed("0.9.3", REPLACE));
    assert_eq!(lock(&f.events).last(), Some(&failed("0.9.3", REPLACE)));
    assert_eq!(f.files().read_pending(), Some(pending("0.9.3", false, false)), "tried once");
    assert_eq!(f.package_on_disk(), GOOD);
}

#[test]
fn a_panic_in_the_installer_is_a_failed_install_not_a_button_stuck_on_installing() {
    let f = fixture();
    f.ready_with("0.9.3", GOOD);
    *lock(&f.installer.install_panics) = true;

    assert!(f.updates.begin_restart());
    f.updates.run_restart();

    assert_eq!(f.state(), failed("0.9.3", REPLACE));
    assert!(!f.logged_any("stop"));
}

#[test]
fn a_package_corrupted_since_it_was_verified_is_deleted_at_restart() {
    let f = fixture();
    f.ready_with("0.9.3", GOOD);
    std::fs::write(f.files().package(), b"bit rot").unwrap();

    assert!(f.updates.begin_restart());
    f.updates.run_restart();

    assert_eq!(f.state(), failed("0.9.3", SIGNATURE));
    assert!(f.on_disk().is_empty(), "{:?}", f.on_disk());
    assert!(!f.logged_any("stop"));
}

#[test]
fn a_package_gone_at_restart_is_a_failed_install() {
    let f = fixture();
    f.ready_with("0.9.3", GOOD);
    std::fs::remove_file(f.files().package()).unwrap();

    assert!(f.updates.begin_restart());
    f.updates.run_restart();

    assert_eq!(f.state(), failed("0.9.3", REPLACE));
    assert!(f.logged_any("show"));
}

// ---- launch: each row of the spec's table

#[test]
fn a_launch_after_a_successful_install_reports_updated_once_and_deletes_the_folder() {
    let f = fixture_with(false, true, "0.9.3");
    f.left_by_a_previous_run(&pending("0.9.3", false, true), GOOD);

    f.launch();

    assert_eq!(f.updates.page_state(), AppUpdateState::Updated { version: "0.9.3".to_owned() });
    assert_eq!(f.updates.page_state(), AppUpdateState::None);
    assert!(f.on_disk().is_empty(), "{:?}", f.on_disk());
    assert!(!f.logged_any("install"));
}

#[test]
fn a_launch_still_on_the_old_version_after_an_attempt_reports_failed_and_never_tries_again() {
    // A crash between `attempted` and the install, or a Windows installer that failed after the exit.
    let f = fixture();
    f.left_by_a_previous_run(&pending("0.9.3", true, true), GOOD);

    f.launch();

    assert_eq!(f.state(), failed("0.9.3", DID_NOT_INSTALL));
    assert!(f.on_disk().is_empty(), "{:?}", f.on_disk());
    assert!(!f.logged_any("install"));
}

#[test]
fn a_launch_on_a_version_past_a_waiting_update_forgets_it() {
    let f = fixture_with(false, true, "0.9.4");
    f.left_by_a_previous_run(&pending("0.9.3", false, false), GOOD);

    f.launch();

    assert_eq!(f.state(), AppUpdateState::None);
    assert!(f.on_disk().is_empty(), "{:?}", f.on_disk());
}

#[test]
fn a_launch_with_on_next_launch_installs_before_anything_else_and_restarts() {
    let f = fixture();
    f.left_by_a_previous_run(&pending("0.9.3", true, false), GOOD);

    let launch = f.updates.plan_launch();
    assert!(matches!(launch, Launch::Install(_)));
    assert_eq!(f.state(), installing("0.9.3"), "before the page can ask");
    f.updates.run_launch(launch);

    assert_eq!(f.logged(), ["install attempted=true", "stop", "restart"]);
}

#[test]
fn a_failed_install_on_next_launch_opens_normally_with_failed_and_is_tried_once() {
    let f = fixture();
    f.left_by_a_previous_run(&pending("0.9.3", true, false), GOOD);
    *lock(&f.installer.install_fails) = Some(InstallError { failure: Failure::Replace, detail: "no".to_owned() });

    f.launch();

    assert_eq!(f.logged(), ["install attempted=true", "show"], "the window it hid comes back");
    assert_eq!(f.state(), failed("0.9.3", REPLACE));
    assert_eq!(f.files().read_pending(), Some(pending("0.9.3", false, false)));

    // The launch after that: the package is still good, and it waits for the user.
    let again = fixture();
    again.left_by_a_previous_run(&f.files().read_pending().unwrap(), GOOD);
    again.launch();
    assert_eq!(again.state(), ready("0.9.3"));
    assert!(!again.logged_any("install"));
}

#[test]
fn a_corrupted_package_on_next_launch_is_deleted_and_the_app_opens_with_failed() {
    let f = fixture();
    f.left_by_a_previous_run(&pending("0.9.3", true, false), b"bit rot");

    f.launch();

    assert_eq!(f.state(), failed("0.9.3", SIGNATURE));
    assert!(f.on_disk().is_empty(), "{:?}", f.on_disk());
    assert!(f.logged_any("show"));
    assert!(!f.logged_any("stop"));
}

#[test]
fn a_launch_with_an_update_waiting_shows_ready_once_its_package_passes_without_downloading_again() {
    let f = fixture();
    f.left_by_a_previous_run(&pending("0.9.3", false, false), GOOD);
    let updates = f.updates.clone();
    let during = Arc::new(Mutex::new(None));
    let seen = during.clone();
    *lock(&f.installer.during_verify) = Some(Box::new(move || *lock(&seen) = Some(updates.state())));

    f.launch();

    assert_eq!(*lock(&during), Some(AppUpdateState::None), "None until the hash is done");
    assert_eq!(f.state(), ready("0.9.3"));
    assert_eq!(lock(&f.events).last(), Some(&ready("0.9.3")));
    assert_eq!(f.on_disk(), ["package", "pending.json"]);
    assert!(!f.logged_any("package"));
    assert!(!f.logged_any("check"));
}

#[test]
fn a_corrupted_or_missing_package_at_launch_is_forgotten() {
    for bytes in [Some(b"bit rot".as_slice()), None] {
        let f = fixture();
        f.left_by_a_previous_run(&pending("0.9.3", false, false), GOOD);
        match bytes {
            Some(bytes) => std::fs::write(f.files().package(), bytes).unwrap(),
            None => std::fs::remove_file(f.files().package()).unwrap(),
        }

        f.launch();

        assert_eq!(f.state(), AppUpdateState::None);
        assert!(f.on_disk().is_empty(), "{:?}", f.on_disk());
        assert!(!f.logged_any("install"));
    }
}

#[test]
fn a_malformed_pending_json_is_cleaned_up_and_never_fails_the_launch() {
    let f = fixture();
    std::fs::create_dir_all(f.root.join("app-update")).unwrap();
    for text in ["", "not json", r#"{"version":"nope","manifest":{},"onNextLaunch":false,"attempted":false}"#, r#"{"version":"0.9.3"}"#] {
        std::fs::write(f.root.join("app-update/pending.json"), text).unwrap();
        std::fs::write(f.files().package(), GOOD).unwrap();

        let launch = f.launch();

        assert_eq!(launch, Launch::Clean(AppUpdateState::None), "{text}");
        assert_eq!(f.state(), AppUpdateState::None);
        assert!(f.on_disk().is_empty(), "{text}: {:?}", f.on_disk());
        std::fs::create_dir_all(f.root.join("app-update")).unwrap();
    }
}

#[test]
fn a_package_no_pending_json_names_is_deleted_at_launch() {
    let f = fixture();
    std::fs::create_dir_all(f.root.join("app-update")).unwrap();
    std::fs::write(f.files().package(), GOOD).unwrap();
    std::fs::write(f.root.join("app-update/package.new.part"), b"half").unwrap();

    f.launch();

    assert!(f.on_disk().is_empty(), "{:?}", f.on_disk());
}

#[test]
fn a_download_a_crash_cut_short_goes_at_launch_and_the_waiting_update_stays() {
    let f = fixture();
    f.left_by_a_previous_run(&pending("0.9.3", false, false), GOOD);
    std::fs::write(f.root.join("app-update/package.new"), b"newer").unwrap();
    std::fs::write(f.root.join("app-update/package.new.part"), b"half").unwrap();

    f.launch();

    assert_eq!(f.state(), ready("0.9.3"));
    assert_eq!(f.on_disk(), ["package", "pending.json"]);
}

#[test]
fn a_build_with_no_updates_leaves_what_an_installed_app_has_waiting_alone() {
    // A dev build shares its data folder with an installed app, and isn't what the update replaces.
    let f = fixture_with(false, false, "0.1.0");
    f.left_by_a_previous_run(&pending("0.9.3", true, false), GOOD);

    f.launch();

    assert_eq!(f.state(), AppUpdateState::None);
    assert_eq!(f.on_disk(), ["package", "pending.json"]);
    assert!(!f.logged_any("install"));
}

// ---- the small decisions

#[test]
fn checks_are_on_by_default_in_a_release_build() {
    // Zed's post-mortem: a settings refactor turned auto-update off for several releases.
    assert!(checks_on(false, false), "a release build, nothing set");
    assert!(!checks_on(false, true), "BATRAK_NO_UPDATE_CHECK");
    assert!(!checks_on(true, false), "a debug build");
}

#[test]
fn manual_installs_are_the_packages_and_a_mac_app_that_never_got_installed() {
    use tauri::utils::config::BundleType::{App, AppImage, Deb, Msi, Nsis, Rpm};
    let installed = "/Applications/Batrak.app/Contents/MacOS/batrak";

    assert!(is_manual(Some(Deb), "/usr/bin/batrak", false));
    assert!(is_manual(Some(Rpm), "/usr/bin/batrak", false));
    assert!(!is_manual(Some(AppImage), "/home/me/Batrak.AppImage", false));
    assert!(!is_manual(Some(Nsis), r"C:\Program Files\Batrak\batrak.exe", false));
    assert!(!is_manual(Some(Msi), r"C:\Program Files\Batrak\batrak.exe", false));
    assert!(!is_manual(Some(App), installed, true));
    assert!(is_manual(Some(App), "/Volumes/Batrak 0.9.2/Batrak.app/Contents/MacOS/batrak", true));
    assert!(is_manual(Some(App), "/private/var/folders/x/T/AppTranslocation/ABC/d/Batrak.app/Contents/MacOS/batrak", true));
    assert!(!is_manual(Some(Nsis), "/Volumes/on-a-mac-only", false));
}

#[test]
fn the_release_page_is_the_versions_tag() {
    assert_eq!(release_page("0.9.3"), "https://github.com/Symblight/batrak/releases/tag/v0.9.3");
}

#[test]
fn the_version_a_state_is_about_opens_its_release_page() {
    let f = fixture();
    assert_eq!(f.updates.release_version(), None);

    f.available_after_a_check("0.9.3");

    assert_eq!(f.updates.release_version().as_deref(), Some("0.9.3"));
}

#[test]
fn the_page_reads_each_state_as_the_spec_writes_it() {
    let json = |state: AppUpdateState| serde_json::to_value(state).unwrap();

    assert_eq!(json(AppUpdateState::None), json!({ "state": "none" }));
    assert_eq!(
        json(AppUpdateState::Available { version: "1".into(), current: "0".into(), manual: true }),
        json!({ "state": "available", "version": "1", "current": "0", "manual": true })
    );
    assert_eq!(
        json(AppUpdateState::Downloading { version: "1".into(), received: 2, total: None }),
        json!({ "state": "downloading", "version": "1", "received": 2, "total": null })
    );
    assert_eq!(
        json(AppUpdateState::Ready { version: "1".into(), on_next_launch: true }),
        json!({ "state": "ready", "version": "1", "onNextLaunch": true })
    );
    assert_eq!(json(installing("1")), json!({ "state": "installing", "version": "1" }));
    assert_eq!(json(failed("1", "why")), json!({ "state": "failed", "version": "1", "reason": "why" }));
    assert_eq!(json(AppUpdateState::Updated { version: "1".into() }), json!({ "state": "updated", "version": "1" }));
}

#[test]
fn a_chat_in_a_terminal_counts_as_an_agent_and_not_again_as_a_terminal() {
    let busy = |ids: &[&str]| ids.iter().map(|id| (*id).to_owned()).collect::<Vec<String>>();

    let blockers = restart_blockers(2, &busy(&["cli-1", "shell-1", "shell-2"]), &busy(&["cli-1", "cli-2"]));

    assert_eq!(blockers, RestartBlockers { agents: 2, terminals: 2 });
}

#[test]
fn the_updater_config_is_what_the_release_is_signed_for_and_the_plugin_parses_it() {
    let conf: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();

    let config: tauri_plugin_updater::Config = serde_json::from_value(conf["plugins"]["updater"].clone()).unwrap();

    assert_eq!(config.pubkey, bt_core::release::PUBKEY);
    assert!(config.require_signed_version);
    let endpoint = config.endpoints.first().unwrap().as_str().to_owned();
    assert_eq!(endpoint, format!("{}/releases/latest/download/latest.json", bt_core::release::REPO_URL));
    assert_eq!(conf["plugins"]["updater"]["windows"]["installMode"], "passive");
    assert!(config.windows.is_some());
}
