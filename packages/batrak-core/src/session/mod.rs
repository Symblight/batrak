//! Agent sessions: agent + workspace. The agents own the sessions (`session/list`); Batrak lists
//! what they say ([`Sessions::sync`]), stores that list to show it at launch, and adds what they
//! can't know (where a session runs, its picks, the user's title). Messages are never stored:
//! the agent replays them (`session/load`). A session's agent process starts with its first
//! message or when it's shown, runs in a [`env::SessionEnv`] (`local`, or a `worktree` of its
//! own), and streams to the frontend through per-window channels.

pub mod env;
pub mod program;
mod runtime;

pub use runtime::{
    AgentSync, CliDraft, CliOpened, DeletePreview, CreateSession, Envelope, EventSink, LoginTab, Probed, PromptInput, SignInEnd, Sessions,
    SessionsOptions, SyncOutcome, SyncReport,
};

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use env::Mode;

/// Where a session's title comes from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleSource {
    /// The first prompt's opening words, until the agent names the session.
    #[default]
    Prompt,
    /// The agent's, from `session_info_update`.
    Agent,
    /// The user renamed it: the agent no longer changes it.
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    /// Getting the workspace ready.
    Preparing,
    /// Spawning the agent, `initialize`, `session/new` or `session/load`.
    Starting,
    Idle,
    /// A turn is running.
    Working,
    /// A local turn waits for another local session's turn in the same checkout. Saved as `idle`.
    Queued,
    /// Blocked on the user (a permission request).
    Waiting,
    /// No agent process; the next message starts one.
    Stopped,
    /// The agent failed to start or died; the transcript stays, Restart and the log are offered.
    Error,
}

impl SessionStatus {
    /// Whether the session holds (or is getting) an agent process.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Preparing | Self::Starting | Self::Idle | Self::Working | Self::Queued | Self::Waiting)
    }
}

/// A session as Batrak lists it: from its agent's list or a create, stored in `sessions.json` in
/// app data (no messages).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub session_id: String,
    /// The agent's own session id, for `session/load`; `None` until the first start.
    pub acp_session_id: Option<String>,
    pub agent_id: String,
    pub mode: Mode,
    /// As the agent sees it; stable for the session's life (`session/load` needs the same cwd).
    pub agent_cwd: PathBuf,
    /// Canonical project root; the frontend's project id.
    pub project_path: PathBuf,
    pub title: String,
    #[serde(default)]
    pub title_source: TitleSource,
    /// The title the agent last gave the session, kept under a user's title for Reset.
    #[serde(default)]
    pub agent_title: Option<String>,
    pub status: SessionStatus,
    pub created_at: String,
    /// The last prompt or turn end; `None` until the first prompt.
    #[serde(default)]
    pub last_activity_at: Option<String>,
    /// The agent's config options (model, thought level, mode…) as last chosen or reported, by
    /// id: a new start of the agent is set to them.
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    /// `worktree` only: the worktree's root (`agent_cwd` is the project's folder in it), its
    /// branch, and the commit it started from.
    #[serde(default)]
    pub worktree_path: Option<PathBuf>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base_commit: Option<String>,
    /// What its agent ran at its last start: when agents.json no longer has `agent_id`, an agent
    /// that runs the same (added again under another id) takes over.
    #[serde(default)]
    pub launch: Option<AgentLaunch>,
    /// Its agent's name as agents.json last gave it, shown once the agent is gone from it.
    #[serde(default)]
    pub agent_name: Option<String>,
    /// Removed where its agent can't delete sessions: never listed again.
    #[serde(default)]
    pub hidden: bool,
    /// The workspace it runs in (its folder and branch are the workspace's); `None`: Main.
    #[serde(default)]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunch {
    pub command: String,
    pub args: Vec<String>,
}

/// A session as the frontend lists it; mirrors `Session` in `src/models/types.js`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub title_source: TitleSource,
    pub agent_title: Option<String>,
    pub status: SessionStatus,
    pub agent_id: String,
    pub agent_name: Option<String>,
    pub acp_session_id: Option<String>,
    /// Until when another app may be running it: its agent saw activity in it that wasn't Batrak's
    /// (2 min after that). Counts only while it doesn't run here.
    pub active_elsewhere_until: Option<String>,
    /// Its agent's own CLI runs it in a terminal here (`Sessions::open_cli`).
    pub in_terminal: bool,
    /// What that CLI is doing, as its agent's records tell; `None`: no CLI, or its agent can't tell.
    pub activity: Option<agent_api::SessionActivity>,
    pub config: BTreeMap<String, String>,
    /// Where the agent works: the project, or its folder in the worktree.
    pub folder: String,
    pub branch: Option<String>,
    pub workspace_id: Option<String>,
    pub created_at: String,
    /// The last prompt or turn end, else `created_at`; the list's order.
    pub last_activity_at: String,
}

impl Session {
    /// The record's fields only; what the page gets is `SessionState::page()`, which adds what
    /// the record doesn't hold (activity elsewhere, the CLI's hold).
    fn of_record(r: &SessionRecord) -> Session {
        Session {
            id: r.session_id.clone(),
            project_id: r.project_path.to_string_lossy().into_owned(),
            title: r.title.clone(),
            title_source: r.title_source,
            agent_title: r.agent_title.clone(),
            status: r.status,
            agent_id: r.agent_id.clone(),
            agent_name: r.agent_name.clone(),
            acp_session_id: r.acp_session_id.clone(),
            active_elsewhere_until: None,
            in_terminal: false,
            activity: None,
            config: r.config.clone(),
            folder: r.agent_cwd.to_string_lossy().into_owned(),
            branch: r.branch.clone(),
            workspace_id: r.workspace_id.clone(),
            created_at: r.created_at.clone(),
            last_activity_at: r.last_activity_at.clone().unwrap_or_else(|| r.created_at.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SessionStatus;

    #[test]
    fn queued_is_active() {
        assert_eq!(serde_json::to_value(SessionStatus::Queued).unwrap(), "queued");
        assert!(SessionStatus::Queued.is_active());
    }
}
