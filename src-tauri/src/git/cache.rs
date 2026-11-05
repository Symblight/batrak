//! Branch and status of one root, kept between requests, so showing the Changes view again costs
//! a few `stat` calls instead of a working-tree scan when nothing changed.
//!
//! A cached answer stays valid while both hold:
//! - the root's change epoch is the same: no watcher batch arrived since (covers the working tree,
//!   and a `.git` inside the root);
//! - the repository files it depends on look the same on disk (the fingerprint: covers a git dir
//!   outside the root, as for a root in a subfolder or a worktree, which the watcher doesn't see).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use serde::Serialize;

use super::repo::{self, RepoInfo, RepoState, Status};

/// Modification time and size of each file a fingerprint looks at; `None` for a missing one.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint(Vec<Option<(Option<SystemTime>, u64)>>);

/// The repository files branch and status depend on. Git replaces refs, `HEAD` and `index` by
/// renaming a lock file onto them, so every write gives them a new mtime. `info/exclude` decides
/// which files count as untracked.
fn fingerprint(info: &RepoInfo, upstream: Option<&str>) -> Fingerprint {
    let (git_dir, common) = (&info.git_dir, &info.common_dir);
    let head = git_dir.join("HEAD");
    let head_ref = fs::read_to_string(&head).ok().and_then(|text| Some(text.strip_prefix("ref: ")?.trim().to_owned()));
    let mut paths: Vec<PathBuf> = vec![
        head,
        git_dir.join("index"),
        common.join("packed-refs"),
        common.join("config"),
        common.join("info/exclude"),
    ];
    paths.extend(head_ref.map(|r| common.join(r)));
    if let Some(upstream) = upstream {
        // `origin/main` or a local branch; whichever exists.
        paths.push(common.join("refs/remotes").join(upstream));
        paths.push(common.join("refs/heads").join(upstream));
    }
    Fingerprint(
        paths
            .iter()
            .map(|p| fs::metadata(p).ok().map(|m| (m.modified().ok(), m.len())))
            .collect(),
    )
}

/// Reply to a status request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReply {
    /// Bumped whenever the status differs from the previous one; the caller passes it back as `since`.
    pub version: u64,
    /// Same version as `since`: `status` is left out, the caller's copy is current.
    pub unchanged: bool,
    /// `None` outside a repository, or when `unchanged`.
    pub status: Option<Status>,
}

struct CachedHead {
    fingerprint: Fingerprint,
    state: RepoState,
}

struct CachedStatus {
    epoch: u64,
    /// `None` outside a repository.
    fingerprint: Option<Fingerprint>,
    status: Option<Status>,
}

/// The repository a root belongs to, as last looked up.
struct CachedInfo {
    epoch: u64,
    /// Whether the root had its own `.git` then: one appearing or going away (a `git init` in a
    /// root inside a larger repository, a deleted `.git`) changes the repository without making
    /// git calls fail.
    dot_git: bool,
    info: Option<Arc<RepoInfo>>,
}

#[derive(Default)]
struct StatusSlot {
    version: u64,
    cached: Option<CachedStatus>,
}

/// Locks ignoring poisoning: a panicked reader must not take the cache down.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Default)]
pub struct GitCache {
    /// Looked up again when the root's own `.git` appears or goes away, and after a failed git
    /// call; "not in one" also after any change (a `git init` above the root).
    info: Mutex<Option<CachedInfo>>,
    head: Mutex<Option<CachedHead>>,
    /// Held while git runs, so a second request waits for the first one's result instead of
    /// scanning again.
    status: Mutex<StatusSlot>,
}

impl GitCache {
    fn info(&self, git: &Path, root: &Path, epoch: u64) -> Result<Option<Arc<RepoInfo>>, String> {
        // A file for a linked worktree; `symlink_metadata` so a dangling link still counts.
        let dot_git = fs::symlink_metadata(root.join(".git")).is_ok();
        let mut slot = lock(&self.info);
        if let Some(cached) = &*slot {
            if cached.dot_git == dot_git && (cached.info.is_some() || cached.epoch == epoch) {
                return Ok(cached.info.clone());
            }
        }
        let info = repo::info(git, root)?.map(Arc::new);
        *slot = Some(CachedInfo { epoch, dot_git, info: info.clone() });
        Ok(info)
    }

    /// Forgets the repository after a failed git call: it may have been deleted or moved.
    fn forget_info(&self) {
        lock(&self.info).take();
    }

