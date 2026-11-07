//! A workspace's changes against its base commit, for its Changes tab.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

/// A workspace's running change list, by workspace id: a new one stops the one before it.
#[derive(Default)]
pub struct WorkspaceScans(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl WorkspaceScans {
    pub fn start(&self, id: &str) -> Arc<AtomicBool> {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut scans = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(previous) = scans.insert(id.to_owned(), Arc::clone(&cancel)) {
            previous.store(true, Ordering::SeqCst);
        }
        cancel
    }
}

/// `path` of a workspace at its base commit, `None` when it wasn't there; `path` goes through
/// `checked_rel` first. Fails, saying why, when it has no text to diff (see `blob::file_at_head`).
pub fn file_at_base(git: &Path, dir: &Path, base: &str, path: &str) -> Result<Option<String>, String> {
    crate::util::checked_rel(path)?;
    super::blob::file_at(git, dir, base, path)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::git::apply::changed_since;
    use crate::git::exec::CANCELLED;
    use crate::git::test_repo::{git_bin, run_in, TestRepo};

    /// A repository with `a.txt`, a worktree on a new branch from it, and that base commit.
    fn workspace(name: &str) -> (TestRepo, PathBuf, String) {
        let mut repo = TestRepo::new(name);
        repo.write("a.txt", "one\ntwo\nthree\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "init"]);
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        let folder = repo.worktree(&format!("{name}-wt"), "task");
        (repo, folder, base)
    }

    #[test]
    fn a_workspaces_list_and_file_text_are_against_its_base() {
        let (_repo, wt, base) = workspace("ws-changes");
        let git = git_bin();
        let list = || -> Vec<String> {
            changed_since(&git, &wt, &base, &AtomicBool::new(false)).unwrap().into_iter().map(|file| file.path).collect()
        };
        assert!(list().is_empty(), "nothing done yet");

        std::fs::write(wt.join("committed.txt"), "c\n").unwrap();
        run_in(&wt, &["add", "."]);
        run_in(&wt, &["commit", "-qm", "agent"]);
        std::fs::write(wt.join("a.txt"), "edited").unwrap();
        std::fs::create_dir(wt.join("dir")).unwrap();
        std::fs::write(wt.join("dir/new.txt"), "new").unwrap();

        assert_eq!(list(), ["a.txt", "committed.txt", "dir/new.txt"]);
        assert_eq!(file_at_base(&git, &wt, &base, "a.txt").unwrap().as_deref(), Some("one\ntwo\nthree\n"));
        assert_eq!(file_at_base(&git, &wt, &base, "dir/new.txt").unwrap(), None);
        let err = file_at_base(&git, &wt, &base, "../x").unwrap_err();
        assert!(err.contains("not a path inside the root"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_new_list_stops_the_one_before_it() {
        let (repo, wt, base) = workspace("ws-supersede");
        // A filter that hangs until the second list.
        let (go, started) = (repo.path.join("go"), repo.path.join("started"));
        let filter = format!("sh -c '[ -e \"{}\" ] || {{ touch \"{}\"; sleep 30; }}; cat'", go.display(), started.display());
        run_in(&wt, &["config", "filter.slow.clean", &filter]);
        std::fs::write(wt.join("a.txt"), "edited").unwrap();
        std::fs::write(wt.join(".gitattributes"), "a.txt filter=slow\n").unwrap();
        let scans = WorkspaceScans::default();

        let first_cancel = scans.start("task");
        let first = {
            let (cancel, wt, base) = (Arc::clone(&first_cancel), wt.clone(), base.clone());
            std::thread::spawn(move || changed_since(&git_bin(), &wt, &base, &cancel))
        };
        while !started.exists() {
            std::thread::sleep(Duration::from_millis(10));
        }
        scans.start("another workspace");
        assert!(!first_cancel.load(Ordering::SeqCst), "another workspace's list leaves it running");

        std::fs::write(&go, "").unwrap();
        let began = Instant::now();
        let second = changed_since(&git_bin(), &wt, &base, &scans.start("task")).unwrap();
        let first = first.join().unwrap().unwrap_err();

        assert!(first.starts_with(CANCELLED), "{first}");
        assert!(began.elapsed() < Duration::from_secs(9), "took {:?}", began.elapsed());
        assert!(second.iter().any(|file| file.path == "a.txt"));
    }
}
