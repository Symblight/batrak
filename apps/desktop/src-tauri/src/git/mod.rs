//! The editor's git: status and HEAD contents, commits; the rest comes from the core.

pub use bt_core::git::*;

pub mod cache;
pub mod commit;
pub mod workspace_changes;
