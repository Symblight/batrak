//! `batrak self update`: replaces the running binary with a signed release (docs/specs/app-update.md
//! §2.2, §3.4). Every message for the user comes back as the error text, as the spec words it.

use std::env::consts::EXE_SUFFIX;
use std::fs::{self, File, TryLockError};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use bt_core::api::ReleaseStatus;
use bt_core::release::{self, Downloaded, Source};
use semver::Version;

const RECEIPT: &str = "batrak.install.json";
const LOCK: &str = ".batrak-update.lock";
/// Everything a run leaves beside the binary starts with this: what a kill interrupted, and on Windows
/// the old binary, which can't be deleted while it runs. The lock doesn't match: it stays, since removing
/// a lock file races its next taker.
const TEMP_PREFIX: &str = ".batrak-update-";
/// A first launch on macOS can spend seconds in the system's checks, so this isn't tight.
const SMOKE_LIMIT: Duration = Duration::from_secs(30);
const SMOKE_POLL: Duration = Duration::from_millis(50);
/// How long after the new binary's exit its output must end; only a process it left behind delays it.
const SMOKE_OUTPUT_GRACE: Duration = Duration::from_secs(1);
const SMOKE_OUTPUT_LIMIT: u64 = 1024;
/// On Windows, where a scanner may hold a file.
const REPLACE_RETRIES: u32 = 3;
const REPLACE_RETRY_DELAY: Duration = Duration::from_millis(500);

/// `release::verify`'s shape, since it is tied to the built-in key and tests have only a test key's.
type Verify = fn(&[u8], &str, &Version, &str) -> Result<(), String>;
/// Puts the file at the first path in place of the second.
type Replace = fn(&Path, &Path) -> Result<(), String>;

struct Deps<'a> {
    source: &'a dyn Source,
    verify: Verify,
    replace: Replace,
    smoke_limit: Duration,
}

fn production() -> Deps<'static> {
    Deps { source: &release::Http, verify: release::verify, replace: replace_running, smoke_limit: SMOKE_LIMIT }
}

/// The binary being updated.
struct Install {
    exe: PathBuf,
    dir: PathBuf,
    current: Version,
    os: &'static str,
    arch: &'static str,
}

impl Install {
    fn running() -> Result<Self, String> {
        let exe = std::env::current_exe().and_then(dunce::canonicalize).map_err(|e| format!("can't find this binary: {e}"))?;
        let dir = exe.parent().ok_or_else(|| format!("{} has no folder", exe.display()))?.to_path_buf();
        let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| format!("this binary's version: {e}"))?;
        Ok(Self { exe, dir, current, os: std::env::consts::OS, arch: std::env::consts::ARCH })
    }
}

/// A released build: its key in `batrak-cli.json` and its asset's name. The name is the one the
/// signature must carry, so it never comes from the manifest.
#[derive(Debug, PartialEq, Eq)]
struct Target {
    key: String,
    asset: String,
}

impl Target {
    /// Takes `std::env::consts::{OS, ARCH}`; `None` for what no release has.
    fn of(os: &str, arch: &str) -> Option<Self> {
        let (key_os, triple) = match (os, arch) {
            ("macos", "aarch64") => ("darwin", "aarch64-apple-darwin"),
            ("macos", "x86_64") => ("darwin", "x86_64-apple-darwin"),
            ("linux", "x86_64") => ("linux", "x86_64-unknown-linux-gnu"),
            ("linux", "aarch64") => ("linux", "aarch64-unknown-linux-gnu"),
            ("windows", "x86_64") => ("windows", "x86_64-pc-windows-msvc"),
            _ => return None,
        };
        let suffix = if os == "windows" { ".exe" } else { "" };
        Some(Self { key: format!("{key_os}-{arch}"), asset: format!("batrak-{triple}{suffix}") })
    }
}

fn is_receipt(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes).is_ok_and(|value| value == serde_json::json!({ "installer": "script" }))
}

fn has_receipt(dir: &Path) -> bool {
    fs::read(dir.join(RECEIPT)).is_ok_and(|bytes| is_receipt(&bytes))
}

fn no_receipt_message(exe: &Path) -> String {
    if exe.components().any(|part| part == Component::Normal("Cellar".as_ref())) {
        "batrak was installed by Homebrew; update it with `brew upgrade batrak`".to_owned()
    } else {
        "batrak wasn't installed by the install script; update it with the tool that installed it".to_owned()
    }
}

