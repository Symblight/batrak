//! In-memory list of every entry under a root, kept in sync with the disk.
//!
//! Paths are relative to the root and always `/`-separated; the root itself is `""`.
//! Directories that are not ignored are scanned up front. Ignored directories
//! (`node_modules`, `target`, ...) are listed but loaded one level at a time, on demand.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub ignored: bool,
    /// Backend only, like `mtime`: Find in Files skips big files, and both tell a modified file.
    #[serde(skip)]
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    #[serde(skip)]
    pub mtime: u64,
}

/// What a batch of disk changes did to the snapshot.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    /// Directories whose child list changed (the tree reloads these).
    pub dirs: BTreeSet<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub modified: Vec<String>,
    /// The repository's state (HEAD, index, refs) changed: branch or status may differ even
    /// with no file in the tree touched, e.g. after a commit.
    pub git: bool,
    /// `.brama/agents.json` may have changed: the agent list is re-read. Not sent.
    #[serde(skip)]
    pub config: bool,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.dirs.is_empty()
            && self.added.is_empty()
            && self.removed.is_empty()
            && self.modified.is_empty()
            && !self.git
            && !self.config
    }
}

pub struct Snapshot {
    root: PathBuf,
    entries: HashMap<String, Entry>,
    /// Child paths of each *loaded* directory. A directory missing here has not been read yet.
    children: HashMap<String, BTreeSet<String>>,
}

/// One directory as read from disk: its path and its children.
type Listing = (String, Vec<Entry>);

impl Snapshot {
    /// Scans the whole root. Blocking; runs the walk on all cores.
    #[cfg(test)]
    pub fn scan(root: &Path) -> Snapshot {
        Self::scan_until(root, &NEVER).expect("a scan that is never cancelled completes")
    }

    /// Scans the whole root, stopping early with `None` once `cancel` turns true. Blocking; runs
    /// the walk on all cores.
    pub fn scan_until(root: &Path, cancel: &AtomicBool) -> Option<Snapshot> {
        let mut snapshot = Snapshot {
            root: root.to_path_buf(),
            entries: HashMap::new(),
            children: HashMap::new(),
        };
        for listing in scan_subtree(root, "", cancel)? {
            snapshot.apply_listing(listing);
        }
        Some(snapshot)
    }

    pub fn abs(&self, rel: &str) -> PathBuf {
        if rel.is_empty() {
            self.root.clone()
        } else {
            self.root.join(rel)
        }
    }

    /// Converts an absolute path under the root to a relative one.
    pub fn rel(&self, abs: &Path) -> Option<String> {
        let rel = abs.strip_prefix(&self.root).ok()?;
        let parts: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect();
        Some(parts.join("/"))
    }

    /// Files that take part in Quick Open and Find in Files: not ignored.
    pub fn files(&self) -> impl Iterator<Item = &Entry> {
        self.entries.values().filter(|e| !e.is_dir && !e.ignored)
    }

    /// `files()` plus the folders (not ignored, not the root), for `@` mentions.
    pub fn files_and_dirs(&self) -> impl Iterator<Item = &Entry> {
        self.entries.values().filter(|e| !e.ignored && !e.path.is_empty())
    }

    pub fn get(&self, rel: &str) -> Option<&Entry> {
        self.entries.get(rel)
    }

    pub fn is_loaded(&self, rel: &str) -> bool {
        self.children.contains_key(rel)
    }

    /// Children of a directory: folders first, then files, by name.
    /// Returns `None` when the directory is not loaded; see [`Snapshot::load_ignored_dir`].
    pub fn list_dir(&self, rel: &str) -> Option<Vec<Entry>> {
        let children = self.children.get(rel)?;
        let mut entries: Vec<Entry> = children.iter().filter_map(|p| self.entries.get(p)).cloned().collect();
        entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
        Some(entries)
    }

    /// Reads one level of an ignored directory that was never scanned.
    pub fn load_ignored_dir(&mut self, rel: &str) -> Result<(), String> {
        match self.entries.get(rel) {
            Some(e) if e.is_dir => {}
            _ => return Err(format!("{rel}: not a directory in the root")),
        }
        let abs = self.abs(rel);
        let entries = read_children(&abs, rel, &HashSet::new()).map_err(|e| format!("{}: {e}", abs.display()))?;
        self.apply_listing((rel.to_owned(), entries));
        Ok(())
    }

