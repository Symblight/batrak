use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use bt_core::release::{Asset, Manifest, Source};
use semver::Version;

use super::*;

const OLD: &[u8] = b"the old binary";
const ASSET: &str = "batrak-aarch64-apple-darwin";
const RECEIPT_TEXT: &str = "{ \"installer\": \"script\" }\n";
#[cfg(unix)]
const GOOD_STUB: &[u8] = b"#!/bin/sh\necho 'batrak 0.9.3'\n";
/// From bt_core::release's tests: signed by a test key, `file:batrak-aarch64-apple-darwin`, `version:0.9.3`.
const TEST_KEY_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRUHJwOHBkWklaa2FGcTVuN0pyaEFtM0V3cXVIY3pwZUwveXlpcmdvNEtJWnpSeHUyelkrRlRWUDFpMWFmVjBSWlFiaG5PN1hlWEFwVjczczFXc0ZVUk00eVAvcWorL0FzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MDUxOTA2CWZpbGU6YmF0cmFrLWFhcmNoNjQtYXBwbGUtZGFyd2luCXZlcnNpb246MC45LjMKU1BLdGhZenJOcGlwNS9zdTV4NVZkdDlKWkJ4TENIQmU2ZFd6OHFnYjNqcmpFMWErOXk4cmwzS0pPOHFBeG91OU1GaEF4WFJTWFVLejR4Njl2RU1MQlE9PQo=";

/// A file being written can't be executed (ETXTBSY) while another thread's fork holds it open, so
/// tests that run a stub take turns.
static RUNNING_STUBS: Mutex<()> = Mutex::new(());

fn one_at_a_time() -> MutexGuard<'static, ()> {
    RUNNING_STUBS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

struct FakeSource {
    manifest: Result<Manifest, String>,
    package: Result<Vec<u8>, String>,
    manifests_asked: AtomicUsize,
    packages_asked: Mutex<Vec<String>>,
}

impl Source for FakeSource {
    fn manifest(&self) -> Result<Manifest, String> {
        self.manifests_asked.fetch_add(1, Ordering::Relaxed);
        self.manifest.clone()
    }

    fn package(&self, url: &str, sink: &mut dyn FnMut(&[u8]) -> Result<(), String>, total: &mut dyn FnMut(Option<u64>)) -> Result<(), String> {
        self.packages_asked.lock().unwrap().push(url.to_owned());
        let bytes = self.package.as_ref().map_err(Clone::clone)?;
        total(Some(bytes.len() as u64));
        sink(bytes)
    }
}

fn manifest(version: &str, url: &str, signature: &str) -> Manifest {
    let asset = Asset { url: url.to_owned(), signature: signature.to_owned() };
    Manifest { version: v(version), pub_date: None, platforms: [("darwin-aarch64".to_owned(), asset)].into() }
}

fn source(version: &str, signature: &str, package: &[u8]) -> FakeSource {
    FakeSource {
        manifest: Ok(manifest(version, "https://example.invalid/any-name-a-manifest-likes", signature)),
        package: Ok(package.to_vec()),
        manifests_asked: AtomicUsize::new(0),
        packages_asked: Mutex::new(Vec::new()),
    }
}

/// Accepts the signature `good` over a non-empty file, only under the name and version the flow must
/// derive by itself; the real check is in bt_core::release's tests.
fn fake_verify(bytes: &[u8], signature: &str, version: &Version, file: &str) -> Result<(), String> {
    if signature == "good" && !bytes.is_empty() && version == &v("0.9.3") && file == ASSET {
        Ok(())
    } else {
        Err(format!("signature check failed for {file} {version}"))
    }
}

fn deps(source: &FakeSource) -> Deps<'_> {
    Deps { source, verify: fake_verify, replace: replace_running, smoke_limit: Duration::from_secs(10) }
}

/// A folder holding an installed binary, with the receipt.
struct Installed {
    dir: PathBuf,
    install: Install,
}

impl Installed {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("batrak-self-update-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir = dunce::canonicalize(dir).unwrap();
        let exe = dir.join("batrak");
        fs::write(&exe, OLD).unwrap();
        fs::write(dir.join("batrak.install.json"), RECEIPT_TEXT).unwrap();
        let install = Install { exe, dir: dir.clone(), current: v("0.9.2"), os: "macos", arch: "aarch64" };
        Self { dir, install }
    }

