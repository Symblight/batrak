//! Running sessions: lifecycle (draft → preparing → starting → idle ⇄ working → stopped, any →
//! error), turns, permissions, and the event stream to the frontend. Which sessions there are is
//! the agents' to say (`sync`). This file holds `Sessions` and the lifecycle calls; each child
//! module adds its part to `Sessions` / `Inner`: `api` (options, requests, events), `state` (one
//! session in memory), `start`, `turn`, `sign_in`, `agents` (following agents.json), `host` (the
//! ACP client side), `replay` (a running agent's conversation, for a page attaching), `worktree`,
//! `sync` (the agents' session lists), `slots` (the local turn slot).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{oneshot, watch};
use tokio::task::AbortHandle;

use self::slots::{Entry, Turn, TurnPermit, TurnSlots};
use super::env::{self, Access, Launch, Mode, SessionEnv};
use crate::util::{iso_now, parse_iso_millis};
use super::{AgentLaunch, Session, SessionRecord, SessionStatus, TitleSource};
use crate::acp::process::AgentProcess;
use crate::acp::auth::SignInMethod;
use crate::acp::{self, ClientHost, ConnectError, Connection, FsError, PermissionRequest, PromptBlock, StartOptions};
use crate::config::env::SecretStore;
use crate::config::view::SignInState;
use crate::config::{AgentConfig, AgentConfigs, LaunchConfig, LocalTurns, Merged};
use crate::storage::JsonFile;

/// The most of a file an agent read (or a selection) holds; larger files are read in parts (`line` / `limit`).
const MAX_READ: u64 = 16 * 1024 * 1024;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Every session of the app, running or not. Cheap to clone.
#[derive(Clone)]
pub struct Sessions {
    inner: Arc<Inner>,
}

struct Inner {
    opts: SessionsOptions,
    /// `sessions.json`: the sessions as last listed, and the hidden ones. No messages.
    store: JsonFile,
    /// Every session listed: as last stored at launch, then as the agents say (`sync`), by id.
    sessions: Mutex<HashMap<String, Arc<SessionState>>>,
    /// Sessions removed where their agent couldn't delete them, by ACP session id: never listed.
    hidden: Mutex<HashMap<String, SessionRecord>>,
    sync: sync::SyncState,
    /// Local sessions' turns, one at a time per project.
    slots: TurnSlots,
    /// Launches that answered AuthRequired, until one signs in or starts.
    sign_ins_needed: Mutex<HashMap<LaunchKey, SignInNeed>>,
    /// Sign-ins running, one per launch.
    signing_in: Mutex<HashMap<LaunchKey, SignInRun>>,
    /// Numbers login terminals (`sign-in-<n>`).
    next_login: AtomicU64,
    /// The projects' workspaces, whose folders chats run in.
    workspaces: crate::workspace::Workspaces,
}

impl Sessions {
    /// Lists the sessions as last stored, all `stopped`, until a sync asks their agents (`sync`).
    pub fn new(opts: SessionsOptions) -> Sessions {
        let store = JsonFile::new(opts.data_dir.join("sessions.json"));
        let (mut records, hidden) = sync::load(&store, &opts.data_dir);
        let workspaces = crate::workspace::Workspaces::new(&opts.data_dir);
        let migrated = workspaces::migrate(&workspaces, &mut records);
        let sessions = records.into_iter().map(|record| (record.session_id.clone(), Arc::new(new_state(record)))).collect();
        let sessions = Sessions {
            inner: Arc::new(Inner {
                opts,
                store,
                sessions: Mutex::new(sessions),
                hidden: Mutex::new(hidden),
                sync: sync::SyncState::default(),
                slots: TurnSlots::default(),
                sign_ins_needed: Mutex::default(),
                signing_in: Mutex::default(),
                next_login: AtomicU64::new(0),
                workspaces,
            }),
        };
        if migrated {
            sessions.inner.persist();
        }
        let configs = &sessions.inner.opts.configs;
        sessions.inner.workspaces.notify_with(Arc::clone(configs.notifier()));
        let (following, runtime) = (Arc::downgrade(&sessions.inner), sessions.inner.opts.runtime.clone());
        configs.follow_agents(Arc::new(move |project: &Path| {
            let Some(inner) = following.upgrade() else { return };
            let project = project.to_path_buf();
            runtime.spawn(async move { Sessions { inner }.sync_agents(&project).await });
        }));
        sessions
    }

