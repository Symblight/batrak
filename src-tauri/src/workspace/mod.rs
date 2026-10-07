//! Workspace snapshots: one per opened root (today the project; later each session's
//! git worktree). The file tree, Quick Open and Find in Files all read from here.

pub mod quick_open;
pub mod search;
pub mod snapshot;
mod watcher;

#[cfg(test)]
mod bench;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use notify_debouncer_full::notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, NoCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use snapshot::{Changes, Snapshot};

/// Tauri event carrying [`ChangedPayload`] after the watcher patched a snapshot.
pub const CHANGED_EVENT: &str = "workspace://changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedPayload<'a> {
    root_id: &'a str,
    #[serde(flatten)]
    changes: Changes,
}

/// Checks a root-relative path from the frontend: `/`-separated, no `..`, `.` or empty
/// segments, not absolute, and not inside `.git`. Every command taking a relative path calls it.
pub fn checked_rel(rel: &str) -> Result<&str, String> {
    let ok = !rel.is_empty()
        && !rel.contains('\\')
        && !rel.contains('\0')
        && !Path::new(rel).is_absolute()
        && rel.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        && rel.split('/').next() != Some(".git");
    if ok {
        Ok(rel)
    } else {
        Err(format!("{rel:?}: not a path inside the workspace"))
    }
}

/// Locks ignoring poisoning: a panicked reader must not take the whole workspace down.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct Root {
    pub id: String,
    pub path: PathBuf,
    pub snapshot: RwLock<Snapshot>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher, NoCache>>>,
    /// Most recent first, at most `quick_open::RECENT_CAPACITY`.
    recent: Mutex<VecDeque<String>>,
    /// Bumped by every Quick Open query; a running query stops when it is no longer current.
    quick_open_generation: AtomicU64,
    /// Cancel flag of the running Find in Files, replaced on every new search.
    search_cancel: Mutex<Arc<AtomicBool>>,
    /// Set by `Workspaces::close`; stops a watcher rescan still running for a closed root.
    pub closed: AtomicBool,
}

impl Root {
    pub fn read(&self) -> std::sync::RwLockReadGuard<'_, Snapshot> {
        self.snapshot.read().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn write(&self) -> std::sync::RwLockWriteGuard<'_, Snapshot> {
        self.snapshot.write().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn note_opened(&self, rel: String) {
        let mut recent = lock(&self.recent);
        recent.retain(|p| p != &rel);
        recent.push_front(rel);
        recent.truncate(quick_open::RECENT_CAPACITY);
    }

    pub fn quick_open(&self, query: &str) -> Option<Vec<quick_open::QuickOpenItem>> {
        let generation = self.quick_open_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let recent: Vec<String> = lock(&self.recent).iter().cloned().collect();
        let snapshot = self.read();
        quick_open::search(&snapshot, &recent, query, || {
            self.quick_open_generation.load(Ordering::Relaxed) != generation
        })
    }

    /// Cancels the running search (if any) and returns the flag for a new one.
    pub fn start_search(&self) -> Arc<AtomicBool> {
        let fresh = Arc::new(AtomicBool::new(false));
        let previous = std::mem::replace(&mut *lock(&self.search_cancel), Arc::clone(&fresh));
        previous.store(true, Ordering::Relaxed);
        fresh
    }

    pub fn cancel_search(&self) {
        lock(&self.search_cancel).store(true, Ordering::Relaxed);
    }
}

/// Error of an open whose scan was cancelled by a newer open in the same group.
pub const SUPERSEDED: &str = "superseded by a newer open";