    /// Re-reads the given directories from disk (one level each) and patches the snapshot.
    /// New non-ignored subdirectories are scanned whole.
    pub fn reconcile(&mut self, dirs: impl IntoIterator<Item = String>, changes: &mut Changes) {
        let mut dirs: Vec<String> = dirs.into_iter().collect();
        // Parents first, so a removed parent drops its subtree before we look inside it.
        dirs.sort_by_key(|d| (d.matches('/').count() + usize::from(!d.is_empty()), d.clone()));
        dirs.dedup();
        for dir in dirs {
            self.reconcile_dir(&dir, changes);
        }
    }

    fn reconcile_dir(&mut self, rel: &str, changes: &mut Changes) {
        let Some(old_children) = self.children.get(rel).cloned() else {
            return; // never loaded, or removed earlier in this batch
        };
        let abs = self.abs(rel);
        let ignored_dir = self.entries.get(rel).is_some_and(|e| e.ignored);
        let not_ignored = if ignored_dir { HashSet::new() } else { not_ignored_children(&abs) };
        let Ok(fresh) = read_children(&abs, rel, &not_ignored) else {
            return; // gone; the parent's reconcile removes it
        };
        let fresh_paths: BTreeSet<String> = fresh.iter().map(|e| e.path.clone()).collect();

        for path in old_children.difference(&fresh_paths) {
            self.remove_subtree(path);
            changes.removed.push(path.clone());
            changes.dirs.insert(rel.to_owned());
        }
        for entry in fresh {
            match self.entries.get(&entry.path) {
                None => {
                    changes.added.push(entry.path.clone());
                    changes.dirs.insert(rel.to_owned());
                    self.insert_new(entry);
                }
                Some(old) if old.is_dir != entry.is_dir || old.ignored != entry.ignored => {
                    // Kind or ignore status flipped: treat as remove + add.
                    self.remove_subtree(&entry.path);
                    changes.removed.push(entry.path.clone());
                    changes.added.push(entry.path.clone());
                    changes.dirs.insert(rel.to_owned());
                    self.insert_new(entry);
                }
                Some(old) if !entry.is_dir && (old.size != entry.size || old.mtime != entry.mtime) => {
                    changes.modified.push(entry.path.clone());
                    self.entries.insert(entry.path.clone(), entry);
                }
                Some(_) => {}
            }
        }
    }

    /// Diffs a fresh full scan against this snapshot, then becomes it.
    pub fn replace_with(&mut self, mut fresh: Snapshot, changes: &mut Changes) {
        // A full scan doesn't enter ignored folders: load again the ones the tree loaded (one level
        // each, parents first), so their files aren't reported removed.
        let mut loaded: Vec<&String> =
            self.children.keys().filter(|dir| self.entries.get(*dir).is_some_and(|e| e.ignored)).collect();
        loaded.sort_by_key(|dir| dir.matches('/').count());
        for dir in loaded {
            let still = fresh.entries.get(dir).is_some_and(|e| e.is_dir && e.ignored);
            if still && fresh.is_loaded(parent_of(dir)) && !fresh.is_loaded(dir) {
                let _ = fresh.load_ignored_dir(dir);
            }
        }
        for (path, old) in &self.entries {
            match fresh.entries.get(path) {
                None => {
                    // Children of lazily loaded ignored dirs vanish from a full scan; the tree
                    // reloads their parent and loads them again on demand.
                    changes.removed.push(path.clone());
                    changes.dirs.insert(parent_of(path).to_owned());
                }
                Some(new) if new.is_dir != old.is_dir || new.ignored != old.ignored => {
                    changes.dirs.insert(parent_of(path).to_owned());
                }
                Some(new) if !new.is_dir && (new.size != old.size || new.mtime != old.mtime) => {
                    changes.modified.push(path.clone());
                }
                Some(_) => {}
            }
        }
        for path in fresh.entries.keys() {
            if !self.entries.contains_key(path) {
                changes.added.push(path.clone());
                changes.dirs.insert(parent_of(path).to_owned());
            }
        }
        *self = fresh;
    }

