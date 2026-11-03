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

    /// The ids of a workspace's chats.
    fn chats_of(&self, workspace: &str) -> Vec<String> {
        self.inner.known().into_iter().filter(|r| r.workspace_id.as_deref() == Some(workspace)).map(|r| r.session_id).collect()
    }
}
