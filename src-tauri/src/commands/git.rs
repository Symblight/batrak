//! Git commands for an opened root: branch and file status, and file contents at HEAD.

use tauri::State;

use crate::git::{binary, blob, repo};
use crate::workspace::{checked_rel, Workspaces};

use super::blocking;

/// Branch and upstream of the root's repository, without scanning files; `null` when the root
/// isn't in one. Fails with "git not found" when git isn't installed.
#[tauri::command]
pub async fn git_head(workspaces: State<'_, Workspaces>, root_id: String) -> Result<Option<repo::RepoState>, String> {
    let root = workspaces.get(&root_id)?;
    blocking(move || repo::head(binary::git()?, &root.path)).await?
}

/// Branch and changed files of the root's repository (scans the working tree, so only on demand);
/// `null` when the root isn't in one. Fails with "git not found" when git isn't installed.
#[tauri::command]
pub async fn git_status(workspaces: State<'_, Workspaces>, root_id: String) -> Result<Option<repo::Status>, String> {
    let root = workspaces.get(&root_id)?;
    blocking(move || repo::status(binary::git()?, &root.path)).await?
}

/// Text of a file at HEAD, the editor's diff baseline; `null` when it has none (not committed,
/// binary, too large, or not in a repository). `path` is relative to the root.
#[tauri::command]
pub async fn git_file_at_head(
    workspaces: State<'_, Workspaces>,
    root_id: String,
    path: String,
) -> Result<Option<String>, String> {
    let root = workspaces.get(&root_id)?;
    checked_rel(&path)?;
    blocking(move || blob::file_at_head(binary::git()?, &root.path, &path)).await?
}

/// Message of the last commit, which Amend starts from; `null` before the first commit.
#[tauri::command]
pub async fn git_last_commit_message(
    workspaces: State<'_, Workspaces>,
    root_id: String,
) -> Result<Option<String>, String> {
    let root = workspaces.get(&root_id)?;
    blocking(move || repo::last_commit_message(binary::git()?, &root.path)).await?
}