fn release_status(receipt: bool, current: &Version, latest: &Version) -> ReleaseStatus {
    ReleaseStatus {
        current: current.to_string(),
        latest: Some(latest.to_string()),
        update_available: release::compare(current, latest),
        self_update: receipt,
    }
}

/// The line both `--check` and an update start with.
fn comparison(status: &ReleaseStatus, latest: &Version) -> String {
    if status.update_available {
        format!("batrak {} → {latest}", status.current)
    } else {
        format!("batrak {} is the latest version", status.current)
    }
}

fn manifest_failed(reason: String) -> String {
    format!("couldn't get the latest release: {reason}")
}

fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_000_000.0)
}

fn check(install: &Install, source: &dyn Source, json: bool, out: &mut dyn Write) -> Result<(), String> {
    let latest = source.manifest().map_err(manifest_failed)?.version;
    let status = release_status(has_receipt(&install.dir), &install.current, &latest);
    let line = if json { serde_json::to_string(&status).map_err(|e| e.to_string())? } else { comparison(&status, &latest) };
    // This line is all `--check` is for, so unlike an update's progress its loss is a failure.
    writeln!(out, "{line}").map_err(|e| format!("couldn't print the result: {e}"))
}

/// Progress lost to a closed pipe is no reason to stop.
fn update(install: &Install, deps: &Deps, out: &mut dyn Write) -> Result<(), String> {
    if !has_receipt(&install.dir) {
        return Err(no_receipt_message(&install.exe));
    }
    let target = Target::of(install.os, install.arch).ok_or_else(|| format!("no release has a build for {} on {}", install.arch, install.os))?;
    let _lock = take_lock(&install.dir)?;
    sweep(&install.dir);
    probe_writable(&install.dir)?;

    let manifest = deps.source.manifest().map_err(manifest_failed)?;
    let status = release_status(true, &install.current, &manifest.version);
    let _ = writeln!(out, "{}", comparison(&status, &manifest.version));
    if !status.update_available {
        return Ok(());
    }
    let asset = manifest.platforms.get(&target.key).ok_or_else(|| format!("release {} has no build for {}", manifest.version, target.key))?;

    let temp = TempFile(install.dir.join(format!("{TEMP_PREFIX}{}{EXE_SUFFIX}", std::process::id())));
    let _ = write!(out, "Downloading {}…", target.asset);
    let _ = out.flush();
    let bytes = fetch(deps.source, &asset.url, &temp.0);
    let size = bytes.as_ref().map_or(String::new(), |bytes| format!(" {}", megabytes(bytes.len() as u64)));
    let _ = writeln!(out, "{size}");
    let bytes = bytes?;

    (deps.verify)(&bytes, &asset.signature, &manifest.version, &target.asset)?;
    let _ = writeln!(out, "Signature verified");

    make_executable(&temp.0).map_err(|e| format!("can't make {} executable: {e}", temp.0.display()))?;
    smoke_test(&temp.0, &manifest.version, deps.smoke_limit)?;
    (deps.replace)(&temp.0, &install.exe)?;
    let _ = writeln!(out, "Updated to batrak {}", manifest.version);
    Ok(())
}

/// Removed on every way out of `update`; what a kill leaves, `sweep` removes on a later run.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn cant_write(dir: &Path) -> String {
    format!("can't write to {}", dir.display())
}

fn take_lock(dir: &Path) -> Result<File, String> {
    let file = File::options().read(true).write(true).create(true).truncate(false).open(dir.join(LOCK)).map_err(|_| cant_write(dir))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err("another `batrak self update` is running".to_owned()),
        Err(TryLockError::Error(e)) => Err(format!("couldn't lock {}: {e}", dir.join(LOCK).display())),
    }
}