    fn without_receipt(name: &str) -> Self {
        let installed = Self::new(name);
        fs::remove_file(installed.dir.join("batrak.install.json")).unwrap();
        installed
    }

    fn update(&self, deps: &Deps) -> (Result<(), String>, String) {
        let _turn = one_at_a_time();
        let mut out = Vec::new();
        let result = update(&self.install, deps, &mut out);
        (result, String::from_utf8(out).unwrap())
    }

    fn check(&self, source: &FakeSource, json: bool) -> (Result<(), String>, String) {
        let mut out = Vec::new();
        let result = check(&self.install, source, json, &mut out);
        (result, String::from_utf8(out).unwrap())
    }

    fn binary(&self) -> Vec<u8> {
        fs::read(&self.install.exe).unwrap()
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    /// The binary as it was and nothing of a run's left but the lock.
    #[track_caller]
    fn assert_untouched_after_a_failure(&self) {
        assert_eq!(self.binary(), OLD);
        assert_eq!(self.names(), [".batrak-update.lock", "batrak", "batrak.install.json"]);
    }
}

// ---- the notice's advice

#[test]
fn the_advice_is_self_update_with_a_receipt_and_the_refusal_without_one() {
    let with = Installed::new("advice");
    let without = Installed::without_receipt("advice-none");

    assert_eq!(with.install.update_advice(), "Run `batrak self update`.");
    assert_eq!(without.install.update_advice(), no_receipt_message(&without.install.exe));
}

// ---- replacing

#[cfg(unix)]
#[test]
fn a_good_release_replaces_the_target_and_says_each_step() {
    let installed = Installed::new("good");
    let source = source("0.9.3", "good", GOOD_STUB);

    let (result, out) = installed.update(&deps(&source));

    assert_eq!(result, Ok(()));
    assert_eq!(installed.binary(), GOOD_STUB);
    assert_eq!(out, format!("batrak 0.9.2 → 0.9.3\nDownloading {ASSET}… 0.0 MB\nSignature verified\nUpdated to batrak 0.9.3\n"));
    assert_eq!(installed.names(), [".batrak-update.lock", "batrak", "batrak.install.json"]);
}

#[cfg(unix)]
#[test]
fn the_file_name_for_the_signature_comes_from_the_target_not_the_url() {
    // `fake_verify` refuses any name but ASSET, and the URL here ends in another one.
    let installed = Installed::new("url-name");
    let mut source = source("0.9.3", "good", GOOD_STUB);
    source.manifest = Ok(manifest("0.9.3", "https://example.invalid/batrak-x86_64-pc-windows-msvc.exe", "good"));

    let (result, _) = installed.update(&deps(&source));

    assert_eq!(result, Ok(()));
    assert_eq!(*source.packages_asked.lock().unwrap(), ["https://example.invalid/batrak-x86_64-pc-windows-msvc.exe"]);
}

#[test]
fn a_bad_signature_leaves_the_binary_and_no_temp() {
    let installed = Installed::new("bad-signature");
    let source = source("0.9.3", "forged", b"bytes");

    let (result, out) = installed.update(&deps(&source));

    assert!(result.unwrap_err().contains("signature check failed"));
    assert!(!out.contains("Signature verified"));
    installed.assert_untouched_after_a_failure();
}

#[cfg(unix)]
#[test]
fn a_failing_smoke_test_leaves_the_binary_and_no_temp() {
    let stubs: [&[u8]; 4] = [
        b"#!/bin/sh\necho 'batrak 0.9.2'\n",
        b"#!/bin/sh\necho 'batrak 0.9.3'\nexit 3\n",
        b"#!/bin/sh\necho 'batrak 0.9.3 and more'\n",
        b"not an executable format",
    ];
    for stub in stubs {
        let installed = Installed::new("smoke");
        let source = source("0.9.3", "good", stub);

        let (result, _) = installed.update(&deps(&source));

        assert!(result.unwrap_err().contains("smoke test"), "{}", String::from_utf8_lossy(stub));
        installed.assert_untouched_after_a_failure();
    }
}

#[cfg(unix)]
#[test]
fn a_hung_new_binary_is_killed_at_the_limit() {
    let installed = Installed::new("hung");
    let source = source("0.9.3", "good", b"#!/bin/sh\nexec sleep 60\n");
    let deps = Deps { smoke_limit: Duration::from_millis(200), ..deps(&source) };
    let started = Instant::now();

    let (result, _) = installed.update(&deps);

    assert!(result.unwrap_err().contains("smoke test"));
    assert!(started.elapsed() < Duration::from_secs(10));
    installed.assert_untouched_after_a_failure();
}

#[cfg(unix)]
#[test]
fn a_background_process_holding_the_output_cant_hold_the_update() {
    let installed = Installed::new("held-output");
    let source = source("0.9.3", "good", b"#!/bin/sh\necho 'batrak 0.9.3'\nsleep 4 &\n");
    let started = Instant::now();

    let (result, _) = installed.update(&deps(&source));

    assert!(result.unwrap_err().contains("smoke test"));
    assert!(started.elapsed() < Duration::from_secs(3));
    installed.assert_untouched_after_a_failure();
}

#[cfg(unix)]
#[test]
fn a_chatty_new_binary_cant_fill_the_memory() {
    let installed = Installed::new("chatty");
    let source = source("0.9.3", "good", b"#!/bin/sh\nexec yes\n");
    let deps = Deps { smoke_limit: Duration::from_secs(2), ..deps(&source) };

    let (result, _) = installed.update(&deps);

    // Cut off by the output limit, not killed at the time limit.
    let error = result.unwrap_err();
    assert!(error.contains("smoke test") && !error.contains("didn't exit"), "{error}");
    installed.assert_untouched_after_a_failure();
}

#[cfg(unix)]
#[test]
fn a_failed_replace_leaves_the_binary_and_no_temp() {
    let installed = Installed::new("replace-fails");
    let source = source("0.9.3", "good", GOOD_STUB);
    let deps = Deps { replace: |_, _| Err("couldn't replace it".to_owned()), ..deps(&source) };

    let (result, out) = installed.update(&deps);

    assert_eq!(result.unwrap_err(), "couldn't replace it");
    assert!(!out.contains("Updated to"));
    installed.assert_untouched_after_a_failure();
}

#[test]
fn a_failed_download_leaves_the_binary_and_no_temp() {
    let installed = Installed::new("download-fails");
    let mut source = source("0.9.3", "good", b"");
    source.package = Err("HTTP 500".to_owned());

    let (result, out) = installed.update(&deps(&source));

    assert!(result.unwrap_err().contains("HTTP 500"));
    assert!(out.ends_with("…\n"), "the partial line is ended: {out:?}");
    installed.assert_untouched_after_a_failure();
}

#[test]
fn a_release_without_this_platform_says_so() {
    let installed = Installed::new("no-platform");
    let mut source = source("0.9.3", "good", b"");
    source.manifest = Ok(Manifest { platforms: Default::default(), ..manifest("0.9.3", "u", "s") });

    let (result, _) = installed.update(&deps(&source));

    assert!(result.unwrap_err().contains("darwin-aarch64"));
    assert!(source.packages_asked.lock().unwrap().is_empty());
    installed.assert_untouched_after_a_failure();
}

#[test]
fn an_unknown_manifest_fails_with_the_sources_reason() {
    let installed = Installed::new("no-manifest");
    let mut source = source("0.9.3", "good", b"");
    source.manifest = Err("https://x/batrak-cli.json: HTTP 404".to_owned());

    let (result, out) = installed.update(&deps(&source));

    assert!(result.unwrap_err().contains("HTTP 404"));
    assert_eq!(out, "");
    installed.assert_untouched_after_a_failure();
}

#[test]
fn production_wiring_refuses_a_signature_from_another_key() {
    let installed = Installed::new("real-verify");
    let source = source("0.9.3", TEST_KEY_SIGNATURE, b"bytes");
    let deps = Deps { source: &source, replace: |_, _| panic!("the real check must refuse this first"), ..production() };

    let (result, _) = installed.update(&deps);

    assert!(result.unwrap_err().contains("signature check failed"));
    installed.assert_untouched_after_a_failure();
}

// ---- refusing and doing nothing

#[test]
fn no_receipt_refuses_before_the_network_and_changes_nothing() {
    let installed = Installed::without_receipt("no-receipt");
    let source = source("0.9.3", "good", b"");

    let (result, out) = installed.update(&deps(&source));

    assert_eq!(result.unwrap_err(), "batrak wasn't installed by the install script; update it with the tool that installed it");
    assert_eq!(out, "");
    assert_eq!(source.manifests_asked.load(Ordering::Relaxed), 0);
    assert_eq!(installed.binary(), OLD);
    assert_eq!(installed.names(), ["batrak"]);
}

#[test]
fn only_the_exact_receipt_counts() {
    assert!(is_receipt(br#"{ "installer": "script" }"#));
    assert!(is_receipt(RECEIPT_TEXT.as_bytes()));
    for other in [&b""[..], b"{", b"[]", b"{}", br#"{ "installer": "brew" }"#, br#"{ "installer": 1 }"#, br#"{ "installer": "script", "x": 1 }"#, b"\xff"] {
        assert!(!is_receipt(other), "{}", String::from_utf8_lossy(other));
    }
}

#[test]
fn a_malformed_receipt_counts_as_none() {
    let installed = Installed::new("bad-receipt");
    fs::write(installed.dir.join("batrak.install.json"), "not json").unwrap();
    let source = source("0.9.3", "good", b"");

    let (result, _) = installed.update(&deps(&source));

    assert!(result.unwrap_err().contains("wasn't installed by the install script"));
    assert_eq!(source.manifests_asked.load(Ordering::Relaxed), 0);
}

#[test]
fn a_homebrew_path_names_brew_upgrade() {
    let brew = no_receipt_message(Path::new("/opt/homebrew/Cellar/batrak/0.9.2/bin/batrak"));
    assert!(brew.contains("brew upgrade"), "{brew}");
    let other = no_receipt_message(Path::new("/home/me/MyCellar/batrak"));
    assert!(!other.contains("brew"), "{other}");
}

#[test]
fn a_held_lock_refuses_before_the_network() {
    let installed = Installed::new("locked");
    let held = File::create(installed.dir.join(".batrak-update.lock")).unwrap();
    held.try_lock().unwrap();
    let source = source("0.9.3", "good", b"");

    let (result, _) = installed.update(&deps(&source));

    assert!(result.unwrap_err().contains("another"));
    assert_eq!(source.manifests_asked.load(Ordering::Relaxed), 0);
    installed.assert_untouched_after_a_failure();
}

#[cfg(unix)]
#[test]
fn an_unwritable_folder_refuses_before_the_network() {
    use std::os::unix::fs::PermissionsExt;
    // One run with a lock file already there (the probe sees it), one without (the lock sees it).
    for leave_a_lock in [true, false] {
        let installed = Installed::new(if leave_a_lock { "read-only-lock" } else { "read-only" });
        if leave_a_lock {
            File::create(installed.dir.join(".batrak-update.lock")).unwrap();
        }
        let source = source("0.9.3", "good", b"");
        fs::set_permissions(&installed.dir, fs::Permissions::from_mode(0o555)).unwrap();
        if File::create(installed.dir.join("root-ignores-modes")).is_ok() {
            return;
        }

        let (result, _) = installed.update(&deps(&source));

        fs::set_permissions(&installed.dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result.unwrap_err(), format!("can't write to {}", installed.dir.display()));
        assert_eq!(source.manifests_asked.load(Ordering::Relaxed), 0);
        assert_eq!(installed.binary(), OLD);
    }
}

#[test]
fn up_to_date_changes_nothing() {
    let installed = Installed::new("up-to-date");
    let source = source("0.9.2", "good", b"");

    let (result, out) = installed.update(&deps(&source));

    assert_eq!(result, Ok(()));
    assert_eq!(out, "batrak 0.9.2 is the latest version\n");
    assert!(source.packages_asked.lock().unwrap().is_empty());
    assert_eq!(installed.binary(), OLD);
}

#[test]
fn an_older_manifest_is_no_downgrade() {
    let installed = Installed::new("downgrade");
    let source = source("0.9.1", "good", b"");

    let (result, out) = installed.update(&deps(&source));

    assert_eq!(result, Ok(()));
    assert_eq!(out, "batrak 0.9.2 is the latest version\n");
    assert!(source.packages_asked.lock().unwrap().is_empty());
    assert_eq!(installed.binary(), OLD);
}

#[test]
fn a_later_run_sweeps_what_a_killed_run_left() {
    let installed = Installed::new("sweep");
    for leftover in [".batrak-update-123", ".batrak-update-123.part", ".batrak-update-probe-123", ".batrak-update-old-123.exe"] {
        fs::write(installed.dir.join(leftover), b"left").unwrap();
    }
    fs::write(installed.dir.join("batrak-keep"), b"not ours").unwrap();
    let source = source("0.9.2", "good", b"");

    let (result, _) = installed.update(&deps(&source));

    assert_eq!(result, Ok(()));
    assert_eq!(installed.names(), [".batrak-update.lock", "batrak", "batrak-keep", "batrak.install.json"]);
}

// ---- --check

#[test]
fn check_json_prints_the_release_status_exactly() {
    let installed = Installed::new("json");
    let source = source("0.9.3", "good", b"");

    let (result, out) = installed.check(&source, true);

    assert_eq!(result, Ok(()));
    assert_eq!(out, "{\"current\":\"0.9.2\",\"latest\":\"0.9.3\",\"updateAvailable\":true,\"selfUpdate\":true}\n");
}

#[test]
fn check_json_says_when_it_cant_replace_itself() {
    let installed = Installed::without_receipt("json-no-receipt");
    let source = source("0.9.2", "good", b"");

    let (result, out) = installed.check(&source, true);

    assert_eq!(result, Ok(()));
    assert_eq!(out, "{\"current\":\"0.9.2\",\"latest\":\"0.9.2\",\"updateAvailable\":false,\"selfUpdate\":false}\n");
}

#[test]
fn check_prints_the_comparison_and_changes_nothing() {
    let installed = Installed::new("check");
    fs::write(installed.dir.join(".batrak-update-123"), b"left").unwrap();
    let before = installed.names();

    let (result, newer) = installed.check(&source("0.9.3", "good", b""), false);
    assert_eq!(result, Ok(()));
    assert_eq!(newer, "batrak 0.9.2 → 0.9.3\n");

    let (result, same) = installed.check(&source("0.9.2", "good", b""), false);
    assert_eq!(result, Ok(()));
    assert_eq!(same, "batrak 0.9.2 is the latest version\n");

    assert_eq!(installed.binary(), OLD);
    assert_eq!(installed.names(), before);
}

#[test]
fn a_failed_check_prints_nothing_on_stdout() {
    let installed = Installed::new("check-fails");
    let mut source = source("0.9.3", "good", b"");
    source.manifest = Err("HTTP 404".to_owned());

    for json in [false, true] {
        let (result, out) = installed.check(&source, json);
        assert!(result.unwrap_err().contains("HTTP 404"));
        assert_eq!(out, "");
    }
}

// ---- the pure decisions

#[test]
fn the_status_follows_the_receipt_and_the_versions() {
    for (receipt, current, latest, update_available) in [
        (true, "0.9.2", "0.9.3", true),
        (false, "0.9.2", "0.9.3", true),
        (true, "0.9.3", "0.9.3", false),
        (true, "0.9.3", "0.9.2", false),
        (true, "0.9.3-beta.1", "0.9.3", true),
    ] {
        let expected = ReleaseStatus { current: current.into(), latest: Some(latest.into()), update_available, self_update: receipt };
        assert_eq!(release_status(receipt, &v(current), &v(latest)), expected);
    }
}

#[test]
fn every_released_target_maps_to_its_manifest_key_and_asset() {
    for (os, arch, key, asset) in [
        ("macos", "aarch64", "darwin-aarch64", "batrak-aarch64-apple-darwin"),
        ("macos", "x86_64", "darwin-x86_64", "batrak-x86_64-apple-darwin"),
        ("linux", "x86_64", "linux-x86_64", "batrak-x86_64-unknown-linux-gnu"),
        ("linux", "aarch64", "linux-aarch64", "batrak-aarch64-unknown-linux-gnu"),
        ("windows", "x86_64", "windows-x86_64", "batrak-x86_64-pc-windows-msvc.exe"),
    ] {
        assert_eq!(Target::of(os, arch), Some(Target { key: key.into(), asset: asset.into() }));
    }
    assert_eq!(Target::of("windows", "aarch64"), None);
    assert_eq!(Target::of("freebsd", "x86_64"), None);
}

#[test]
fn sizes_read_like_the_spec() {
    assert_eq!(megabytes(15_200_000), "15.2 MB");
    assert_eq!(megabytes(0), "0.0 MB");
}

#[test]
fn replacing_is_retried_as_many_times_as_asked() {
    let mut attempts = 0;
    let gave_up: Result<(), &str> = retrying(3, Duration::ZERO, || {
        attempts += 1;
        Err("held")
    });
    assert_eq!((gave_up, attempts), (Err("held"), 4));

    let mut attempts = 0;
    let passed = retrying(3, Duration::ZERO, || {
        attempts += 1;
        if attempts == 2 { Ok(()) } else { Err("held") }
    });
    assert_eq!((passed, attempts), (Ok(()), 2));
}

// ---- replacing a binary that is running

const REPLACE_WITH: &str = "BATRAK_TEST_REPLACE_WITH";
const NEW_BINARY: &[u8] = b"the new binary";

/// Not a test by itself: `the_running_binary_*` run it in a copy of this test binary, where it replaces
/// that copy the way a real run does. The check on the folder keeps it from ever touching the original.
#[test]
fn replace_helper() {
    let Some(new) = std::env::var_os(REPLACE_WITH) else { return };
    let new = PathBuf::from(new);
    let install = Install::running().unwrap();
    assert_eq!(new.parent(), Some(install.dir.as_path()));
    replace_running(&new, &install.exe).unwrap();
}

/// A folder with a copy of this test binary and the file to replace it with.
fn running_copy(name: &str) -> (PathBuf, PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("batrak-self-update-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let dir = dunce::canonicalize(dir).unwrap();
    let copy = dir.join(format!("batrak{EXE_SUFFIX}"));
    fs::copy(std::env::current_exe().unwrap(), &copy).unwrap();
    let new = dir.join(".batrak-update-new");
    fs::write(&new, NEW_BINARY).unwrap();
    (dir, copy, new)
}

fn run_the_helper(program: &Path, cwd: &Path, new: &Path) {
    let out = std::process::Command::new(program).args(["--exact", "self_update::tests::replace_helper"]).env(REPLACE_WITH, new).current_dir(cwd).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
}

/// Nothing but the new binary is left, once a run's sweep has been; Windows releases the exe of a
/// process that exited a little later.
#[track_caller]
fn assert_replaced(dir: &Path, copy: &Path) {
    assert_eq!(fs::read(copy).unwrap(), NEW_BINARY);
    let swept = retrying(3, Duration::from_millis(500), || {
        sweep(dir);
        let left = fs::read_dir(dir).unwrap().count();
        if left == 1 { Ok(()) } else { Err(left) }
    });
    assert_eq!(swept, Ok(()));
}

#[test]
fn the_running_binary_is_replaced() {
    let _turn = one_at_a_time();
    let (dir, copy, new) = running_copy("running");

    run_the_helper(&copy, &dir, &new);

    assert_replaced(&dir, &copy);
}

#[cfg(unix)]
#[test]
fn the_running_binary_keeps_its_mode() {
    use std::os::unix::fs::PermissionsExt;
    let _turn = one_at_a_time();
    let (dir, copy, new) = running_copy("mode");
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o750)).unwrap();
    fs::set_permissions(&new, fs::Permissions::from_mode(0o755)).unwrap();

    run_the_helper(&copy, &dir, &new);

    assert_eq!(fs::metadata(&copy).unwrap().permissions().mode() & 0o7777, 0o750);
    assert_replaced(&dir, &copy);
}

#[cfg(unix)]
#[test]
fn the_running_binary_is_replaced_through_a_relative_link_from_another_folder() {
    use std::os::unix::fs::PermissionsExt;
    let _turn = one_at_a_time();
    let (dir, copy, new) = running_copy("link");
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o750)).unwrap();
    let outside = dir.with_file_name(format!("batrak-self-update-{}-link-outside", std::process::id()));
    let _ = fs::remove_dir_all(&outside);
    // From `cwd`, the link's text names this other file: a resolver using the working directory hits it.
    let cwd = outside.join("from");
    fs::create_dir_all(&cwd).unwrap();
    let dir_name = dir.file_name().unwrap().to_str().unwrap();
    let decoy = outside.join(dir_name).join(copy.file_name().unwrap());
    fs::create_dir_all(decoy.parent().unwrap()).unwrap();
    fs::write(&decoy, b"not ours").unwrap();
    let link = outside.join("link");
    std::os::unix::fs::symlink(format!("../{dir_name}/{}", copy.file_name().unwrap().to_str().unwrap()), &link).unwrap();

