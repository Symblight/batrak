//! The editor's git: status and HEAD contents, commits; the rest comes from the core.

pub use bt_core::git::*;

pub mod blob;
pub mod branches;
pub mod cache;
pub mod commit;
pub mod compare;
pub mod line_counts;
pub mod remote;
pub mod repo;
pub mod revert;
pub mod status;
pub mod workspace_changes;
