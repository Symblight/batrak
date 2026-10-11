//! Workspace commands. All are async so scans and searches never run on the main thread.

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State, Window};

use crate::workspace::quick_open::QuickOpenItem;
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
    let root = blocking(move || workspaces.open(app, &PathBuf::from(path), &group)).await??;
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
    dirs: Option<bool>,
) -> Result<QuickOpenResult, String> {
    let root = workspaces.get(&root_id)?;
    let items = blocking(move || root.quick_open(&query, dirs.unwrap_or(false))).await?;
    Ok(QuickOpenResult { cancelled: items.is_none(), items: items.unwrap_or_default() })
}

/// Records a file as recently opened (boosts it in Quick Open). `path` is relative.
#[tauri::command]
pub async fn note_file_opened(workspaces: State<'_, Workspaces>, root_id: String, path: String) -> Result<(), String> {
    workspaces.get(&root_id)?.note_opened(path);
    Ok(())
}

/// Starts a search in the background and returns immediately; results arrive on `channel`.
/// Starting a new search cancels the previous one of this root.
#[tauri::command]
pub async fn find_in_files(
    workspaces: State<'_, Workspaces>,
    root_id: String,
    options: SearchOptions,
    channel: Channel<SearchEvent>,
) -> Result<(), String> {
    let root = workspaces.get(&root_id)?;
    let cancel = root.start_search();
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
pub async fn cancel_search(workspaces: State<'_, Workspaces>, root_id: String) -> Result<(), String> {
    workspaces.get(&root_id)?.cancel_search();
    Ok(())
}