    run_the_helper(&link, &cwd, &new);

    assert_eq!(fs::read(&decoy).unwrap(), b"not ours");
    assert_eq!(fs::metadata(&copy).unwrap().permissions().mode() & 0o7777, 0o750);
    assert_replaced(&dir, &copy);
}

// ---- Windows' swap, over plain paths

struct Swap {
    new: PathBuf,
    target: PathBuf,
    aside: PathBuf,
}

fn swap_files(name: &str) -> Swap {
    let installed = Installed::new(name);
    let new = installed.dir.join(".batrak-update-1.exe");
    fs::write(&new, NEW_BINARY).unwrap();
    Swap { new, target: installed.install.exe, aside: installed.dir.join(".batrak-update-old-1.exe") }
}

/// `fs::rename`, except that a move onto `failing` fails its first `times` tries.
fn rename_failing<'a>(failing: &'a Path, times: usize, tries: &'a AtomicUsize) -> impl Fn(&Path, &Path) -> io::Result<()> + 'a {
    move |from: &Path, to: &Path| {
        if to == failing && tries.fetch_add(1, Ordering::Relaxed) < times {
            return Err(io::Error::other("held by a scanner"));
        }
        fs::rename(from, to)
    }
}

#[test]
fn the_swap_puts_the_old_binary_aside() {
    let files = swap_files("swap");

    assert_eq!(swap_aside(&files.new, &files.target, &files.aside, |from: &Path, to: &Path| fs::rename(from, to), Duration::ZERO), Ok(()));

    assert_eq!(fs::read(&files.target).unwrap(), NEW_BINARY);
    assert_eq!(fs::read(&files.aside).unwrap(), OLD);
    assert!(!files.new.exists());
}

