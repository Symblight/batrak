//! Worktrees in app data: tidying them at launch.

use super::*;

impl Sessions {
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
                if let Err(e) = crate::workspace::checkout::remove_orphan(&path) {
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