    fn insert_new(&mut self, entry: Entry) {
        let path = entry.path.clone();
        let scan = entry.is_dir && !entry.ignored;
        self.children.entry(parent_of(&path).to_owned()).or_default().insert(path.clone());
        self.entries.insert(path.clone(), entry);
        if scan {
            for listing in scan_subtree(&self.root, &path, &NEVER).unwrap_or_default() {
                self.apply_listing(listing);
            }
        }
    }

    fn remove_subtree(&mut self, rel: &str) {
        if let Some(children) = self.children.remove(rel) {
            for child in children {
                self.remove_subtree(&child);
            }
        }
        self.entries.remove(rel);
        if let Some(siblings) = self.children.get_mut(parent_of(rel)) {
            siblings.remove(rel);
        }
    }

    fn apply_listing(&mut self, (dir, entries): Listing) {
        let paths = entries.iter().map(|e| e.path.clone()).collect();
        for entry in entries {
            self.entries.insert(entry.path.clone(), entry);
        }
        self.children.insert(dir, paths);
    }
}

pub fn parent_of(rel: &str) -> &str {
    rel.rfind('/').map_or("", |i| &rel[..i])
}

fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}

/// Walker with the project's ignore rules: .gitignore, .ignore, global gitignore, .git/info/exclude.
/// Hidden files are kept; `.git` itself is never entered.
fn walker(dir: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(dir);
    builder
        .hidden(false)
        .parents(true)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| e.file_name() != ".git" && !is_brama_local(e.path()));
    builder
}

/// `.brama/local/`: per-user app state, never part of the tree or a search.
fn is_brama_local(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n == crate::config::LOCAL_DIR)
        && path.parent().and_then(Path::file_name).is_some_and(|n| n == crate::config::DIR)
}

/// Names of a directory's direct children that the ignore rules keep.
fn not_ignored_children(dir: &Path) -> HashSet<String> {
    walker(dir)
        .max_depth(Some(1))
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.depth() == 1)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

/// Reads one directory level. A child is ignored unless its name is in `not_ignored`.
/// Symlinks are left out: the only place entries come from, so the tree, Quick Open and Find in Files
/// never show one, and the scan cannot loop.
fn read_children(abs: &Path, rel: &str, not_ignored: &HashSet<String>) -> std::io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(abs)? {
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        if name == ".git" || is_brama_local(&abs.join(&name)) {
            continue;
        }
        let Ok(meta) = item.metadata() else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        entries.push(Entry {
            path: join(rel, &name),
            ignored: !not_ignored.contains(&name),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime,
            name,
        });
    }
    Ok(entries)
}

/// Cancel flag of scans nobody cancels.
static NEVER: AtomicBool = AtomicBool::new(false);

