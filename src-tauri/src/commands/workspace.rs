//! Workspace commands. All are async so scans and searches never run on the main thread.

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State, Window};

use crate::workspace::quick_open::{QuickOpenItem, QuickOpenKind};
use crate::workspace::search::{self, SearchEvent, SearchOptions};
use crate::workspace::snapshot::Entry;
use crate::workspace::Workspaces;

use super::blocking;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedRoot {
    pub root_id: String,
    /// Canonical absolute path of the root; entry paths are relative to it.
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpenResult {
    pub items: Vec<QuickOpenItem>,
    /// A newer query superseded this one; the frontend drops it.
    pub cancelled: bool,
}

/// Scans a folder and starts watching it. A newer open from the same window cancels this one's
/// scan; it then fails with `workspace::SUPERSEDED`.
#[tauri::command]
pub async fn open_workspace(
    app: AppHandle,
    window: Window,
    workspaces: State<'_, Workspaces>,
    path: String,
) -> Result<OpenedRoot, String> {
    let workspaces = workspaces.inner().clone();
    let group = window.label().to_owned();
    let root = blocking(move || {
        let root = workspaces.open(app, &PathBuf::from(path), &group)?;
        // A read-only folder still opens; it just has no project config.
        if let Err(e) = crate::config::ensure_project_dir(&root.path) {
            tracing::info!("no .brama folder: {e}");
        }
        Ok::<_, String>(root)
    })
    .await??;
    Ok(OpenedRoot { root_id: root.id.clone(), path: root.path.to_string_lossy().into_owned() })
}

/// Scans a worktree session's folder for the Files tree and starts watching it. Refused for a
/// local session, or a worktree not checked out yet.
#[tauri::command]
pub async fn open_session_root(
    app: AppHandle,
    window: Window,
    workspaces: State<'_, Workspaces>,
    sessions: State<'_, crate::session::Sessions>,
    session_id: String,
) -> Result<OpenedRoot, String> {
    let folder = sessions.worktree_folder(&session_id)?;
    let workspaces = workspaces.inner().clone();
    let group = window.label().to_owned();
    let root = blocking(move || workspaces.open_session(app, &folder, &group)).await??;
    Ok(OpenedRoot { root_id: root.id.clone(), path: root.path.to_string_lossy().into_owned() })
}

#[tauri::command]
pub async fn close_workspace(workspaces: State<'_, Workspaces>, root_id: String) -> Result<(), String> {
    workspaces.close(&root_id);
    Ok(())
}

/// Closes every root this window opened. Called when its page starts, so roots kept open by the
/// page before a reload don't outlive it.
#[tauri::command]
pub async fn close_window_workspaces(window: Window, workspaces: State<'_, Workspaces>) -> Result<(), String> {
    workspaces.close_group(window.label());
    Ok(())
}

/// Scans a root again from disk (the Files column's Refresh); what changed goes out as
/// `workspace://changed`, like the watcher's batches.
#[tauri::command]
pub async fn rescan_workspace(workspaces: State<'_, Workspaces>, root_id: String) -> Result<(), String> {
    let root = workspaces.get(&root_id)?;
    tracing::info!(path = %root.path.display(), "rescan root");
    blocking(move || root.rescan()).await
}

/// Children of a directory (`""` = the root). Ignored directories are read on first request.
#[tauri::command]
pub async fn list_dir(workspaces: State<'_, Workspaces>, root_id: String, path: String) -> Result<Vec<Entry>, String> {
    let root = workspaces.get(&root_id)?;
    blocking(move || {
        if let Some(entries) = root.read().list_dir(&path) {
            return Ok(entries);
        }
        let mut snapshot = root.write();
        if !snapshot.is_loaded(&path) {
            snapshot.load_ignored_dir(&path)?;
        }
        Ok(snapshot.list_dir(&path).unwrap_or_default())
    })
    .await?
}

#[tauri::command]
pub async fn quick_open(
    workspaces: State<'_, Workspaces>,
    root_id: String,
    query: String,
    kind: Option<QuickOpenKind>,
) -> Result<QuickOpenResult, String> {
    let root = workspaces.get(&root_id)?;
    let items = blocking(move || root.quick_open(&query, kind.unwrap_or_default())).await?;
    Ok(QuickOpenResult { cancelled: items.is_none(), items: items.unwrap_or_default() })
}

/// Records a file as recently opened (boosts it in Quick Open). `path` is relative.
#[tauri::command]
pub async fn note_file_opened(workspaces: State<'_, Workspaces>, root_id: String, path: String) -> Result<(), String> {
    workspaces.get(&root_id)?.note_opened(path);
    Ok(())
}

/// Starts a search in the background and returns immediately; results arrive on `channel`.
/// Starting a new search cancels the previous one of this root in the same `slot` (`"panel"`,
/// `"dialog"`).
#[tauri::command]
pub async fn find_in_files(
    workspaces: State<'_, Workspaces>,
    root_id: String,
    slot: String,
    options: SearchOptions,
    channel: Channel<SearchEvent>,
) -> Result<(), String> {
    let root = workspaces.get(&root_id)?;
    let cancel = root.start_search(&slot);
    std::thread::spawn(move || {
        // TODO: search unsaved editor buffers too: take their text here and search it
        // instead of the disk version of the same paths.
        let files: Vec<(String, u64)> = {
            let snapshot = root.read();
            let mut files: Vec<_> = snapshot.files().map(|e| (e.path.clone(), e.size)).collect();
            files.sort_unstable();
            files
        };
        search::run(&root.path, files, &options, &cancel, &|event| {
            let _ = channel.send(event);
        });
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_search(workspaces: State<'_, Workspaces>, root_id: String, slot: String) -> Result<(), String> {
    workspaces.get(&root_id)?.cancel_search(&slot);
    Ok(())
}
