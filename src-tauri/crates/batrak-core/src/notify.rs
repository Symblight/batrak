//! What changed, told to whichever front runs the core: the app turns each into a window event, a
//! command line prints a line or nothing. Every method is optional: a front hears what it wants.

use std::path::Path;

use serde::Serialize;

use crate::session::{LoginTab, Session, SyncReport};

pub trait Notifier: Send + Sync {
    /// An agents.json changed, or what its agents need (`None`: the user's, the agents of no
    /// project). Reached through [`crate::config::AgentConfigs::announce`], which also tells the
    /// project's sessions.
    fn agents_changed(&self, _project: Option<&Path>) {}
    /// A sync of `project` ended; `sessions` are the project's.
    fn sessions_synced(&self, _project: &Path, _sessions: &[Session], _report: &SyncReport) {}
    fn workspaces_changed(&self, _project: &Path) {}
    /// How a sign-in goes.
    fn sign_in(&self, _event: &SignInEvent) {}
    /// A failure of ours the user should see.
    fn notice(&self, _level: NoticeLevel, _message: &str) {}
}

/// Hears nothing: what the core runs with unless a front says otherwise.
pub struct Silent;
impl Notifier for Silent {}

/// `agents://changed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsChanged {
    pub project_path: Option<String>,
}

/// `sessions://synced`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsSynced<'a> {
    pub project_path: String,
    pub sessions: &'a [Session],
    pub report: &'a SyncReport,
}

/// `workspaces://changed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacesChanged {
    pub project_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignInProgress {
    Waiting,
    Done,
    Failed,
    Cancelled,
}

/// `agents://sign-in`. `terminal`: the login's tab, which only its own window can reach.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInEvent {
    pub project_path: Option<String>,
    pub agent_id: String,
    pub state: SignInProgress,
    pub message: Option<String>,
    pub terminal: Option<LoginTab>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeLevel {
    Warn,
    Error,
}

/// `app://notice`.
#[derive(Debug, Clone, Serialize)]
pub struct Notice {
    pub level: NoticeLevel,
    pub message: String,
}

/// Tests hear one kind of change through a closure.
#[cfg(test)]
pub mod testing {
    use super::*;

    pub struct OnAgents<F>(pub F);
    impl<F: Fn(Option<&Path>) + Send + Sync> Notifier for OnAgents<F> {
        fn agents_changed(&self, project: Option<&Path>) {
            (self.0)(project);
        }
    }

    pub struct OnWorkspaces<F>(pub F);
    impl<F: Fn(&Path) + Send + Sync> Notifier for OnWorkspaces<F> {
        fn workspaces_changed(&self, project: &Path) {
            (self.0)(project);
        }
    }
}