/// Parallel scan of a non-ignored directory: one listing per non-ignored directory in it,
/// with ignored children marked but not descended into. `None` when `cancel` turned true
/// midway; both the walk and the per-directory reads check it.
fn scan_subtree(root: &Path, rel: &str, cancel: &AtomicBool) -> Option<Vec<Listing>> {
    let start = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    // Every path the walker keeps, grouped by parent; each thread buffers locally.
    let kept: Arc<Mutex<Vec<(PathBuf, bool)>>> = Arc::default();

    struct Buffer {
        items: Vec<(PathBuf, bool)>,
        out: Arc<Mutex<Vec<(PathBuf, bool)>>>,
    }
    impl Drop for Buffer {
        fn drop(&mut self) {
            self.out.lock().unwrap_or_else(PoisonError::into_inner).append(&mut self.items);
        }
    }

    walker(&start).build_parallel().run(|| {
        let mut buffer = Buffer { items: Vec::new(), out: Arc::clone(&kept) };
        Box::new(move |result| {
            if cancel.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            if let Ok(entry) = result {
                let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
                buffer.items.push((entry.into_path(), is_dir));
            }
            WalkState::Continue
        })
    });

    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let kept = std::mem::take(&mut *kept.lock().unwrap_or_else(PoisonError::into_inner));
    let mut kept_names: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    let mut dirs = Vec::new();
    for (path, is_dir) in kept {
        if is_dir {
            dirs.push(path.clone());
        }
        if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
            kept_names
                .entry(parent.to_path_buf())
                .or_default()
                .insert(name.to_string_lossy().into_owned());
        }
    }

    let empty = HashSet::new();
    let listings = dirs
        .iter()
        .take_while(|_| !cancel.load(Ordering::Relaxed))
        .filter_map(|dir| {
            let rel_dir = dir.strip_prefix(root).ok()?;
            let rel_dir: Vec<_> = rel_dir.components().map(|c| c.as_os_str().to_string_lossy()).collect();
            let rel_dir = rel_dir.join("/");
            let names = kept_names.get(dir).unwrap_or(&empty);
            read_children(dir, &rel_dir, names).ok().map(|entries| (rel_dir, entries))
        })
        .collect();
    (!cancel.load(Ordering::Relaxed)).then_some(listings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brama-snapshot-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".gitignore"), "node_modules\n*.log\n").unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(dir.join("debug.log"), "x").unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "x").unwrap();
        dir
    }

    #[test]
    fn scan_marks_ignored_and_skips_git() {
        let root = temp_root("scan");
        let snap = Snapshot::scan(&root);
        let top: Vec<_> = snap.list_dir("").unwrap().into_iter().map(|e| (e.name, e.ignored)).collect();
        assert_eq!(
            top,
            vec![
                ("node_modules".into(), true),
                ("src".into(), false),
                (".gitignore".into(), false),
                ("debug.log".into(), true),
            ]
        );
        assert!(!snap.is_loaded("node_modules"));
        let files: Vec<_> = snap.files().map(|e| e.path.as_str()).collect();
        assert!(files.contains(&"src/main.rs"));
        assert!(!files.contains(&"debug.log"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_listing_sends_the_page_only_what_the_tree_shows() {
        let entry = Entry {
            name: "a.rs".into(),
            path: "src/a.rs".into(),
            is_dir: false,
            ignored: false,
            size: 5,
            mtime: 7,
        };
        let sent = serde_json::to_value(&entry).unwrap();
        assert_eq!(sent, serde_json::json!({ "name": "a.rs", "path": "src/a.rs", "isDir": false, "ignored": false }));
    }

    #[test]
    fn a_listing_has_folders_first_then_names_ignoring_case() {
        let root = temp_root("list-order");
        fs::create_dir_all(root.join("sub/Zeta")).unwrap();
        fs::create_dir_all(root.join("sub/alpha")).unwrap();
        for name in ["b.txt", "A.txt", "C.txt"] {
            fs::write(root.join("sub").join(name), "").unwrap();
        }
        let snap = Snapshot::scan(&root);
        let names: Vec<_> = snap.list_dir("sub").unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["alpha", "Zeta", "A.txt", "b.txt", "C.txt"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_hidden_wherever_a_folder_is_read() {
        use std::os::unix::fs::symlink;
        let link_all = |dir: &Path| {
            symlink(dir.join("real.txt"), dir.join("to-file")).unwrap();
            symlink(dir.join("real-dir"), dir.join("to-dir")).unwrap();
            symlink(dir.join("nothing"), dir.join("dangling")).unwrap();
        };
        let names = |snap: &Snapshot, rel: &str| -> Vec<String> {
            snap.list_dir(rel).unwrap().into_iter().map(|e| e.name).collect()
        };
        let root = temp_root("symlinks");
        for dir in ["src", "node_modules/pkg"] {
            fs::write(root.join(dir).join("real.txt"), "").unwrap();
            fs::create_dir_all(root.join(dir).join("real-dir")).unwrap();
        }
        link_all(&root.join("src"));
        link_all(&root.join("node_modules/pkg"));

        let mut snap = Snapshot::scan(&root);
        assert_eq!(names(&snap, "src"), ["real-dir", "main.rs", "real.txt"], "a scan");
        assert!(snap.files().all(|e| !e.path.contains("to-")), "Quick Open and Find in Files");

        snap.load_ignored_dir("node_modules").unwrap();
        snap.load_ignored_dir("node_modules/pkg").unwrap();
        assert_eq!(names(&snap, "node_modules/pkg"), ["real-dir", "index.js", "real.txt"], "an ignored folder");

        symlink(root.join("src/real.txt"), root.join("src/new-link")).unwrap();
        fs::write(root.join("src/new.txt"), "").unwrap();
        let mut changes = Changes::default();
        snap.reconcile(["src".to_owned()], &mut changes);
        assert_eq!(changes.added, ["src/new.txt"], "a watcher batch");
        assert!(!names(&snap, "src").contains(&"new-link".to_owned()));

        fs::remove_file(root.join("src/new.txt")).unwrap();
        symlink(root.join("src/real.txt"), root.join("src/new.txt")).unwrap();
        let mut changes = Changes::default();
        snap.reconcile(["src".to_owned()], &mut changes);
        assert_eq!(changes.removed, ["src/new.txt"], "a file replaced by a link is gone");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn brama_local_is_left_out() {
        let root = temp_root("brama-local");
        crate::config::ensure_project_dir(&root).unwrap();
        fs::create_dir_all(root.join(".brama/local/state")).unwrap();
        fs::write(root.join(".brama/local/state/x.json"), "{}").unwrap();
        let mut snap = Snapshot::scan(&root);
        let brama: Vec<_> = snap.list_dir(".brama").unwrap().into_iter().map(|e| e.name).collect();
        assert!(brama.contains(&"agents.json".to_owned()));
        assert!(!brama.contains(&"local".to_owned()), "{brama:?}");
        assert!(snap.files().all(|e| !e.path.starts_with(".brama/local")));

        let mut changes = Changes::default();
        snap.reconcile(BTreeSet::from([".brama".to_owned()]), &mut changes);
        assert!(!changes.added.iter().any(|p| p.starts_with(".brama/local")), "{changes:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reconcile_picks_up_create_delete_rename() {
        let root = temp_root("reconcile");
        let mut snap = Snapshot::scan(&root);

        fs::write(root.join("src/lib.rs"), "").unwrap();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/nested/a.rs"), "").unwrap();
        let mut changes = Changes::default();
        snap.reconcile(["src".to_owned()], &mut changes);
        assert!(changes.added.contains(&"src/lib.rs".to_owned()));
        assert!(snap.files().any(|e| e.path == "src/nested/a.rs"));

        fs::rename(root.join("src/lib.rs"), root.join("src/core.rs")).unwrap();
        fs::remove_dir_all(root.join("src/nested")).unwrap();
        let mut changes = Changes::default();
        snap.reconcile(["src".to_owned()], &mut changes);
        assert!(changes.removed.contains(&"src/lib.rs".to_owned()));
        assert!(changes.added.contains(&"src/core.rs".to_owned()));
        assert!(!snap.files().any(|e| e.path.starts_with("src/nested")));
        assert_eq!(changes.dirs.iter().collect::<Vec<_>>(), vec!["src"]);

        snap.load_ignored_dir("node_modules").unwrap();
        assert_eq!(snap.list_dir("node_modules").unwrap()[0].name, "pkg");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_full_scan_keeps_the_ignored_folders_the_tree_loaded() {
        let root = temp_root("replace-ignored");
        fs::write(root.join("node_modules/pkg/gone.js"), "").unwrap();
        let mut snap = Snapshot::scan(&root);
        snap.load_ignored_dir("node_modules").unwrap();
        snap.load_ignored_dir("node_modules/pkg").unwrap();

        fs::write(root.join("node_modules/pkg/index.js"), "changed").unwrap();
        fs::remove_file(root.join("node_modules/pkg/gone.js")).unwrap();
        let mut changes = Changes::default();
        snap.replace_with(Snapshot::scan(&root), &mut changes);

        assert_eq!(changes.removed, ["node_modules/pkg/gone.js"], "only what left the disk");
        assert_eq!(changes.modified, ["node_modules/pkg/index.js"]);
        assert_eq!(snap.list_dir("node_modules/pkg").unwrap().len(), 1, "still loaded");

        fs::remove_dir_all(root.join("node_modules")).unwrap();
        let mut changes = Changes::default();
        snap.replace_with(Snapshot::scan(&root), &mut changes);
        assert!(changes.removed.contains(&"node_modules/pkg/index.js".to_owned()));
        assert!(!snap.is_loaded("node_modules"));
        fs::remove_dir_all(root).unwrap();
    }
}
