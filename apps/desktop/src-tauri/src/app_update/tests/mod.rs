//! The update flow from a command's side: states, events and files on disk, over one fake for the
//! installer, the source and the host, and a temp folder.

mod check;
mod download;
mod install;
mod launch;
mod pure;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bt_core::release::{Manifest, Source};
use serde_json::{json, Value};
use tracing_subscriber::layer::SubscriberExt;

use super::installer::{Found, InstallError, Installer};
use super::pending::{Files, Launch, Pending, DID_NOT_INSTALL};
use super::*;

const GOOD: &[u8] = b"a signed package";
const OTHER_GOOD: &[u8] = b"another signed package";
/// Fails its signature check.
const BAD: &[u8] = b"tampered";
/// Passes its signature check, and the installer can't put it in place.
const REFUSED: &[u8] = b"a package the installer refuses";
const REACH: &str = "couldn't reach GitHub";
const SIGNATURE: &str = "the download failed its signature check";
const REPLACE: &str = "couldn't replace the app";
/// What `app-update/` holds with an update waiting.
const WAITING: &[&str] = &["package", "pending.json"];

/// What a case does to its fixture.
type Arrange = fn(&Fixture);
type Outcome = (AppUpdateState, Vec<String>, Vec<String>);
type Hook = Box<dyn FnOnce() + Send>;

fn expect(state: AppUpdateState, on_disk: &[&str], logged: &[&str]) -> Outcome {
    let strings = |lines: &[&str]| lines.iter().map(|line| (*line).to_owned()).collect();
    (state, strings(on_disk), strings(logged))
}

fn manifest(version: &str) -> Value { json!({ "version": version, "platforms": {} }) }
fn pending(version: &str, on_next_launch: bool, attempted: bool) -> Pending { Pending { version: version.parse().unwrap(), manifest: manifest(version), on_next_launch, attempted } }
fn available(version: &str) -> AppUpdateState { AppUpdateState::Available { version: version.to_owned(), current: "0.9.2".to_owned(), manual: false } }
fn ready(version: &str) -> AppUpdateState { AppUpdateState::Ready { version: version.to_owned(), on_next_launch: false } }
fn failed(version: &str, reason: &str) -> AppUpdateState { AppUpdateState::Failed { version: version.to_owned(), reason: reason.to_owned() } }
fn installing(version: &str) -> AppUpdateState { AppUpdateState::Installing { version: version.to_owned() } }

/// The installer, the source and the host. Logs each call, then runs what `Fixture::on` left for it.
struct Fake {
    files: Files,
    log: Mutex<Vec<String>>,
    hooks: Mutex<HashMap<&'static str, Hook>>,
    /// The version the next checks find; an `Err` can't reach GitHub. Finds nothing when none is left.
    checks: Mutex<VecDeque<Result<Option<&'static str>, ()>>>,
    /// What the next transfers send; `None` fails. `GOOD` when none is left.
    packages: Mutex<VecDeque<Option<&'static [u8]>>>,
}

impl Fake {
    fn note(&self, line: &str) {
        lock(&self.log).push(line.to_owned());
        let hook = lock(&self.hooks).remove(line.split(' ').next().unwrap_or_default());
        if let Some(hook) = hook {
            hook();
        }
    }
}

impl Installer for Fake {
    fn check(&self) -> Result<Option<Found>, String> {
        self.note("check");
        let answer = lock(&self.checks).pop_front().unwrap_or(Ok(None));
        let found = |version: &str| Found { version: version.parse().unwrap(), current: "0.9.2".to_owned(), url: format!("https://x/{version}"), manifest: manifest(version) };
        answer.map(|version| version.map(found)).map_err(|()| "dns".to_owned())
    }

    fn verify(&self, _: &Value, bytes: &[u8]) -> Result<(), String> {
        self.note("verify");
        if bytes == BAD { Err("bad signature".to_owned()) } else { Ok(()) }
    }

    fn install(&self, _: &Value, bytes: &[u8]) -> Result<(), InstallError> {
        let attempted = self.files.read_pending().is_some_and(|pending| pending.attempted);
        self.note(&format!("install attempted={attempted}"));
        let failure = match bytes {
            BAD => Failure::Signature,
            REFUSED => Failure::Replace,
            _ => return Ok(()),
        };
        Err(InstallError { failure, detail: "no".to_owned() })
    }
}

