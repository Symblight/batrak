//! One process handles updates per data folder: nothing stops a second one from starting, and
//! `BATRAK_HOME` means to allow others, so whoever holds `app-update.lock` owns `app-update/`.
//!
//! The file lies beside that folder, since a cleanup deletes the folder and Windows can't delete a locked
//! file. It stays on disk. `std` opens it unshared with children (`O_CLOEXEC`, a non-inheritable handle),
//! so an agent or a shell can't keep it held after the app is gone.

use std::fs::{self, File, TryLockError};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use tracing::info;

const RETRY_EVERY: Duration = Duration::from_millis(50);

/// What this process is to the updates of its data folder.
pub enum Standing {
    /// It handles them. No file in a build that doesn't update, where locks don't work, and once let go
    /// for a restart.
    Handling(Option<File>),
    /// Another process held the lock at the last try, which may be one on its way out.
    Contended,
    /// Another process holds the lock: no updates here for this process's life.
    Aside,
}

impl Standing {
    pub fn handling(&self) -> bool {
        matches!(self, Standing::Handling(_))
    }

    /// Unlocks rather than only closes: a child between its fork and its exec shares the open file, and
    /// would keep a lock that is merely closed.
    pub fn let_go(&mut self) {
        if let Standing::Handling(file) = self {
            if let Some(Err(e)) = file.take().map(|file| file.unlock()) {
                info!("couldn't unlock for the restart: {e}");
            }
        }
    }
}

/// Only another process's lock stands in the way: a filesystem without locks mustn't disable updates for
/// good, so it goes on unguarded.
pub fn standing_after(file: File, attempt: Result<(), TryLockError>) -> Standing {
    match attempt {
        Ok(()) => Standing::Handling(Some(file)),
        Err(TryLockError::WouldBlock) => Standing::Contended,
        Err(TryLockError::Error(e)) => unguarded(&e),
    }
}

fn unguarded(error: &std::io::Error) -> Standing {
    info!("updates run without their lock: {error}");
    Standing::Handling(None)
}

/// One try, which never waits.
pub fn claim(path: &Path) -> Standing {
    let parent = path.parent().map_or(Ok(()), fs::create_dir_all);
    match parent.and_then(|()| File::options().create(true).truncate(false).write(true).open(path)) {
        Ok(file) => {
            let attempt = file.try_lock();
            standing_after(file, attempt)
        }
        Err(e) => unguarded(&e),
    }
}

/// Blocking: tries until `wait` is over. A relaunch can start before the process it replaces has ended.
pub fn claim_within(path: &Path, wait: Duration) -> Standing {
    let deadline = Instant::now() + wait;
    loop {
        match claim(path) {
            Standing::Contended if Instant::now() < deadline => thread::sleep(RETRY_EVERY),
            Standing::Contended => {
                info!("another process handles updates for this data folder");
                return Standing::Aside;
            }
            decided => return decided,
        }
    }
}
