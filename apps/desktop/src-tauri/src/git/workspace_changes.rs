//! A workspace's changes against its base commit, for its Changes tab.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use super::apply::with_snapshot;
use super::exec::Mode;
use super::line_counts::parse_numstat;
use super::status::{FileKind, FileStatus};

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

/// Files under `dir` (a worktree or a folder in one; paths relative to it) that differ from
/// `base`: its commits and uncommitted work together, with line counts. Renames show as a deletion
/// and an addition. Sorted by path. A refresh: once `cancel` is set git stops (`exec::CANCELLED`).
pub fn changed_since(git: &Path, dir: &Path, base: &str, cancel: &AtomicBool) -> Result<Vec<FileStatus>, String> {
    with_snapshot(git, dir, false, Mode::Background, Some(cancel), |run| {
        let diff = |format: &'static str| run(&[&"diff", &"--cached", &format, &"-z", &"--relative", &"--no-renames", &base]);
        let names = diff("--name-status")?;
        let counts = parse_numstat(&String::from_utf8_lossy(&diff("--numstat")?));
        let names = String::from_utf8_lossy(&names);
        let mut fields = names.split('\0').filter(|f| !f.is_empty());
        let mut files = Vec::new();
        while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
            let kind = match status.as_bytes().first() {
                Some(b'A') => FileKind::Added,
                Some(b'D') => FileKind::Deleted,
                Some(b'T') => FileKind::TypeChanged,
                _ => FileKind::Modified,
            };
            let (added, removed) = counts.get(path).copied().unwrap_or((None, None));
            files.push(FileStatus { path: path.to_owned(), kind, staged: false, unstaged: true, orig_path: None, added, removed });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::git::blob;
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

    #[test]
    fn listing_a_worktrees_changes_leaves_no_objects_in_the_repository() {
        let mut repo = TestRepo::with_commit("no-objects");
        let wt = repo.worktree("no-objects-wt", "batrak/no-objects");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        std::fs::write(wt.join("README.md"), "agent edit\n").unwrap();
        std::fs::write(wt.join("new.txt"), "new\n").unwrap();
        let before = repo.git(&["count-objects"]);

        assert_eq!(changed_since(&git_bin(), &wt, &base, &AtomicBool::new(false)).unwrap().len(), 2);

        assert_eq!(repo.git(&["count-objects"]), before);
    }

    #[cfg(unix)]
    #[test]
    fn a_colon_in_the_repositorys_path_is_only_a_colon() {
        let mut repo = TestRepo::with_commit("co:lon");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        let wt = repo.worktree("colon-wt", "batrak/colon");
        std::fs::write(wt.join("README.md"), "agent edit\n").unwrap();

        let files = changed_since(&git_bin(), &wt, &base, &AtomicBool::new(false)).unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["README.md"]);
    }

    #[test]
    fn files_changed_since_the_base_commit_and_their_text_there() {
        let mut repo = TestRepo::with_commit("since");
        for (path, text) in [("app/edit.txt", "one\n"), ("app/gone.txt", "gone\n"), ("app/keep.txt", "keep\n")] {
            repo.write(path, text);
        }
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "app"]);
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        let wt = repo.worktree("since-wt", "batrak/since");
        std::fs::write(wt.join("app/edit.txt"), "one\ntwo\n").unwrap();
        run_in(&wt, &["commit", "-qam", "agent"]);
        std::fs::remove_file(wt.join("app/gone.txt")).unwrap();
        std::fs::write(wt.join("app/new.txt"), "a\nb\nc\n").unwrap();
        std::fs::write(wt.join("outside.txt"), "not the project's").unwrap();
        run_in(&wt, &["add", "app/new.txt"]);
        let git = git_bin();

        let files = changed_since(&git, &wt.join("app"), &base, &AtomicBool::new(false)).unwrap();
        let summary: Vec<_> = files.iter().map(|f| (f.path.as_str(), f.kind, f.added, f.removed)).collect();
        assert_eq!(
            summary,
            [
                ("edit.txt", FileKind::Modified, Some(1), Some(0)),
                ("gone.txt", FileKind::Deleted, Some(0), Some(1)),
                ("new.txt", FileKind::Added, Some(3), Some(0)),
            ]
        );
        assert_eq!(run_in(&wt, &["diff", "--cached", "--name-only"]), "app/new.txt\n", "the worktree's index is untouched");
        assert_eq!(blob::file_at(&git, &wt.join("app"), &base, "edit.txt").unwrap().as_deref(), Some("one\n"));
        assert_eq!(blob::file_at(&git, &wt.join("app"), &base, "new.txt").unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn listing_a_worktrees_changes_doesnt_run_the_repositorys_fsmonitor_hook() {
        use std::os::unix::fs::PermissionsExt;
        let mut repo = TestRepo::with_commit("list-fsmonitor");
        let wt = repo.worktree("list-fsmonitor-wt", "batrak/list-fsmonitor");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        std::fs::write(wt.join("README.md"), "agent edit\n").unwrap();
        let dir = crate::git::test_repo::temp_dir("list-fsmonitor-hook");
        let (hook, ran) = (dir.join("hook"), dir.join("ran"));
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\nexit 1\n", ran.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        repo.git(&["config", "core.fsmonitor", hook.to_str().unwrap()]);

        assert_eq!(changed_since(&git_bin(), &wt, &base, &AtomicBool::new(false)).unwrap().len(), 1);

        assert!(!ran.exists(), "the hook ran on a refresh");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