impl Source for Fake {
    fn manifest(&self) -> Result<Manifest, String> { Err("the desktop's checks go through the installer".to_owned()) }

    fn package(&self, url: &str, sink: &mut dyn FnMut(&[u8]) -> Result<(), String>, total: &mut dyn FnMut(Option<u64>)) -> Result<(), String> {
        self.note(&format!("package {url}"));
        let bytes = lock(&self.packages).pop_front().unwrap_or(Some(GOOD)).ok_or("connection reset")?;
        total(Some(bytes.len() as u64));
        sink(bytes)
    }
}

impl Host for Fake {
    fn stop_everything(&self) { self.note("stop"); }
    fn report_stopped(&self) { self.note("report stopped"); }
    fn restart(&self) { self.note("restart"); }
    fn show_window(&self) { self.note("show"); }
}

struct Fixture {
    root: PathBuf,
    files: Files,
    fake: Arc<Fake>,
    events: Arc<Mutex<Vec<AppUpdateState>>>,
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
    let fake = Arc::new(Fake { files: Files::new(dir.clone()), log: Mutex::default(), hooks: Mutex::default(), checks: Mutex::default(), packages: Mutex::default() });
    let events = Arc::new(Mutex::new(Vec::new()));
    let heard = events.clone();
    let updates = AppUpdates::new(Options {
        dir: dir.clone(),
        running: running.parse().unwrap(),
        manual,
        updates_enabled,
        installer: fake.clone(),
        source: fake.clone(),
        host: fake.clone(),
        sink: Arc::new(move |state: &AppUpdateState| lock(&heard).push(state.clone())),
    });
    Fixture { root, files: Files::new(dir), fake, events, updates }
}

fn fixture() -> Fixture {
    fixture_with(false, true, "0.9.2")
}

impl Fixture {
    /// Runs `hook` once, inside the fake's next call of that name: what happens mid-download or mid-verify.
    fn on(&self, call: &'static str, hook: impl FnOnce(&AppUpdates) + Send + 'static) {
        let updates = self.updates.clone();
        lock(&self.fake.hooks).insert(call, Box::new(move || hook(&updates)));
    }

    fn check_finds(&self, answer: Result<Option<&'static str>, ()>) {
        lock(&self.fake.checks).push_back(answer);
    }

    fn serves(&self, package: Option<&'static [u8]>) {
        lock(&self.fake.packages).push_back(package);
    }

    /// What's on disk under `app-update/`, sorted.
    fn on_disk(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.root.join("app-update")) else { return Vec::new() };
        let mut names: Vec<String> = entries.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    /// The state, the files, and the fake's calls since the helper that set the state up.
    fn outcome(&self) -> Outcome {
        (self.updates.state(), self.on_disk(), lock(&self.fake.log).clone())
    }

    fn assert_waits(&self, version: &str, package: &[u8]) {
        assert_eq!(self.files.read_pending(), Some(pending(version, false, false)));
        assert_eq!(std::fs::read(self.files.package()).unwrap(), package);
        assert_eq!(self.on_disk(), WAITING);
    }

    fn available_after_a_check(&self, version: &'static str) {
        self.check_finds(Ok(Some(version)));
        assert_eq!(self.updates.check(CheckBy::Schedule), Ok(available(version)));
        lock(&self.fake.log).clear();
    }

    fn download(&self) {
        let job = self.updates.begin_download().unwrap().expect("a download starts");
        self.updates.run_download(job);
    }

    fn failed_after_a_download(&self, version: &'static str) {
        self.available_after_a_check(version);
        self.serves(None);
        self.download();
        lock(&self.fake.log).clear();
    }

    fn ready_after_a_download(&self, version: &'static str) {
        self.available_after_a_check(version);
        self.download();
        lock(&self.fake.log).clear();
    }

    /// Version 0.9.3, as a previous run left it.
    fn left_by_a_previous_run(&self, on_next_launch: bool, attempted: bool, package: &[u8]) {
        self.files.write_pending(&pending("0.9.3", on_next_launch, attempted)).unwrap();
        std::fs::write(self.files.package(), package).unwrap();
    }

    fn launch(&self) -> Launch {
        let launch = self.updates.plan_launch();
        self.updates.run_launch(launch.clone());
        launch
    }
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
    tracing::subscriber::with_default(tracing_subscriber::registry().with(warnings.clone()), work);
    warnings.0.load(Ordering::Relaxed)
}
