//! Worktree sessions: their folders, changes, Apply Locally, Check Out Branch, and tidying at launch.

use super::*;

impl Sessions {
    /// A worktree session's folder (its agent's cwd), once it's checked out; the Files tree lists it.
    pub fn worktree_folder(&self, id: &str) -> Result<PathBuf, String> {
        let state = self.get(id)?;
        let record = lock(&state.record);
        if record.mode != Mode::Worktree {
            return Err(format!("session {id} doesn't run in a worktree"));
        }
        if !record.agent_cwd.is_dir() {
            return Err(format!("{}: the worktree isn't checked out", record.agent_cwd.display()));
        }
        Ok(record.agent_cwd.clone())
    }

    /// Applies a worktree session's work since its base (commits and uncommitted changes) to the
    /// project's checkout, unstaged; a checkout that moved on gets a three-way merge. Refused while
    /// a turn runs.
    pub async fn apply_locally(&self, id: &str) -> Result<crate::git::apply::ApplyOutcome, String> {
        let state = self.get(id)?;
        let (dir, base) = self.worktree_of(id)?;
        let _slot = Self::idle_worktree(&state)?;
        let project = state.record().project_path;
        let outcome = tokio::task::spawn_blocking(move || {
            crate::git::apply::apply_locally(crate::git::binary::git()?, &dir, &base, &project)
        })
        .await
        .map_err(|e| e.to_string())??;
        tracing::info!(session = %id, ?outcome, "applied the worktree's work to the project");
        Ok(outcome)
    }

    /// Hands a worktree session's branch to the project: stops the agent and checks the branch out
    /// in the project's checkout (the worktree is left detached; the session goes on only once the
    /// project is on another branch). Refused while a turn runs or the worktree has uncommitted
    /// changes, which a checkout would leave behind.
    pub async fn check_out_branch(&self, id: &str) -> Result<(), String> {
        let state = self.get(id)?;
        self.worktree_of(id)?;
        let _slot = Self::idle_worktree(&state)?;
        let record = state.record();
        let (Some(root), Some(branch)) = (record.worktree_path, record.branch) else {
            return Err("the session's worktree is missing from its record".to_owned());
        };
        let check = root.clone();
        let dirty = tokio::task::spawn_blocking(move || crate::git::worktree::is_dirty(crate::git::binary::git()?, &check))
            .await
            .map_err(|e| e.to_string())??;
        if dirty {
            return Err("The worktree has uncommitted changes, which a checkout would leave behind: Apply Locally brings them, or ask the agent to commit them".to_owned());
        }
        self.inner.stop(&state).await;
        self.inner.set_status(&state, SessionStatus::Stopped, None);
        let project = record.project_path;
        let handed = branch.clone();
        tokio::task::spawn_blocking(move || {
            crate::git::apply::check_out_branch(crate::git::binary::git()?, &root, &handed, &project)
        })
        .await
        .map_err(|e| e.to_string())??;
        tracing::info!(session = %id, %branch, "checked the session's branch out in the project");
        Ok(())
    }

    /// Takes the session's turn slot for git work on its worktree, so no prompt starts while it runs
    /// (`send_prompt` then refuses); released when the guard drops. Refused while a turn runs.
    fn idle_worktree(state: &Arc<SessionState>) -> Result<SlotGuard, String> {
        if state.turn_running.swap(true, Ordering::SeqCst) {
            return Err("The agent is working in the worktree; wait for its turn to end, or stop it".to_owned());
        }
        Ok(SlotGuard(Arc::clone(state)))
    }

    /// A worktree session's changed files since its base commit, relative to its folder. Blocking.
    pub fn changes(&self, id: &str) -> Result<Vec<crate::git::repo::FileStatus>, String> {
        let (dir, base) = self.worktree_of(id)?;
        crate::git::apply::changed_since(crate::git::binary::git()?, &dir, &base)
    }

    /// A worktree session's file (relative to its folder) at its base commit; `None` when it
    /// wasn't there, is binary or too large. Blocking.
    pub fn file_at_base(&self, id: &str, path: &str) -> Result<Option<String>, String> {
        crate::workspace::checked_rel(path)?;
        let (dir, base) = self.worktree_of(id)?;
        crate::git::blob::file_at(crate::git::binary::git()?, &dir, &base, path)
    }

    /// A worktree session's folder and base commit.
    fn worktree_of(&self, id: &str) -> Result<(PathBuf, String), String> {
        let record = self.get(id)?.record();
        match (record.mode, record.base_commit) {
            (Mode::Worktree, Some(base)) if record.agent_cwd.is_dir() => Ok((record.agent_cwd, base)),
            (Mode::Worktree, Some(_)) => Err(format!("{}: the worktree isn't checked out", record.agent_cwd.display())),
            _ => Err("only worktree sessions have changes of their own".to_owned()),
        }
    }

    /// At launch: drops the worktree metadata of deleted folders in every project with worktree
    /// sessions, and removes the worktrees in app data no session owns (left by a removal that
    /// failed), unless they hold uncommitted work. Branches stay. Blocking.
    pub fn tidy_worktrees(&self) {
        let records = self.inner.known();
        let worktrees: Vec<&SessionRecord> = records.iter().filter(|r| r.mode == Mode::Worktree).collect();
        let projects: std::collections::HashSet<&Path> = worktrees.iter().map(|r| r.project_path.as_path()).collect();
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
                // Asked of the live sessions, not a list read earlier: one created meanwhile may be
                // checking this folder out.
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

    /// Whether a session's worktree is at `path`.
    fn owns_worktree(&self, path: &Path) -> bool {
        self.inner.known().iter().any(|record| record.worktree_path.as_deref() == Some(path))
    }
}
