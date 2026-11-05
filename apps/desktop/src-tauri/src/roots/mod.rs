//! Root snapshots: one per opened root (a project, or a workspace's
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
pub const CHANGED_EVENT: &str = "roots://changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedPayload<'a> {
    root_id: &'a str,
    #[serde(flatten)]
    changes: Changes,
}

/// Locks ignoring poisoning: a panicked reader must not take the whole root down.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a root's change batches reach outside its snapshot.
pub trait Host: Send + Sync + 'static {
    /// `.bt/agents.json` of a project changed on disk.
    fn agents_changed(&self, project: &Path);
    /// Files changed in a folder that chats run in: running local turns there that both changed one hear of it.
    fn files_changed(&self, folder: &Path, changed: &[String]);
    /// Tells the windows, as [`CHANGED_EVENT`].
    fn emit(&self, root_id: &str, changes: Changes);
}

impl Host for AppHandle {
    fn agents_changed(&self, project: &Path) {
        use tauri::Manager;
        let Some(configs) = self.try_state::<crate::config::AgentConfigs>() else { return };
        if configs.reload(project) {
            configs.announce(Some(project));
        }
    }

    fn files_changed(&self, folder: &Path, changed: &[String]) {
        use tauri::Manager;
        if let Some(sessions) = self.try_state::<crate::session::Sessions>() {
            sessions.note_changes(folder, changed);
        }
    }

    fn emit(&self, root_id: &str, changes: Changes) {
        let _ = Emitter::emit(self, CHANGED_EVENT, ChangedPayload { root_id, changes });
    }
}

/// A project's folder, or a workspace's: a workspace's `.bt/` is its branch's copy and configures nothing.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Project,
    Workspace,
}

impl Kind {
    /// Cancel key of a window's scans of this kind: a project's and a workspace's don't cancel each other.
    fn key(self, group: &str) -> String {
        match self {
            Kind::Project => group.to_owned(),
            Kind::Workspace => format!("{group}:workspace"),
        }
    }
}

/// Hands a batch to `host`: agents reload for a project, the folder's chats hear of the files, windows of it all.
fn hear(host: &impl Host, kind: Kind, root: &Root, changes: Changes) {
    if kind == Kind::Project && changes.config {
        host.agents_changed(&root.path);
    }
    let changed: Vec<String> = changes.added.iter().chain(&changes.modified).chain(&changes.removed).cloned().collect();
    if !changed.is_empty() {
        host.files_changed(&root.path, &changed);
    }
    host.emit(&root.id, changes);
}

/// Hears a root's changed snapshot, on the watcher's thread or a rescan's.
type OnChange = Box<dyn Fn(&Root, Changes) + Send + Sync>;

pub struct Root {
    pub id: String,
    pub path: PathBuf,
    /// The window that opened it; its roots close with it.
    group: String,
    kind: Kind,
    pub snapshot: RwLock<Snapshot>,
    /// Hears every batch that changed the snapshot: the watcher's and a `rescan`'s.
    on_change: OnChange,
    /// Held through a whole batch (scan, patch, `on_change`) by the watcher and by `rescan`, which
    /// run on different threads: a rescan's older scan must not replace what the watcher applied
    /// meanwhile, and batches reach `on_change` in order.
    batch: Mutex<()>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher, NoCache>>>,
    /// Most recent first, at most `quick_open::RECENT_CAPACITY`.
    recent: Mutex<VecDeque<String>>,
    /// Bumped by every Quick Open query; a running query stops when it is no longer current.
    quick_open_generation: AtomicU64,
    /// Cancel flag of the running Find in Files per slot (the Search pane's, the dialog's),
    /// replaced on every new search in that slot.
    search_cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Set by `Roots::close`; stops a watcher rescan still running for a closed root.
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

