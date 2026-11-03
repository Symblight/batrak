//! Workspaces: a project's tasks (docs/specs/workspaces.md). A workspace has a name, its own git
//! worktree in app data on branch `brama/<slug>`, and chats (sessions) that run in its folder.
//! Main, the project's own folder, is not stored.


mod store;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::git::exec::{self, Mode as GitMode};
use crate::session::env::{self, SessionEnv};

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
    /// A turn of one of its chats started or ended.
    #[serde(default)]
    pub last_active_at: Option<String>,
    /// The chat it was made for (a worktree session moved in, or the Worktree run target): it
    /// goes when that chat is removed and it has no other. Until workspaces can be deleted in the
    /// page (spec Phase 3), so Remove still cleans a worktree session up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub made_for: Option<String>,
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
    /// Told the project of every change (the app: `workspaces://changed` to every window).
    on_change: Mutex<Option<OnChange>>,
}

/// Told a project's workspaces changed.
pub type OnChange = Arc<dyn Fn(&Path) + Send + Sync>;

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
                on_change: Mutex::default(),
            }),
        }
    }

    /// Calls `f` with the project of each change from now on.
    pub fn on_change(&self, f: OnChange) {
        *lock(&self.inner.on_change) = Some(f);
    }

    fn changed(&self, project: &Path) {
        let f = lock(&self.inner.on_change).clone();
        if let Some(f) = f {
            f(project);
        }
    }

    /// A project's workspaces as the page lists them. Blocking (looks for each folder).
    pub fn pages(&self, project: &Path) -> Vec<Workspace> {
        let creating = lock(&self.inner.creating).clone();
        let failed = lock(&self.inner.failed).clone();
        self.list(project)
            .into_iter()
            .map(|record| Workspace {
                creating: creating.contains(&record.id),
                error: failed.get(&record.id).cloned(),
                missing: !creating.contains(&record.id) && !record.worktree_path.join(".git").exists() && !record.never_checked_out(),
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

    /// Creates a workspace named `name` in a canonical `project` and checks its folder out.
    /// Blocking.
    #[cfg(test)]
    pub fn create(&self, project: &Path, name: &str, base: Option<&str>) -> Result<WorkspaceRecord, String> {
        let record = self.place(project, name, NameSource::User, base)?;
        self.check_out(&record.id)?;
        Ok(record)
    }

    /// Stores a new workspace placed from `base` (default: the project's base branch), its
    /// checkout still to run (`check_out`). Refuses a project without git or a commit. Blocking.
    pub fn place(&self, project: &Path, name: &str, name_source: NameSource, base: Option<&str>) -> Result<WorkspaceRecord, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a workspace's name can't be empty".to_owned());
        }
        let git = crate::git::binary::git()?;
        let base_branch = match base {
            Some(base) => Some(base.to_owned()),
            None => default_base(git, project),
        };
        let stem = env::slug(name, "workspace");
        // One placement at a time: a name is taken once stored, before its checkout makes it.
        let _placing = lock(&self.inner.placing);
        let stored = self.inner.store.list(None);
        // A branch is taken within one repository: the worktrees of one group folder.
        let reserved = |root: &Path, branch: &str| {
            stored.iter().any(|w| w.worktree_path == root || (w.worktree_path.parent() == root.parent() && w.branch == branch))
        };
        let placed = env::place_named(project, &self.inner.worktrees, &stem, base_branch.as_deref(), &reserved)
            .map_err(|e| e.replace("worktree sessions need", "workspaces need"))?;
        let (Some(worktree_path), Some(branch), Some(base_commit)) = (placed.worktree_path, placed.branch, placed.base_commit) else {
            return Err("a worktree placement without a worktree".to_owned());
        };
        let record = WorkspaceRecord {
            id: new_id(),
            project_path: project.to_path_buf(),
            name: name.to_owned(),
            name_source,
            folder: placed.agent_cwd,
            worktree_path,
            branch,
            base_commit,
            base_branch,
            created_at: crate::session::iso_now(),
            last_active_at: None,
            made_for: None,
        };
        self.inner.store.insert(record.clone())?;
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
        if self.get(id)?.never_checked_out() {
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
        let result = record.env().prepare(&AtomicBool::new(false));
        lock(&self.inner.creating).remove(id);
        self.changed(&record.project_path);
        match &result {
            Ok(()) => drop(lock(&self.inner.failed).remove(id)),
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
            last_active_at: session.last_activity_at.clone(),
            made_for: Some(session.session_id.clone()),
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

    /// Deletes a workspace's folder and its record. Uncommitted work is first committed onto its
    /// branch; the branch stays when `keep_branch` and it has commits past the base, else it's
    /// deleted. Its chats are the caller's (`Sessions::delete_workspace`). Blocking.
    pub fn discard(&self, id: &str, keep_branch: bool) -> Result<(), String> {
        let record = self.get(id)?;
        let gate = self.gate(id);
        let _held = lock(&gate);
        let message = format!("Work in progress from workspace \"{}\"\n\nSaved by Brama when the workspace was deleted.", record.name);
        let removed = record.env().remove_with(&message, keep_branch);
        if let Err(e) = &removed {
            // Kept on disk (a detached worktree with work): the record goes all the same.
            tracing::warn!(workspace = %id, "removing the workspace's folder failed: {e}");
        }
        self.inner.store.remove(id)?;
        lock(&self.inner.gates).remove(id);
        lock(&self.inner.failed).remove(id);
        tracing::info!(workspace = %id, "workspace deleted");
        self.changed(&record.project_path);
        Ok(())
    }

    /// What deleting a workspace would touch: its uncommitted files and its commits past the base.
    /// A folder that isn't there has neither. Blocking.
    pub fn changes_counts(&self, id: &str) -> Result<(usize, usize), String> {
        let record = self.get(id)?;
        if !record.worktree_path.join(".git").exists() {
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
}

impl WorkspaceRecord {
    /// Neither its worktree nor its branch is there: its first checkout is still to run. Blocking.
    pub fn never_checked_out(&self) -> bool {
        if self.worktree_path.join(".git").exists() {
            return false;
        }
        let Ok(git) = crate::git::binary::git() else { return false };
        let rev = format!("refs/heads/{}", self.branch);
        exec::run(git, &self.project_path, &exec::args(&[&"rev-parse", &"--verify", &"--quiet", &rev]), GitMode::Background).is_err()
    }

    /// Where its chats run.
    pub fn placement(&self) -> env::Placement {
        env::Placement {
            agent_cwd: self.folder.clone(),
            worktree_path: Some(self.worktree_path.clone()),
            branch: Some(self.branch.clone()),
            base_commit: Some(self.base_commit.clone()),
        }
    }

    /// Its worktree as a session environment that checks it out.
    pub fn env(&self) -> env::WorktreeEnv {
        env::WorktreeEnv::new(
            self.project_path.clone(),
            self.worktree_path.clone(),
            self.folder.clone(),
            self.branch.clone(),
            self.base_commit.clone(),
            self.name.clone(),
        )
    }
}

/// The project's base branch: `origin/HEAD`'s, else `main`, else `master`, else HEAD's; `None`
/// when there is none (a detached HEAD). Blocking.
fn default_base(git: &Path, project: &Path) -> Option<String> {
    let run = |args: &[&dyn AsRef<std::ffi::OsStr>]| {
        exec::run(git, project, &exec::args(args), GitMode::Background).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned())
    };
    let exists = |branch: &str| run(&[&"rev-parse", &"--verify", &"--quiet", &format!("refs/heads/{branch}")]).is_some();
    let origin = run(&[&"symbolic-ref", &"-q", &"--short", &"refs/remotes/origin/HEAD"])
        .and_then(|r| r.strip_prefix("origin/").map(str::to_owned));
    origin
        .into_iter()
        .chain(["main".to_owned(), "master".to_owned()])
        .find(|b| exists(b))
        .or_else(|| run(&[&"symbolic-ref", &"-q", &"--short", &"HEAD"]).filter(|b| exists(b)))
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
