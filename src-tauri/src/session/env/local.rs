//! `local` mode: the agent works in the project directory itself, so its paths are host paths.

use std::path::{Path, PathBuf};

use super::{spawn_in, Launch, Mode, SessionEnv};
use crate::acp::process::{AgentPipes, AgentProcess};

pub struct LocalEnv {
    /// Canonical project root.
    root: PathBuf,
}

impl LocalEnv {
    pub fn new(root: PathBuf) -> LocalEnv {
        LocalEnv { root }
    }
}

impl SessionEnv for LocalEnv {
    fn mode(&self) -> Mode {
        Mode::Local
    }

    fn prepare(&self) -> Result<(), String> {
        if self.root.is_dir() {
            Ok(())
        } else {
            Err(format!("{}: the project folder is gone", self.root.display()))
        }
    }

    fn agent_cwd(&self) -> &Path {
        &self.root
    }

    fn host_dir(&self) -> &Path {
        &self.root
    }

    fn project_dir(&self) -> &Path {
        &self.root
    }

    fn spawn_agent(&self, launch: Launch) -> Result<(AgentProcess, AgentPipes), String> {
        spawn_in(&self.root, launch)
    }

    fn to_host_path(&self, agent_path: &Path) -> Result<PathBuf, String> {
        Ok(agent_path.to_path_buf())
    }
}