    pub fn quick_open(&self, query: &str, kind: quick_open::QuickOpenKind) -> Option<Vec<quick_open::QuickOpenItem>> {
        let generation = self.quick_open_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let recent: Vec<String> = lock(&self.recent).iter().cloned().collect();
        let snapshot = self.read();
        quick_open::search(&snapshot, &recent, query, kind, || {
            self.quick_open_generation.load(Ordering::Relaxed) != generation
        })
    }

    /// Cancels the running search of `slot` (if any) and returns the flag for a new one.
    pub fn start_search(&self, slot: &str) -> Arc<AtomicBool> {
        let fresh = Arc::new(AtomicBool::new(false));
        if let Some(previous) = lock(&self.search_cancel).insert(slot.to_owned(), Arc::clone(&fresh)) {
            previous.store(true, Ordering::Relaxed);
        }
        fresh
    }

    pub fn cancel_search(&self, slot: &str) {
        if let Some(cancel) = lock(&self.search_cancel).get(slot) {
            cancel.store(true, Ordering::Relaxed);
        }
    }

    fn cancel_all_searches(&self) {
        for cancel in lock(&self.search_cancel).values() {
            cancel.store(true, Ordering::Relaxed);
        }
    }

    /// Patches the snapshot from the given directories on disk, read with no lock held: a big batch
    /// (a checkout, a new folder scanned whole) doesn't stop the tree and Quick Open. Only the watcher
    /// calls it, under `batch`, so nothing else patches these directories in between. Blocking.
    fn reconcile(&self, dirs: impl IntoIterator<Item = String>, changes: &mut Changes) {
        let plan = self.read().plan(dirs);
        let readings = snapshot::read_planned(&self.path, plan, &self.closed);
        self.write().apply_readings(readings, changes);
    }

    /// Scans the whole root again (the Files column's Refresh), for changes the watcher missed,
    /// and reports them as the watcher would. Blocking.
    pub fn rescan(&self) {
        let _batch = lock(&self.batch);
        let Some(fresh) = Snapshot::scan_until(&self.path, &self.closed) else { return };
        let mut changes = Changes::default();
        self.write().replace_with(fresh, &mut changes);
        // Whatever was missed may have changed git's answers too.
        self.bump_epoch();
        if !changes.is_empty() {
            (self.on_change)(self, changes);
        }
    }
}

/// Error of an open whose scan was cancelled by a newer open in the same group.
pub const SUPERSEDED: &str = "superseded by a newer open";

