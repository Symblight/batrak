//! `worktree` mode: the agent works in its own git worktree, on its own branch, in app data. Its
//! paths are host paths there; the project's checkout is never touched.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::{spawn_in, Launch, Mode, Placement, SessionEnv};
use crate::acp::process::{AgentPipes, AgentProcess};
use crate::git::exec::{self, Mode as GitMode};
use crate::git::{binary, worktree};

/// Why a workspace's chat doesn't start: its folder was deleted outside Brama.
pub const FOLDER_MISSING: &str = "the workspace's folder is missing; recreate it to go on";

pub struct WorktreeEnv {
    /// Canonical project root: the main checkout, or a folder in it.
    project: PathBuf,
    /// The worktree's own root.
    root: PathBuf,
    /// The project's folder inside the worktree: the agent's cwd.
    dir: PathBuf,
    branch: String,
    base_commit: String,
    /// The session's, for its snapshot commit.
    title: String,
    /// A workspace's chat: the workspace checks the folder out and removes it, never the chat.
    shared: bool,
}

impl WorktreeEnv {
    pub fn new(project: PathBuf, root: PathBuf, dir: PathBuf, branch: String, base_commit: String, title: String) -> WorktreeEnv {
        WorktreeEnv { project, root, dir, branch, base_commit, title, shared: false }
    }

    /// The same worktree as a workspace's chat sees it: `prepare` checks no folder out and
    /// `archive` / `discard` leave it.
    pub fn shared(self) -> WorktreeEnv {
        WorktreeEnv { shared: true, ..self }
    }

    /// Whether the worktree has its branch checked out (not detached by Check Out Branch).
    fn on_branch(&self, git: &Path) -> bool {
        let head = exec::run(git, &self.root, &exec::args(&[&"symbolic-ref", &"-q", &"--short", &"HEAD"]), GitMode::Background);
        head.map(|h| String::from_utf8_lossy(&h).trim().to_owned()).ok().as_deref() == Some(self.branch.as_str())
    }

    /// Whether the session's branch is checked out in another worktree (the project's checkout).
    fn checked_out_elsewhere(&self, git: &Path) -> Result<bool, String> {
        let entries = worktree::list(git, &self.project)?;
        Ok(entries.iter().any(|e| e.branch.as_deref() == Some(self.branch.as_str()) && e.path != self.root))
    }

    /// The branch's commit, `None` once it's gone.
    fn tip(&self, git: &Path) -> Option<String> {
        let rev = format!("refs/heads/{}^{{commit}}", self.branch);
        let out = exec::run(git, &self.project, &exec::args(&[&"rev-parse", &"--verify", &"--quiet", &rev]), GitMode::Background);
        out.ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned())
    }
}

/// Whether a worktree session can start in `project`: it's in a repository with a commit. Blocking.
pub fn can_place(project: &Path) -> bool {
    let Ok(git) = binary::git() else { return false };
    exec::run(git, project, &exec::args(&[&"rev-parse", &"--verify", &"--quiet", &"HEAD^{commit}"]), GitMode::Background).is_ok()
}

/// Where a new worktree session goes, checked against the repository: `base` (a branch or commit,
/// `None` for the project's HEAD) must name a commit. Creates nothing but the parent folder. Blocking.
pub fn place(project: &Path, worktrees: &Path, session_id: &str, title: &str, base: Option<&str>) -> Result<Placement, String> {
    place_named(project, worktrees, &format!("{}-{}", slug(title, "session"), short_id(session_id)), base)
}

