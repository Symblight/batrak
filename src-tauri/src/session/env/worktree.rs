//! `worktree` mode: the agent works in its own git worktree, on its own branch, in app data. Its
//! paths are host paths there; the project's checkout is never touched.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::{spawn_in, Launch, Mode, Placement, SessionEnv};
use crate::acp::process::{AgentPipes, AgentProcess};
use crate::git::exec::{self, Mode as GitMode};
use crate::git::{binary, worktree};

pub struct WorktreeEnv {
    /// Canonical project root: the main checkout, or a folder in it.
    project: PathBuf,
    /// The worktree's own root.
    root: PathBuf,
    /// The project's folder inside the worktree: the agent's cwd.
    dir: PathBuf,
    branch: String,
    base_commit: String,
}

impl WorktreeEnv {
    pub fn new(project: PathBuf, root: PathBuf, dir: PathBuf, branch: String, base_commit: String) -> WorktreeEnv {
        WorktreeEnv { project, root, dir, branch, base_commit }
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

/// Where a new worktree session goes, checked against the repository: `base` (a branch or commit,
/// `None` for the project's HEAD) must name a commit. Creates nothing but the parent folder. Blocking.
pub fn place(project: &Path, worktrees: &Path, session_id: &str, title: &str, base: Option<&str>) -> Result<Placement, String> {
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

    let stem = format!("brama/{}-{}", slug(title, "session"), short_id(session_id));
    let exists = |name: &str| run(&[&"rev-parse", &"--verify", &"--quiet", &format!("refs/heads/{name}")]).is_ok();
    let branch = std::iter::once(stem.clone())
        .chain((2..100).map(|n| format!("{stem}-{n}")))
        .find(|name| !exists(name))
        .ok_or_else(|| format!("{stem}: every branch name is taken"))?;

    let name = top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let group = worktrees.join(format!("{}-{:08x}", slug(&name, "project"), fnv1a(top.as_os_str().as_encoded_bytes()) as u32));
    fs::create_dir_all(&group).map_err(|e| format!("{}: {e}", group.display()))?;
    // Canonical, as `confine` compares against it.
    let root = dunce::canonicalize(&group).map_err(|e| format!("{}: {e}", group.display()))?.join(session_id);
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
        if !self.root.join(".git").exists() {
            worktree::prune(git, &self.project)?;
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".to_owned());
            }
            match self.tip(git) {
                Some(_) => worktree::attach(git, &self.project, &self.root, &self.branch)?,
                None => worktree::add(git, &self.project, &self.root, &self.branch, &self.base_commit)?,
            }
            tracing::info!(path = %self.root.display(), branch = %self.branch, "worktree checked out");
        }
        let head = exec::run(git, &self.root, &exec::args(&[&"symbolic-ref", &"-q", &"--short", &"HEAD"]), GitMode::Background);
        if head.map(|h| String::from_utf8_lossy(&h).trim().to_owned()).ok().as_deref() != Some(self.branch.as_str()) {
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

    /// The branch keeps the commits; uncommitted work stays in the folder.
    fn archive(&self) -> Result<(), String> {
        Ok(())
    }

    /// Removes a clean worktree, and its branch when it has no commits of its own. A worktree with
    /// uncommitted changes is kept.
    fn discard(&self) -> Result<(), String> {
        let git = binary::git()?;
        if self.root.exists() && worktree::is_dirty(git, &self.root)? {
            return Err(format!("{}: has uncommitted changes, so it was kept", self.root.display()));
        }
        let tip = self.tip(git);
        // A branch checked out elsewhere can't be deleted (git refuses); it's the project's now.
        let unused = tip.as_deref() == Some(self.base_commit.as_str()) && !self.checked_out_elsewhere(git)?;
        let cleanup = if unused {
            worktree::BranchCleanup::Delete
        } else {
            worktree::BranchCleanup::Keep
        };
        worktree::remove(git, &self.project, &self.root, tip.is_some().then_some(self.branch.as_str()), cleanup)?;
        if let Some(group) = self.root.parent() {
            // Only when empty: the project's other sessions keep theirs.
            let _ = fs::remove_dir(group);
        }
        tracing::info!(path = %self.root.display(), branch = %self.branch, ?cleanup, "worktree removed");
        Ok(())
    }
}

/// `text` as a branch-name part: lowercase ASCII letters and digits, runs of anything else as
/// one `-`, at most 32 characters; `fallback` when nothing is left.
fn slug(text: &str, fallback: &str) -> String {
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
    fn branch_names_are_slugs() {
        assert_eq!(slug("Fix the session jump!", "x"), "fix-the-session-jump");
        assert_eq!(slug("  Ünïcode — only  ", "x"), "n-code-only");
        assert_eq!(slug("…", "session"), "session");
        assert_eq!(slug(&"a".repeat(50), "x").len(), 32);
        assert_eq!(short_id("3F2a-91bc-77d0"), "3f2a91bc");
    }
}