    /// The projects' workspaces.
    pub fn workspaces(&self) -> &crate::workspace::Workspaces {
        &self.inner.workspaces
    }

    /// How many of the project's sessions run `agent_id` now (or are about to).
    pub fn active_of(&self, project: &Path, agent_id: &str) -> usize {
        lock(&self.inner.sessions)
            .values()
            .filter(|s| {
                let record = lock(&s.record);
                record.project_path == project && record.agent_id == agent_id && record.status.is_active()
            })
            .count()
    }

    /// Most recently active first.
    pub fn list(&self) -> Vec<Session> {
        let mut sessions: Vec<Session> = lock(&self.inner.sessions).values().map(|s| s.page()).collect();
        sessions.sort_by(|a, b| (&b.last_activity_at, &b.created_at).cmp(&(&a.last_activity_at, &a.created_at)));
        sessions
    }

    /// Whether a canonical `path` lies in a workspace's folder, which the page may read.
    pub fn contains(&self, path: &Path) -> bool {
        self.inner.workspaces.store().list(None).iter().any(|w| path.starts_with(&w.folder))
    }

    /// Whether a canonical `path` lies in any session's folder: a local session's project, a
    /// worktree session's folder in its worktree. A terminal may start there.
    pub fn contains_folder(&self, path: &Path) -> bool {
        self.inner.known().iter().any(|record| path.starts_with(&record.agent_cwd))
    }

    fn get(&self, id: &str) -> Result<Arc<SessionState>, String> {
        lock(&self.inner.sessions).get(id).cloned().ok_or_else(|| format!("unknown session {id}"))
    }

    /// Creates a session and starts its agent in the background; progress arrives on `sink`.
    /// Blocking: placing a worktree session asks git.
    pub fn create(&self, req: CreateSession, sink_key: &str, sink: Arc<dyn EventSink>) -> Result<Session, String> {
        let record = self.new_record(&req)?;
        let state = self.insert(record, Some((sink_key, sink)))?;
        tracing::info!(session = %state.id, agent = %req.agent_id, workspace = ?req.workspace_id, branch = ?state.record().branch, "session created");
        self.inner.start_in_background(&state);
        Ok(state.page())
    }

    /// The record of a new session, `preparing`, its folder placed. Blocking: placing a worktree
    /// session asks git.
    fn new_record(&self, req: &CreateSession) -> Result<SessionRecord, String> {
        // It names the session's folder in app data, which Remove deletes.
        let valid_id = (1..=64).contains(&req.session_id.len())
            && req.session_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !valid_id {
            return Err(format!("invalid session id {:?}", req.session_id));
        }
        let project = dunce::canonicalize(&req.project_path).map_err(|e| format!("{}: {e}", req.project_path))?;
        if !project.is_dir() {
            return Err(format!("{}: not a folder", project.display()));
        }
        let merged = self.inner.opts.configs.merged(Some(&project));
        let Some(agent_name) = merged.agent(&req.agent_id).map(|a| a.name.clone()) else {
            return Err(format!("Unknown agent \"{}\": add it to .brama/agents.json", req.agent_id));
        };
        if merged.enabled(&req.agent_id).is_none() {
            return Err(Absence::Off.message(&merged, &req.agent_id));
        }
        if lock(&self.inner.sessions).contains_key(&req.session_id) {
            return Err(format!("session {} exists already", req.session_id));
        }
        let workspace = match &req.workspace_id {
            None => None,
            Some(id) => {
                let workspace = self.inner.workspaces.for_new_chat(id)?;
                if workspace.project_path != project {
                    return Err(format!("workspace {id} belongs to another project"));
                }
                // An unnamed workspace takes its first chat's first message.
                if !self.inner.known().iter().any(|r| r.workspace_id.as_deref() == Some(id)) {
                    if let Err(e) = self.inner.workspaces.follow_title(id, || Some(req.title.clone())) {
                        tracing::warn!(workspace = %id, "naming the workspace after its first chat failed: {e}");
                    }
                }
                Some(workspace)
            }
        };
        let placed = env::Placement::of(&project, workspace.as_ref());
        Ok(SessionRecord {
            session_id: req.session_id.clone(),
            acp_session_id: None,
            agent_id: req.agent_id.clone(),
            mode: placed.mode,
            agent_cwd: placed.agent_cwd,
            project_path: project,
            title: req.title.clone(),
            title_source: TitleSource::Prompt,
            agent_title: None,
            status: SessionStatus::Preparing,
            created_at: iso_now(),
            last_activity_at: None,
            config: req.config.clone(),
            worktree_path: placed.worktree_path,
            branch: placed.branch,
            base_commit: placed.base_commit,
            launch: None,
            agent_name: Some(agent_name),
            hidden: false,
            workspace_id: placed.workspace_id,
        })
    }

