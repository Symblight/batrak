//! Workspaces: a project's tasks (docs/specs/workspaces.md). A workspace has a name, its own git
//! worktree in app data on branch `brama/<slug>`, and chats (sessions) that run in its folder.
//! Main, the project's own folder, is not stored.

pub mod checkout;
mod store;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::git::exec::{self, Mode as GitMode};

use serde::{Deserialize, Serialize};

pub use store::Store;

/// Where a workspace's name comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NameSource {
    /// Its first chat's: the first message's line, then the agent's title.
    Agent,
    /// The user named it: chats no longer rename it.
    User,
}

/// A workspace as stored in `workspaces.json`. Folder, worktree and branch never change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    /// Canonical project root.
    pub project_path: PathBuf,
    pub name: String,
    pub name_source: NameSource,
    /// The project's folder in the worktree: its chats' cwd.
    pub folder: PathBuf,
    pub worktree_path: PathBuf,
    pub branch: String,
    pub base_commit: String,
    /// The branch it was created from; `None` for the project's HEAD then.
    #[serde(default)]
    pub base_branch: Option<String>,
    pub created_at: String,
    /// Its first checkout succeeded: a folder not there since was deleted. Records older than
    /// this field count as checked out.
    #[serde(default = "checked_out_before")]
    pub checked_out: bool,
}

fn checked_out_before() -> bool {
    true
}

/// Where a workspace's folder stands (`WorkspaceRecord::checkout_state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckoutState {
    /// Checked out.
    Ready,
    /// Placed, its first checkout still to run (it failed, or the app quit first).
    NeverCheckedOut,
    /// Deleted after a checkout (outside Brama): missing until Recreate.
    Absent,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Every project's workspaces: the records, and what only this launch knows (a checkout
/// running or failed). Cheap to clone.
#[derive(Clone)]
pub struct Workspaces {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    /// `<app data>/worktrees`.
    worktrees: PathBuf,
    /// Held while a workspace's folder is checked out; a chat's start waits on it.
    gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Held while a new workspace's name is chosen and stored.
    placing: Mutex<()>,
    /// Workspaces whose checkout runs.
    creating: Mutex<HashSet<String>>,
    /// Why a workspace's last checkout failed.
    failed: Mutex<HashMap<String, String>>,
    /// Set by Delete: its checkout stops and undoes itself.
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Being deleted (`Deleting`): no chat joins them.
    deleting: Mutex<HashSet<String>>,
    /// Told the project of every change.
    notifier: Mutex<Option<Arc<dyn crate::notify::Notifier>>>,
}

/// A workspace as the page lists it: its record and what this launch knows of its folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    #[serde(flatten)]
    pub record: WorkspaceRecord,
    /// Its checkout runs.
    pub creating: bool,
    /// Why its last checkout failed.
    pub error: Option<String>,
    /// Its folder is gone (deleted outside Brama); Recreate checks it out again.
    pub missing: bool,
}

impl Workspaces {
    /// `data_dir` is app data: `workspaces.json` and `worktrees/`.
    pub fn new(data_dir: &Path) -> Workspaces {
        Workspaces {
            inner: Arc::new(Inner {
                store: Store::open(data_dir.join("workspaces.json")),
                worktrees: data_dir.join("worktrees"),
                gates: Mutex::default(),
                placing: Mutex::default(),
                creating: Mutex::default(),
                failed: Mutex::default(),
                cancels: Mutex::default(),
                deleting: Mutex::default(),
                notifier: Mutex::default(),
            }),
        }
    }

    /// Tells `notifier` of each change from now on.
    pub fn notify_with(&self, notifier: Arc<dyn crate::notify::Notifier>) {
        *lock(&self.inner.notifier) = Some(notifier);
    }

    fn changed(&self, project: &Path) {
        let notifier = lock(&self.inner.notifier).clone();
        if let Some(notifier) = notifier {
            notifier.workspaces_changed(project);
        }
    }

    /// A project's workspaces as the page lists them: a folder not checked out while no checkout
    /// runs is missing (deleted, never checked out before a relaunch, or its checkout failed), and
    /// Recreate checks it out. Blocking (looks for each folder).
    pub fn pages(&self, project: &Path) -> Vec<Workspace> {
        let creating = lock(&self.inner.creating).clone();
        let failed = lock(&self.inner.failed).clone();
        self.list(project)
            .into_iter()
            .map(|record| Workspace {
                creating: creating.contains(&record.id),
                error: failed.get(&record.id).cloned(),
                missing: !creating.contains(&record.id) && record.checkout_state() != CheckoutState::Ready,
                record,
            })
            .collect()
    }

    pub fn store(&self) -> &Store {
        &self.inner.store
    }

