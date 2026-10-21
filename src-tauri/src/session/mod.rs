//! Agent sessions: agent + workspace + history. A session's agent process and ACP session start
//! with its first message, run in a [`env::SessionEnv`] (`local`, or a `worktree` of their own),
//! and stream to the frontend through per-window channels.

pub mod env;
mod runtime;
mod transcript;

pub use runtime::{CreateSession, Envelope, EventSink, PromptInput, Sessions, SessionsOptions};

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

/// What is kept in app data per session.
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
    pub config: BTreeMap<String, String>,
    pub mode: Mode,
    /// Where the agent works: the project, or its folder in the worktree.
    pub folder: String,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_commit: Option<String>,
    pub created_at: String,
    /// The last prompt or turn end, else `created_at`; the list's order.
    pub last_activity_at: String,
}

impl From<&SessionRecord> for Session {
    fn from(r: &SessionRecord) -> Session {
        Session {
            id: r.session_id.clone(),
            project_id: r.project_path.to_string_lossy().into_owned(),
            title: r.title.clone(),
            title_source: r.title_source,
            agent_title: r.agent_title.clone(),
            status: r.status,
            agent_id: r.agent_id.clone(),
            agent_name: r.agent_name.clone(),
            config: r.config.clone(),
            mode: r.mode,
            folder: r.agent_cwd.to_string_lossy().into_owned(),
            worktree_path: r.worktree_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            branch: r.branch.clone(),
            base_commit: r.base_commit.clone(),
            created_at: r.created_at.clone(),
            last_activity_at: r.last_activity_at.clone().unwrap_or_else(|| r.created_at.clone()),
        }
    }
}

/// Now as an ISO 8601 UTC timestamp with milliseconds, like JavaScript's `toISOString()`.
pub fn iso_now() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    iso_from_millis(now.as_millis() as i64)
}

fn iso_from_millis(ms: i64) -> String {
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::SessionStatus;

    #[test]
    fn queued_is_active() {
        assert_eq!(serde_json::to_value(SessionStatus::Queued).unwrap(), "queued");
        assert!(SessionStatus::Queued.is_active());
    }

    #[test]
    fn iso_timestamps() {
        assert_eq!(super::iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(super::iso_from_millis(1_792_065_296_789), "2026-10-15T11:54:56.789Z");
        assert_eq!(super::iso_from_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
