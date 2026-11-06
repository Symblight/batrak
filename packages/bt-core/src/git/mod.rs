//! Git through the `git` CLI (so the user's hooks, LFS and credential helpers apply): what sessions
//! and workspaces need, worktrees and applying their work.

pub mod apply;
pub mod binary;
pub mod blob;
pub mod branches;
pub mod compare;
pub mod exec;
pub mod line_counts;
pub mod lock;
pub mod remote;
pub mod repo;
pub mod revert;
pub mod status;
pub mod temp_file;
pub mod worktree;

#[cfg(any(test, feature = "test-support"))]
pub mod test_repo;