/// Where a new worktree named `stem` goes: `<worktrees>/<repo>-<hash>/<stem>` on `brama/<stem>`,
/// `-2`, `-3`… when the folder or the branch is taken. `base` (a branch or commit, `None` for the
/// project's HEAD) must name a commit. Creates nothing but the parent folder. Blocking.
pub fn place_named(project: &Path, worktrees: &Path, stem: &str, base: Option<&str>) -> Result<Placement, String> {
    let git = binary::git()?;
    let run = |args: &[&dyn AsRef<std::ffi::OsStr>]| exec::run(git, project, &exec::args(args), GitMode::Background);
    let top = run(&[&"rev-parse", &"--show-toplevel"])
        .map_err(|_| format!("{}: worktree sessions need a git repository", project.display()))?;
    let top = exec::canonical(Path::new(String::from_utf8_lossy(&top).trim()));
    let inside = project.strip_prefix(&top).map_err(|_| format!("{}: not inside {}", project.display(), top.display()))?;
    // `--end-of-options`: a base is a name, never an option.
    let base_rev = format!("{}^{{commit}}", base.unwrap_or("HEAD"));
    let base_commit = run(&[&"rev-parse", &"--verify", &"--quiet", &"--end-of-options", &base_rev]).map_err(|_| match base {
        None => format!("{}: the repository has no commit yet", project.display()),
        Some(base) => format!("{base}: no such branch or commit"),
    })?;
    let base_commit = String::from_utf8_lossy(&base_commit).trim().to_owned();

    let name = top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let group = worktrees.join(format!("{}-{:08x}", slug(&name, "project"), fnv1a(top.as_os_str().as_encoded_bytes()) as u32));
    fs::create_dir_all(&group).map_err(|e| format!("{}: {e}", group.display()))?;
    // Canonical, as `confine` compares against it.
    let group = dunce::canonicalize(&group).map_err(|e| format!("{}: {e}", group.display()))?;

    // The folder is named like the branch, `brama/` left out; both must be free.
    let taken = |leaf: &str| {
        group.join(leaf).exists() || run(&[&"rev-parse", &"--verify", &"--quiet", &format!("refs/heads/brama/{leaf}")]).is_ok()
    };
    let leaf = std::iter::once(stem.to_owned())
        .chain((2..100).map(|n| format!("{stem}-{n}")))
        .find(|leaf| !taken(leaf))
        .ok_or_else(|| format!("brama/{stem}: every branch name is taken"))?;
    let branch = format!("brama/{leaf}");
    let root = group.join(&leaf);
    // `join("")` would add a trailing slash to the agent's cwd.
    let dir = if inside.as_os_str().is_empty() { root.clone() } else { root.join(inside) };
    Ok(Placement { agent_cwd: dir, worktree_path: Some(root), branch: Some(branch), base_commit: Some(base_commit) })
}

impl SessionEnv for WorktreeEnv {
    fn mode(&self) -> Mode {
        Mode::Worktree
    }

    /// Checks the worktree out on the first start, and again from its branch when its folder was
    /// deleted. A worktree whose branch was checked out in the project (Check Out Branch) goes back
    /// on it, or doesn't start: its agent's commits would land on no branch.
    fn prepare(&self, cancel: &AtomicBool) -> Result<(), String> {
        if !self.project.is_dir() {
            return Err(format!("{}: the project folder is gone", self.project.display()));
        }
        let git = binary::git()?;
        if self.shared && !self.root.join(".git").exists() {
            return Err(format!("{}: {FOLDER_MISSING}", self.root.display()));
        }
        if !self.root.join(".git").exists() {
            worktree::prune(git, &self.project)?;
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".to_owned());
            }
            let existing = self.tip(git).is_some();
            if existing {
                worktree::attach(git, &self.project, &self.root, &self.branch)?;
            } else {
                worktree::add(git, &self.project, &self.root, &self.branch, &self.base_commit)?;
            }
            // Stopped while git checked out (it can't be interrupted): undone, the new branch too.
            if cancel.load(Ordering::SeqCst) {
                let cleanup = if existing { worktree::BranchCleanup::Keep } else { worktree::BranchCleanup::Delete };
                worktree::remove(git, &self.project, &self.root, Some(&self.branch), cleanup)?;
                return Err("cancelled".to_owned());
            }
            tracing::info!(path = %self.root.display(), branch = %self.branch, "worktree checked out");
        }
        if !self.on_branch(git) {
            if self.checked_out_elsewhere(git)? {
                return Err(format!(
                    "Branch {} is checked out in the project; switch the project to another branch to go on with this session",
                    self.branch
                ));
            }
            exec::run(git, &self.root, &exec::args(&[&"switch", &"--end-of-options", &self.branch]), GitMode::Local)?;
        }
        if self.dir.is_dir() {
            Ok(())
        } else {
            Err(format!("{}: the project's folder is not on branch {}", self.dir.display(), self.branch))
        }
    }

    fn held_elsewhere(&self) -> Result<bool, String> {
        let git = binary::git()?;
        Ok(!self.on_branch(git) && self.checked_out_elsewhere(git)?)
    }

    fn agent_cwd(&self) -> &Path {
        &self.dir
    }

    fn host_dir(&self) -> &Path {
        &self.dir
    }

    fn project_dir(&self) -> &Path {
        &self.project
    }

    fn spawn_agent(&self, launch: Launch) -> Result<(AgentProcess, AgentPipes), String> {
        spawn_in(&self.dir, launch)
    }

    fn to_host_path(&self, agent_path: &Path) -> Result<PathBuf, String> {
        Ok(agent_path.to_path_buf())
    }

    /// Removes the worktree, its uncommitted work first committed onto its branch (a snapshot), and
    /// the branch when it has no commits of its own. A detached worktree with uncommitted work is
    /// kept: its branch is the project's then.
    fn discard(&self) -> Result<(), String> {
        if self.shared {
            return Ok(());
        }
        let message = format!("Work in progress from session \"{}\"\n\nSaved by Brama when the session was removed.", self.title);
        self.remove_with(&message, true)
    }
}

