//! Workspaces' chats: what a workspace does to the sessions that run in it.

use super::*;

impl Sessions {
    /// Deletes a workspace: each of its chats is removed as Remove session removes one (a running
    /// turn ends `cancelled`), then its folder (`Workspaces::discard`).
    pub async fn delete_workspace(&self, id: &str, keep_branch: bool) -> Result<(), String> {
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

    /// Applies a workspace's work since its base (commits and uncommitted changes) to the
    /// project's checkout, unstaged; a checkout that moved on gets a three-way merge. Refused while
    /// a chat of it is in a turn.
    pub async fn workspace_apply_locally(&self, id: &str) -> Result<crate::git::apply::ApplyOutcome, String> {
        let (dir, base) = self.checked_out(id)?;
        let _held = self.hold_workspace(id)?;
        let project = self.inner.workspaces.get(id)?.project_path;
        let outcome = tokio::task::spawn_blocking(move || {
            crate::git::apply::apply_locally(crate::git::binary::git()?, &dir, &base, &project)
        })
        .await
        .map_err(|e| e.to_string())??;
        tracing::info!(workspace = %id, ?outcome, "applied the workspace's work to the project");
        Ok(outcome)
    }

    /// Hands a workspace's branch to the project: stops every chat's agent and checks the branch
    /// out in the project's checkout (the worktree is left detached; its chats go on only once the
    /// project is on another branch). Refused while a chat is in a turn or the worktree has
    /// uncommitted changes, which a checkout would leave behind.
    pub async fn workspace_check_out_branch(&self, id: &str) -> Result<(), String> {
        self.checked_out(id)?;
        let held = self.hold_workspace(id)?;
        let workspace = self.inner.workspaces.get(id)?;
        let check = workspace.worktree_path.clone();
        let dirty = tokio::task::spawn_blocking(move || crate::git::worktree::is_dirty(crate::git::binary::git()?, &check))
            .await
            .map_err(|e| e.to_string())??;
        if dirty {
            return Err("The worktree has uncommitted changes, which a checkout would leave behind: Apply to Main brings them, or ask the agent to commit them".to_owned());
        }
        for state in &held.0 {
            self.inner.stop(&state.0).await;
            self.inner.set_status(&state.0, SessionStatus::Stopped, None);
        }
        let (root, branch, project) = (workspace.worktree_path, workspace.branch.clone(), workspace.project_path);
        tokio::task::spawn_blocking(move || crate::git::apply::check_out_branch(crate::git::binary::git()?, &root, &branch, &project))
            .await
            .map_err(|e| e.to_string())??;
        tracing::info!(workspace = %id, branch = %workspace.branch, "checked the workspace's branch out in the project");
        Ok(())
    }

    /// A workspace's changed files since its base commit, relative to its folder. Blocking.
    pub fn workspace_changes(&self, id: &str) -> Result<Vec<crate::git::repo::FileStatus>, String> {
        let (dir, base) = self.checked_out(id)?;
        crate::git::apply::changed_since(crate::git::binary::git()?, &dir, &base)
    }

    /// A workspace's file (relative to its folder) at its base commit; `None` when it wasn't
    /// there, is binary or too large. Blocking.
    pub fn workspace_file_at_base(&self, id: &str, path: &str) -> Result<Option<String>, String> {
        crate::roots::checked_rel(path)?;
        let (dir, base) = self.checked_out(id)?;
        crate::git::blob::file_at(crate::git::binary::git()?, &dir, &base, path)
    }

    /// A workspace's folder and base commit, once its folder is there.
    fn checked_out(&self, id: &str) -> Result<(PathBuf, String), String> {
        let workspace = self.inner.workspaces.get(id)?;
        if !workspace.folder.is_dir() {
            return Err(format!("{}: the workspace's folder isn't checked out", workspace.folder.display()));
        }
        Ok((workspace.folder, workspace.base_commit))
    }

    /// Claims the turn slot of every chat of a workspace for git work on its folder, all or none,
    /// so no prompt starts while it runs (`send_prompt` then refuses); released when the hold
    /// drops. Refused, naming the chat, while one is in a turn.
    pub(super) fn hold_workspace(&self, id: &str) -> Result<WorkspaceHold, String> {
        let chats: Vec<Arc<SessionState>> = lock(&self.inner.sessions)
            .values()
            .filter(|s| lock(&s.record).workspace_id.as_deref() == Some(id))
            .cloned()
            .collect();
        let mut held = WorkspaceHold(Vec::new());
        for state in chats {
            let record = state.record();
            if in_turn(record.status) || state.turn_running.swap(true, Ordering::SeqCst) {
                // `held` drops: the slots claimed so far are released.
                return Err(format!("\u{201c}{}\u{201d} is working in this workspace; wait for its turn to end, or stop it", record.title));
            }
            held.0.push(SlotGuard(state));
        }
        Ok(held)
    }

    /// Checks a workspace's folder out again from its branch, after it was deleted outside Brama
    /// (or its first checkout failed). Its chats start again from then on.
    pub async fn recreate_workspace(&self, id: &str) -> Result<(), String> {
        let workspaces = self.inner.workspaces.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || workspaces.check_out(&id)).await.map_err(|e| e.to_string())?
    }

    /// The ids of a workspace's chats.
    fn chats_of(&self, workspace: &str) -> Vec<String> {
        self.inner.known().into_iter().filter(|r| r.workspace_id.as_deref() == Some(workspace)).map(|r| r.session_id).collect()
    }
}

impl Inner {
    /// A workspace the agent names (`NameSource::Agent`) takes its first chat's agent title.
    pub(super) fn name_workspace_after(&self, chat: &SessionRecord) {
        let (Some(id), Some(title)) = (chat.workspace_id.as_deref(), chat.agent_title.as_deref()) else { return };
        let first = self
            .known()
            .into_iter()
            .filter(|r| r.workspace_id.as_deref() == Some(id))
            .min_by(|a, b| (&a.created_at, &a.session_id).cmp(&(&b.created_at, &b.session_id)));
        if first.is_none_or(|r| r.session_id != chat.session_id) {
            return;
        }
        if let Err(e) = self.workspaces.follow_title(id, title) {
            tracing::warn!(workspace = %id, "naming the workspace after its chat failed: {e}");
        }
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

/// The turn slots of a workspace's chats, claimed for git work (`hold_workspace`).
pub(super) struct WorkspaceHold(Vec<SlotGuard>);
