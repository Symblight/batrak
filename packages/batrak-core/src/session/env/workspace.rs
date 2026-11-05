//! `worktree` mode: a workspace's chat works in the workspace's folder, a git worktree in app
//! data on its own branch. Its paths are host paths there; the project's checkout is never
//! touched. The workspace checks the folder out and removes it (`workspace::checkout`), never
//! the chat.

use std::path::{Path, PathBuf};

use super::{spawn_in, Launch, Mode, SessionEnv};
use crate::acp::process::{AgentPipes, AgentProcess};
use crate::workspace::checkout;

/// Why a workspace's chat doesn't start: its folder was deleted outside Brama.
const FOLDER_MISSING: &str = "the workspace's folder is missing; recreate it to go on";

pub struct WorkspaceEnv {
    /// Canonical project root: the main checkout, or a folder in it.
    project: PathBuf,
    /// The worktree's own root.
    root: PathBuf,
    /// The project's folder inside the worktree: the agent's cwd.
    dir: PathBuf,
    branch: String,
}

impl WorkspaceEnv {
    pub fn new(project: PathBuf, root: PathBuf, dir: PathBuf, branch: String) -> WorkspaceEnv {
        WorkspaceEnv { project, root, dir, branch }
    }
}

impl SessionEnv for WorkspaceEnv {
    fn mode(&self) -> Mode {
        Mode::Worktree
    }

    /// The folder must be checked out; a worktree whose branch was checked out in the project
    /// (Check Out Branch) goes back on it, or doesn't start.
    fn prepare(&self) -> Result<(), String> {
        if !self.project.is_dir() {
            return Err(format!("{}: the project folder is gone", self.project.display()));
        }
        if !checkout::is_checked_out(&self.root) {
            return Err(format!("{}: {FOLDER_MISSING}", self.root.display()));
        }
        checkout::back_on_branch(crate::git::binary::git()?, &self.project, &self.root, &self.branch)?;
        checkout::folder_on_branch(&self.dir, &self.branch)
    }

    fn held_elsewhere(&self) -> Result<bool, String> {
        checkout::held_elsewhere(&self.project, &self.root, &self.branch)
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
}