    /// Branch, HEAD and upstream; `None` outside a repository. `epoch` is the root's change epoch,
    /// read before calling. Blocking.
    pub fn head(&self, git: &Path, root: &Path, epoch: u64) -> Result<Option<RepoState>, String> {
        let Some(info) = self.info(git, root, epoch)? else { return Ok(None) };
        let mut slot = lock(&self.head);
        let mut upstream = slot.as_ref().and_then(|c| c.state.upstream.clone());
        let mut fingerprint = fingerprint(&info, upstream.as_deref());
        if let Some(cached) = &*slot {
            if cached.fingerprint == fingerprint {
                return Ok(Some(cached.state.clone()));
            }
        }
        // The fingerprint is taken before git reads, so a change while it runs makes the next call
        // read again. It covers the upstream ref only once the upstream is known: when the read
        // finds another one (the first read, or a new upstream), read once more with it covered.
        let mut state = repo::head_in(git, root).inspect_err(|_| self.forget_info())?;
        if state.upstream != upstream {
            upstream = state.upstream.clone();
            fingerprint = self::fingerprint(&info, upstream.as_deref());
            state = repo::head_in(git, root).inspect_err(|_| self.forget_info())?;
        }
        *slot = (state.upstream == upstream).then(|| CachedHead { fingerprint, state: state.clone() });
        Ok(Some(state))
    }