    /// The workspaces of a canonical project, oldest first.
    pub fn list(&self, project: &Path) -> Vec<WorkspaceRecord> {
        self.inner.store.list(Some(project))
    }

    pub fn get(&self, id: &str) -> Result<WorkspaceRecord, String> {
        self.inner.store.get(id)
    }

    /// A workspace a new chat may join: not one being deleted.
    pub fn for_new_chat(&self, id: &str) -> Result<WorkspaceRecord, String> {
        if self.is_deleting(id) {
            return Err(format!("workspace {id} is being deleted"));
        }
        self.get(id)
    }

    pub fn is_deleting(&self, id: &str) -> bool {
        lock(&self.inner.deleting).contains(id)
    }

    /// Marks a workspace as being deleted until the guard drops (done, or stopped halfway).
    pub fn deleting(&self, id: &str) -> Deleting {
        lock(&self.inner.deleting).insert(id.to_owned());
        Deleting { inner: Arc::clone(&self.inner), id: id.to_owned() }
    }

    /// The folder of a workspace checked out and not checking out now: what a window opens as its root.
    pub fn open_folder(&self, id: &str) -> Result<PathBuf, String> {
        let record = self.get(id)?;
        if lock(&self.inner.creating).contains(id) || record.checkout_state() != CheckoutState::Ready {
            return Err(format!("{}: the workspace isn't checked out", record.folder.display()));
        }
        Ok(record.folder)
    }

    /// Creates a workspace named `name` in a canonical `project` and checks its folder out.
    /// Blocking.
    #[cfg(test)]
    pub fn create(&self, project: &Path, name: &str, base: Option<&str>) -> Result<WorkspaceRecord, String> {
        let record = self.place(project, Some(name), base)?;
        self.check_out(&record.id)?;
        self.get(&record.id)
    }

    /// Stores a new workspace placed from `base` (default: the project's base branch), listed as
    /// `creating` from the start: the caller runs its checkout (`check_out`) next. Without a `name` it's called after its branch
    /// (`brama/workspace-2`: "Workspace 2") and its first chat names it (`NameSource::Agent`); a
    /// given name is the user's.
    /// Refuses a project without git or a commit. Blocking.
    pub fn place(&self, project: &Path, name: Option<&str>, base: Option<&str>) -> Result<WorkspaceRecord, String> {
        let name = name.map(str::trim);
        if name == Some("") {
            return Err("a workspace's name can't be empty".to_owned());
        }
        let git = crate::git::binary::git()?;
        let base_branch = match base {
            Some(base) => Some(base.to_owned()),
            None => default_base(git, project),
        };
        let stem = name.map_or_else(|| "workspace".to_owned(), |n| checkout::slug(n, "workspace"));
        // One placement at a time: a name is taken once stored, before its checkout makes it.
        let _placing = lock(&self.inner.placing);
        let stored = self.inner.store.list(None);
        // A branch is taken within one repository: the worktrees of one group folder.
        let reserved = |root: &Path, branch: &str| {
            stored.iter().any(|w| w.worktree_path == root || (w.worktree_path.parent() == root.parent() && w.branch == branch))
        };
        let placed = checkout::place_named(project, &self.inner.worktrees, &stem, base_branch.as_deref(), &reserved)?;
        let record = WorkspaceRecord {
            id: new_id(),
            project_path: project.to_path_buf(),
            name: name.map_or_else(|| placeholder_name(&placed.branch), str::to_owned),
            name_source: if name.is_some() { NameSource::User } else { NameSource::Agent },
            folder: placed.folder,
            worktree_path: placed.worktree_path,
            branch: placed.branch,
            base_commit: placed.base_commit,
            base_branch,
            created_at: crate::util::iso_now(),
            checked_out: false,
        };
        lock(&self.inner.creating).insert(record.id.clone());
        if let Err(e) = self.inner.store.insert(record.clone()) {
            lock(&self.inner.creating).remove(&record.id);
            return Err(e);
        }
        tracing::info!(workspace = %record.id, branch = %record.branch, "workspace created");
        self.changed(project);
        Ok(record)
    }

    /// Checks a workspace's folder out (again from its branch when it was deleted). Chats
    /// starting meanwhile wait (`ready`). Blocking.
    pub fn check_out(&self, id: &str) -> Result<(), String> {
        let gate = self.gate(id);
        let _held = lock(&gate);
        self.check_out_held(id)
    }

    /// Before a chat of the workspace starts: waits for a checkout that runs, or runs the first
    /// one of a workspace never checked out (placed, then its checkout failed or the app quit). A
    /// folder deleted after its checkout stays missing until `check_out` (Recreate). Blocking.
    pub fn ready(&self, id: &str) -> Result<(), String> {
        let gate = self.gate(id);
        let _held = lock(&gate);
        if self.get(id)?.checkout_state() == CheckoutState::NeverCheckedOut {
            return self.check_out_held(id);
        }
        Ok(())
    }

