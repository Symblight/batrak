//! Where a session's agent runs. All mode-specific logic lives behind [`SessionEnv`]: the agent's
//! working directory, how its process starts, and how its paths map to the host: `local` (Main,
//! the project's folder) or `worktree` (a workspace's folder). The mode is picked when a session
//! is created and never changes: `session/load` needs the same cwd.

mod local;
mod workspace;

pub use local::LocalEnv;
pub use workspace::WorkspaceEnv;

use std::fs::File;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::SessionRecord;
use crate::acp::process::{AgentCommand, AgentPipes, AgentProcess};
use crate::workspace::WorkspaceRecord;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// The agent works in the project directory itself.
    Local,
    /// A workspace's git worktree in app data.
    Worktree,
}

/// What the agent is to run; the environment decides where and how.
pub struct Launch<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    /// The complete environment (login shell + agent env), secrets included.
    pub env: &'a [(String, String)],
    /// The agent's stderr goes here.
    pub stderr: File,
}

pub trait SessionEnv: Send + Sync {
    fn mode(&self) -> Mode;
    /// Checks the directory is ready for the agent (a workspace's worktree on its branch). Blocking.
    fn prepare(&self) -> Result<(), String>;
    /// Whether `prepare` would refuse because the user took the session's place over (the project
    /// has a worktree's branch checked out). Blocking.
    fn held_elsewhere(&self) -> Result<bool, String> {
        Ok(false)
    }
    /// The agent's working directory, as the agent sees it (ACP `cwd`).
    fn agent_cwd(&self) -> &Path;
    /// The same directory on the host.
    fn host_dir(&self) -> &Path;
    /// The project's own folder (`host_dir` for `local`): a prompt may quote the user's files there
    /// by absolute path.
    fn project_dir(&self) -> &Path;
    fn spawn_agent(&self, launch: Launch) -> Result<(AgentProcess, AgentPipes), String>;
    /// Maps a path the agent sent to the host. Doesn't check it: [`confine`] does.
    fn to_host_path(&self, agent_path: &Path) -> Result<PathBuf, String>;
}

/// Where a new chat runs, fixed for its life and kept in its record.
#[derive(Debug, Clone)]
pub struct Placement {
    pub mode: Mode,
    pub agent_cwd: PathBuf,
    pub worktree_path: Option<PathBuf>,
    pub branch: Option<String>,
    pub base_commit: Option<String>,
    pub workspace_id: Option<String>,
}

impl Placement {
    /// A chat of `workspace`, in its folder (`worktree`), or of Main for `None`: the canonical
    /// `project` folder itself (`local`).
    pub fn of(project: &Path, workspace: Option<&WorkspaceRecord>) -> Placement {
        match workspace {
            None => Placement {
                mode: Mode::Local,
                agent_cwd: project.to_path_buf(),
                worktree_path: None,
                branch: None,
                base_commit: None,
                workspace_id: None,
            },
            Some(w) => Placement {
                mode: Mode::Worktree,
                agent_cwd: w.folder.clone(),
                worktree_path: Some(w.worktree_path.clone()),
                branch: Some(w.branch.clone()),
                base_commit: Some(w.base_commit.clone()),
                workspace_id: Some(w.id.clone()),
            },
        }
    }
}

/// Builds the environment of a placed session.
pub fn for_session(record: &SessionRecord) -> Result<Box<dyn SessionEnv>, String> {
    match record.mode {
        Mode::Local => Ok(Box::new(LocalEnv::new(record.project_path.clone()))),
        Mode::Worktree => {
            let (Some(root), Some(branch)) = (&record.worktree_path, &record.branch) else {
                return Err(format!("session {}: its worktree is missing from its record", record.session_id));
            };
            Ok(Box::new(WorkspaceEnv::new(record.project_path.clone(), root.clone(), record.agent_cwd.clone(), branch.clone())))
        }
    }
}

