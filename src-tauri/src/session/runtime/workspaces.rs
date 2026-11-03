//! Workspaces' chats: what a workspace does to the sessions that run in it.

// Until the workspace commands use it (spec Phase 1 step 14).
#![allow(dead_code)]

use super::*;

impl Sessions {
    /// Deletes a workspace: each of its chats is removed as Remove session removes one (a running
    /// turn ends `cancelled`), then its folder (`Workspaces::discard`).
    pub async fn delete_workspace(&self, id: &str, keep_branch: bool) -> Result<(), String> {
        self.inner.workspaces.get(id)?;
        for chat in self.chats_of(id) {
            self.remove(&chat).await?;
        }
        let workspaces = self.inner.workspaces.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || workspaces.discard(&id, keep_branch)).await.map_err(|e| e.to_string())?
    }

    /// What deleting a workspace would do: its uncommitted files and commits past the base, and
    /// the titles of its chats in a turn, which it would stop.
    pub async fn workspace_delete_preview(&self, id: &str) -> Result<DeletePreview, String> {
        let workspaces = self.inner.workspaces.clone();
        let ws = id.to_owned();
        let (uncommitted, commits) =
            tokio::task::spawn_blocking(move || workspaces.changes_counts(&ws)).await.map_err(|e| e.to_string())??;
        let working = self
            .inner
            .known()
            .into_iter()
            .filter(|r| r.workspace_id.as_deref() == Some(id) && in_turn(r.status))
            .map(|r| r.title)
            .collect();
        Ok(DeletePreview { uncommitted, commits, working })
    }

    /// The ids of a workspace's chats.
    fn chats_of(&self, workspace: &str) -> Vec<String> {
        self.inner.known().into_iter().filter(|r| r.workspace_id.as_deref() == Some(workspace)).map(|r| r.session_id).collect()
    }
}

/// What deleting a workspace would touch (`workspace_delete_preview`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePreview {
    pub uncommitted: usize,
    pub commits: usize,
    /// Titles of its chats in a turn.
    pub working: Vec<String>,
}

/// Whether a chat is in a turn, or about to be: preparing, starting, working, waiting, queued.
pub(super) fn in_turn(status: SessionStatus) -> bool {
    matches!(
        status,
        SessionStatus::Preparing | SessionStatus::Starting | SessionStatus::Working | SessionStatus::Waiting | SessionStatus::Queued
    )
}

/// Gives each worktree session without a workspace one of its own (`Workspaces::adopt`), at
/// every load, so it's idempotent. `true` when a record changed.
pub(super) fn migrate(workspaces: &crate::workspace::Workspaces, records: &mut [SessionRecord]) -> bool {
    let mut changed = false;
    for record in records.iter_mut().filter(|r| r.mode == Mode::Worktree && r.workspace_id.is_none()) {
        match workspaces.adopt(record) {
            Ok(workspace) => {
                record.workspace_id = Some(workspace.id);
                changed = true;
            }
            Err(e) => tracing::warn!("moving a worktree session into a workspace failed: {e}"),
        }
    }
    changed
}
