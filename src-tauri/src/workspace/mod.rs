//! Workspaces: a project's tasks (docs/specs/workspaces.md). A workspace has a name, its own git
//! worktree in app data on branch `brama/<slug>`, and chats (sessions) that run in its folder.
//! Main, the project's own folder, is not stored.

// Wired up step by step (spec Phase 1); goes once the commands use every part.
#![allow(dead_code, unused_imports)]

mod store;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub use store::Store;

/// Where a workspace's name comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NameSource {
    /// Its first chat's: the first message's line, then the agent's title.
    Agent,
    /// The user named it: chats no longer rename it.
    User,
}

/// A workspace as stored in `workspaces.json`. Folder, worktree and branch never change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    /// Canonical project root.
    pub project_path: PathBuf,
    pub name: String,
    pub name_source: NameSource,
    /// The project's folder in the worktree: its chats' cwd.
    pub folder: PathBuf,
    pub worktree_path: PathBuf,
    pub branch: String,
    pub base_commit: String,
    /// The branch it was created from; `None` for the project's HEAD then.
    #[serde(default)]
    pub base_branch: Option<String>,
    pub created_at: String,
    /// A turn of one of its chats started or ended.
    #[serde(default)]
    pub last_active_at: Option<String>,
}

#[cfg(test)]
mod tests;
