//! Git commands for an opened root: branch and file status, file contents at HEAD, and commits.

use tauri::State;

use crate::git::cache::StatusReply;
use crate::git::{binary, blob, commit, repo};
use crate::roots::Roots;
use crate::util::checked_rel;

use super::blocking;

/// Branch and upstream of the root's repository, without scanning files; `null` when the root
/// isn't in one. Fails with "git not found" when git isn't installed.
#[tauri::command]
pub async fn git_head(roots: State<'_, Roots>, root_id: String) -> Result<Option<repo::RepoState>, String> {
    let root = roots.get(&root_id)?;
    blocking(move || root.git.head(binary::git()?, &root.path, root.epoch())).await?
}

/// Branch and changed files of the root's repository. Scans the working tree only when something
/// changed since the last scan (or with `force`); `unchanged` when the caller's `since` version is
/// still current. Fails with "git not found" when git isn't installed.
#[tauri::command]
pub async fn git_status(
    roots: State<'_, Roots>,
    root_id: String,
    since: Option<u64>,
    force: bool,
) -> Result<StatusReply, String> {
    let root = roots.get(&root_id)?;
    blocking(move || root.git.status(binary::git()?, &root.path, root.epoch(), since, force)).await?
}

/// Text of a file at HEAD, the editor's diff baseline; `null` when it has none (not committed, or
/// not in a repository). Fails, saying why, when it has no text to diff (binary, too large).
/// `path` is relative to the root.
#[tauri::command]
pub async fn git_file_at_head(
    roots: State<'_, Roots>,
    root_id: String,
    path: String,
) -> Result<Option<String>, String> {
    let root = roots.get(&root_id)?;
    checked_rel(&path)?;
    blocking(move || blob::file_at_head(binary::git()?, &root.path, &path)).await?
}

/// Branches a workspace can be based on: local and remote-tracking ones, and the remote's default.
#[tauri::command]
pub async fn git_branches(roots: State<'_, Roots>, root_id: String) -> Result<repo::BranchList, String> {
    let root = roots.get(&root_id)?;
    blocking(move || repo::branch_list(binary::git()?, &root.path)).await?
}

/// Fetches every remote of the root's repository (New workspace's refresh), pruning deleted branches.
#[tauri::command]
pub async fn git_fetch(roots: State<'_, Roots>, root_id: String) -> Result<(), String> {
    let root = roots.get(&root_id)?;
    tracing::info!(root = %root.path.display(), "fetching remotes");
    blocking(move || repo::fetch(binary::git()?, &root.path)).await?
}

/// Message of the last commit, which Amend starts from; `null` before the first commit.
#[tauri::command]
pub async fn git_last_commit_message(
    roots: State<'_, Roots>,
    root_id: String,
) -> Result<Option<String>, String> {
    let root = roots.get(&root_id)?;
    blocking(move || repo::last_commit_message(binary::git()?, &root.path)).await?
}

/// Commits `paths` (relative to the root; picked files, both sides of a rename) as they are in the
/// working tree, with `message`; `amend` replaces the last commit. The user's hooks run, and their
/// failure is the error.
#[tauri::command]
pub async fn git_commit(
    roots: State<'_, Roots>,
    root_id: String,
    paths: Vec<String>,
    message: String,
    amend: bool,
) -> Result<commit::Committed, String> {
    let root = roots.get(&root_id)?;
    for path in &paths {
        checked_rel(path)?;
    }
    let count = paths.len();
    let done = blocking(move || commit::commit(binary::git()?, &root.path, &paths, &message, amend)).await??;
    tracing::info!(sha = %done.sha, files = count, amend, "committed");
    Ok(done)
}