    /// `check_out` with the workspace's gate held.
    fn check_out_held(&self, id: &str) -> Result<(), String> {
        let record = self.get(id)?;
        if lock(&self.inner.creating).insert(id.to_owned()) {
            self.changed(&record.project_path);
        }
        let cancel = self.cancel_flag(id);
        let result = checkout::check_out(&record, &cancel);
        lock(&self.inner.creating).remove(id);
        self.changed(&record.project_path);
        match &result {
            Ok(()) => {
                lock(&self.inner.failed).remove(id);
                if !record.checked_out {
                    if let Err(e) = self.inner.store.update(id, |r| r.checked_out = true) {
                        tracing::warn!(workspace = %id, "storing the workspace's checkout failed: {e}");
                    }
                }
            }
            Err(_) if cancel.load(Ordering::SeqCst) => tracing::info!(workspace = %id, "the workspace's checkout was stopped"),
            Err(e) => {
                tracing::warn!(workspace = %id, "checking the workspace out failed: {e}");
                lock(&self.inner.failed).insert(id.to_owned(), e.clone());
            }
        }
        result
    }

    /// The workspace of an older version's worktree session: its folder, worktree, branch and
    /// base as they are, named after it. The one already made for that worktree when there is one
    /// (idempotent).
    pub fn adopt(&self, session: &crate::session::SessionRecord) -> Result<WorkspaceRecord, String> {
        let (Some(worktree_path), Some(branch), Some(base_commit)) =
            (session.worktree_path.clone(), session.branch.clone(), session.base_commit.clone())
        else {
            return Err(format!("session {}: its worktree is missing from its record", session.session_id));
        };
        if let Some(found) = self.inner.store.list(None).into_iter().find(|w| w.worktree_path == worktree_path) {
            return Ok(found);
        }
        let record = WorkspaceRecord {
            id: format!("ws-{}", session.session_id),
            project_path: session.project_path.clone(),
            name: session.title.clone(),
            name_source: if session.title_source == crate::session::TitleSource::User { NameSource::User } else { NameSource::Agent },
            folder: session.agent_cwd.clone(),
            worktree_path,
            branch,
            base_commit,
            base_branch: None,
            created_at: session.created_at.clone(),
            checked_out: true,
        };
        self.inner.store.insert(record.clone())?;
        tracing::info!(workspace = %record.id, session = %session.session_id, "a worktree session became a workspace");
        Ok(record)
    }

