//! Keeps a root's snapshot in sync with the disk and tells the frontend what changed.
//!
//! Event kinds from the OS are unreliable (FSEvents merges them, renames arrive as two
//! unrelated paths, editors save via temp file + rename), so they are only used to learn
//! *which directories* to look at; the snapshot then re-reads those directories from disk.

use std::collections::BTreeSet;
use std::sync::{Arc, Weak};
use std::time::Duration;

use notify_debouncer_full::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};

use super::snapshot::{parent_of, Changes, Snapshot};
use super::Root;

const DEBOUNCE: Duration = Duration::from_millis(150);
/// Files whose change can flip the ignore status of anything below them.
const IGNORE_FILES: &[&str] = &[".gitignore", ".ignore"];

/// Watches the root recursively; `on_change` runs on the debouncer thread after each batch
/// that changed the snapshot.
pub fn start(
    root: &Arc<Root>,
    on_change: impl Fn(&Root, Changes) + Send + 'static,
) -> Result<Debouncer<RecommendedWatcher, NoCache>, String> {
    let weak: Weak<Root> = Arc::downgrade(root);
    // NoCache: we never match renames by file id, and the default cache would walk
    // the whole tree (node_modules included) up front.
    let mut debouncer = new_debouncer_opt(
        DEBOUNCE,
        None,
        move |result: DebounceEventResult| {
            let Some(root) = weak.upgrade() else { return };
            let events = match result {
                Ok(events) => events,
                Err(errors) => {
                    tracing::warn!(path = %root.path.display(), ?errors, "watcher errors");
                    return;
                }
            };
            let changes = apply(&root, &events);
            if !changes.is_empty() {
                on_change(&root, changes);
            }
        },
        NoCache,
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    debouncer
        .watch(&root.path, RecursiveMode::Recursive)
        .map_err(|e| format!("{}: {e}", root.path.display()))?;
    Ok(debouncer)
}

fn apply(root: &Root, events: &[notify_debouncer_full::DebouncedEvent]) -> Changes {
    let mut changes = Changes::default();
    let mut full_rescan = false;
    let mut dirs = BTreeSet::new();
    {
        let snapshot = root.read();
        for event in events {
            if event.need_rescan() {
                full_rescan = true;
            }
            for path in &event.paths {
                let Some(rel) = snapshot.rel(path) else { continue };
                if let Some(inner) = rel.strip_prefix(".git/").or((rel == ".git").then_some("")) {
                    changes.git |= is_repo_state(inner);
                    // Ignore rules for the whole tree, like a `.gitignore` at the root.
                    full_rescan |= inner == "info/exclude";
                    continue;
                }
                if path.file_name().is_some_and(|n| IGNORE_FILES.iter().any(|f| n == *f)) {
                    full_rescan = true;
                }
                if rel.is_empty() {
                    dirs.insert(rel);
                    continue;
                }
                // The parent learns about adds/removes/renames; a loaded dir also re-reads itself
                // (FSEvents sometimes reports only the directory).
                if snapshot.is_loaded(&rel) {
                    dirs.insert(rel.clone());
                }
                dirs.insert(parent_of(&rel).to_owned());
            }
        }
    }

    if full_rescan {
        // Scan without holding the lock, so the tree and Quick Open keep answering. A root closed
        // meanwhile stops the scan: nobody will read the result.
        let Some(fresh) = Snapshot::scan_until(&root.path, &root.closed) else { return changes };
        root.write().replace_with(fresh, &mut changes);
    } else if !dirs.is_empty() {
        root.write().reconcile(dirs, &mut changes);
    }
    // After the disk changed, before anyone hears of it: a result cached at an older epoch may
    // predate this batch. Changes inside ignored folders (a build's output) leave it alone, as git
    // ignores them too. Lost events (`full_rescan`) may have hidden anything.
    if full_rescan || !changes.is_empty() {
        root.bump_epoch();
    }
    changes
}

/// Whether a path inside `.git` (`""` for the directory itself, which FSEvents sometimes
/// reports alone) holds state that branch or status depend on (`info/exclude`: which files are
/// untracked). Lock files, objects and logs don't: a write lands as a rename onto the real name,
/// which matches here.
fn is_repo_state(inner: &str) -> bool {
    matches!(
        inner,
        "" | "HEAD" | "index" | "packed-refs" | "MERGE_HEAD" | "REBASE_HEAD" | "CHERRY_PICK_HEAD" | "info/exclude"
    )
        || (inner.starts_with("refs/") && !inner.ends_with(".lock"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::mpsc;

    use super::*;

    #[test]
    fn repo_state_paths() {
        for yes in ["", "HEAD", "index", "packed-refs", "refs/heads/main", "refs/remotes/origin/main", "MERGE_HEAD", "info/exclude"] {
            assert!(is_repo_state(yes), "{yes}");
        }
        for no in ["index.lock", "refs/heads/main.lock", "objects/ab/cdef", "logs/HEAD", "COMMIT_EDITMSG", "FETCH_HEAD"] {
            assert!(!is_repo_state(no), "{no}");
        }
    }
    use crate::workspace::Workspaces;

    /// Waits for a batch that satisfies `pred`, skipping unrelated ones.
    fn wait_for(rx: &mpsc::Receiver<Changes>, pred: impl Fn(&Changes) -> bool) -> Changes {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let changes = rx.recv_timeout(left).expect("no matching change within 5s");
            if pred(&changes) {
                return changes;
            }
        }
    }

    #[test]
    fn external_changes_reach_the_snapshot() {
        let dir = std::env::temp_dir().join(format!("brama-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join(".gitignore"), "*.log\n").unwrap();
        let (tx, rx) = mpsc::channel();
        let workspaces = Workspaces::default();
        let root = workspaces
            .open_with(&dir, "main", &std::sync::atomic::AtomicBool::new(false), move |_, changes| tx.send(changes).unwrap())
            .unwrap();
        let has = |path: &str| root.read().files().any(|e| e.path == path);

        fs::write(dir.join("src/new.rs"), "").unwrap();
        wait_for(&rx, |c| c.added.contains(&"src/new.rs".to_owned()));
        assert!(has("src/new.rs"));

        fs::rename(dir.join("src/new.rs"), dir.join("src/renamed.rs")).unwrap();
        wait_for(&rx, |c| c.added.contains(&"src/renamed.rs".to_owned()));
        assert!(!has("src/new.rs") && has("src/renamed.rs"));

        fs::write(dir.join("src/renamed.rs"), "changed").unwrap();
        wait_for(&rx, |c| c.modified.contains(&"src/renamed.rs".to_owned()));

        fs::write(dir.join("debug.log"), "").unwrap();
        wait_for(&rx, |c| c.added.contains(&"debug.log".to_owned()));
        assert!(!has("debug.log"), "ignored files are not searchable");

        fs::remove_file(dir.join("src/renamed.rs")).unwrap();
        wait_for(&rx, |c| c.removed.contains(&"src/renamed.rs".to_owned()));
        assert!(!has("src/renamed.rs"));

        fs::create_dir_all(dir.join(".git/refs/heads")).unwrap();
        fs::write(dir.join(".git/refs/heads/main"), "0000\n").unwrap();
        let git = wait_for(&rx, |c| c.git);
        assert!(git.added.is_empty() && git.dirs.is_empty(), ".git stays out of the tree");

        workspaces.close(&root.id);
        fs::remove_dir_all(dir).unwrap();
    }
}