    /// Lists a new session, its events going to `sink` if given.
    fn insert(&self, record: SessionRecord, sink: Option<(&str, Arc<dyn EventSink>)>) -> Result<Arc<SessionState>, String> {
        let id = record.session_id.clone();
        let state = {
            let mut sessions = lock(&self.inner.sessions);
            if sessions.contains_key(&id) {
                return Err(format!("session {id} exists already"));
            }
            let state = Arc::new(new_state(record));
            if let Some((key, sink)) = sink {
                lock(&state.sinks).insert(key.to_owned(), sink);
            }
            sessions.insert(id, Arc::clone(&state));
            state
        };
        self.inner.persist();
        Ok(state)
    }

    /// Sends this window's events of a session to `sink` (replacing an earlier one), starting
    /// with the conversation so far while its agent runs (`snapshot`), then the current status.
    pub fn attach(&self, id: &str, sink_key: &str, sink: Arc<dyn EventSink>) -> Result<Session, String> {
        let state = self.get(id)?;
        state.add_sink(sink_key, sink);
        let status = state.status();
        state.emit("status", json!({ "status": status }));
        Ok(state.page())
    }

    /// Forgets a window's sinks (it closed or reloaded).
    pub fn detach_all(&self, sink_key: &str) {
        for state in lock(&self.inner.sessions).values() {
            lock(&state.sinks).remove(sink_key);
        }
    }

    /// Stops the agent (its whole process group); the session stays listed as `stopped`.
    pub async fn stop(&self, id: &str) -> Result<(), String> {
        let state = self.get(id)?;
        self.inner.stop(&state).await;
        self.inner.set_status(&state, SessionStatus::Stopped, None);
        Ok(())
    }