impl WorktreeEnv {
    /// Commits the uncommitted work onto the branch with `message`.
    fn snapshot(&self, message: &str) -> Result<(), String> {
        let git = binary::git()?;
        if let Some(sha) = crate::git::apply::snapshot_commit(git, &self.root, &self.branch, message)? {
            tracing::info!(branch = %self.branch, %sha, "saved the worktree's uncommitted work");
        }
        Ok(())
    }

    /// Removes the worktree. `keep_work`: uncommitted work is first committed onto the branch with
    /// `message`, and the branch stays when it has commits past the base; else it's deleted. A
    /// detached worktree with uncommitted work is kept (an error): its branch is the project's
    /// then. A branch checked out elsewhere is never deleted (git refuses). Blocking.
    pub fn remove_with(&self, message: &str, keep_work: bool) -> Result<(), String> {
        let git = binary::git()?;
        if self.root.exists() && worktree::is_dirty(git, &self.root)? {
            if !self.on_branch(git) {
                return Err(format!("{}: has uncommitted changes and isn't on its branch, so it was kept", self.root.display()));
            }
            if keep_work {
                self.snapshot(message)?;
            }
            worktree::remove_saved(git, &self.project, &self.root)?;
        }
        let tip = self.tip(git);
        let unused = !keep_work || tip.as_deref() == Some(self.base_commit.as_str());
        let cleanup = if unused && !self.checked_out_elsewhere(git)? {
            worktree::BranchCleanup::Delete
        } else {
            worktree::BranchCleanup::Keep
        };
        worktree::remove(git, &self.project, &self.root, tip.is_some().then_some(self.branch.as_str()), cleanup)?;
        if let Some(group) = self.root.parent() {
            // Only when empty: the project's other worktrees keep theirs.
            let _ = fs::remove_dir(group);
        }
        tracing::info!(path = %self.root.display(), branch = %self.branch, ?cleanup, "worktree removed");
        Ok(())
    }
}

/// Removes a worktree in app data that no session owns, unless it has uncommitted changes; its
/// branch stays. A folder that isn't a worktree goes only when empty. Blocking.
pub fn remove_orphan(path: &Path) -> Result<(), String> {
    if !path.join(".git").exists() {
        return fs::remove_dir(path).map_err(|e| format!("{}: {e}", path.display()));
    }
    let git = binary::git()?;
    if worktree::is_dirty(git, path)? {
        return Err(format!("{}: a removed session's worktree with uncommitted changes; kept", path.display()));
    }
    let repo = crate::git::lock::common_dir(git, path)?;
    worktree::remove(git, &repo, path, None, worktree::BranchCleanup::Keep)?;
    tracing::info!(path = %path.display(), "removed a worktree no session owns");
    Ok(())
}