    /// Names a workspace (trimmed, not empty); its chats' titles no longer rename it. Folder and
    /// branch stay.
    pub fn rename(&self, id: &str, name: &str) -> Result<WorkspaceRecord, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a workspace's name can't be empty".to_owned());
        }
        let record = self.inner.store.update(id, |record| {
            record.name = name.to_owned();
            record.name_source = NameSource::User;
        })?;
        self.changed(&record.project_path);
        Ok(record)
    }

    /// Takes `title` as its name while its chats name it (`NameSource::Agent`); the page hears
    /// of a change.
    pub fn follow_title(&self, id: &str, title: impl Fn() -> Option<String>) -> Result<(), String> {
        let follows = |r: &WorkspaceRecord, title: &str| r.name_source == NameSource::Agent && r.name != title;
        // Gone meanwhile: nothing to name. The `update` below reads the title again: it's the one
        // writer, so the last caller to get there applies the latest title.
        let Ok(current) = self.get(id) else { return Ok(()) };
        if !title().is_some_and(|t| follows(&current, &t)) {
            return Ok(());
        }
        let mut renamed = false;
        let record = self.inner.store.update(id, |r| {
            if let Some(title) = title().filter(|t| follows(r, t)) {
                r.name = title;
                renamed = true;
            }
        })?;
        if renamed {
            tracing::info!(workspace = %id, "the workspace took its chat's title");
            self.changed(&record.project_path);
        }
        Ok(())
    }

    /// Deletes a workspace's folder and its record. Uncommitted work is first committed onto its
    /// branch; the branch stays when `keep_branch` and it has commits past the base, else it's
    /// deleted. Its chats are the caller's (`Sessions::delete_workspace`). Blocking.
    /// A checkout that runs is stopped first, and undoes itself.
    pub fn discard(&self, id: &str, keep_branch: bool) -> Result<(), String> {
        let record = self.get(id)?;
        self.cancel_flag(id).store(true, Ordering::SeqCst);
        let gate = self.gate(id);
        let _held = lock(&gate);
        let message = format!("Work in progress from workspace \"{}\"\n\nSaved by Brama when the workspace was deleted.", record.name);
        let removed = checkout::remove(&record, &message, keep_branch);
        if let Err(e) = &removed {
            // Kept on disk (a detached worktree with work): the record goes all the same.
            tracing::warn!(workspace = %id, "removing the workspace's folder failed: {e}");
        }
        self.inner.store.remove(id)?;
        lock(&self.inner.gates).remove(id);
        lock(&self.inner.failed).remove(id);
        lock(&self.inner.cancels).remove(id);
        // Deleted before its checkout began: nothing else clears it.
        lock(&self.inner.creating).remove(id);
        tracing::info!(workspace = %id, "workspace deleted");
        self.changed(&record.project_path);
        Ok(())
    }

    /// What deleting a workspace would touch: its uncommitted files and its commits past the base.
    /// A folder that isn't there has neither. Blocking.
    pub fn changes_counts(&self, id: &str) -> Result<(usize, usize), String> {
        let record = self.get(id)?;
        if record.checkout_state() != CheckoutState::Ready {
            return Ok((0, 0));
        }
        let git = crate::git::binary::git()?;
        let run = |args: &[&dyn AsRef<std::ffi::OsStr>]| exec::run(git, &record.worktree_path, &exec::args(args), GitMode::Background);
        let status = run(&[&"status", &"--porcelain", &"-z", &"--untracked-files=all"])?;
        // `-z` entries; a rename's entry is followed by its old path.
        let mut uncommitted = 0;
        let mut entries = status.split(|b| *b == 0).filter(|e| !e.is_empty());
        while let Some(entry) = entries.next() {
            uncommitted += 1;
            if matches!(entry.first(), Some(b'R' | b'C')) {
                entries.next();
            }
        }
        let range = format!("{}..refs/heads/{}", record.base_commit, record.branch);
        let commits = run(&[&"rev-list", &"--count", &range]).map(|o| String::from_utf8_lossy(&o).trim().parse().unwrap_or(0)).unwrap_or(0);
        Ok((uncommitted, commits))
    }

    fn gate(&self, id: &str) -> Arc<Mutex<()>> {
        Arc::clone(lock(&self.inner.gates).entry(id.to_owned()).or_default())
    }

    /// Never cleared once set: only Delete sets it, and the workspace goes.
    fn cancel_flag(&self, id: &str) -> Arc<AtomicBool> {
        Arc::clone(lock(&self.inner.cancels).entry(id.to_owned()).or_default())
    }
}

/// A workspace being deleted, while held (`Workspaces::deleting`).
pub struct Deleting {
    inner: Arc<Inner>,
    id: String,
}

impl Drop for Deleting {
    fn drop(&mut self) {
        lock(&self.inner.deleting).remove(&self.id);
    }
}

impl WorkspaceRecord {
    /// Whether its folder is checked out, still to be, or gone. Blocking (looks for the folder).
    pub fn checkout_state(&self) -> CheckoutState {
        if checkout::is_checked_out(&self.worktree_path) {
            CheckoutState::Ready
        } else if self.checked_out {
            CheckoutState::Absent
        } else {
            CheckoutState::NeverCheckedOut
        }
    }
}

/// The project's base branch: `origin/HEAD`'s target (`origin/main`) when it resolves, else
/// `main`, else `master`, else HEAD's; `None` when there is none (a detached HEAD). Blocking.
fn default_base(git: &Path, project: &Path) -> Option<String> {
    let run = |args: &[&dyn AsRef<std::ffi::OsStr>]| {
        exec::run(git, project, &exec::args(args), GitMode::Background).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned())
    };
    let resolves = |r: &str| run(&[&"rev-parse", &"--verify", &"--quiet", &"--end-of-options", &format!("{r}^{{commit}}")]).is_some();
    let exists = |branch: &str| resolves(&format!("refs/heads/{branch}"));
    let origin = run(&[&"symbolic-ref", &"-q", &"refs/remotes/origin/HEAD"])
        .filter(|r| resolves(r))
        .and_then(|r| r.strip_prefix("refs/remotes/").map(str::to_owned));
    origin.or_else(|| {
        ["main", "master"]
            .into_iter()
            .map(str::to_owned)
            .find(|b| exists(b))
            .or_else(|| run(&[&"symbolic-ref", &"-q", &"--short", &"HEAD"]).filter(|b| exists(b)))
    })
}

/// An unnamed workspace's name, from its branch: `brama/workspace-2` → "Workspace 2".
fn placeholder_name(branch: &str) -> String {
    match branch.rsplit_once('-') {
        Some((_, n)) if n.chars().all(|c| c.is_ascii_digit()) => format!("Workspace {n}"),
        _ => "Workspace".to_owned(),
    }
}

/// A new workspace id: time and a counter, unique in this app data.
fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    format!("ws-{:x}-{:x}-{}", now.as_millis(), std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst))
}

#[cfg(test)]
mod tests;
