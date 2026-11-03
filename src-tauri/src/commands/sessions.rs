//! Agent session commands. Events of a session reach a window through the channel it passed to
//! `session_create` / `session_open`.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State, Window};

use crate::session::{CliDraft, CliOpened, CliWindow, CreateSession, Envelope, EventSink, PromptInput, Session, Sessions, SyncReport, WorkspaceChoice};

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

/// The sessions listed so far this launch (a sync fills a project's: `sessions_sync`).
#[tauri::command]
pub async fn list_sessions(sessions: State<'_, Sessions>) -> Result<Vec<Session>, String> {
    Ok(sessions.list())
}

/// Every window hears a project's sessions after each sync.
pub const SESSIONS_SYNCED_EVENT: &str = "sessions://synced";

/// Asks the project's agents (`agent_ids`, else all) for its sessions; every window then hears
/// the project's sessions and the report (`sessions://synced`). Joins a sync already running.
#[tauri::command]
pub async fn sessions_sync(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    project_path: String,
    agent_ids: Option<Vec<String>>,
) -> Result<SyncReport, String> {
    let project = blocking({
        let path = project_path.clone();
        move || dunce::canonicalize(&path).map_err(|e| format!("{path}: {e}"))
    })
    .await??;
    let report = sessions.sync(&project, agent_ids.as_deref()).await;
    let project_id = project.to_string_lossy().into_owned();
    let listed: Vec<Session> = sessions.list().into_iter().filter(|s| s.project_id == project_id).collect();
    let _ = app.emit(SESSIONS_SYNCED_EVENT, serde_json::json!({ "projectPath": project_id, "sessions": listed, "report": report }));
    Ok(report)
}

/// A draft's first message: creates the session under the draft's id, in `workspace` (Main or a
/// stored one of the project), and starts its folder and agent in the background.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn session_create(
    window: Window,
    sessions: State<'_, Sessions>,
    session_id: String,
    project_path: String,
    agent_id: String,
    title: String,
    config: Option<BTreeMap<String, String>>,
    workspace: WorkspaceChoice,
    channel: Channel<Envelope>,
) -> Result<Session, String> {
    let config = config.unwrap_or_default();
    let request = CreateSession { session_id, project_path, agent_id, title, config, workspace };
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
) -> Result<String, String> {
    sessions.send_prompt(&session_id, prompt)
}

#[tauri::command]
pub async fn session_cancel(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    sessions.cancel(&session_id)
}

/// Stops one subagent of the session (`subagent_id`: its ACP session id).
#[tauri::command]
pub async fn session_cancel_subagent(sessions: State<'_, Sessions>, session_id: String, subagent_id: String) -> Result<(), String> {
    sessions.cancel_subagent(&session_id, &subagent_id)
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

/// Removes a session: stops its agent, deletes it in the agent (or hides it where the agent can't)
/// and deletes its log. The project's files stay.
#[tauri::command]
pub async fn session_remove(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    sessions.remove(&session_id).await
}

/// Sets the title the session is listed by; returns the session as it is then.
#[tauri::command]
pub async fn session_rename(sessions: State<'_, Sessions>, session_id: String, title: String) -> Result<Session, String> {
    sessions.rename(&session_id, &title)
}

/// Gives a renamed session back its agent's title; returns the session as it is then.
#[tauri::command]
pub async fn session_reset_title(sessions: State<'_, Sessions>, session_id: String) -> Result<Session, String> {
    sessions.reset_title(&session_id)
}

#[tauri::command]
pub async fn session_restart(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    sessions.restart(&session_id).await
}

/// Starts a stopped session's agent; `false` when it stays stopped (see `Sessions::resume`).
#[tauri::command]
pub async fn session_resume(sessions: State<'_, Sessions>, session_id: String) -> Result<bool, String> {
    sessions.resume(&session_id).await
}

/// Continues a session in its agent's own CLI, in a terminal this window owns (`terminalId`,
/// which the page attaches to like a Terminal tab's), at the page's size. Refused while its ACP
/// agent runs: the page stops it first. A `draft` (a new session, its id a UUID) is created and
/// started there under that id; the page then hears its events through `session_open`. The CLI's
/// exit comes as a `cli-exited { code, signal }` session event.
#[tauri::command]
pub async fn session_open_cli(
    window: Window,
    sessions: State<'_, Sessions>,
    terminals: State<'_, crate::terminal::Terminals>,
    session_id: String,
    cols: u16,
    rows: u16,
    draft: Option<CliDraft>,
) -> Result<CliOpened, String> {
    let cli = CliWindow { terminals: terminals.inner(), group: window.label(), cols, rows };
    sessions.open_cli(&session_id, draft, cli).await
}

/// Closes a session's CLI and returns once it's gone; the chat can start its agent then.
#[tauri::command]
pub async fn session_close_cli(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    sessions.close_cli(&session_id).await
}

/// Whether closing the session's CLI would stop its work (a tool it runs, or activity in the last 10 s).
#[tauri::command]
pub async fn session_cli_busy(sessions: State<'_, Sessions>, session_id: String) -> Result<bool, String> {
    sessions.cli_busy(&session_id)
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