/// `text` as a branch-name part: lowercase ASCII letters and digits, runs of anything else as
/// one `-`, at most 32 characters; `fallback` when nothing is left.
pub fn slug(text: &str, fallback: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 32 {
            break;
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() { fallback.to_owned() } else { out.to_owned() }
}

/// The session id's first 8 letters and digits, so two sessions with one title get two branches.
fn short_id(id: &str) -> String {
    id.chars().filter(char::is_ascii_alphanumeric).take(8).collect::<String>().to_ascii_lowercase()
}

/// FNV-1a: stable across builds (unlike `DefaultHasher`), so a project keeps its folder.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &b| (hash ^ u64::from(b)).wrapping_mul(0x100_0000_01b3))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worktree_needs_a_repository_with_a_commit() {
        use crate::git::test_repo::{temp_dir, TestRepo};
        let repo = TestRepo::with_commit("can-place");
        assert!(can_place(&repo.path));
        std::fs::create_dir_all(repo.path.join("sub")).unwrap();
        assert!(can_place(&repo.path.join("sub")));
        assert!(!can_place(&TestRepo::new("can-place-unborn").path));
        let plain = temp_dir("can-place-plain");
        assert!(!can_place(&plain));
        std::fs::remove_dir_all(plain).unwrap();
    }

    /// A checkout that finishes after Stop is undone: no worktree, no new branch.
    #[cfg(unix)]
    #[test]
    fn a_checkout_cancelled_while_it_runs_is_undone() {
        use crate::git::test_repo::{temp_dir, TestRepo};
        use std::os::unix::fs::PermissionsExt;
        use std::sync::Arc;
        let repo = TestRepo::with_commit("cancel-checkout");
        let hook = repo.path.join(".git/hooks/post-checkout");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&hook, "#!/bin/sh\nsleep 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        let home = temp_dir("cancel-checkout-home");
        let root = home.join("s");
        let env = WorktreeEnv::new(repo.path.clone(), root.clone(), root.clone(), "brama/cancel".into(), base, "t".into());

        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        let preparing = std::thread::spawn(move || env.prepare(&flag));
        std::thread::sleep(std::time::Duration::from_millis(300));
        cancel.store(true, Ordering::SeqCst);
        assert!(preparing.join().unwrap().unwrap_err().contains("cancelled"));
        assert!(!root.exists());
        assert!(repo.git(&["branch", "--list", "brama/cancel"]).is_empty());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_worktree_is_named_after_its_session() {
        use crate::git::test_repo::{temp_dir, TestRepo};
        let repo = TestRepo::with_commit("place-name");
        let worktrees = temp_dir("place-name-worktrees");
        let placed = place(&repo.path, &worktrees, "3f2a91bc-77d0", "Fix the login", None).unwrap();
        let root = placed.worktree_path.unwrap();
        assert_eq!(root.file_name().unwrap(), "fix-the-login-3f2a91bc");
        assert_eq!(placed.branch.as_deref(), Some("brama/fix-the-login-3f2a91bc"));

        // A folder left behind (an orphan kept for its uncommitted work) takes the next name.
        std::fs::create_dir_all(&root).unwrap();
        let next = place(&repo.path, &worktrees, "3f2a91bc-77d0", "Fix the login", None).unwrap();
        assert_eq!(next.worktree_path.unwrap().file_name().unwrap(), "fix-the-login-3f2a91bc-2");
        assert_eq!(next.branch.as_deref(), Some("brama/fix-the-login-3f2a91bc-2"));
        std::fs::remove_dir_all(worktrees).unwrap();
    }

    #[test]
    fn branch_names_are_slugs() {
        assert_eq!(slug("Fix the session jump!", "x"), "fix-the-session-jump");
        assert_eq!(slug("  Ünïcode — only  ", "x"), "n-code-only");
        assert_eq!(slug("…", "session"), "session");
        assert_eq!(slug(&"a".repeat(50), "x").len(), 32);
        assert_eq!(short_id("3F2a-91bc-77d0"), "3f2a91bc");
    }
}
