//! Agent session commands. Events of a session reach a window through the channel it passed to
//! `session_create` / `session_open`.

use std::path::Path;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{State, Window};

use crate::session::env::Mode;
use crate::session::{CreateSession, Envelope, EventSink, PromptInput, Session, Sessions};

use super::blocking;

struct ChannelSink(Channel<Envelope>);

impl EventSink for ChannelSink {
    fn send(&self, envelope: &Envelope) -> bool {
        self.0.send(envelope.clone()).is_ok()
    }
}

fn sink(channel: Channel<Envelope>) -> Arc<dyn EventSink> {
    Arc::new(ChannelSink(channel))
}

#[tauri::command]
pub async fn list_sessions(sessions: State<'_, Sessions>) -> Result<Vec<Session>, String> {
    Ok(sessions.list())
}

#[tauri::command]
pub fn get_active_session() -> Option<String> {
    None
}

#[tauri::command]
pub fn set_active_session(_id: String) {}

/// A draft's first message: creates the session under the draft's id and starts its workspace
/// and agent in the background. Refused when a local session already runs in the project, or a
/// worktree one has no repository or `base_branch` to start from.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn session_create(
    window: Window,
    sessions: State<'_, Sessions>,
    session_id: String,
    project_path: String,
    agent_id: String,
    mode: Mode,
    title: String,
    model: Option<String>,
    base_branch: Option<String>,
    channel: Channel<Envelope>,
) -> Result<Session, String> {
    let request = CreateSession { session_id, project_path, agent_id, mode, title, model, base_branch };
    let sessions = sessions.inner().clone();
    let label = window.label().to_owned();
    blocking(move || sessions.create(request, &label, sink(channel))).await?
}

/// Sends a listed session's events to this window from now on, starting with its status.
#[tauri::command]
pub async fn session_open(
    window: Window,
    sessions: State<'_, Sessions>,
    session_id: String,
    channel: Channel<Envelope>,
) -> Result<Session, String> {
    sessions.attach(&session_id, window.label(), sink(channel))
}

#[tauri::command]
pub async fn session_send_prompt(
    sessions: State<'_, Sessions>,
    session_id: String,
    prompt: Vec<PromptInput>,
) -> Result<(), String> {
    sessions.send_prompt(&session_id, prompt)
}

#[tauri::command]
pub async fn session_cancel(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    sessions.cancel(&session_id)
}

/// `option_id: null` cancels the request.
#[tauri::command]
pub async fn session_respond_permission(
    sessions: State<'_, Sessions>,
    session_id: String,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    sessions.respond_permission(&session_id, &request_id, option_id)
}

#[tauri::command]
pub async fn session_stop(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    sessions.stop(&session_id).await
}

/// Removes a session: stops its agent and deletes its transcript and log. The project's files stay.
#[tauri::command]
pub async fn session_remove(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    sessions.remove(&session_id).await
}

/// Sets the title the session is listed by; returns the session as it is then.
#[tauri::command]
pub async fn session_rename(sessions: State<'_, Sessions>, session_id: String, title: String) -> Result<Session, String> {
    sessions.rename(&session_id, &title)
}

#[tauri::command]
pub async fn session_restart(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    sessions.restart(&session_id).await
}

/// Sets the agent's model, thought level or mode (`session/set_config_option`); the options as they
/// are then arrive as a `config-options` event.
#[tauri::command]
pub async fn session_set_config_option(
    sessions: State<'_, Sessions>,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<(), String> {
    sessions.set_config_option(&session_id, &config_id, &value).await
}

/// The session's recorded conversation, oldest first (see `session::transcript`), for the chat to
/// show again after a reload.
#[tauri::command]
pub async fn session_history(sessions: State<'_, Sessions>, session_id: String) -> Result<Vec<serde_json::Value>, String> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.history(&session_id)).await?
}

/// A worktree session's changed files since it started (its commits and uncommitted work),
/// relative to its folder.
#[tauri::command]
pub async fn session_changes(
    sessions: State<'_, Sessions>,
    session_id: String,
) -> Result<Vec<crate::git::repo::FileStatus>, String> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.changes(&session_id)).await?
}

/// A worktree session's file at the commit it started from, its diff's baseline; `null` when new,
/// binary or too large.
#[tauri::command]
pub async fn session_file_at_base(
    sessions: State<'_, Sessions>,
    session_id: String,
    path: String,
) -> Result<Option<String>, String> {
    let sessions = sessions.inner().clone();
    blocking(move || sessions.file_at_base(&session_id, &path)).await?
}

/// Applies a worktree session's work since it started to the project's checkout, unstaged;
/// `conflicts` lists files left with conflict markers by a three-way merge.
#[tauri::command]
pub async fn session_apply_locally(
    sessions: State<'_, Sessions>,
    session_id: String,
) -> Result<crate::git::apply::ApplyOutcome, String> {
    sessions.apply_locally(&session_id).await
}

/// Stops a worktree session's agent and checks its branch out in the project's checkout.
#[tauri::command]
pub async fn session_check_out_branch(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    sessions.check_out_branch(&session_id).await
}

/// Opens the agent's stderr log in the OS's default viewer.
#[tauri::command]
pub async fn session_open_log(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    let path = sessions.log_path(&session_id)?;
    blocking(move || open_file(&path)).await?
}

fn open_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err("The agent has written no log yet".to_owned());
    }
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(path).status();
    #[cfg(target_os = "windows")]
    let status = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer").raw_arg(format!("\"{}\"", path.display())).status()
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let status = std::process::Command::new("xdg-open").arg(path).status();
    status.map(|_| ()).map_err(|e| format!("{}: {e}", path.display()))
}