    /// Branch and changed files, read again only when something changed since the cached answer
    /// (or with `force`). Blocking.
    pub fn status(
        &self,
        git: &Path,
        root: &Path,
        epoch: u64,
        since: Option<u64>,
        force: bool,
    ) -> Result<StatusReply, String> {
        let info = self.info(git, root, epoch)?;
        let mut slot = lock(&self.status);
        let upstream = slot.cached.as_ref().and_then(|c| c.status.as_ref()?.repo.upstream.clone());
        let fingerprint = info.as_deref().map(|info| fingerprint(info, upstream.as_deref()));
        let valid = !force
            && slot.cached.as_ref().is_some_and(|c| c.epoch == epoch && c.fingerprint == fingerprint);
        if !valid {
            let status = match &info {
                Some(info) => Some(repo::status_in(git, root, info).inspect_err(|_| self.forget_info())?),
                None => None,
            };
            if slot.cached.as_ref().map(|c| &c.status) != Some(&status) {
                slot.version += 1;
            }
            // The scan found another upstream (the first scan, or a new upstream): cover its ref from
            // now on. Unlike `head`, no second scan to close the gap — only the counts could be
            // stale, and only if that ref moved in the moment since git read it.
            let new_upstream = status.as_ref().and_then(|s| s.repo.upstream.clone());
            let fingerprint = match &info {
                Some(info) if new_upstream != upstream => Some(self::fingerprint(info, new_upstream.as_deref())),
                _ => fingerprint,
            };
            slot.cached = Some(CachedStatus { epoch, fingerprint, status });
        }
        let version = slot.version;
        let unchanged = since == Some(version);
        let status = if unchanged { None } else { slot.cached.as_ref().and_then(|c| c.status.clone()) };
        Ok(StatusReply { version, unchanged, status })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::{git_bin, temp_dir, TestRepo};

    /// Status at `epoch`, as the caller holding `since` sees it.
    fn ask(cache: &GitCache, root: &Path, epoch: u64, since: Option<u64>) -> StatusReply {
        cache.status(&git_bin(), root, epoch, since, false).unwrap()
    }

    #[test]
    fn unchanged_until_the_epoch_or_the_repository_moves() {
        let repo = TestRepo::with_commit("cache");
        let cache = GitCache::default();
        let first = ask(&cache, &repo.path, 0, None);
        assert!(!first.unchanged && first.status.as_ref().unwrap().files.is_empty());

        let again = ask(&cache, &repo.path, 0, Some(first.version));
        assert!(again.unchanged && again.status.is_none(), "nothing changed: no status sent");

        // A file the watcher would report: the epoch moves.
        repo.write("README.md", "edited\n");
        let edited = ask(&cache, &repo.path, 1, Some(first.version));
        assert!(!edited.unchanged);
        assert_eq!(edited.status.unwrap().files[0].path, "README.md");

        // Changed again, but to the same status: a new scan, same version.
        repo.write("README.md", "edited again\n");
        let same = ask(&cache, &repo.path, 2, Some(edited.version));
        assert!(same.unchanged, "an identical status keeps its version");

        // The index moves without an epoch (git dir outside a watched root): the fingerprint sees it.
        repo.git(&["add", "README.md"]);
        let staged = ask(&cache, &repo.path, 2, Some(edited.version));
        assert!(!staged.unchanged);
        assert!(staged.status.unwrap().files[0].staged);

        // HEAD moves.
        repo.git(&["commit", "-qm", "edit"]);
        let committed = ask(&cache, &repo.path, 2, Some(staged.version));
        assert!(committed.status.unwrap().files.is_empty());
    }

    #[test]
    fn head_follows_the_repository_files() {
        let (repo, _origin) = TestRepo::with_remote("cache-head");
        let (git, cache) = (git_bin(), GitCache::default());
        let main = cache.head(&git, &repo.path, 0).unwrap().unwrap();
        assert_eq!(main.branch.as_deref(), Some("main"));
        repo.git(&["switch", "-qc", "topic"]);
        assert_eq!(cache.head(&git, &repo.path, 0).unwrap().unwrap().branch.as_deref(), Some("topic"));
        repo.git(&["switch", "-q", "main"]);
        assert_eq!(cache.head(&git, &repo.path, 0).unwrap().unwrap().upstream_sha, main.sha);

        // The upstream ref moves (a push or fetch in a terminal), without an epoch.
        let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
        let moved = repo.git(&["commit-tree", "-p", "HEAD", "-m", "remote moves", tree.trim()]);
        repo.git(&["update-ref", "refs/remotes/origin/main", moved.trim()]);
        assert_eq!(cache.head(&git, &repo.path, 0).unwrap().unwrap().upstream_sha.as_deref(), Some(moved.trim()), "upstream ref moved");
    }

    #[test]
    fn a_worktree_outside_the_watched_root_is_followed_by_fingerprint() {
        let mut repo = TestRepo::with_commit("cache-wt");
        let wt = repo.worktree("cache-wt-dir", "wt-branch");
        let cache = GitCache::default();
        let first = ask(&cache, &wt, 0, None);
        std::fs::write(wt.join("README.md"), "changed\n").unwrap();
        crate::git::test_repo::run_in(&wt, &["add", "README.md"]);
        let staged = ask(&cache, &wt, 0, Some(first.version));
        assert!(!staged.unchanged, "the worktree's index lives under the main .git");
    }

    /// An edit the watcher doesn't report (same epoch): a cached answer must not see it.
    fn untracked_unreported(repo: &TestRepo) {
        repo.write(&format!("unreported-{}.txt", std::process::id()), "x");
    }

    #[test]
    fn a_branch_with_an_upstream_is_cached_too() {
        let repo = TestRepo::with_commit("cache-upstream");
        repo.git(&["branch", "base"]);
        repo.git(&["branch", "-q", "--set-upstream-to=base"]);
        let (git, cache) = (git_bin(), GitCache::default());

        let state = cache.head(&git, &repo.path, 0).unwrap().unwrap();
        assert_eq!(state.upstream.as_deref(), Some("base"));
        assert!(lock(&cache.head).is_some(), "cached from the first call");

        let first = ask(&cache, &repo.path, 0, None);
        untracked_unreported(&repo);
        assert!(ask(&cache, &repo.path, 0, Some(first.version)).unchanged, "the second visit reuses the first scan");
    }

    #[test]
    fn a_repository_created_in_a_subfolder_root_replaces_the_outer_one() {
        let repo = TestRepo::with_commit("cache-nested");
        repo.write("pkg/a.txt", "a");
        let root = repo.path.join("pkg");
        let cache = GitCache::default();
        let outer = ask(&cache, &root, 0, None);
        assert_eq!(outer.status.unwrap().files[0].path, "a.txt");

        crate::git::test_repo::run_in(&root, &["init", "-q", "-b", "main"]);
        let inner = ask(&cache, &root, 1, Some(outer.version)).status.unwrap();
        assert_eq!(inner.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt"]);
        assert_eq!(inner.repo.sha, None, "the new repository, with no commits");

        std::fs::remove_dir_all(root.join(".git")).unwrap();
        let back = ask(&cache, &root, 2, None).status.unwrap();
        assert!(back.repo.sha.is_some(), "the outer repository again");
    }

    #[test]
    fn info_exclude_changes_the_untracked_files() {
        let repo = TestRepo::with_commit("cache-exclude");
        repo.write("build.log", "x");
        let cache = GitCache::default();
        let first = ask(&cache, &repo.path, 0, None);
        assert_eq!(first.status.unwrap().files.len(), 1);
        repo.write(".git/info/exclude", "*.log\n");
        let excluded = ask(&cache, &repo.path, 0, Some(first.version));
        assert!(excluded.status.unwrap().files.is_empty());
    }

    #[test]
    fn a_new_repository_is_noticed_after_a_change() {
        let dir = temp_dir("cache-init");
        let cache = GitCache::default();
        let none = ask(&cache, &dir, 0, None);
        assert!(none.status.is_none());
        crate::git::test_repo::run_in(&dir, &["init", "-q", "-b", "main"]);
        assert!(ask(&cache, &dir, 1, Some(none.version)).status.is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

