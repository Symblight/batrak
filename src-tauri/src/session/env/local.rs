//! `local` mode: the agent works in the project directory itself, so its paths are host paths.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

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

    fn prepare(&self, _cancel: &AtomicBool) -> Result<(), String> {
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

    fn spawn_agent(&self, launch: Launch) -> Result<(AgentProcess, AgentPipes), String> {
        spawn_in(&self.root, launch)
    }

    fn to_host_path(&self, agent_path: &Path) -> Result<PathBuf, String> {
        Ok(agent_path.to_path_buf())
    }

    /// The work is the project's own: nothing to keep apart.
    fn archive(&self) -> Result<(), String> {
        Ok(())
    }

    /// Never deletes the project.
    fn discard(&self) -> Result<(), String> {
        Ok(())
    }
}
