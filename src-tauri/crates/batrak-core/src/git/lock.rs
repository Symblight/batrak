//! Serializes the operations that change a repository. Keyed by the common git directory, so a
//! checkout and all its worktrees share one lock (they share refs, objects and worktree metadata).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use super::exec::{self, Mode};

/// Operations waiting or running per repository before new ones are refused.
const MAX_QUEUED: usize = 8;

#[derive(Default)]
struct Slot {
    lock: Mutex<()>,
    queued: AtomicUsize,
}

static SLOTS: LazyLock<Mutex<HashMap<PathBuf, Arc<Slot>>>> = LazyLock::new(Default::default);

/// Runs `f` while holding the lock of the repository `cwd` belongs to.
pub fn with_mutation<T>(git: &Path, cwd: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let key = common_dir(git, cwd)?;
    let slot = Arc::clone(SLOTS.lock().unwrap_or_else(PoisonError::into_inner).entry(key).or_default());
    if slot.queued.fetch_add(1, Ordering::SeqCst) >= MAX_QUEUED {
        slot.queued.fetch_sub(1, Ordering::SeqCst);
        return Err("too many git operations queued for this repository".to_owned());
    }
    let result = {
        let _guard = slot.lock.lock().unwrap_or_else(PoisonError::into_inner);
        f()
    };
    slot.queued.fetch_sub(1, Ordering::SeqCst);
    result
}

/// The canonical common git directory of the repository at `cwd`.
pub fn common_dir(git: &Path, cwd: &Path) -> Result<PathBuf, String> {
    let out = exec::run(
        git,
        cwd,
        &exec::args(&[&"rev-parse", &"--path-format=absolute", &"--git-common-dir"]),
        Mode::Background,
    )?;
    let dir = String::from_utf8_lossy(&out);
    Ok(exec::canonical(Path::new(dir.trim())))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::thread;
    use std::time::Duration;

    use super::*;
    use crate::git::test_repo::{git_bin, TestRepo};

    #[test]
    fn worktrees_of_one_repository_share_the_lock() {
        let mut repo = TestRepo::with_commit("lock");
        let wt = repo.worktree("lock-wt", "lock-branch");
        assert_eq!(common_dir(&git_bin(), &repo.path).unwrap(), common_dir(&git_bin(), &wt).unwrap());

        let busy = Arc::new(AtomicBool::new(false));
        let overlapped = Arc::new(AtomicBool::new(false));
        let handles: Vec<_> = [repo.path.clone(), wt.clone()]
            .into_iter()
            .map(|cwd| {
                let (busy, overlapped) = (Arc::clone(&busy), Arc::clone(&overlapped));
                thread::spawn(move || {
                    with_mutation(&git_bin(), &cwd, || {
                        if busy.swap(true, Ordering::SeqCst) {
                            overlapped.store(true, Ordering::SeqCst);
                        }
                        thread::sleep(Duration::from_millis(100));
                        busy.store(false, Ordering::SeqCst);
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert!(!overlapped.load(Ordering::SeqCst), "mutations of one repository overlapped");
    }
}
