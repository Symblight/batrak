//! Session domain model: agent + isolated workspace + change history.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Working,
    /// Blocked on the user (e.g. a permission request).
    Waiting,
    Idle,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: SessionStatus,
    pub agent_id: String,
    pub model: Option<String>,
    pub worktree_path: Option<String>,
    pub base_commit: Option<String>,
    pub created_at: String,
}
