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
use std::time::Instant;

use notify_debouncer_full::notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, NoCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::git::cache::GitCache;
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

/// `.brama/agents.json` changed on disk: the project's agent list is re-read, and windows hear
/// of it when it differs.
fn agents_changed(app: &AppHandle, project: &Path) {
    use tauri::Manager;
    let Some(configs) = app.try_state::<crate::config::AgentConfigs>() else { return };
    if configs.reload(project) {
        crate::commands::agents::emit_changed(app, Some(project));
    }
}

pub struct Root {
    pub id: String,
    pub path: PathBuf,
    /// The window that opened it; its roots close with it.
    group: String,
    /// A worktree session's folder for the Files tree, not a project: its `.brama/` configures nothing.
    session: bool,
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
    /// Bumped by the watcher after every batch that changed something (or lost events): a cached
    /// result computed at an older epoch may be out of date.
    change_epoch: AtomicU64,
    /// Branch and status, validated against `change_epoch` before reuse.
    pub git: GitCache,
}

impl Root {
    pub fn read(&self) -> std::sync::RwLockReadGuard<'_, Snapshot> {
        self.snapshot.read().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn write(&self) -> std::sync::RwLockWriteGuard<'_, Snapshot> {
        self.snapshot.write().unwrap_or_else(PoisonError::into_inner)
    }

    /// Read before computing anything cached against it, so a change meanwhile invalidates the result.
    pub fn epoch(&self) -> u64 {
        self.change_epoch.load(Ordering::SeqCst)
    }

    fn bump_epoch(&self) {
        self.change_epoch.fetch_add(1, Ordering::SeqCst);
    }

    pub fn note_opened(&self, rel: String) {
        let mut recent = lock(&self.recent);
        recent.retain(|p| p != &rel);
        recent.push_front(rel);
        recent.truncate(quick_open::RECENT_CAPACITY);
    }

    pub fn quick_open(&self, query: &str, dirs: bool) -> Option<Vec<quick_open::QuickOpenItem>> {
        let generation = self.quick_open_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let recent: Vec<String> = lock(&self.recent).iter().cloned().collect();
        let snapshot = self.read();
        quick_open::search(&snapshot, &recent, query, dirs, || {
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

/// Cancel key of a window's session-root scans, apart from its project scans.
fn session_key(group: &str) -> String {
    format!("{group}:session")
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
        let result = self.open_with(path, group, &cancel, false, move |root, changes| {
            if changes.config {
                agents_changed(&app, &root.path);
            }
            let _ = app.emit(CHANGED_EVENT, ChangedPayload { root_id: &root.id, changes });
        });
        self.end_open(group, &cancel);
        result
    }

    /// Opens a worktree session's folder for the Files tree, in `group` so it closes with the
    /// window. Its scan has its own cancel key: it neither cancels nor is cancelled by a project's.
    /// Its `.brama/agents.json` is the branch's copy, so a change there reloads no agents. Blocking.
    pub fn open_session(&self, app: AppHandle, path: &Path, group: &str) -> Result<Arc<Root>, String> {
        let key = session_key(group);
        let cancel = self.begin_open(&key);
        let result = self.open_with(path, group, &cancel, true, move |root, changes| {
            let _ = app.emit(CHANGED_EVENT, ChangedPayload { root_id: &root.id, changes });
        });
        self.end_open(&key, &cancel);
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
        group: &str,
        cancel: &AtomicBool,
        session: bool,
        on_change: impl Fn(&Root, Changes) + Send + 'static,
    ) -> Result<Arc<Root>, String> {
        // FSEvents reports canonical paths (e.g. /private/var), so the root must be canonical too.
        // `dunce` keeps it a plain `C:\…` on Windows: relative paths are joined to it with `/`.
        let path = dunce::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if !path.is_dir() {
            return Err(format!("{}: not a directory", path.display()));
        }
        let started = Instant::now();
        let Some(snapshot) = Snapshot::scan_until(&path, cancel) else {
            tracing::debug!(path = %path.display(), "scan superseded");
            return Err(SUPERSEDED.to_owned());
        };
        tracing::info!(
            path = %path.display(),
            files = snapshot.files().count(),
            elapsed = ?started.elapsed(),
            "scanned root"
        );
        let id = format!("root-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let root = Arc::new(Root {
            id: id.clone(),
            snapshot: RwLock::new(snapshot),
            path,
            group: group.to_owned(),
            session,
            watcher: Mutex::new(None),
            recent: Mutex::new(VecDeque::new()),
            quick_open_generation: AtomicU64::new(0),
            search_cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
            closed: AtomicBool::new(false),
            change_epoch: AtomicU64::new(0),
            git: GitCache::default(),
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

    /// Closes every root a window opened: when it closes, or when its page loads again and the
    /// frontend no longer knows them.
    pub fn close_group(&self, group: &str) {
        let ids: Vec<String> =
            lock(&self.roots).values().filter(|root| root.group == group).map(|root| root.id.clone()).collect();
        for id in ids {
            self.close(&id);
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

    /// Whether a canonical `path` lies inside an opened project, a session root left out.
    pub fn contains_project(&self, path: &Path) -> bool {
        lock(&self.roots).values().any(|root| !root.session && path.starts_with(&root.path))
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
    fn a_session_roots_scan_and_the_projects_dont_cancel_each_other() {
        let workspaces = Workspaces::default();
        let project = workspaces.begin_open("main");
        let session = workspaces.begin_open(&session_key("main"));
        assert!(!project.load(Ordering::Relaxed));
        let newer = workspaces.begin_open(&session_key("main"));
        assert!(session.load(Ordering::Relaxed), "a newer session root cancels the older one");
        assert!(!project.load(Ordering::Relaxed) && !newer.load(Ordering::Relaxed));
    }

    #[test]
    fn a_cancelled_open_fails_as_superseded_and_registers_nothing() {
        let base = std::env::temp_dir().join(format!("brama-superseded-{}", std::process::id()));
        std::fs::create_dir_all(base.join("src")).unwrap();
        let workspaces = Workspaces::default();
        let err = workspaces.open_with(&base, "main", &AtomicBool::new(true), false, |_, _| {}).err();
        assert_eq!(err.as_deref(), Some(SUPERSEDED));
        assert!(!workspaces.contains(&dunce::canonicalize(&base).unwrap().join("src")));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_session_root_is_no_project() {
        let base = std::env::temp_dir().join(format!("brama-session-root-{}", std::process::id()));
        std::fs::create_dir_all(base.join("proj")).unwrap();
        std::fs::create_dir_all(base.join("worktree")).unwrap();
        let workspaces = Workspaces::default();
        let project = workspaces.open_with(&base.join("proj"), "main", &AtomicBool::new(false), false, |_, _| {}).unwrap();
        let session = workspaces.open_with(&base.join("worktree"), "main", &AtomicBool::new(false), true, |_, _| {}).unwrap();

        let agents = |root: &Root| root.path.join(".brama/agents.json");
        assert!(workspaces.contains_project(&agents(&project)));
        assert!(workspaces.contains(&agents(&session)), "its files are readable");
        assert!(!workspaces.contains_project(&agents(&session)), "but it isn't a project");
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
        let opened = workspaces.open_with(&root, "main", &AtomicBool::new(false), false, |_, _| {}).unwrap();

        assert!(workspaces.contains(&opened.path.join("src/main.rs")));
        assert!(!workspaces.contains(&opened.path.with_file_name("proj-other").join("x")));
        assert!(!workspaces.contains(Path::new("/etc/passwd")));

        workspaces.close(&opened.id);
        assert!(!workspaces.contains(&opened.path.join("src/main.rs")));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn closing_a_window_closes_only_its_roots() {
        let base = std::env::temp_dir().join(format!("brama-group-{}", std::process::id()));
        std::fs::create_dir_all(base.join("a")).unwrap();
        std::fs::create_dir_all(base.join("b")).unwrap();
        let workspaces = Workspaces::default();
        let open = |dir: &str, group: &str| {
            workspaces.open_with(&base.join(dir), group, &AtomicBool::new(false), false, |_, _| {}).unwrap()
        };
        let (a1, b1, a2) = (open("a", "main"), open("b", "main"), open("a", "second"));

        workspaces.close_group("main");
        assert!(workspaces.get(&a1.id).is_err() && workspaces.get(&b1.id).is_err());
        assert!(a1.closed.load(Ordering::Relaxed), "its watcher rescans stop too");
        assert!(workspaces.get(&a2.id).is_ok(), "another window's root stays open");
        workspaces.close_group("second");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
