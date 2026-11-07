//! The seam over `tauri-plugin-updater`, in plain data, so everything above it is tested with a fake.

use std::io::ErrorKind;
use std::time::Duration;

use bt_core::release;
use semver::Version;
use serde_json::Value;
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::{Error, Update, Updater, UpdaterExt};

use super::Failure;

/// The plugin sets no timeout of its own.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// An update a check found.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub version: Version,
    pub current: String,
    pub url: String,
    /// The manifest as served, which `verify` and `install` work from.
    pub manifest: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallError {
    pub failure: Failure,
    pub detail: String,
}

/// All blocking; none of it runs on the main thread (see `PluginInstaller`).
pub trait Installer: Send + Sync {
    /// `None`: no release newer than this app.
    fn check(&self) -> Result<Option<Found>, String>;
    fn verify(&self, manifest: &Value, bytes: &[u8]) -> Result<(), String>;
    /// Returns on macOS and Linux, with the app replaced on disk and still running. On Windows a success
    /// never returns: the plugin stops the app through `on_before_exit` and ends the process.
    fn install(&self, manifest: &Value, bytes: &[u8]) -> Result<(), InstallError>;
}

/// `verify` and `install` go through `restore_update` whether the update was found just now or read
/// from disk after a relaunch: one path, which always requires the signed version.
///
/// Off the main thread only: on macOS a privileged install waits for a closure it posts to the main
/// thread, so from there it would never end.
pub struct PluginInstaller<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> PluginInstaller<R> {
    fn updater(&self) -> Result<Updater, Error> {
        let app = self.0.clone();
        self.0
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .version_comparator(|current, release| release::compare(&current, &release.version))
            // Replaces the plugin's own hook, which only cleans up. Windows only: `install` exits the
            // process right after it, which skips `RunEvent::Exit`.
            .on_before_exit(move || {
                crate::stop_everything(&app);
                app.cleanup_before_exit();
            })
            .build()
    }

    fn restored(&self, manifest: &Value) -> Result<Update, Error> {
        self.updater()?.restore_update(manifest.clone())?.ok_or(Error::ReleaseNotFound)
    }
}

impl<R: Runtime> Installer for PluginInstaller<R> {
    fn check(&self) -> Result<Option<Found>, String> {
        let updater = self.updater().map_err(|e| e.to_string())?;
        let update = tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())?;
        update
            .map(|update| {
                Ok(Found {
                    version: Version::parse(&update.version).map_err(|e| format!("{}: {e}", update.version))?,
                    current: update.current_version,
                    url: update.download_url.to_string(),
                    manifest: update.raw_json,
                })
            })
            .transpose()
    }

    fn verify(&self, manifest: &Value, bytes: &[u8]) -> Result<(), String> {
        let update = self.restored(manifest).map_err(|e| e.to_string())?;
        update.verify(bytes).map_err(|e| e.to_string())?;
        // Only now is the comment trusted. The plugin binds the version alone, and the CLI's binaries
        // carry the same key, so without this a manifest could pair one of them with that version.
        let file = release::signed_file(&update.signature)?;
        if !fits_bundle(&file, tauri::utils::platform::bundle_type()) {
            return Err(format!("the signature is for {file}, not this app's package"));
        }
        Ok(())
    }

    fn install(&self, manifest: &Value, bytes: &[u8]) -> Result<(), InstallError> {
        self.restored(manifest).and_then(|update| update.install(bytes)).map_err(install_error)
    }
}

/// Whether a signed `file:` is the package this install takes. `None` is a binary the bundler didn't
/// mark, which can only be told from the CLI's.
fn fits_bundle(file: &str, bundle: Option<BundleType>) -> bool {
    use BundleType::{App, AppImage, Deb, Dmg, Msi, Nsis, Rpm};
    let suffixes: &[&str] = match bundle {
        Some(App | Dmg) => &[".app.tar.gz"],
        Some(Nsis) => &["-setup.exe"],
        Some(Msi) => &[".msi"],
        Some(AppImage) => &[".AppImage"],
        Some(Deb) => &[".deb"],
        Some(Rpm) => &[".rpm"],
        None => &[".app.tar.gz", "-setup.exe", ".msi", ".AppImage", ".deb", ".rpm"],
    };
    suffixes.iter().any(|suffix| file.ends_with(suffix))
}

fn install_error(error: Error) -> InstallError {
    let failure = match &error {
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) | Error::SignedVersionMismatch { .. } | Error::MissingSignedVersion => Failure::Signature,
        Error::Io(e) if matches!(e.kind(), ErrorKind::StorageFull | ErrorKind::QuotaExceeded) => Failure::Disk,
        _ => Failure::Replace,
    };
    InstallError { failure, detail: error.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signed_file_fits_only_the_package_this_install_takes() {
        use BundleType::{App, AppImage, Deb, Msi, Nsis, Rpm};
        let cases = [
            ("Batrak.app.tar.gz", Some(App), true),
            ("Batrak_0.9.3_x64-setup.exe", Some(Nsis), true),
            ("Batrak_0.9.3_x64_en-US.msi", Some(Msi), true),
            ("Batrak_0.9.3_amd64.AppImage", Some(AppImage), true),
            ("batrak_0.9.3_amd64.deb", Some(Deb), true),
            ("batrak-0.9.3-1.x86_64.rpm", Some(Rpm), true),
            ("batrak-x86_64-unknown-linux-gnu", Some(AppImage), false),
            ("batrak-aarch64-apple-darwin", Some(App), false),
            ("batrak-x86_64-pc-windows-msvc.exe", Some(Nsis), false),
            ("Batrak_0.9.3_x64_en-US.msi", Some(Nsis), false),
            ("Batrak_0.9.3_x64-setup.exe", Some(Msi), false),
            // An unpatched binary reads the plain platform keys, but a CLI binary is still no app.
            ("Batrak_0.9.3_amd64.AppImage", None, true),
            ("Batrak_0.9.3_x64-setup.exe", None, true),
            ("batrak-x86_64-unknown-linux-gnu", None, false),
            ("batrak-x86_64-pc-windows-msvc.exe", None, false),
        ];
        for (file, bundle, fits) in cases {
            assert_eq!(fits_bundle(file, bundle.clone()), fits, "{file} for {bundle:?}");
        }
    }

    #[test]
    fn a_failed_install_reads_as_what_went_wrong() {
        let failure = |error| install_error(error).failure;

        assert_eq!(failure(Error::MissingSignedVersion), Failure::Signature);
        assert_eq!(failure(Error::Io(ErrorKind::StorageFull.into())), Failure::Disk);
        assert_eq!(failure(Error::Io(ErrorKind::PermissionDenied.into())), Failure::Replace);
        assert_eq!(failure(Error::ReleaseNotFound), Failure::Replace);
    }
}
