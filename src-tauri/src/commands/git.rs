//! Git commands for an opened root: branch and file status, file contents at HEAD, and commits.

use tauri::State;

use crate::git::cache::StatusReply;
use crate::git::remote::{self, RemoteError, RemoteOp};
use crate::git::{binary, blob, branch, commit, repo};
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

/// Local branches a worktree session can start from, most recently committed first.
#[tauri::command]
pub async fn git_branches(workspaces: State<'_, Workspaces>, root_id: String) -> Result<Vec<String>, String> {
    let root = workspaces.get(&root_id)?;
    blocking(move || repo::branches(binary::git()?, &root.path)).await?
}

/// The branch popover's lists: local branches with their counts and age, and the remote branches
/// that have no local one yet.
#[tauri::command]
pub async fn git_branches_detail(workspaces: State<'_, Workspaces>, root_id: String) -> Result<branch::BranchList, String> {
    let root = workspaces.get(&root_id)?;
    blocking(move || branch::list(binary::git()?, &root.path)).await?
}

/// Switches the root's checkout to `branch` (`create`: makes it from HEAD; `remote`: makes it tracking
/// `<remote>/<branch>`) and replies with the new state. Git's refusal, e.g. local changes a switch
/// would overwrite, is the error.
#[tauri::command]
pub async fn git_switch(
    workspaces: State<'_, Workspaces>,
    root_id: String,
    branch: String,
    create: bool,
    remote: Option<String>,
) -> Result<repo::RepoState, String> {
    let root = workspaces.get(&root_id)?;
    let state = blocking(move || {
        let git = binary::git()?;
        branch::switch(git, &root.path, &branch, create, remote.as_deref())?;
        // The reply must carry the new state even where the repository files keep their mtimes.
        root.git.invalidate();
        root.git.head(git, &root.path, root.epoch())?.ok_or_else(|| "Not a git repository".to_owned())
    })
    .await??;
    tracing::info!(create, "switched branch");
    Ok(state)
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

/// Fetches, pulls (fast-forward, rebase or merge), pushes, publishes or force-pushes (`expected` is the
/// upstream commit it replaces) the root's current branch, or aborts a pull stopped on a conflict, and
/// replies with its new state. Never prompts for credentials; a failure carries its kind and git's message.
#[tauri::command]
pub async fn git_remote(
    workspaces: State<'_, Workspaces>,
    root_id: String,
    action: RemoteOp,
    expected: Option<String>,
) -> Result<repo::RepoState, RemoteError> {
    let root = workspaces.get(&root_id).map_err(RemoteError::other)?;
    let result = blocking(move || {
        let git = binary::git().map_err(RemoteError::other)?;
        let state = root
            .git
            .head(git, &root.path, root.epoch())
            .map_err(RemoteError::other)?
            .ok_or_else(|| RemoteError::other("Not a git repository"))?;
        remote::run(git, &root.path, action, &state, expected.as_deref())?;
        // The reply must carry the new counts even where the repository files keep their mtimes.
        root.git.invalidate();
        root.git
            .head(git, &root.path, root.epoch())
            .map_err(RemoteError::other)?
            .ok_or_else(|| RemoteError::other("Not a git repository"))
    })
    .await
    .map_err(RemoteError::other)?;
    match &result {
        Ok(_) => tracing::info!(?action, "git remote operation done"),
        Err(e) => tracing::info!(?action, kind = ?e.kind, "git remote operation failed"),
    }
    result
}

/// What a background fetch found: the branch's state afterwards, and why it couldn't fetch if it couldn't.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchQuiet {
    pub repo: Option<repo::RepoState>,
    pub error: Option<RemoteError>,
}

/// Fetches the root's branch remote for the counts on the remote chip, without prompting. A failure
/// is data, not an error: nobody asked for this fetch, so nobody is told but the chip's tooltip.
#[tauri::command]
pub async fn git_fetch_quiet(workspaces: State<'_, Workspaces>, root_id: String) -> Result<FetchQuiet, String> {
    let root = workspaces.get(&root_id)?;
    blocking(move || {
        let git = binary::git()?;
        let Some(state) = root.git.head(git, &root.path, root.epoch())? else {
            return Ok(FetchQuiet { repo: None, error: None });
        };
        let error = remote::fetch_quietly(git, &root.path, &state);
        if let Some(e) = &error {
            tracing::debug!(kind = ?e.kind, "background fetch failed");
        }
        Ok(FetchQuiet { repo: root.git.head(git, &root.path, root.epoch())?, error })
    })
    .await?
}
