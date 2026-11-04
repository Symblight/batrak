//! Terminal tab commands: the shell runs in the backend, its output streams to the page as raw
//! bytes (`ArrayBuffer`s, no JSON or base64).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Manager, State, Window};

use crate::session::Sessions;
use crate::terminal::{Busy, OpenRequest, Opened, TerminalEvent, TerminalSink, Terminals};
use crate::roots::Roots;

use super::blocking;

const TERMINAL_ID_HEADER: &str = "terminal-id";

struct ChannelSink {
    output: Channel<InvokeResponseBody>,
    events: Channel<TerminalEvent>,
}

impl TerminalSink for ChannelSink {
    fn output(&self, bytes: &[u8]) -> bool {
        self.output.send(InvokeResponseBody::Raw(bytes.to_vec())).is_ok()
    }

    fn event(&self, event: &TerminalEvent) -> bool {
        self.events.send(event.clone()).is_ok()
    }
}

/// Starts a shell in `cwd` (or `fallback` when `cwd` doesn't exist): a folder in an open root,
/// a session's folder or the home folder. A running id answers with what it already runs.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_open(
    app: AppHandle,
    window: Window,
    terminals: State<'_, Terminals>,
    roots: State<'_, Roots>,
    sessions: State<'_, Sessions>,
    id: String,
    cwd: String,
    fallback: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<Opened, String> {
    let terminals = terminals.inner().clone();
    let roots = roots.inner().clone();
    let sessions = sessions.inner().clone();
    let home = app.path().home_dir().ok().and_then(|home| dunce::canonicalize(home).ok());
    let group = window.label().to_owned();
    blocking(move || {
        let fallback = fallback.map(PathBuf::from);
        let req = OpenRequest { id: &id, group: &group, cwd: Path::new(&cwd), fallback: fallback.as_deref(), cols, rows };
        let allowed = |path: &Path| {
            roots.contains(path) || sessions.contains_folder(path) || home.as_deref() == Some(path)
        };
        terminals.open(&req, &allowed)
    })
    .await?
}

/// Refuses a terminal another window opened (a sign-in's login another window started, say): a
/// window reaches only its own.
fn own(terminals: &Terminals, window: &Window, id: &str) -> Result<(), String> {
    if terminals.owns(window.label(), id) {
        Ok(())
    } else {
        Err(format!("unknown terminal {id}"))
    }
}

/// Sends the terminal's kept output, then streams it; replaces an earlier attachment.
#[tauri::command]
pub async fn terminal_attach(
    window: Window,
    terminals: State<'_, Terminals>,
    id: String,
    output: Channel<InvokeResponseBody>,
    events: Channel<TerminalEvent>,
) -> Result<(), String> {
    own(&terminals, &window, &id)?;
    terminals.attach(&id, Arc::new(ChannelSink { output, events }))
}

/// Input for the shell: the request's raw body, as typed or as a mouse report's bytes (which can't
/// go as a string); the terminal's id in the `Terminal-Id` header.
#[tauri::command]
pub async fn terminal_write(window: Window, terminals: State<'_, Terminals>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("terminal input must be raw bytes".to_owned());
    };
    let id = request
        .headers()
        .get(TERMINAL_ID_HEADER)
        .and_then(|id| id.to_str().ok())
        .ok_or("no terminal id")?
        .to_owned();
    own(&terminals, &window, &id)?;
    let data = data.clone();
    let terminals = terminals.inner().clone();
    blocking(move || terminals.write(&id, &data)).await?
}

/// The page has drawn `bytes` of the terminal's output; a paused reader goes on.
#[tauri::command]
pub async fn terminal_ack(window: Window, terminals: State<'_, Terminals>, id: String, bytes: usize) -> Result<(), String> {
    own(&terminals, &window, &id)?;
    terminals.ack(&id, bytes);
    Ok(())
}

/// The user cleared the terminal: what it cleared doesn't come back on the next attach.
#[tauri::command]
pub async fn terminal_clear(window: Window, terminals: State<'_, Terminals>, id: String) -> Result<(), String> {
    own(&terminals, &window, &id)?;
    terminals.clear_output(&id)
}

#[tauri::command]
pub async fn terminal_resize(window: Window, terminals: State<'_, Terminals>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    own(&terminals, &window, &id)?;
    terminals.resize(&id, cols, rows)
}

/// The terminals among `ids` running a program other than their shell.
#[tauri::command]
pub async fn terminal_busy(window: Window, terminals: State<'_, Terminals>, ids: Vec<String>) -> Result<Vec<Busy>, String> {
    Ok(terminals.busy(&terminals.of_group(window.label(), &ids)))
}

#[tauri::command]
pub async fn terminal_close(window: Window, terminals: State<'_, Terminals>, ids: Vec<String>) -> Result<(), String> {
    terminals.close(&terminals.of_group(window.label(), &ids));
    Ok(())
}

/// Closes every terminal this window opened. Called when its page starts.
#[tauri::command]
pub async fn close_window_terminals(window: Window, terminals: State<'_, Terminals>) -> Result<(), String> {
    terminals.close_group(window.label());
    Ok(())
}