/// All opened roots, by id. Cheap to clone.
#[derive(Clone, Default)]
pub struct Workspaces {
    roots: Arc<Mutex<HashMap<String, Arc<Root>>>>,
    next_id: Arc<AtomicU64>,
    /// Cancel flag of the scan in progress per group (a window): a newer open stops the older scan
    /// instead of letting both saturate the disk.
    opening: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Workspaces {
    /// Scans `path` and starts watching it; changes go to the frontend as [`CHANGED_EVENT`].
    /// A later open in the same `group` cancels this one's scan, which then fails with
    /// [`SUPERSEDED`]. Blocking: call off the main thread.
    pub fn open(&self, app: AppHandle, path: &Path, group: &str) -> Result<Arc<Root>, String> {
        let cancel = self.begin_open(group);
        let result = self.open_with(path, &cancel, move |root, changes| {
            let _ = app.emit(CHANGED_EVENT, ChangedPayload { root_id: &root.id, changes });
        });
        self.end_open(group, &cancel);
        result
    }

    /// Cancels the scan in progress in `group`, if any, and returns the flag of a new one.
    fn begin_open(&self, group: &str) -> Arc<AtomicBool> {
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(previous) = lock(&self.opening).insert(group.to_owned(), Arc::clone(&cancel)) {
            previous.store(true, Ordering::Relaxed);
        }
        cancel
    }

    /// Forgets `cancel` once its open is done, unless a newer open already replaced it.
    fn end_open(&self, group: &str, cancel: &Arc<AtomicBool>) {
        let mut opening = lock(&self.opening);
        if opening.get(group).is_some_and(|current| Arc::ptr_eq(current, cancel)) {
            opening.remove(group);
        }
    }

    fn open_with(
        &self,
        path: &Path,
        cancel: &AtomicBool,
        on_change: impl Fn(&Root, Changes) + Send + 'static,
    ) -> Result<Arc<Root>, String> {
        // FSEvents reports canonical paths (e.g. /private/var), so the root must be canonical too.
        // `dunce` keeps it a plain `C:\…` on Windows: relative paths are joined to it with `/`.
        let path = dunce::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if !path.is_dir() {
            return Err(format!("{}: not a directory", path.display()));
        }
        let snapshot = Snapshot::scan_until(&path, cancel).ok_or(SUPERSEDED)?;
        let id = format!("root-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let root = Arc::new(Root {
            id: id.clone(),
            snapshot: RwLock::new(snapshot),
            path,
            watcher: Mutex::new(None),
            recent: Mutex::new(VecDeque::new()),
            quick_open_generation: AtomicU64::new(0),
            search_cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
            closed: AtomicBool::new(false),
        });
        // Started after the scan: a change in between is picked up by the next event in that folder.
        let watcher = watcher::start(&root, on_change)?;
        *lock(&root.watcher) = Some(watcher);
        lock(&self.roots).insert(id, Arc::clone(&root));
        Ok(root)
    }

    pub fn close(&self, id: &str) {
        if let Some(root) = lock(&self.roots).remove(id) {
            root.closed.store(true, Ordering::Relaxed);
            root.cancel_search();
            // Dropping the debouncer stops its thread.
            lock(&root.watcher).take();
        }
    }

    pub fn get(&self, id: &str) -> Result<Arc<Root>, String> {
        lock(&self.roots).get(id).cloned().ok_or_else(|| format!("unknown workspace root: {id}"))
    }

    /// Whether a canonical `path` lies inside an opened root (compared by component, so
    /// `/a/bc` is not inside `/a/b`).
    pub fn contains(&self, path: &Path) -> bool {
        lock(&self.roots).values().any(|root| path.starts_with(&root.path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_open_cancels_the_older_scan_in_its_group_only() {
        let workspaces = Workspaces::default();
        let first = workspaces.begin_open("main");
        let other_window = workspaces.begin_open("second");
        let second = workspaces.begin_open("main");
        assert!(first.load(Ordering::Relaxed), "older scan in the same window is cancelled");
        assert!(!second.load(Ordering::Relaxed));
        assert!(!other_window.load(Ordering::Relaxed), "another window's scan keeps going");

        workspaces.end_open("main", &first); // late finish of the cancelled open
        assert!(lock(&workspaces.opening).contains_key("main"), "doesn't forget the newer one");
        workspaces.end_open("main", &second);
        assert!(!lock(&workspaces.opening).contains_key("main"));
    }

    #[test]
    fn a_cancelled_open_fails_as_superseded_and_registers_nothing() {
        let base = std::env::temp_dir().join(format!("brama-superseded-{}", std::process::id()));
        std::fs::create_dir_all(base.join("src")).unwrap();
        let workspaces = Workspaces::default();
        let err = workspaces.open_with(&base, &AtomicBool::new(true), |_, _| {}).err();
        assert_eq!(err.as_deref(), Some(SUPERSEDED));
        assert!(!workspaces.contains(&dunce::canonicalize(&base).unwrap().join("src")));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn checked_rel_rejects_paths_leaving_the_root() {
        for ok in ["a.txt", "src/main.rs", ".gitignore", "a/.git-keep", "dir with space/ф.txt"] {
            assert_eq!(checked_rel(ok), Ok(ok), "{ok}");
        }
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a/", ".git/config", ".git", "a\\b", "C:\\x"] {
            assert!(checked_rel(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn contains_only_paths_inside_open_roots() {
        let base = std::env::temp_dir().join(format!("brama-contains-{}", std::process::id()));
        let root = base.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(base.join("proj-other")).unwrap();
        let workspaces = Workspaces::default();
        let opened = workspaces.open_with(&root, &AtomicBool::new(false), |_, _| {}).unwrap();

        assert!(workspaces.contains(&opened.path.join("src/main.rs")));
        assert!(!workspaces.contains(&opened.path.with_file_name("proj-other").join("x")));
        assert!(!workspaces.contains(Path::new("/etc/passwd")));

        workspaces.close(&opened.id);
        assert!(!workspaces.contains(&opened.path.join("src/main.rs")));
        std::fs::remove_dir_all(&base).unwrap();
    }
}
