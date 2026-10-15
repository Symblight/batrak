//! Git commands for an opened root: branch and file status, file contents at HEAD, and commits.

use tauri::State;

use crate::git::cache::StatusReply;
use crate::git::{binary, blob, commit, repo};
use crate::workspace::{checked_rel, Workspaces};

use super::blocking;

/// Branch and upstream of the root's repository, without scanning files; `null` when the root
/// isn't in one. Fails with "git not found" when git isn't installed.
#[tauri::command]
pub async fn git_head(workspaces: State<'_, Workspaces>, root_id: String) -> Result<Option<repo::RepoState>, String> {
    let root = workspaces.get(&root_id)?;
    blocking(move || root.git.head(binary::git()?, &root.path, root.epoch())).await?
}

/// Branch and changed files of the root's repository. Scans the working tree only when something
/// changed since the last scan (or with `force`); `unchanged` when the caller's `since` version is
/// still current. Fails with "git not found" when git isn't installed.
#[tauri::command]
pub async fn git_status(
    workspaces: State<'_, Workspaces>,
    root_id: String,
    since: Option<u64>,
    force: bool,
) -> Result<StatusReply, String> {
    let root = workspaces.get(&root_id)?;
    blocking(move || root.git.status(binary::git()?, &root.path, root.epoch(), since, force)).await?
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

/// Commits `paths` (relative to the root; picked files, both sides of a rename) as they are in the
/// working tree, with `message`; `amend` replaces the last commit. The user's hooks run, and their
/// failure is the error.
#[tauri::command]
pub async fn git_commit(
    workspaces: State<'_, Workspaces>,
    root_id: String,
    paths: Vec<String>,
    message: String,
    amend: bool,
) -> Result<commit::Committed, String> {
    let root = workspaces.get(&root_id)?;
    for path in &paths {
        checked_rel(path)?;
    }
    let count = paths.len();
    let done = blocking(move || commit::commit(binary::git()?, &root.path, &paths, &message, amend)).await??;
    tracing::info!(sha = %done.sha, files = count, amend, "committed");
    Ok(done)
}
