//! Git through the `git` CLI (so the user's hooks, LFS and credential helpers apply): what sessions
//! and workspaces need, worktrees and applying their work.

pub mod apply;
pub mod binary;
pub mod blob;
pub mod exec;
pub mod lock;
pub mod remote;
pub mod repo;
pub mod worktree;

#[cfg(any(test, feature = "test-support"))]
pub mod test_repo;
