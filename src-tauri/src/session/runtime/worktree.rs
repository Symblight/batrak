//! Worktree sessions: their folders, changes, Apply Locally, Check Out Branch, and tidying at launch.

use super::*;

impl Sessions {
    /// Applies the work of a chat's workspace to the project (`workspace_apply_locally`).
    pub async fn apply_locally(&self, id: &str) -> Result<crate::git::apply::ApplyOutcome, String> {
        self.workspace_apply_locally(&self.workspace_of_chat(id)?).await
    }

    /// Hands the branch of a chat's workspace to the project (`workspace_check_out_branch`).
    pub async fn check_out_branch(&self, id: &str) -> Result<(), String> {
        self.workspace_check_out_branch(&self.workspace_of_chat(id)?).await
    }

    /// The changes of a chat's workspace since its base (`workspace_changes`). Blocking.
    pub fn changes(&self, id: &str) -> Result<Vec<crate::git::repo::FileStatus>, String> {
        self.workspace_changes(&self.workspace_of_chat(id)?)
    }

    /// A file of a chat's workspace at its base (`workspace_file_at_base`). Blocking.
    pub fn file_at_base(&self, id: &str, path: &str) -> Result<Option<String>, String> {
        self.workspace_file_at_base(&self.workspace_of_chat(id)?, path)
    }

    /// The workspace a chat runs in.
    fn workspace_of_chat(&self, id: &str) -> Result<String, String> {
        self.get(id)?.record().workspace_id.ok_or_else(|| "only chats in a workspace (a worktree) have changes of their own".to_owned())
    }

    /// At launch: drops the worktree metadata of deleted folders in every project with
    /// workspaces, and removes the worktrees in app data no workspace owns (left by a removal
    /// that failed), unless they hold uncommitted work. Branches stay. Blocking.
    pub fn tidy_worktrees(&self) {
        let workspaces = self.inner.workspaces.store().list(None);
        let projects: std::collections::HashSet<&Path> = workspaces.iter().map(|w| w.project_path.as_path()).collect();
        if let Ok(git) = crate::git::binary::git() {
            for project in projects.into_iter().filter(|p| p.is_dir()) {
                if let Err(e) = crate::git::worktree::prune(git, project) {
                    tracing::info!(project = %project.display(), "pruning worktrees failed: {e}");
                }
            }
        }
        let Ok(groups) = std::fs::read_dir(self.inner.data_dir().join("worktrees")) else { return };
        for group in groups.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()) {
            let Ok(group) = dunce::canonicalize(&group) else { continue };
            for path in std::fs::read_dir(&group).into_iter().flatten().filter_map(Result::ok).map(|e| e.path()) {
                // Asked of the live list, not one read earlier: a workspace created meanwhile may
                // be checking this folder out.
                if !path.is_dir() || self.owns_worktree(&path) {
                    continue;
                }
                if let Err(e) = env::remove_orphan(&path) {
                    if e.contains("uncommitted") {
                        tracing::warn!("{e}");
                    } else {
                        tracing::info!("{e}");
                    }
                }
            }
            // Only when empty.
            let _ = std::fs::remove_dir(&group);
        }
    }

    /// Whether a workspace's worktree is at `path`.
    fn owns_worktree(&self, path: &Path) -> bool {
        self.inner.workspaces.store().list(None).iter().any(|w| w.worktree_path == path)
    }
}
