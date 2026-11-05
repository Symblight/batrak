//! Git integration through the `git` CLI (so the user's hooks, LFS and credential helpers apply):
//! status and HEAD contents for the editor, commits, worktrees and applying their work for sessions.

pub mod apply;
pub mod binary;
pub mod blob;
pub mod cache;
pub mod commit;
pub mod exec;
pub mod lock;
pub mod remote;
pub mod repo;
pub mod worktree;

#[cfg(test)]
pub(crate) mod test_repo;