    /// Sets the title the session is listed by (trimmed, not empty); the agent no longer changes it.
    pub fn rename(&self, id: &str, title: &str) -> Result<Session, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("a session's title can't be empty".into());
        }
        let state = self.get(id)?;
        {
            let mut record = lock(&state.record);
            record.title = title.to_owned();
            record.title_source = TitleSource::User;
        }
        self.inner.persist();
        Ok(state.page())
    }

    /// Gives a renamed session back the title its agent gave it, which it then keeps up to date.
    pub fn reset_title(&self, id: &str) -> Result<Session, String> {
        let state = self.get(id)?;
        {
            let mut record = lock(&state.record);
            let title = record.agent_title.clone().ok_or("the agent hasn't named this session")?;
            record.title = title;
            record.title_source = TitleSource::Agent;
        }
        self.inner.persist();
        Ok(state.page())
    }

    /// Removes a session for good: its agent is stopped (a running turn ends `cancelled`), it's
    /// deleted in its agent (`session/delete`), or hidden in Brama where the agent can't, it's no
    /// longer listed, and its log is deleted. Its folder is discarded by its
    /// environment: `local` keeps the project as it is, `worktree` keeps a worktree with
    /// uncommitted changes and a branch with commits.
    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let state = self.get(id)?;
        self.inner.close_cli(&state).await;
        self.inner.stop(&state).await;
        if lock(&self.inner.sessions).remove(id).is_none() {
            return Err(format!("unknown session {id}"));
        }
        let record = state.record();
        if let Some(acp_id) = record.acp_session_id.clone() {
            if !self.inner.delete_in_agent(&record, &acp_id).await {
                lock(&self.inner.hidden).insert(acp_id, SessionRecord { hidden: true, ..sync::stored(record.clone()) });
            }
        }
        self.inner.persist();
        let dir = self.inner.data_dir().join("sessions").join(id);
        tokio::task::spawn_blocking(move || {
            match std::fs::remove_dir_all(&dir) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    tracing::warn!(path = %dir.display(), "deleting the session's files failed: {e}");
                }
                _ => {}
            }
        })
        .await
        .map_err(|e| e.to_string())?;
        tracing::info!(session = %id, "session removed");
        Ok(())
    }

    /// Stops the agent and starts it again, continuing its ACP session where the agent supports
    /// `session/load`.
    pub async fn restart(&self, id: &str) -> Result<(), String> {
        let state = self.get(id)?;
        self.inner.stop(&state).await;
        self.inner.set_status(&state, SessionStatus::Stopped, None);
        self.inner.start_in_background(&state);
        Ok(())
    }

    /// Starts a stopped session's agent, continuing its ACP session where the agent supports
    /// `session/load`; a running or starting one is left as it is. `false`, quietly, when it
    /// can't start where it is: the project has its worktree's branch checked out (Restart then
    /// says why), or its agent starts only when the user acts on it (`Agent::starts_in_background`).
    pub async fn resume(&self, id: &str) -> Result<bool, String> {
        let state = self.get(id)?;
        if lock(&state.cli).is_some() {
            return Ok(false);
        }
        let record = state.record();
        if record.status != SessionStatus::Stopped {
            return Ok(record.status.is_active());
        }
        let merged = self.inner.opts.configs.merged(Some(&record.project_path));
        if merged.agent(&record.agent_id).is_some_and(|agent| !self.inner.starts_in_background(agent)) {
            return Ok(false);
        }
        let env = env::for_session(&record)?;
        let held = tokio::task::spawn_blocking(move || env.held_elsewhere()).await.map_err(|e| e.to_string())??;
        if held {
            return Ok(false);
        }
        {
            // Claimed under the record's lock, so a second resume sees it starting.
            let mut current = lock(&state.record);
            if current.status != SessionStatus::Stopped {
                return Ok(current.status.is_active());
            }
            current.status = SessionStatus::Preparing;
        }
        self.inner.set_status(&state, SessionStatus::Preparing, None);
        self.inner.start_in_background(&state);
        Ok(true)
    }

    /// Sets one of the agent's config options (model, thought level, mode); the options as they
    /// are then arrive as `config-options`. The agent must be running.
    pub async fn set_config_option(&self, id: &str, config_id: &str, value: &str) -> Result<(), String> {
        let state = self.get(id)?;
        let conn = state.conn().ok_or("The agent isn't running; the choice applies when it starts")?;
        let options = conn.set_config_option(config_id, value).await?;
        remember_config(&state, &options);
        self.inner.persist();
        state.emit_options(options);
        Ok(())
    }

    /// The agent's stderr log of a session.
    pub fn log_path(&self, id: &str) -> Result<PathBuf, String> {
        self.get(id)?;
        Ok(self.inner.log_path(id))
    }

    /// App exit: every agent process group is stopped, every session saved as `stopped`.
    pub fn shutdown(&self) {
        let states: Vec<_> = lock(&self.inner.sessions).values().cloned().collect();
        for state in &states {
            state.stopping.store(true, Ordering::SeqCst);
            if let Some(start) = lock(&state.starting).take() {
                start.abort();
            }
            if let Ok(mut live) = state.live.try_lock() {
                if let Some(mut process) = live.take().and_then(|l| l.process) {
                    process.stop_now(Duration::from_millis(500));
                }
            }
            lock(&state.record).status = SessionStatus::Stopped;
        }
        // Groups whose owner couldn't be reached (a start in progress) go too.
        crate::acp::process::stop_all(Duration::from_millis(500));
        self.inner.persist();
    }
}

impl Inner {
    /// Saves the sessions as listed (no status, no messages) and the hidden ones.
    fn persist(&self) {
        let records: Vec<SessionRecord> = {
            let sessions = lock(&self.sessions);
            let hidden = lock(&self.hidden);
            let mut records: Vec<_> = sessions.values().map(|s| sync::stored(s.record())).chain(hidden.values().cloned()).collect();
            records.sort_by(|a, b| (&a.created_at, &a.session_id).cmp(&(&b.created_at, &b.session_id)));
            records
        };
        if let Err(e) = self.store.save(&records) {
            tracing::warn!("saving sessions failed: {e}");
        }
    }