/// Runs the agent with `launch` in `cwd`, in its own process group.
pub fn spawn_in(cwd: &Path, launch: Launch) -> Result<(AgentProcess, AgentPipes), String> {
    let command = AgentCommand { program: launch.program, args: launch.args, cwd, env: launch.env };
    crate::acp::process::spawn(&command, launch.stderr)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// The path must exist.
    Read,
    /// The path may be new; its nearest existing ancestor must be inside.
    Write,
}

/// Checks a host path the agent asked for and returns the real path to use: absolute, no `..`,
/// inside `host_dir` once symlinks are resolved, and nowhere in a `.git`. `host_dir` is canonical.
pub fn confine(host_dir: &Path, path: &Path, access: Access) -> Result<PathBuf, String> {
    let shown = path.display();
    if !path.is_absolute() {
        return Err(format!("{shown}: not an absolute path"));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("{shown}: \"..\" is not allowed"));
    }
    // The nearest existing ancestor is resolved (symlinks included); what follows it doesn't exist,
    // so it can't be a link.
    let mut existing = path.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let real = loop {
        match dunce::canonicalize(&existing) {
            Ok(real) => break real,
            Err(_) if access == Access::Write => {
                let name = existing.file_name().ok_or_else(|| format!("{shown}: no existing parent"))?.to_owned();
                missing.push(name);
                if !existing.pop() {
                    return Err(format!("{shown}: no existing parent"));
                }
            }
            Err(e) => return Err(format!("{shown}: {e}")),
        }
    };
    let real = missing.iter().rev().fold(real, |acc, name| acc.join(name));
    let rel = real.strip_prefix(host_dir).map_err(|_| format!("{shown}: outside the session's folder"))?;
    if rel.components().any(|c| c.as_os_str() == ".git") {
        return Err(format!("{shown}: inside .git"));
    }
    if access == Access::Write && real.is_dir() {
        return Err(format!("{shown}: is a folder"));
    }
    Ok(real)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("batrak-confine-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/config"), "[core]\n").unwrap();
        std::fs::write(dir.join("src/a.txt"), "a").unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    #[test]
    fn allows_files_inside_and_new_files_in_new_folders() {
        let root = project("inside");
        assert_eq!(confine(&root, &root.join("src/a.txt"), Access::Read).unwrap(), root.join("src/a.txt"));
        assert_eq!(confine(&root, &root.join("new/deep/b.txt"), Access::Write).unwrap(), root.join("new/deep/b.txt"));
        assert!(confine(&root, &root.join("missing.txt"), Access::Read).is_err(), "reads need the file");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_escapes_git_and_relative_paths() {
        let root = project("escape");
        let err = |p: PathBuf, a| confine(&root, &p, a).unwrap_err();
        assert!(err(root.join("../x"), Access::Write).contains(".."));
        assert!(err(root.join("src/../../x"), Access::Read).contains(".."));
        assert!(err(root.join(".git/config"), Access::Read).contains(".git"));
        assert!(err(root.join(".git/hooks/pre-commit"), Access::Write).contains(".git"));
        assert!(err(root.join("sub/.git/HEAD"), Access::Write).contains(".git"));
        assert!(err(PathBuf::from("/etc/passwd"), Access::Read).contains("outside"));
        assert!(err(PathBuf::from("src/a.txt"), Access::Read).contains("absolute"));
        assert!(err(root.join("src"), Access::Write).contains("folder"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_leave_the_folder() {
        let root = project("symlink");
        let outside = root.with_file_name(format!("batrak-confine-outside-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linkdir")).unwrap();
        std::os::unix::fs::symlink(root.join("src/a.txt"), root.join("inner.txt")).unwrap();

        assert!(confine(&root, &root.join("link.txt"), Access::Read).unwrap_err().contains("outside"));
        assert!(confine(&root, &root.join("link.txt"), Access::Write).unwrap_err().contains("outside"));
        assert!(confine(&root, &root.join("linkdir/new.txt"), Access::Write).unwrap_err().contains("outside"));
        assert_eq!(confine(&root, &root.join("inner.txt"), Access::Read).unwrap(), root.join("src/a.txt"));
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
