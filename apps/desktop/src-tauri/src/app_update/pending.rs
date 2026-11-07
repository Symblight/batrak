//! The files of an update waiting on disk, under `app-update/`, and what a launch makes of them.
//!
//! `pending.json` always names a verified package: the new package stays beside the old as
//! `package.new` until it is verified, and `pending.json` is written last. So a package with no
//! `pending.json` is junk from a crash, and a crash at any point leaves something a launch can sort out.

use std::fs;
use std::path::{Path, PathBuf};

use bt_core::release;
use bt_core::util::write_atomic;
use semver::Version;
use serde::{Deserialize, Serialize};

use super::AppUpdateState;

const PENDING: &str = "pending.json";
/// Never from the manifest's URL: the manifest is unsigned, so it can't choose a path under our data
/// folder. The installer tells the formats apart by their bytes.
const PACKAGE: &str = "package";
const INCOMING: &str = "package.new";
const INCOMING_PART: &str = "package.new.part";

pub const DID_NOT_INSTALL: &str = "the update didn't install";

/// `pending.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub version: Version,
    /// The manifest as the release served it: `Installer::install` restores the update from it.
    pub manifest: serde_json::Value,
    pub on_next_launch: bool,
    /// Written before any install: both the record of the result and what stops a crash from looping.
    pub attempted: bool,
}

pub struct Files {
    dir: PathBuf,
}

impl Files {
    pub fn new(dir: PathBuf) -> Files {
        Files { dir }
    }

    pub fn package(&self) -> PathBuf {
        self.dir.join(PACKAGE)
    }

    /// Where a download lands, leaving a package already waiting as it is.
    pub fn incoming(&self) -> PathBuf {
        self.dir.join(INCOMING)
    }

    /// Anything unreadable or malformed counts as nothing waiting.
    pub fn read_pending(&self) -> Option<Pending> {
        let text = fs::read(self.dir.join(PENDING)).ok()?;
        serde_json::from_slice(&text).ok()
    }

    pub fn write_pending(&self, pending: &Pending) -> std::io::Result<()> {
        let text = serde_json::to_vec_pretty(pending).map_err(std::io::Error::other)?;
        write_atomic(&self.dir.join(PENDING), &text)
    }

    /// Puts a verified `package.new` in place of what is waiting. `pending.json` goes first, so a crash
    /// in between leaves a package nothing names, which the next launch deletes.
    pub fn promote(&self, pending: &Pending) -> std::io::Result<()> {
        remove_if_there(&self.dir.join(PENDING))?;
        fs::rename(self.incoming(), self.package())?;
        self.write_pending(pending)
    }

    pub fn remove_incoming(&self) {
        let _ = fs::remove_file(self.incoming());
        let _ = fs::remove_file(self.dir.join(INCOMING_PART));
    }

    /// The whole folder. Only a launch's cleanup or a corrupted package gets here, with nothing the
    /// user asked for at stake, so a folder that can't go is worth a warning.
    pub fn delete_all(&self) {
        if let Err(e) = fs::remove_dir_all(&self.dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(dir = %self.dir.display(), "couldn't delete a finished update: {e}");
            }
        }
    }
}

fn remove_if_there(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// What a launch does with what it finds (`docs/specs/app-update.md` §3.3).
#[derive(Debug, Clone, PartialEq)]
pub enum Launch {
    /// This build doesn't update.
    Nothing,
    /// Deletes `app-update/` and opens in this state.
    Clean(AppUpdateState),
    /// Installs before anything else, then restarts.
    Install(Pending),
    /// Opens in `None`, and `Ready` once the package passes.
    Verify(Pending),
}

pub fn decide(pending: Option<Pending>, running: &Version) -> Launch {
    let Some(pending) = pending else {
        return Launch::Clean(AppUpdateState::None);
    };
    let version = pending.version.to_string();
    let still_older = release::compare(running, &pending.version);
    match (pending.attempted, still_older) {
        (true, false) => Launch::Clean(AppUpdateState::Updated { version }),
        (true, true) => Launch::Clean(AppUpdateState::Failed { version, reason: DID_NOT_INSTALL.to_owned() }),
        (false, false) => Launch::Clean(AppUpdateState::None),
        (false, true) if pending.on_next_launch => Launch::Install(pending),
        (false, true) => Launch::Verify(pending),
    }
}
