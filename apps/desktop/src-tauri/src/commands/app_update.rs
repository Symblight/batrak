//! Updating the app: a thin map from each command to `AppUpdates`.

use tauri::State;

use crate::app_update::{release_page, restart_blockers, AppUpdateState, AppUpdates, CheckBy, RestartBlockers};
use crate::session::Sessions;
use crate::terminal::Terminals;

use super::{blocking, fs};

#[tauri::command]
pub async fn app_update_state(updates: State<'_, AppUpdates>) -> Result<AppUpdateState, String> {
    Ok(updates.page_state())
}

/// The check from About: the new state, or an error for its row.
#[tauri::command]
pub async fn app_update_check(updates: State<'_, AppUpdates>) -> Result<AppUpdateState, String> {
    let updates = updates.inner().clone();
    blocking(move || updates.check(CheckBy::User)).await?
}

/// Starts the download, or Retry, and returns as it starts.
#[tauri::command]
pub async fn app_update_download(updates: State<'_, AppUpdates>) -> Result<AppUpdateState, String> {
    let updates = updates.inner().clone();
    if let Some(job) = updates.begin_download()? {
        let running = updates.clone();
        tauri::async_runtime::spawn_blocking(move || running.run_download(job));
    }
    Ok(updates.state())
}

#[tauri::command]
pub async fn app_update_cancel(updates: State<'_, AppUpdates>) -> Result<AppUpdateState, String> {
    Ok(updates.cancel())
}

#[tauri::command]
pub async fn app_update_on_next_launch(updates: State<'_, AppUpdates>, on: bool) -> Result<AppUpdateState, String> {
    let updates = updates.inner().clone();
    blocking(move || updates.set_on_next_launch(on)).await?
}

/// What a restart would stop, across all windows.
#[tauri::command]
pub async fn app_update_blockers(sessions: State<'_, Sessions>, terminals: State<'_, Terminals>) -> Result<RestartBlockers, String> {
    let (sessions, terminals) = (sessions.inner().clone(), terminals.inner().clone());
    blocking(move || {
        let busy: Vec<String> = terminals.busy(&terminals.ids()).into_iter().map(|busy| busy.id).collect();
        restart_blockers(sessions.working(), &busy, &sessions.cli_terminals())
    })
    .await
}

/// Ready only; the state says how it goes. A success restarts the app.
#[tauri::command]
pub async fn app_update_restart(updates: State<'_, AppUpdates>) -> Result<AppUpdateState, String> {
    let updates = updates.inner().clone();
    if updates.begin_restart() {
        let running = updates.clone();
        tauri::async_runtime::spawn_blocking(move || running.run_restart());
    }
    Ok(updates.state())
}

/// **Download manually**: the release page of the version the state is about.
#[tauri::command]
pub async fn app_update_open_release(updates: State<'_, AppUpdates>) -> Result<(), String> {
    let version = updates.release_version().ok_or("no release to open")?;
    blocking(move || fs::open_in_browser(&release_page(&version))).await?
}