#[test]
fn the_swap_retries_a_held_file_three_times() {
    let files = swap_files("swap-retry");
    let tries = AtomicUsize::new(0);

    let swapped = swap_aside(&files.new, &files.target, &files.aside, rename_failing(&files.target, 3, &tries), Duration::ZERO);

    assert_eq!(swapped, Ok(()));
    assert_eq!(tries.load(Ordering::Relaxed), 4);
    assert_eq!(fs::read(&files.target).unwrap(), NEW_BINARY);
}

#[test]
fn a_failed_swap_puts_the_old_binary_back() {
    let files = swap_files("swap-restore");
    let tries = AtomicUsize::new(0);
    // Fails every move onto the target from `new`, then lets the restore through.
    let rename = |from: &Path, to: &Path| {
        if from == files.new.as_path() {
            tries.fetch_add(1, Ordering::Relaxed);
            return Err(io::Error::other("held by a scanner"));
        }
        fs::rename(from, to)
    };

    let swapped = swap_aside(&files.new, &files.target, &files.aside, rename, Duration::ZERO);

    assert!(swapped.unwrap_err().contains("held by a scanner"));
    assert_eq!(tries.load(Ordering::Relaxed), 4);
    assert_eq!(fs::read(&files.target).unwrap(), OLD);
    assert!(!files.aside.exists());
    assert_eq!(fs::read(&files.new).unwrap(), NEW_BINARY);
}

#[test]
fn a_target_that_wont_move_is_left_where_it_is() {
    let files = swap_files("swap-held-target");
    let tries = AtomicUsize::new(0);

    let swapped = swap_aside(&files.new, &files.target, &files.aside, rename_failing(&files.aside, usize::MAX, &tries), Duration::ZERO);

    assert!(swapped.is_err());
    assert_eq!(fs::read(&files.target).unwrap(), OLD);
    assert_eq!(fs::read(&files.new).unwrap(), NEW_BINARY);
}

#[test]
fn a_failed_restore_says_where_the_old_binary_is() {
    let files = swap_files("swap-no-restore");
    let rename = |from: &Path, to: &Path| {
        if from == files.aside.as_path() || from == files.new.as_path() {
            return Err(io::Error::other("held"));
        }
        fs::rename(from, to)
    };

    let swapped = swap_aside(&files.new, &files.target, &files.aside, rename, Duration::ZERO);

    let error = swapped.unwrap_err();
    assert!(error.contains(&files.aside.display().to_string()), "{error}");
    assert_eq!(fs::read(&files.aside).unwrap(), OLD);
}
