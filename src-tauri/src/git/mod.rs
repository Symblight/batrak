//! Git integration through the `git` CLI (so the user's hooks, LFS and credential helpers apply):
//! status and HEAD contents for the editor, commits, worktrees and applying their work for sessions.

// Worktrees and applying their work are used by sessions (stage 3); tested here already.
#[allow(dead_code)]
pub mod apply;
pub mod binary;
pub mod blob;
pub mod branch;
pub mod cache;
pub mod commit;
pub mod exec;
pub mod lock;
pub mod remote;
pub mod repo;
#[allow(dead_code)]
pub mod worktree;

#[cfg(test)]
pub(crate) mod test_repo;