/// Holding the lock, so whatever matches was left by a run that is gone.
fn sweep(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(TEMP_PREFIX) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn probe_writable(dir: &Path) -> Result<(), String> {
    let probe = dir.join(format!("{TEMP_PREFIX}probe-{}", std::process::id()));
    File::create_new(&probe).map_err(|_| cant_write(dir))?;
    fs::remove_file(&probe).map_err(|_| cant_write(dir))
}

fn fetch(source: &dyn Source, url: &str, dest: &Path) -> Result<Vec<u8>, String> {
    match release::download(source, url, dest, &AtomicBool::new(false), |_, _| ()).map_err(|e| format!("the download failed: {e}"))? {
        Downloaded::Done => fs::read(dest).map_err(|e| format!("{}: {e}", dest.display())),
        Downloaded::Cancelled => Err("the download was cancelled".to_owned()),
    }
}

#[cfg(unix)]
fn make_executable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

/// Windows has no executable bit; `.exe` is enough.
#[cfg(not(unix))]
fn make_executable(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Runs `binary --version` and wants exactly the signed version back. A new binary that hangs is killed
/// at `limit`, one that floods is cut off at `SMOKE_OUTPUT_LIMIT`, and one that exits but leaves a
/// process holding its stdout fails after `SMOKE_OUTPUT_GRACE`: the read is on its own thread, which is
/// abandoned then since this process exits soon after.
fn smoke_test(binary: &Path, version: &Version, limit: Duration) -> Result<(), String> {
    let failed = |reason: String| format!("the new binary failed its smoke test: {reason}");
    let mut child = Command::new(binary).arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| failed(e.to_string()))?;
    let stdout = child.stdout.take();
    let (send, output) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(stdout) = stdout {
            let _ = stdout.take(SMOKE_OUTPUT_LIMIT).read_to_end(&mut bytes);
        }
        let _ = send.send(bytes);
    });

    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(SMOKE_POLL),
            outcome => {
                let _ = child.kill();
                let _ = child.wait();
                let reason = outcome.err().map_or(format!("it didn't exit within {} s", limit.as_secs()), |e| e.to_string());
                return Err(failed(reason));
            }
        }
    };
    let output = output.recv_timeout(SMOKE_OUTPUT_GRACE).map_err(|_| failed("its output didn't end".to_owned()))?;
    if !status.success() {
        return Err(failed(format!("it exited with {status}")));
    }
    if output != format!("batrak {version}\n").as_bytes() {
        return Err(failed(format!("it printed {:?}", String::from_utf8_lossy(&output))));
    }
    Ok(())
}

fn retrying<T, E>(retries: u32, delay: Duration, mut attempt: impl FnMut() -> Result<T, E>) -> Result<T, E> {
    let mut left = retries;
    loop {
        match attempt() {
            Err(_) if left > 0 => {
                left -= 1;
                thread::sleep(delay);
            }
            outcome => return outcome,
        }
    }
}

/// Puts `new`, which is beside `target`, in its place with `target`'s mode. `target` may be running.
fn replace_running(new: &Path, target: &Path) -> Result<(), String> {
    let replaced = fs::metadata(target).and_then(|old| fs::set_permissions(new, old.permissions())).map_err(|e| e.to_string()).and_then(|()| {
        if cfg!(windows) {
            let aside = target.with_file_name(format!("{TEMP_PREFIX}old-{}.exe", std::process::id()));
            swap_aside(new, target, &aside, |from: &Path, to: &Path| fs::rename(from, to), REPLACE_RETRY_DELAY)
        } else {
            fs::rename(new, target).map_err(|e| e.to_string())
        }
    });
    replaced.map_err(|e| format!("couldn't replace {}: {e}", target.display()))
}

/// Windows can't rename over a running exe, but can rename the exe away. Either `new` ends up at
/// `target` and the old binary at `aside` for a later sweep, or the old binary goes back.
fn swap_aside(new: &Path, target: &Path, aside: &Path, rename: impl Fn(&Path, &Path) -> io::Result<()>, delay: Duration) -> Result<(), String> {
    retrying(REPLACE_RETRIES, delay, || rename(target, aside)).map_err(|e| e.to_string())?;
    let Err(failed) = retrying(REPLACE_RETRIES, delay, || rename(new, target)) else { return Ok(()) };
    match retrying(REPLACE_RETRIES, delay, || rename(aside, target)) {
        Ok(()) => Err(failed.to_string()),
        Err(_) => Err(format!("{failed}; the old binary is at {}", aside.display())),
    }
}

/// `batrak self update [--check] [--json]`.
pub fn run(only_check: bool, json: bool) -> ExitCode {
    let deps = production();
    let mut out = io::stdout();
    let outcome = Install::running().and_then(|install| if only_check { check(&install, deps.source, json, &mut out) } else { update(&install, &deps, &mut out) });
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            let _ = writeln!(io::stderr(), "{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests;
