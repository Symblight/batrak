//! Agent sessions: agent + workspace. The agents own the sessions (`session/list`); Brama lists
//! what they say ([`Sessions::sync`]), stores that list to show it at launch, and adds what they
//! can't know (where a session runs, its picks, the user's title). Messages are never stored:
//! the agent replays them (`session/load`). A session's agent process starts with its first
//! message or when it's shown, runs in a [`env::SessionEnv`] (`local`, or a `worktree` of its
//! own), and streams to the frontend through per-window channels.

pub mod env;
mod runtime;

pub use runtime::{
    CliDraft, CliOpened, DeletePreview, CliWindow, CreateSession, Envelope, EventSink, Login, LoginExit, LoginTab, Probed, PromptInput, SignInEnd, Sessions,
    SessionsOptions, SyncReport,
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

/// A session as Brama lists it: from its agent's list or a create, stored in `sessions.json` in
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
    /// Until when another app may be running it: its agent saw activity in it that wasn't Brama's
    /// (2 min after that). Counts only while it doesn't run here.
    pub active_elsewhere_until: Option<String>,
    /// Its agent's own CLI runs it in a terminal here (`Sessions::open_cli`): activity its agent
    /// reports meanwhile is that CLI's, not another app's.
    pub in_terminal: bool,
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
            config: r.config.clone(),
            folder: r.agent_cwd.to_string_lossy().into_owned(),
            branch: r.branch.clone(),
            workspace_id: r.workspace_id.clone(),
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

pub(crate) fn iso_from_millis(ms: i64) -> String {
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

/// Milliseconds since the epoch of an ISO 8601 / RFC 3339 timestamp (`2026-10-20T10:00:00Z`,
/// fractions and `±HH:MM` offsets too), as agents write `updatedAt`.
pub(crate) fn parse_iso_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hour, minute, second) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut i = 19;
    let mut millis = 0;
    if b.get(i) == Some(&b'.') {
        let digits = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            return None;
        }
        let frac = &s[i + 1..i + 1 + digits.min(3)];
        millis = frac.parse::<i64>().ok()? * 10_i64.pow(3 - frac.len() as u32);
        i += 1 + digits;
    }
    let offset = match b.get(i) {
        Some(b'Z' | b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if b.len() == i + 6 && b[i + 3] == b':' => {
            let minutes = num(i + 1, 2)? * 60 + num(i + 4, 2)?;
            if *sign == b'+' { minutes } else { -minutes }
        }
        _ => return None,
    };
    // Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset * 60;
    Some(secs * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::SessionStatus;

    #[test]
    fn parses_agents_timestamps() {
        assert_eq!(super::parse_iso_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(super::parse_iso_millis("2026-10-15T11:54:56.789Z"), Some(1_792_065_296_789));
        assert_eq!(super::parse_iso_millis("2026-10-15T11:54:56.7891234Z"), Some(1_792_065_296_789));
        assert_eq!(super::parse_iso_millis("2026-10-15T13:54:56.789+02:00"), Some(1_792_065_296_789));
        assert_eq!(super::parse_iso_millis("2000-02-29T00:00:00Z"), Some(951_782_400_000));
        for bad in ["", "yesterday", "2026-13-01T00:00:00Z", "2026-10-15T11:54:56", "2026-10-15T11:54:56.Z"] {
            assert_eq!(super::parse_iso_millis(bad), None, "{bad}");
        }
    }

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
