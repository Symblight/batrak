//! Workspace commands (docs/specs/workspaces.md). Every change reaches all windows as
//! `workspaces://changed` (`{ projectPath }`), through the `Notifier`.

use std::path::PathBuf;

use tauri::State;

use crate::session::{DeletePreview, Sessions};
use crate::workspace::Workspace;

use super::blocking;

fn canonical(project_path: &str) -> Result<PathBuf, String> {
    dunce::canonicalize(project_path).map_err(|e| format!("{project_path}: {e}"))
}

/// A project's workspaces, oldest first (Main is the page's).
#[tauri::command]
pub async fn workspaces_list(sessions: State<'_, Sessions>, project_path: String) -> Result<Vec<Workspace>, String> {
    let workspaces = sessions.workspaces().clone();
    blocking(move || Ok(workspaces.pages(&canonical(&project_path)?))).await?
}

/// Creates a workspace from `base_branch` (default: the project's base branch) and checks its
/// folder out in the background (`creating` until then); its chats' starts wait for it. Without a
/// `name` it's called after its branch until its first chat names it.
#[tauri::command]
pub async fn workspace_create(
    sessions: State<'_, Sessions>,
    project_path: String,
    name: Option<String>,
    base_branch: Option<String>,
) -> Result<Workspace, String> {
    let workspaces = sessions.workspaces().clone();
    blocking(move || {
        let project = canonical(&project_path)?;
        let record = workspaces.place(&project, name.as_deref(), base_branch.as_deref())?;
        let checkout = workspaces.clone();
        let id = record.id.clone();
        tauri::async_runtime::spawn_blocking(move || checkout.check_out(&id));
        workspaces.pages(&project).into_iter().find(|w| w.record.id == record.id).ok_or_else(|| "the workspace is gone".to_owned())
    })
    .await?
}

#[tauri::command]
pub async fn workspace_rename(sessions: State<'_, Sessions>, id: String, name: String) -> Result<(), String> {
    let workspaces = sessions.workspaces().clone();
    blocking(move || workspaces.rename(&id, &name).map(drop)).await?
}

/// What deleting would touch: uncommitted files, commits past the base, chats in a turn.
#[tauri::command]
pub async fn workspace_delete_preview(sessions: State<'_, Sessions>, id: String) -> Result<DeletePreview, String> {
    sessions.workspace_delete_preview(&id).await
}

/// Deletes a workspace, its chats and its folder; uncommitted work is saved on its branch, which
/// stays when `keep_branch` and it has commits.
#[tauri::command]
pub async fn workspace_delete(sessions: State<'_, Sessions>, id: String, keep_branch: bool) -> Result<(), String> {
    sessions.delete_workspace(&id, keep_branch).await
}

/// Checks a deleted folder out again from the workspace's branch.
#[tauri::command]
pub async fn workspace_recreate(sessions: State<'_, Sessions>, id: String) -> Result<(), String> {
    sessions.recreate_workspace(&id).await
}

/// Applies the workspace's work since its base to Main's checkout, unstaged.
#[tauri::command]
pub async fn workspace_apply_locally(sessions: State<'_, Sessions>, id: String) -> Result<crate::git::apply::ApplyOutcome, String> {
    sessions.workspace_apply_locally(&id).await
}

/// Stops the workspace's chats and checks its branch out in Main.
#[tauri::command]
pub async fn workspace_check_out_branch(sessions: State<'_, Sessions>, id: String) -> Result<(), String> {
    sessions.workspace_check_out_branch(&id).await
}

/// The workspace's changed files since its base, relative to its folder.
#[tauri::command]
pub async fn workspace_changes(sessions: State<'_, Sessions>, id: String) -> Result<Vec<crate::git::repo::FileStatus>, String> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.workspace_changes(&id)).await?
}

/// A workspace's file at its base commit; `null` when new, binary or too large.
#[tauri::command]
pub async fn workspace_file_at_base(sessions: State<'_, Sessions>, id: String, path: String) -> Result<Option<String>, String> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.workspace_file_at_base(&id, &path)).await?
}