    /// Marks the session active now (a prompt, output, a turn's end), which orders the list;
    /// returns the stamp it wrote.
    fn touch(&self, state: &SessionState) -> String {
        let now = Self::stamp(state);
        self.persist();
        now
    }

    /// `touch()` without the disk write, for the connection's dispatch loop, which must not wait
    /// on it; the turn's end persists the stamp.
    fn stamp(state: &SessionState) -> String {
        let now = iso_now();
        *lock(&state.active_here) = parse_iso_millis(&now);
        lock(&state.record).last_activity_at = Some(now.clone());
        now
    }

    /// The agent's output in a turn (not a history replayed at a start): stamps the session and
    /// tells the page (`activity`), unless it did so within `output_stamp`.
    fn stamp_output(&self, state: &SessionState) {
        if !state.in_turn.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut stamped = lock(&state.output_stamped);
            if stamped.is_some_and(|at| at.elapsed() < self.opts.output_stamp) {
                return;
            }
            *stamped = Some(Instant::now());
        }
        let at = Self::stamp(state);
        state.emit("activity", json!({ "at": at }));
    }

    /// Every listed session's record.
    fn known(&self) -> Vec<SessionRecord> {
        lock(&self.sessions).values().map(|s| s.record()).collect()
    }

    fn set_status(&self, state: &SessionState, status: SessionStatus, message: Option<&str>) {
        lock(&state.record).status = status;
        self.persist();
        state.emit("status", json!({ "status": status, "message": message }));
    }

    fn log_path(&self, id: &str) -> PathBuf {
        self.data_dir().join("sessions").join(id).join("agent.log")
    }

    fn data_dir(&self) -> &Path {
        &self.opts.data_dir
    }

    async fn stop(&self, state: &SessionState) {
        state.stopping.store(true, Ordering::SeqCst);
        self.leave_queue(state);
        self.drop_held(state);
        if lock(&state.sign_in).take().is_some() {
            state.emit("sign-in", Value::Null);
        }
        if let Some(start) = lock(&state.starting).take() {
            start.abort();
        }
        let taken = state.live.lock().await.take();
        lock(&state.conn).take();
        lock(&state.env).take();
        state.end_replay();
        if let Some(mut live) = taken {
            if state.turn_running.load(Ordering::SeqCst) {
                let _ = live.conn.cancel();
            }
            if let Some(process) = live.process.as_mut() {
                process.stop().await;
            }
            tracing::info!(session = %state.id, "agent stopped");
        }
    }

    /// The agent's side closed. Unless Stop did it, that's a crash: the session goes to `error`
    /// and the leftovers of its process group are killed.
    async fn on_agent_exit(&self, state: &Arc<SessionState>, generation: u64, reason: String) {
        let mut live = state.live.lock().await;
        if live.as_ref().map(|l| l.generation) != Some(generation) {
            return;
        }
        let taken = live.take();
        drop(live);
        lock(&state.conn).take();
        lock(&state.env).take();
        state.end_replay();
        self.leave_queue(state);
        if let Some(mut process) = taken.and_then(|l| l.process) {
            process.stop().await;
        }
        if state.stopping.load(Ordering::SeqCst) {
            return;
        }
        let agent = state.record().agent_id;
        tracing::warn!(session = %state.id, agent = %agent, "agent exited: {reason}");
        let message = format!("The agent stopped: {reason}");
        state.emit("error", json!({ "message": message }));
        self.set_status(state, SessionStatus::Error, Some(&message));
    }
}

mod agents;
mod api;
mod cli;
mod host;
mod replay;
mod sign_in;
mod slots;
mod start;
mod state;
mod subagents;
mod sync;
#[cfg(test)]
mod tests;
mod turn;
mod workspaces;
mod worktree;

use self::agents::*;
use self::cli::{CliHeld, OPEN_IN_TERMINAL};
use self::host::*;
use self::start::*;
use self::state::*;
use self::turn::*;
pub use cli::{CliDraft, CliOpened};
pub use api::{CreateSession, Envelope, EventSink, Launched, Launcher, PromptInput, SessionsOptions};
pub use sign_in::{LoginTab, Probed, SignInEnd};
use sign_in::{LaunchKey, SignInNeed, SignInRun};
pub use sync::SyncReport;
pub use workspaces::DeletePreview;