/// All opened roots, by id. Cheap to clone.
#[derive(Clone, Default)]
pub struct Roots {
    roots: Arc<Mutex<HashMap<String, Arc<Root>>>>,
    next_id: Arc<AtomicU64>,
    /// Cancel flag of the scan in progress per group (a window): a newer open stops the older scan
    /// instead of letting both saturate the disk.
    opening: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Roots {
    /// Scans a project's folder and starts watching it; changes go to the frontend as [`CHANGED_EVENT`].
    /// A later open in the same `group` cancels this one's scan, which then fails with
    /// [`SUPERSEDED`]. Blocking: call off the main thread.
    pub fn open(&self, app: AppHandle, path: &Path, group: &str) -> Result<Arc<Root>, String> {
        self.open_kind(app, path, group, Kind::Project)
    }

    /// Opens a workspace's folder, in `group` so it closes with the window. Its scan neither cancels
    /// nor is cancelled by a project's. Blocking.
    pub fn open_workspace(&self, app: AppHandle, path: &Path, group: &str) -> Result<Arc<Root>, String> {
        self.open_kind(app, path, group, Kind::Workspace)
    }

    fn open_kind(&self, host: impl Host, path: &Path, group: &str, kind: Kind) -> Result<Arc<Root>, String> {
        let key = kind.key(group);
        let cancel = self.begin_open(&key);
        let result = self.open_with(path, group, &cancel, kind, move |root, changes| hear(&host, kind, root, changes));
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
        kind: Kind,
        on_change: impl Fn(&Root, Changes) + Send + Sync + 'static,
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
            on_change: Box::new(on_change),
            batch: Mutex::new(()),
            path,
            group: group.to_owned(),
            kind,
            watcher: Mutex::new(None),
            recent: Mutex::new(VecDeque::new()),
            quick_open_generation: AtomicU64::new(0),
            search_cancel: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            change_epoch: AtomicU64::new(0),
            git: GitCache::default(),
        });
        // Started after the scan: a change in between is picked up by the next event in that folder.
        let watcher = watcher::start(&root)?;
        *lock(&root.watcher) = Some(watcher);
        lock(&self.roots).insert(id, Arc::clone(&root));
        Ok(root)
    }

    pub fn close(&self, id: &str) {
        if let Some(root) = lock(&self.roots).remove(id) {
            root.closed.store(true, Ordering::Relaxed);
            root.cancel_all_searches();
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
        lock(&self.roots).get(id).cloned().ok_or_else(|| format!("unknown root: {id}"))
    }

    /// Whether a canonical `path` lies inside an opened root (compared by component, so
    /// `/a/bc` is not inside `/a/b`).
    pub fn contains(&self, path: &Path) -> bool {
        lock(&self.roots).values().any(|root| path.starts_with(&root.path))
    }

    /// Whether a canonical `path` lies inside an opened project, a workspace root left out.
    pub fn contains_project(&self, path: &Path) -> bool {
        lock(&self.roots).values().any(|root| root.kind == Kind::Project && path.starts_with(&root.path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_open_cancels_the_older_scan_in_its_group_only() {
        let roots = Roots::default();
        let first = roots.begin_open("main");
        let other_window = roots.begin_open("second");
        let second = roots.begin_open("main");
        assert!(first.load(Ordering::Relaxed), "older scan in the same window is cancelled");
        assert!(!second.load(Ordering::Relaxed));
        assert!(!other_window.load(Ordering::Relaxed), "another window's scan keeps going");

        roots.end_open("main", &first); // late finish of the cancelled open
        assert!(lock(&roots.opening).contains_key("main"), "doesn't forget the newer one");
        roots.end_open("main", &second);
        assert!(!lock(&roots.opening).contains_key("main"));
    }

    #[test]
    fn a_workspace_roots_scan_and_the_projects_dont_cancel_each_other() {
        let roots = Roots::default();
        let project = roots.begin_open(&Kind::Project.key("main"));
        let workspace = roots.begin_open(&Kind::Workspace.key("main"));
        assert!(!project.load(Ordering::Relaxed));
        let newer = roots.begin_open(&Kind::Workspace.key("main"));
        assert!(workspace.load(Ordering::Relaxed), "a newer workspace root cancels the older one");
        assert!(!project.load(Ordering::Relaxed) && !newer.load(Ordering::Relaxed));
    }

    /// Records what a root's change batches reach.
    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<String>>>);

    impl Host for Recorder {
        fn agents_changed(&self, project: &Path) {
            lock(&self.0).push(format!("agents {}", project.display()));
        }
        fn files_changed(&self, folder: &Path, changed: &[String]) {
            lock(&self.0).push(format!("files {} {}", folder.display(), changed.join(",")));
        }
        fn emit(&self, _root_id: &str, _changes: Changes) {}
    }

    #[test]
    fn a_workspace_roots_changes_reach_its_folders_chats_and_reload_no_agents() {
        let base = std::env::temp_dir().join(format!("batrak-workspace-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join(".bt")).unwrap();
        let host = Recorder::default();
        let roots = Roots::default();
        let root = roots.open_kind(host.clone(), &base, "main", Kind::Workspace).unwrap();

        std::fs::write(base.join(".bt/agents.json"), "{}").unwrap();

        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while lock(&host.0).is_empty() {
            assert!(Instant::now() < deadline, "the watcher's batch arrives");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let heard = lock(&host.0).clone();
        assert_eq!(heard, [format!("files {} .bt/agents.json", root.path.display())]);
        roots.close(&root.id);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_rescan_finds_what_the_watcher_missed_and_reports_it() {
        let base = std::env::temp_dir().join(format!("batrak-rescan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("src")).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let roots = Roots::default();
        let root =
            roots.open_with(&base, "main", &AtomicBool::new(false), Kind::Project, move |_, changes| tx.send(changes).unwrap()).unwrap();
        // No watcher: every change from here on is one it missed.
        lock(&root.watcher).take();
        std::fs::write(base.join("src/missed.rs"), "").unwrap();
        let epoch = root.epoch();

        root.rescan();

        assert!(root.read().files().any(|e| e.path == "src/missed.rs"));
        assert!(root.epoch() > epoch, "cached git state is computed again");
        let changes = rx.try_recv().expect("the rescan's changes are reported");
        assert_eq!(changes.added, ["src/missed.rs"]);
        assert!(changes.dirs.contains("src"));

        root.rescan();
        assert!(rx.try_recv().is_err(), "nothing changed, nothing reported");
        roots.close(&root.id);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_watcher_batch_waits_for_a_rescan_in_progress() {
        let base = std::env::temp_dir().join(format!("batrak-rescan-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("src")).unwrap();
        let rescanning = std::thread::current().id();
        let (tx, rx) = std::sync::mpsc::channel();
        let roots = Roots::default();
        let root = roots
            .open_with(&base, "main", &AtomicBool::new(false), Kind::Project, {
                let base = base.clone();
                move |root, _| {
                    if std::thread::current().id() != rescanning {
                        return;
                    }
                    // A change the watcher hears while the rescan is still reporting its own.
                    std::fs::write(base.join("src/during.rs"), "").unwrap();
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    tx.send(root.read().files().any(|e| e.path == "src/during.rs")).unwrap();
                }
            })
            .unwrap();
        std::fs::write(base.join("src/before.rs"), "").unwrap();

        root.rescan();

        assert!(!rx.try_recv().unwrap(), "the watcher's batch didn't patch the snapshot mid-rescan");
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while !root.read().files().any(|e| e.path == "src/during.rs") {
            assert!(Instant::now() < deadline, "the watcher's batch applies after the rescan");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        roots.close(&root.id);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_batch_reading_the_disk_keeps_the_snapshot_free() {
        let base = std::env::temp_dir().join(format!("batrak-batch-unlocked-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub")).unwrap();
        let roots = Roots::default();
        let root = roots.open_with(&base, "main", &AtomicBool::new(false), Kind::Project, |_, _| {}).unwrap();
        lock(&root.watcher).take();
        // The walk opens `.gitignore`, which waits here until something writes to the FIFO.
        let fifo = base.join("sub/.gitignore");
        assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
        std::fs::write(base.join("sub/new.rs"), "").unwrap();

        let batch = std::thread::spawn({
            let root = Arc::clone(&root);
            move || {
                let mut changes = Changes::default();
                root.reconcile(["sub".to_owned()], &mut changes);
                changes
            }
        });
        std::thread::sleep(std::time::Duration::from_millis(300));
        let free = root.snapshot.try_write().is_ok();
        std::fs::write(&fifo, "").unwrap(); // lets the batch go on, whatever the check said
        let changes = batch.join().unwrap();

        assert!(free, "the tree and Quick Open keep answering while the disk is read");
        assert!(changes.added.contains(&"sub/new.rs".to_owned()), "{changes:?}");
        assert!(root.read().get("sub/new.rs").is_some());
        roots.close(&root.id);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_cancelled_open_fails_as_superseded_and_registers_nothing() {
        let base = std::env::temp_dir().join(format!("batrak-superseded-{}", std::process::id()));
        std::fs::create_dir_all(base.join("src")).unwrap();
        let roots = Roots::default();
        let err = roots.open_with(&base, "main", &AtomicBool::new(true), Kind::Project, |_, _| {}).err();
        assert_eq!(err.as_deref(), Some(SUPERSEDED));
        assert!(!roots.contains(&dunce::canonicalize(&base).unwrap().join("src")));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_workspace_root_is_no_project() {
        let base = std::env::temp_dir().join(format!("batrak-workspace-root-{}", std::process::id()));
        std::fs::create_dir_all(base.join("proj")).unwrap();
        std::fs::create_dir_all(base.join("worktree")).unwrap();
        let roots = Roots::default();
        let project = roots.open_kind(Recorder::default(), &base.join("proj"), "main", Kind::Project).unwrap();
        let workspace = roots.open_kind(Recorder::default(), &base.join("worktree"), "main", Kind::Workspace).unwrap();

        let agents = |root: &Root| root.path.join(".bt/agents.json");
        assert!(roots.contains_project(&agents(&project)));
        assert!(roots.contains(&agents(&workspace)), "its files are readable");
        assert!(!roots.contains_project(&agents(&workspace)), "but it isn't a project");
        roots.close_group("main");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn search_slots_cancel_only_their_own() {
        let base = std::env::temp_dir().join(format!("batrak-search-slots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("a.txt"), "needle\n").unwrap();
        let roots = Roots::default();
        let root = roots.open_with(&base, "main", &AtomicBool::new(false), Kind::Project, |_, _| {}).unwrap();
        let done = |cancel: &AtomicBool| {
            let options = search::SearchOptions {
                query: "needle".into(),
                case_sensitive: false,
                whole_word: false,
                regex: false,
                include: String::new(),
                exclude: String::new(),
            };
            let cancelled = Mutex::new(None);
            search::run(&root.path, vec![("a.txt".into(), 7)], &options, cancel, &|event| {
                if let search::SearchEvent::Done { cancelled: c, .. } = event {
                    *lock(&cancelled) = Some(c);
                }
            });
            cancelled.into_inner().unwrap().unwrap()
        };

        let panel = root.start_search("panel");
        let dialog = root.start_search("dialog");
        root.cancel_search("panel");
        assert!(done(&panel), "the cancelled slot's search reports cancelled");
        assert!(!done(&dialog), "the other slot's search runs on");

        let dialog_again = root.start_search("dialog");
        assert!(dialog.load(Ordering::Relaxed), "a new search cancels its own slot's");
        let panel_again = root.start_search("panel");
        assert!(!dialog_again.load(Ordering::Relaxed));

        roots.close(&root.id);
        assert!(panel_again.load(Ordering::Relaxed) && dialog_again.load(Ordering::Relaxed), "closing cancels all");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn contains_only_paths_inside_open_roots() {
        let base = std::env::temp_dir().join(format!("batrak-contains-{}", std::process::id()));
        let root = base.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(base.join("proj-other")).unwrap();
        let roots = Roots::default();
        let opened = roots.open_with(&root, "main", &AtomicBool::new(false), Kind::Project, |_, _| {}).unwrap();

        assert!(roots.contains(&opened.path.join("src/main.rs")));
        assert!(!roots.contains(&opened.path.with_file_name("proj-other").join("x")));
        assert!(!roots.contains(Path::new("/etc/passwd")));

        roots.close(&opened.id);
        assert!(!roots.contains(&opened.path.join("src/main.rs")));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn closing_a_window_closes_only_its_roots() {
        let base = std::env::temp_dir().join(format!("batrak-group-{}", std::process::id()));
        std::fs::create_dir_all(base.join("a")).unwrap();
        std::fs::create_dir_all(base.join("b")).unwrap();
        let roots = Roots::default();
        let open = |dir: &str, group: &str| {
            roots.open_with(&base.join(dir), group, &AtomicBool::new(false), Kind::Project, |_, _| {}).unwrap()
        };
        let (a1, b1, a2) = (open("a", "main"), open("b", "main"), open("a", "second"));

        roots.close_group("main");
        assert!(roots.get(&a1.id).is_err() && roots.get(&b1.id).is_err());
        assert!(a1.closed.load(Ordering::Relaxed), "its watcher rescans stop too");
        assert!(roots.get(&a2.id).is_ok(), "another window's root stays open");
        roots.close_group("second");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
