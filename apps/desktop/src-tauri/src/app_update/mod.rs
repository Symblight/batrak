//! Updating the app from GitHub Releases (spec: `docs/specs/app-update.md`). `AppUpdates` is the one
//! writer of `AppUpdateState`: every change goes through `next`, under one mutex, and reaches the page
//! as `app-update://changed`. A command that doesn't apply where the state is changes nothing.

pub mod installer;
pub mod pending;
pub mod process_lock;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bt_core::dirs::Dirs;
use bt_core::release::{self, DownloadError, Downloaded, Source};
use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tracing::{debug, info};

use installer::{Found, InstallError, Installer, PluginInstaller};
use pending::{Files, Launch, Pending};
use process_lock::Standing;

const CHANGED: &str = "app-update://changed";
const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const MEGABYTE: u64 = 1024 * 1024;
const LOCK_WAIT: Duration = Duration::from_secs(1);

/// Debug builds have no update row and never touch what waits on disk: they share the data folder with
/// an installed app, and aren't what its update replaces.
pub const UPDATES_ENABLED: bool = !cfg!(debug_assertions);

/// Why an update failed, as the Failed button says it. The raw detail goes to the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Network,
    Signature,
    Disk,
    Replace,
}

impl Failure {
    fn reason(self) -> &'static str {
        match self {
            Failure::Network => "couldn't reach GitHub",
            Failure::Signature => "the download failed its signature check",
            Failure::Disk => "couldn't save the update",
            Failure::Replace => "couldn't replace the app",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AppUpdateState {
    None,
    Available { version: String, current: String, manual: bool },
    Downloading { version: String, received: u64, total: Option<u64> },
    Ready { version: String, on_next_launch: bool },
    Installing { version: String },
    Failed { version: String, reason: String },
    /// Only from the first `app_update_state` after a relaunch on the new version; then `None`.
    Updated { version: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartBlockers {
    pub agents: usize,
    pub terminals: usize,
}

/// What restarting asks about. A chat its CLI runs is its session's business (`Sessions::working`,
/// which asks its terminal too), so that terminal never counts again as a terminal.
pub fn restart_blockers(working: usize, busy_terminals: &[String], cli_terminals: &[String]) -> RestartBlockers {
    RestartBlockers { agents: working, terminals: busy_terminals.iter().filter(|id| !cli_terminals.contains(id)).count() }
}

/// What can happen to the state.
enum Step {
    Found { version: Version, current: String, manual: bool },
    NothingFound,
    DownloadStarted { version: String },
    Progress { received: u64, total: Option<u64> },
    Cancelled { current: String },
    DownloadFailed { reason: String },
    /// A retry's check found no release any more.
    ReleaseGone,
    Downloaded,
    RestartAsked,
    InstallFailed { reason: String },
    OnNextLaunch(bool),
    /// A package from an earlier run passed its check.
    Restored { version: String },
}

/// The state after `step`; the same state when `step` doesn't apply there.
fn next(state: &AppUpdateState, step: Step) -> AppUpdateState {
    use AppUpdateState as S;
    match (state, step) {
        (S::Failed { version: failed, .. }, Step::Found { version, .. }) if *failed == version.to_string() => state.clone(),
        (S::Ready { version: ready, .. }, Step::Found { version, .. }) if !is_newer(ready, &version) => state.clone(),
        (S::None | S::Updated { .. } | S::Available { .. } | S::Failed { .. } | S::Ready { .. }, Step::Found { version, current, manual }) => {
            S::Available { version: version.to_string(), current, manual }
        }
        (S::Available { .. } | S::Failed { .. }, Step::NothingFound) => S::None,
        (S::Available { .. } | S::Failed { .. } | S::Downloading { .. }, Step::DownloadStarted { version }) => S::Downloading { version, received: 0, total: None },
        (S::Downloading { version, .. }, Step::Progress { received, total }) => S::Downloading { version: version.clone(), received, total },
        (S::Downloading { version, .. }, Step::Cancelled { current }) => S::Available { version: version.clone(), current, manual: false },
        (S::Downloading { version, .. }, Step::DownloadFailed { reason }) => S::Failed { version: version.clone(), reason },
        (S::Downloading { .. }, Step::ReleaseGone) => S::None,
        (S::Downloading { version, .. }, Step::Downloaded) => S::Ready { version: version.clone(), on_next_launch: false },
        (S::Ready { version, .. }, Step::RestartAsked) => S::Installing { version: version.clone() },
        (S::Ready { version, .. }, Step::OnNextLaunch(on_next_launch)) => S::Ready { version: version.clone(), on_next_launch },
        (S::Installing { version }, Step::InstallFailed { reason }) => S::Failed { version: version.clone(), reason },
        (S::None, Step::Restored { version }) => S::Ready { version, on_next_launch: false },
        (state, _) => state.clone(),
    }
}

fn is_newer(than: &str, version: &Version) -> bool {
    Version::parse(than).is_ok_and(|than| release::compare(&than, version))
}

/// Who asks for a check. A person gets the state as it is while an update is on its way; the schedule
/// may still find something newer than what's ready.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckBy {
    User,
    Schedule,
}

fn may_check(state: &AppUpdateState, by: CheckBy) -> bool {
    match state {
        AppUpdateState::Downloading { .. } | AppUpdateState::Installing { .. } => false,
        AppUpdateState::Ready { .. } => by == CheckBy::Schedule,
        _ => true,
    }
}

/// Whether the app checks by itself: on unless a debug build or `BATRAK_NO_UPDATE_CHECK` says otherwise.
pub fn checks_on(debug_build: bool, disabled_by_env: bool) -> bool {
    !debug_build && !disabled_by_env
}

/// Whether this install can't replace itself, so only **Download manually** is offered. `exe` matters on
/// macOS only: an app run from a disk image or translocated by Gatekeeper has no place to go.
pub fn is_manual(bundle: Option<tauri::utils::config::BundleType>, exe: &str, macos: bool) -> bool {
    use tauri::utils::config::BundleType::{Deb, Rpm};
    matches!(bundle, Some(Deb | Rpm)) || (macos && (exe.starts_with("/Volumes/") || exe.contains("/AppTranslocation/")))
}

pub fn release_page(version: &str) -> String {
    format!("{}/releases/tag/v{version}", release::REPO_URL)
}

/// What the app does that the update flow needs and a test records.
pub trait Host: Send + Sync {
    fn stop_everything(&self);
    /// Tells the page what a stop that the app outlived left stopped; nothing when none ran.
    fn report_stopped(&self);
    /// Doesn't return in the app.
    fn restart(&self);
    /// Brings back the window a failed install left hidden: by a launch, or on Windows by the hook
    /// that runs before the installer starts.
    fn show_window(&self);
    /// Hides the window for an install on next launch that had to wait for the lock.
    fn hide_window(&self);
}

struct AppHost<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Host for AppHost<R> {
    fn stop_everything(&self) {
        crate::stop_everything(&self.0);
    }

    fn report_stopped(&self) {
        tauri::async_runtime::block_on(self.0.state::<crate::session::Sessions>().report_stopped());
    }

    fn restart(&self) {
        self.0.restart();
    }

    fn show_window(&self) {
        for window in self.0.webview_windows().values() {
            let _ = window.show();
        }
    }

    fn hide_window(&self) {
        for window in self.0.webview_windows().values() {
            let _ = window.hide();
        }
    }
}

pub struct Options {
    /// `app-update/` under `Dirs.data`.
    pub dir: PathBuf,
    /// `app-update.lock` under `Dirs.data`.
    pub lock: PathBuf,
    /// How long a launch that finds the lock held keeps trying.
    pub lock_wait: Duration,
    pub running: Version,
    pub manual: bool,
    pub updates_enabled: bool,
    pub installer: Arc<dyn Installer>,
    pub source: Arc<dyn Source>,
    pub host: Arc<dyn Host>,
    pub sink: Arc<dyn Fn(&AppUpdateState) + Send + Sync>,
}

#[derive(Clone)]
pub struct AppUpdates {
    inner: Arc<Inner>,
}

struct Inner {
    options: Options,
    files: Files,
    /// Held through a download, so one that was cancelled is gone before the next writes the same file.
    work: Mutex<()>,
    core: Mutex<Core>,
}

struct Core {
    state: AppUpdateState,
    /// What the last check found, for the download of the version the state names.
    found: Option<Found>,
    /// The running download's cancel flag, set only under this lock: whoever holds it knows whether the
    /// download still owns the state.
    cancel: Option<Arc<AtomicBool>>,
    standing: Standing,
}

/// A download `begin_download` admitted.
pub struct Download {
    cancel: Arc<AtomicBool>,
    found: Option<Found>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl AppUpdates {
    pub fn new(options: Options) -> AppUpdates {
        let files = Files::new(options.dir.clone());
        // A dev build shares its data folder with an installed app, and mustn't hold up that app's updates.
        let standing = if options.updates_enabled { process_lock::claim(&options.lock) } else { Standing::Handling(None) };
        let core = Core { state: AppUpdateState::None, found: None, cancel: None, standing };
        AppUpdates { inner: Arc::new(Inner { options, files, work: Mutex::new(()), core: Mutex::new(core) }) }
    }

    /// Moves the state and tells the page, in that order under the lock, so events can't overtake.
    fn step(&self, core: &mut Core, step: Step) {
        let after = next(&core.state, step);
        if after != core.state {
            core.state = after;
            (self.inner.options.sink)(&core.state);
        }
    }

    /// Whether About has its **Check for updates** row.
    pub fn updates_enabled(&self) -> bool {
        self.inner.options.updates_enabled && lock(&self.inner.core).standing.handling()
    }

    pub fn state(&self) -> AppUpdateState {
        lock(&self.inner.core).state.clone()
    }

    /// The state for a page that just loaded. `Updated` is told once.
    pub fn page_state(&self) -> AppUpdateState {
        let mut core = lock(&self.inner.core);
        let state = core.state.clone();
        if matches!(state, AppUpdateState::Updated { .. }) {
            core.state = AppUpdateState::None;
        }
        state
    }

    /// The version whose release page **Download manually** opens.
    pub fn release_version(&self) -> Option<String> {
        use AppUpdateState as S;
        match self.state() {
            S::None => None,
            S::Available { version, .. } | S::Downloading { version, .. } | S::Ready { version, .. } | S::Installing { version } | S::Failed { version, .. } | S::Updated { version } => Some(version),
        }
    }

    /// Blocking. An error is for the person who asked: a failed check changes no state, since a failed
    /// check shows nothing by itself. Logged at `debug!`, so no snackbar either.
    pub fn check(&self, by: CheckBy) -> Result<AppUpdateState, String> {
        if by == CheckBy::User && !self.inner.options.updates_enabled {
            return Err("this build doesn't update".to_owned());
        }
        {
            let core = lock(&self.inner.core);
            if !core.standing.handling() || !may_check(&core.state, by) {
                return Ok(core.state.clone());
            }
        }
        let found = self.inner.options.installer.check().map_err(|detail| {
            debug!(detail, "update check failed");
            Failure::Network.reason().to_owned()
        })?;
        let mut core = lock(&self.inner.core);
        match found {
            Some(found) => {
                let (version, current) = (found.version.clone(), found.current.clone());
                self.step(&mut core, Step::Found { version, current, manual: self.inner.options.manual });
                if matches!(core.state, AppUpdateState::Available { .. } | AppUpdateState::Failed { .. }) {
                    core.found = Some(found);
                }
            }
            None => {
                self.step(&mut core, Step::NothingFound);
                if core.state == AppUpdateState::None {
                    core.found = None;
                }
            }
        }
        Ok(core.state.clone())
    }

    /// Available or Failed → Downloading, at once; `None` when there's nothing to start. `run_download`
    /// does the rest.
    pub fn begin_download(&self) -> Result<Option<Download>, String> {
        let mut core = lock(&self.inner.core);
        let (AppUpdateState::Available { version, .. } | AppUpdateState::Failed { version, .. }) = core.state.clone() else {
            return Ok(None);
        };
        if self.inner.options.manual {
            return Err("this install can't update itself: download the release instead".to_owned());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        core.cancel = Some(cancel.clone());
        let found = core.found.clone().filter(|found| found.version.to_string() == version);
        info!(version, "update download started");
        self.step(&mut core, Step::DownloadStarted { version });
        Ok(Some(Download { cancel, found }))
    }

    /// Blocking. Package written → verified → `pending.json` → Ready.
    pub fn run_download(&self, job: Download) {
        let _one_writer = lock(&self.inner.work);
        let Download { cancel, found } = job;
        let found = match found {
            Some(found) => found,
            None => match self.find_for_a_retry(&cancel) {
                Some(found) => found,
                None => return,
            },
        };
        let mut throttle = Throttle::default();
        let progress = |received, total| {
            if throttle.moved(received, total) {
                self.if_still_running(&cancel, |core| self.step(core, Step::Progress { received, total }));
            }
        };
        let files = &self.inner.files;
        match release::download(&*self.inner.options.source, &found.url, &files.incoming(), &cancel, progress) {
            Ok(Downloaded::Cancelled) => {}
            Ok(Downloaded::Done) => self.finish_download(&cancel, &found),
            Err(DownloadError::Network(detail)) => self.fail_download(&cancel, Failure::Network, &detail),
            Err(DownloadError::Disk(detail)) => self.fail_download(&cancel, Failure::Disk, &detail),
        }
    }

    /// After a relaunch or a cancelled retry no `Found` is known, so the download asks first.
    fn find_for_a_retry(&self, cancel: &AtomicBool) -> Option<Found> {
        match self.inner.options.installer.check() {
            Ok(Some(found)) => {
                self.if_still_running(cancel, |core| {
                    core.found = Some(found.clone());
                    self.step(core, Step::DownloadStarted { version: found.version.to_string() });
                });
                Some(found)
            }
            Ok(None) => {
                self.if_still_running(cancel, |core| self.step(core, Step::ReleaseGone));
                None
            }
            Err(detail) => {
                self.fail_download(cancel, Failure::Network, &detail);
                None
            }
        }
    }

    fn if_still_running(&self, cancel: &AtomicBool, change: impl FnOnce(&mut Core)) {
        let mut core = lock(&self.inner.core);
        if !cancel.load(Ordering::SeqCst) {
            change(&mut core);
        }
    }

    fn fail_download(&self, cancel: &AtomicBool, failure: Failure, detail: &str) {
        info!(detail, "the update's download failed");
        self.inner.files.remove_incoming();
        self.if_still_running(cancel, |core| self.step(core, Step::DownloadFailed { reason: failure.reason().to_owned() }));
    }

    /// Under the lock from the cancel flag's last look to Ready, so a cancel either comes first and
    /// nothing changes on disk, or comes after and finds Ready.
    fn finish_download(&self, cancel: &AtomicBool, found: &Found) {
        let files = &self.inner.files;
        let verified = match std::fs::read(files.incoming()) {
            Ok(bytes) => self.inner.options.installer.verify(&found.manifest, &bytes).map_err(|detail| (Failure::Signature, detail)),
            Err(e) => Err((Failure::Disk, e.to_string())),
        };
        let mut core = lock(&self.inner.core);
        if cancel.load(Ordering::SeqCst) {
            files.remove_incoming();
            return;
        }
        let pending = Pending { version: found.version.clone(), manifest: found.manifest.clone(), on_next_launch: false, attempted: false };
        let promoted = verified.and_then(|()| files.promote(&pending).map_err(|e| (Failure::Disk, e.to_string())));
        match promoted {
            Ok(()) => {
                info!(version = %found.version, "update downloaded");
                self.step(&mut core, Step::Downloaded);
            }
            Err((failure, detail)) => {
                info!(detail, "the update's download failed");
                files.remove_incoming();
                self.step(&mut core, Step::DownloadFailed { reason: failure.reason().to_owned() });
            }
        }
    }

    /// Downloading → Available at once; the transfer sees the flag at its next chunk.
    pub fn cancel(&self) -> AppUpdateState {
        let mut core = lock(&self.inner.core);
        if matches!(core.state, AppUpdateState::Downloading { .. }) {
            if let Some(flag) = &core.cancel {
                flag.store(true, Ordering::SeqCst);
            }
            info!("update download cancelled");
            self.step(&mut core, Step::Cancelled { current: self.inner.options.running.to_string() });
        }
        core.state.clone()
    }

    /// Blocking: saved at once. Ready only.
    pub fn set_on_next_launch(&self, on: bool) -> Result<AppUpdateState, String> {
        let mut core = lock(&self.inner.core);
        if matches!(core.state, AppUpdateState::Ready { .. }) {
            let files = &self.inner.files;
            let mut pending = files.read_pending().ok_or("the downloaded update is gone")?;
            pending.on_next_launch = on;
            files.write_pending(&pending).map_err(|e| e.to_string())?;
            self.step(&mut core, Step::OnNextLaunch(on));
        }
        Ok(core.state.clone())
    }

    /// Ready → Installing, at once; `false` from anywhere else. `run_restart` does the rest.
    pub fn begin_restart(&self) -> bool {
        let mut core = lock(&self.inner.core);
        if !matches!(core.state, AppUpdateState::Ready { .. }) {
            return false;
        }
        self.step(&mut core, Step::RestartAsked);
        true
    }

    /// Blocking.
    pub fn run_restart(&self) {
        match self.inner.files.read_pending() {
            Some(pending) => self.install(pending),
            None => self.install_failed(InstallError { failure: Failure::Replace, detail: "no pending.json".to_owned() }, None),
        }
    }

    /// `attempted` on disk, the install, and only after it worked everything stopped and the restart. On
    /// Windows a successful install never comes back: the stops ran in `on_before_exit`.
    fn install(&self, mut pending: Pending) {
        let host = &self.inner.options.host;
        match self.attempt(&mut pending) {
            Ok(()) => {
                info!(version = %pending.version, "update installed, restarting");
                host.stop_everything();
                // The new process starts before this one ends, and would take itself for a second one.
                lock(&self.inner.core).standing.let_go();
                host.restart();
            }
            Err(error) => self.install_failed(error, Some(pending)),
        }
    }

    fn attempt(&self, pending: &mut Pending) -> Result<(), InstallError> {
        let files = &self.inner.files;
        pending.attempted = true;
        files.write_pending(pending).map_err(|e| InstallError { failure: Failure::Disk, detail: e.to_string() })?;
        let bytes = std::fs::read(files.package()).map_err(|e| InstallError { failure: Failure::Replace, detail: e.to_string() })?;
        // A panic would leave the button on Installing, and a launch's window hidden.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.inner.options.installer.install(&pending.manifest, &bytes)))
            .unwrap_or_else(|_| Err(InstallError { failure: Failure::Replace, detail: "the installer panicked".to_owned() }))
    }

    /// A bad package goes. Otherwise it stays for the next launch, without `attempted`, which is for a
    /// crash, and without `onNextLaunch`, since that is tried once.
    fn install_failed(&self, error: InstallError, pending: Option<Pending>) {
        info!(detail = error.detail, "the update didn't install");
        let files = &self.inner.files;
        match pending {
            Some(_) if error.failure == Failure::Signature => files.delete_all(),
            Some(mut pending) => {
                pending.attempted = false;
                pending.on_next_launch = false;
                // Still marked, the next launch reports what happened and deletes it: true enough.
                if let Err(e) = files.write_pending(&pending) {
                    info!("couldn't clear the attempt: {e}");
                }
            }
            None => {}
        }
        let mut core = lock(&self.inner.core);
        self.step(&mut core, Step::InstallFailed { reason: error.failure.reason().to_owned() });
        drop(core);
        // On Windows `on_before_exit` already stopped everything, before the installer failed to start.
        self.inner.options.host.report_stopped();
        self.inner.options.host.show_window();
    }

    /// Reads what the last run left (one small file) and settles the state the page will first see.
    /// Never fails: anything unreadable counts as nothing waiting.
    pub fn plan_launch(&self) -> Launch {
        if !self.inner.options.updates_enabled {
            return Launch::Nothing;
        }
        match lock(&self.inner.core).standing {
            Standing::Handling(_) => {}
            Standing::Contended => return Launch::WaitForLock,
            Standing::Aside => return Launch::Nothing,
        }
        let launch = pending::decide(self.inner.files.read_pending(), &self.inner.options.running);
        let mut core = lock(&self.inner.core);
        match &launch {
            Launch::Clean(state) => core.state = state.clone(),
            Launch::Install(pending) => core.state = AppUpdateState::Installing { version: pending.version.to_string() },
            Launch::Verify(_) | Launch::Nothing | Launch::WaitForLock => {}
        }
        launch
    }

    /// Blocking: off the main thread.
    pub fn run_launch(&self, launch: Launch) {
        let files = &self.inner.files;
        match launch {
            Launch::Nothing => {}
            Launch::WaitForLock => self.launch_after_the_wait(),
            Launch::Clean(_) => files.delete_all(),
            Launch::Install(pending) => self.install(pending),
            Launch::Verify(pending) => {
                files.remove_incoming();
                let verified = std::fs::read(files.package()).map_err(|e| e.to_string()).and_then(|bytes| self.inner.options.installer.verify(&pending.manifest, &bytes));
                match verified {
                    Ok(()) => {
                        let mut core = lock(&self.inner.core);
                        self.step(&mut core, Step::Restored { version: pending.version.to_string() });
                    }
                    Err(detail) => {
                        info!(detail, "a waiting update didn't pass its check");
                        files.delete_all();
                    }
                }
            }
        }
    }

    /// The launch `setup` couldn't settle without stalling the main thread: the page may have asked by
    /// now, so it's told. A page that hears `Updated` and asks too announces it twice, which beats losing it.
    fn launch_after_the_wait(&self) {
        let standing = process_lock::claim_within(&self.inner.options.lock, self.inner.options.lock_wait);
        lock(&self.inner.core).standing = standing;
        let launch = self.plan_launch();
        if matches!(launch, Launch::Install(_)) {
            self.inner.options.host.hide_window();
        }
        {
            let core = lock(&self.inner.core);
            if core.state != AppUpdateState::None {
                (self.inner.options.sink)(&core.state);
            }
        }
        self.run_launch(launch);
    }
}

/// Lets progress through only when the whole percent changes, or the whole megabyte with no known total.
#[derive(Default)]
struct Throttle {
    last: Option<u64>,
}

impl Throttle {
    fn moved(&mut self, received: u64, total: Option<u64>) -> bool {
        let mark = match total {
            Some(total) if total > 0 => received.saturating_mul(100) / total,
            _ => received / MEGABYTE,
        };
        let moved = self.last != Some(mark);
        self.last = Some(mark);
        moved
    }
}

/// The app's `AppUpdates`, its window side wired to `app`.
pub fn for_app<R: Runtime>(app: &AppHandle<R>, dirs: &Dirs) -> AppUpdates {
    let exe = std::env::current_exe().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
    let emitter = app.clone();
    AppUpdates::new(Options {
        dir: dirs.data.join("app-update"),
        lock: dirs.data.join("app-update.lock"),
        lock_wait: LOCK_WAIT,
        running: app.package_info().version.clone(),
        manual: is_manual(tauri::utils::platform::bundle_type(), &exe, cfg!(target_os = "macos")),
        updates_enabled: UPDATES_ENABLED,
        installer: Arc::new(PluginInstaller(app.clone())),
        source: Arc::new(release::Http),
        host: Arc::new(AppHost(app.clone())),
        sink: Arc::new(move |state: &AppUpdateState| {
            let _ = emitter.emit(CHANGED, state);
        }),
    })
}

/// A launch's work off the main thread, then the checks: 30 s after launch, then every 6 h.
pub fn start(updates: AppUpdates, launch: Launch) {
    let launching = updates.clone();
    tauri::async_runtime::spawn_blocking(move || launching.run_launch(launch));
    if !checks_on(cfg!(debug_assertions), release::checks_disabled()) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let checking = updates.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || checking.check(CheckBy::Schedule)).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}
