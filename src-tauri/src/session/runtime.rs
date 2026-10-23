//! Running sessions: lifecycle (draft → preparing → starting → idle ⇄ working → stopped, any →
//! error), turns, permissions, and the event stream to the frontend.

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
use super::transcript::{self, Transcript};
use super::{iso_now, AgentLaunch, Session, SessionRecord, SessionStatus, TitleSource};
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

/// One message to the frontend: `seq` is monotonic per session across every window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub session_id: String,
    pub seq: u64,
    /// `update` (payload: ACP `SessionUpdate`), `status`, `permission-request`, `turn-start`,
    /// `turn-end` (`{ stopReason }`), `error`, `config-options` (`{ configOptions }`: the
    /// agent's model, thought level and mode options as they are now), or `session` (the `Session`
    /// after the agent named it), `sign-in` (`{ agentId, agentName, methods }`: the agent asks
    /// for a sign-in; `null` once a start works or Stop), `held` (`{ prompt }`: the turn's prompt
    /// waits for that sign-in) or `prompt-returned` (`{ prompt }`: a held prompt was dropped).
    pub kind: &'static str,
    pub payload: Value,
}

/// Where a session's events go: one per window that opened it (a Tauri channel).
pub trait EventSink: Send + Sync {
    /// `false` once the receiver is gone; the sink is then dropped.
    fn send(&self, envelope: &Envelope) -> bool;
}

/// A started agent: its process (none for an in-process test agent) and the pipes ACP runs over.
pub struct Launched {
    pub process: Option<AgentProcess>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
}

/// Starts agents; the app spawns processes through the session's environment, tests run a fake
/// agent in-process.
pub trait Launcher: Send + Sync {
    fn launch(&self, env: &dyn SessionEnv, agent: &AgentConfig, process_env: &[(String, String)], stderr: File)
        -> Result<Launched, String>;
}

/// The real thing: the agent's command in its own process group, through `env.spawn_agent`.
pub struct ProcessLauncher;

impl Launcher for ProcessLauncher {
    fn launch(&self, env: &dyn SessionEnv, agent: &AgentConfig, process_env: &[(String, String)], stderr: File)
        -> Result<Launched, String> {
        let launch = Launch { program: &agent.command, args: &agent.args, env: process_env, stderr };
        let (process, pipes) = env.spawn_agent(launch)?;
        Ok(Launched { process: Some(process), writer: Box::new(pipes.stdin), reader: Box::new(pipes.stdout) })
    }
}

pub struct SessionsOptions {
    /// App data: `sessions.json` and `sessions/<id>/agent.log`.
    pub data_dir: PathBuf,
    pub configs: AgentConfigs,
    pub secrets: Arc<dyn SecretStore + Send + Sync>,
    /// The environment agents start from (the login shell's). Blocking.
    pub base_env: Arc<dyn Fn() -> HashMap<String, String> + Send + Sync>,
    pub launcher: Arc<dyn Launcher>,
    /// How long a starting agent may take to answer `initialize`, and each config option the
    /// session is set to.
    pub initialize_timeout: Duration,
    /// How long after its end a turn's changes still count for an overlap: the watcher reports a
    /// write a debounce later, so the batch with a turn's last edits may come after it ended.
    pub overlap_grace: Duration,
}

/// Several watcher debounces (150 ms), FSEvents' latency included.
const OVERLAP_GRACE: Duration = Duration::from_secs(1);

/// The longest a sign-in may wait for the user in the browser.
const SIGN_IN_LIMIT: Duration = Duration::from_secs(10 * 60);

impl SessionsOptions {
    pub fn for_app(data_dir: PathBuf, configs: AgentConfigs) -> SessionsOptions {
        SessionsOptions {
            data_dir,
            configs,
            secrets: Arc::new(crate::config::env::OsKeychain),
            base_env: Arc::new(|| crate::config::env::login_shell_env().clone()),
            launcher: Arc::new(ProcessLauncher),
            initialize_timeout: acp::INITIALIZE_TIMEOUT,
            overlap_grace: OVERLAP_GRACE,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSession {
    /// The frontend's id for it (the draft's), so its conversation keeps its id.
    pub session_id: String,
    pub project_path: String,
    pub agent_id: String,
    pub mode: Mode,
    pub title: String,
    /// The agent's config options picked in the draft (model, thought level, mode), by id.
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    /// `worktree`: the branch or commit to start from; `None` for the project's HEAD.
    #[serde(default)]
    pub base_branch: Option<String>,
}

/// A prompt piece from the page. Paths are relative to the session's folder; the backend maps and
/// checks them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PromptInput {
    Text { text: String },
    /// An `@`-mentioned file or folder.
    Mention { path: String },
    /// Lines from an editor, 1-based and inclusive.
    Selection { path: String, from_line: u32, to_line: u32 },
}

/// A started agent of a session.
struct Live {
    conn: Arc<Connection>,
    process: Option<AgentProcess>,
    /// Matches `SessionState::generation` at start; a watcher for an older start does nothing.
    generation: u64,
}

struct SessionState {
    id: String,
    record: Mutex<SessionRecord>,
    sinks: Mutex<HashMap<String, Arc<dyn EventSink>>>,
    /// Guarded by `sinks`, so the order of `seq` is the order of sending.
    seq: AtomicU64,
    /// Held while starting, so one start runs at a time.
    live: tokio::sync::Mutex<Option<Live>>,
    /// For cancel and permission answers, which must not wait for a start in progress.
    conn: Mutex<Option<Arc<Connection>>>,
    env: Mutex<Option<Arc<dyn SessionEnv>>>,
    /// The start in progress, aborted by Stop (dropping it kills the agent's process group).
    starting: Mutex<Option<AbortHandle>>,
    /// Set by Stop for the start in progress: its blocking `prepare` (a checkout) isn't aborted
    /// with the task, so it checks this and undoes its work.
    prepare_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// Starts attempted so far. A caller notes it before waiting for a start in progress; when that
    /// start failed, the caller fails with it (`start_error`) instead of starting again.
    start_attempts: AtomicU64,
    start_error: Mutex<Option<StartError>>,
    generation: AtomicU64,
    /// A turn is running, its startup included. The git layer will gate mutations on it.
    turn_running: AtomicBool,
    cancel_requested: AtomicBool,
    /// Stop was asked for: the agent going away is not an error.
    stopping: AtomicBool,
    transcript: Transcript,
    /// Between `turn-start` and the turn's end: the agent's updates go into the transcript. History
    /// an agent replays while starting (`session/load`) is in it already.
    recording: AtomicBool,
    /// agents.json no longer has the session's agent (reported, status `error`); `Some(true)`: it
    /// was running or asked to start, so it starts again once the agent is back.
    unconfigured: Mutex<Option<bool>>,
    /// What the running agent was started with, and whether the page was told agents.json now
    /// says otherwise (`agent-outdated`).
    running: Mutex<Option<LaunchConfig>>,
    outdated: AtomicBool,
    /// Files the running turn's tool calls changed (host paths: diffs, and locations of calls that
    /// don't only look), and those of them it was told another running turn changed too
    /// (`overlap`). Cleared at turn start, with the kinds of its tool calls by id.
    touched: Mutex<HashSet<PathBuf>>,
    overlaps: Mutex<HashSet<PathBuf>>,
    tool_kinds: Mutex<HashMap<String, String>>,
    /// When the last turn ended (`None` while one runs): its `touched` still count for a while.
    turn_ended: Mutex<Option<Instant>>,
    /// The agent asked for a sign-in at its last start or prompt (the page was sent `sign-in`);
    /// a start that works, or a Stop, clears it (`sign-in: null`).
    sign_in: Mutex<Option<SignInNeed>>,
    /// The turn whose prompt waits for that sign-in: `true` sends it, `false` drops it.
    held: Mutex<Option<oneshot::Sender<bool>>>,
}

impl SessionState {
    fn record(&self) -> SessionRecord {
        lock(&self.record).clone()
    }

    fn status(&self) -> SessionStatus {
        lock(&self.record).status
    }

    fn conn(&self) -> Option<Arc<Connection>> {
        lock(&self.conn).clone()
    }

    fn emit(&self, kind: &'static str, payload: Value) {
        let mut sinks = lock(&self.sinks);
        let envelope = Envelope {
            session_id: self.id.clone(),
            seq: self.seq.fetch_add(1, Ordering::SeqCst) + 1,
            kind,
            payload,
        };
        sinks.retain(|_, sink| sink.send(&envelope));
    }
}

/// Every session of the app, running or not. Cheap to clone.
#[derive(Clone)]
pub struct Sessions {
    inner: Arc<Inner>,
}

struct Inner {
    opts: SessionsOptions,
    store: JsonFile,
    sessions: Mutex<HashMap<String, Arc<SessionState>>>,
    /// Local sessions' turns, one at a time per project.
    slots: TurnSlots,
    /// Launches that answered AuthRequired, until one signs in or starts.
    sign_ins_needed: Mutex<HashMap<LaunchKey, SignInNeed>>,
    /// Sign-ins running, one per launch.
    signing_in: Mutex<HashMap<LaunchKey, SignInRun>>,
    /// Numbers login terminals (`sign-in-<n>`).
    next_login: AtomicU64,
}

/// An agent's launch as far as its login goes: the same command line and env names (not values)
/// sign in to the same account.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct LaunchKey {
    command: String,
    args: Vec<String>,
    env: Vec<String>,
}

impl LaunchKey {
    fn new(command: &str, args: &[String], env: &BTreeMap<String, String>) -> LaunchKey {
        LaunchKey { command: command.to_owned(), args: args.to_vec(), env: env.keys().cloned().collect() }
    }

    fn of(agent: &AgentConfig) -> LaunchKey {
        LaunchKey::new(&agent.command, &agent.args, &agent.env)
    }
}

/// A launch that answered AuthRequired, and how it can sign in.
#[derive(Debug, Clone)]
struct SignInNeed {
    key: LaunchKey,
    agent_id: String,
    agent_name: String,
    methods: Vec<SignInMethod>,
}

struct SignInRun {
    /// An `authenticate` sign-in's task.
    abort: Option<AbortHandle>,
    /// A terminal sign-in's login, which the user runs to its end.
    login: Option<LoginTab>,
    done: Arc<watch::Sender<Option<SignInEnd>>>,
}

/// A login that runs in a Terminal tab (`terminal` / `command` methods): the page opens the tab
/// `terminal_id`, titled `title`, with `command_line` (no env) as its tooltip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginTab {
    pub terminal_id: String,
    pub title: String,
    pub command_line: String,
}

/// What a login tab's terminal runs: only for the call that started it. Its env holds the
/// agent's resolved secrets, so it never leaves the backend.
pub struct Login {
    pub cwd: PathBuf,
    pub command: acp::auth::LoginCommand,
}

/// How a login's terminal ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginExit {
    Code(i32),
    Signal(String),
    /// Its tab was closed first: a cancel.
    Closed,
}

/// A cancelled sign-in; a login's terminal is the caller's to close.
pub struct Cancelled {
    pub terminal_id: Option<String>,
}

/// How a sign-in ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInEnd {
    Done,
    Failed(String),
    Cancelled,
}

/// A sign-in started (or joined) by `Sessions::sign_in`.
pub struct SignIn {
    pub agent_name: String,
    /// A login to show in a Terminal tab (also for a call that joined it).
    pub tab: Option<LoginTab>,
    /// What that tab runs, for the call that started it.
    pub login: Option<Login>,
    done: watch::Receiver<Option<SignInEnd>>,
}

impl SignIn {
    pub async fn end(mut self) -> SignInEnd {
        match self.done.wait_for(Option::is_some).await {
            Ok(end) => end.clone().unwrap_or(SignInEnd::Cancelled),
            Err(_) => SignInEnd::Cancelled,
        }
    }
}

/// What a probe learned: the agent's options, or that it wants a sign-in first.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Probed {
    Options(Vec<Value>),
    #[serde(rename_all = "camelCase")]
    SignIn { sign_in: Vec<SignInMethod> },
}

impl Sessions {
    /// Loads the stored sessions; none is running yet, so all of them are `stopped`.
    pub fn new(opts: SessionsOptions) -> Sessions {
        let store = JsonFile::new(opts.data_dir.join("sessions.json"));
        let records: Vec<SessionRecord> = store.load();
        let sessions = records
            .into_iter()
            .map(|mut record| {
                record.status = SessionStatus::Stopped;
                (record.session_id.clone(), Arc::new(new_state(record, &opts.data_dir)))
            })
            .collect();
        Sessions {
            inner: Arc::new(Inner {
                opts,
                store,
                sessions: Mutex::new(sessions),
                slots: TurnSlots::default(),
                sign_ins_needed: Mutex::default(),
                signing_in: Mutex::default(),
                next_login: AtomicU64::new(0),
            }),
        }
    }

    /// Most recently active first.
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

    pub fn list(&self) -> Vec<Session> {
        let mut sessions: Vec<Session> =
            lock(&self.inner.sessions).values().map(|s| Session::from(&*lock(&s.record))).collect();
        sessions.sort_by(|a, b| (&b.last_activity_at, &b.created_at).cmp(&(&a.last_activity_at, &a.created_at)));
        sessions
    }

    /// Whether a canonical `path` lies in a worktree session's folder, which the page may read.
    pub fn contains(&self, path: &Path) -> bool {
        lock(&self.inner.sessions).values().any(|s| {
            let record = lock(&s.record);
            record.mode == Mode::Worktree && path.starts_with(&record.agent_cwd)
        })
    }

    /// Whether a canonical `path` lies in any session's folder: a local session's project, a
    /// worktree session's folder in its worktree. A terminal may start there.
    pub fn contains_folder(&self, path: &Path) -> bool {
        lock(&self.inner.sessions).values().any(|s| path.starts_with(&lock(&s.record).agent_cwd))
    }

    /// A worktree session's folder (its agent's cwd), once it's checked out; the Files tree lists it.
    pub fn worktree_folder(&self, id: &str) -> Result<PathBuf, String> {
        let state = self.get(id)?;
        let record = lock(&state.record);
        if record.mode != Mode::Worktree {
            return Err(format!("session {id} doesn't run in a worktree"));
        }
        if !record.agent_cwd.is_dir() {
            return Err(format!("{}: the worktree isn't checked out", record.agent_cwd.display()));
        }
        Ok(record.agent_cwd.clone())
    }

    fn get(&self, id: &str) -> Result<Arc<SessionState>, String> {
        lock(&self.inner.sessions).get(id).cloned().ok_or_else(|| format!("unknown session {id}"))
    }

    /// Creates a session and starts its agent in the background; progress arrives on `sink`.
    /// Blocking: placing a worktree session asks git.
    pub fn create(&self, req: CreateSession, sink_key: &str, sink: Arc<dyn EventSink>) -> Result<Session, String> {
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
        let placed =
            env::place(req.mode, &project, self.inner.data_dir(), &req.session_id, &req.title, req.base_branch.as_deref())?;
        let record = SessionRecord {
            session_id: req.session_id.clone(),
            acp_session_id: None,
            agent_id: req.agent_id,
            mode: req.mode,
            agent_cwd: placed.agent_cwd,
            project_path: project,
            title: req.title,
            title_source: TitleSource::Prompt,
            agent_title: None,
            status: SessionStatus::Preparing,
            created_at: iso_now(),
            last_activity_at: None,
            config: req.config,
            worktree_path: placed.worktree_path,
            branch: placed.branch,
            base_commit: placed.base_commit,
            launch: None,
            agent_name: Some(agent_name),
        };
        let state = {
            let mut sessions = lock(&self.inner.sessions);
            if sessions.contains_key(&req.session_id) {
                return Err(format!("session {} exists already", req.session_id));
            }
            let state = Arc::new(new_state(record, self.inner.data_dir()));
            lock(&state.sinks).insert(sink_key.to_owned(), sink);
            sessions.insert(req.session_id.clone(), Arc::clone(&state));
            state
        };
        self.inner.persist();
        let record = state.record();
        tracing::info!(session = %state.id, agent = %record.agent_id, mode = ?req.mode, branch = ?record.branch, "session created");
        self.inner.start_in_background(&state);
        Ok(Session::from(&state.record()))
    }

    /// Sends this window's events of a session to `sink` (replacing an earlier one), starting
    /// with the current status.
    pub fn attach(&self, id: &str, sink_key: &str, sink: Arc<dyn EventSink>) -> Result<Session, String> {
        let state = self.get(id)?;
        lock(&state.sinks).insert(sink_key.to_owned(), sink);
        let status = state.status();
        state.emit("status", json!({ "status": status }));
        Ok(Session::from(&state.record()))
    }

    /// Forgets a window's sinks (it closed or reloaded).
    pub fn detach_all(&self, sink_key: &str) {
        for state in lock(&self.inner.sessions).values() {
            lock(&state.sinks).remove(sink_key);
        }
    }

    /// Starts a turn and returns once it's accepted; it runs in the background, its updates and
    /// `turn-end` arrive as events. Starts the agent first if needed.
    pub fn send_prompt(&self, id: &str, prompt: Vec<PromptInput>) -> Result<(), String> {
        let state = self.get(id)?;
        if prompt.is_empty() {
            return Err("empty prompt".to_owned());
        }
        if state.turn_running.swap(true, Ordering::SeqCst) {
            return Err("The agent is still working on the previous message".to_owned());
        }
        state.cancel_requested.store(false, Ordering::SeqCst);
        state.transcript.append(&json!({ "kind": "prompt", "prompt": prompt, "at": iso_now() }));
        self.inner.touch(&state);
        let inner = Arc::clone(&self.inner);
        let attempts = state.start_attempts.load(Ordering::SeqCst);
        tokio::spawn(async move {
            let result = inner.run_turn(&state, prompt, attempts).await;
            state.turn_running.store(false, Ordering::SeqCst);
            if state.recording.swap(false, Ordering::SeqCst) {
                *lock(&state.turn_ended) = Some(Instant::now());
            }
            let ended = match &result {
                Ok(stop_reason) => json!({ "kind": "turn-end", "stopReason": stop_reason }),
                Err(_) if state.stopping.load(Ordering::SeqCst) => json!({ "kind": "turn-end", "stopReason": "cancelled" }),
                Err(e) => json!({ "kind": "turn-end", "stopReason": "error", "message": e }),
            };
            state.transcript.append(&ended);
            inner.touch(&state);
            match result {
                Ok(stop_reason) => {
                    state.emit("turn-end", json!({ "stopReason": stop_reason }));
                    if state.conn().is_some() {
                        inner.set_status(&state, SessionStatus::Idle, None);
                    }
                }
                // A turn cut short by Stop ends as cancelled, not as a failure.
                Err(_) if state.stopping.load(Ordering::SeqCst) => {
                    state.emit("turn-end", json!({ "stopReason": "cancelled" }));
                }
                Err(e) => {
                    tracing::info!(session = %state.id, "turn failed: {e}");
                    state.emit("error", json!({ "message": e, "turn": true }));
                    if state.conn().is_some() {
                        inner.set_status(&state, SessionStatus::Idle, None);
                    }
                }
            }
            // agents.json may have lost the agent during the turn.
            inner.check_agent(&state).await;
        });
        Ok(())
    }

    /// The project's agents.json changed: each of its sessions whose agent left it is stopped and
    /// in `error` at once, a running turn finished first; one whose agent is back (or one that
    /// runs the same) is put back as it was, started if it ran.
    pub async fn sync_agents(&self, project: &Path) {
        let states: Vec<_> =
            lock(&self.inner.sessions).values().filter(|s| lock(&s.record).project_path == project).cloned().collect();
        for state in states {
            self.inner.check_agent(&state).await;
        }
    }

    /// Files that changed in a project (root-relative, a watcher batch): each one the tool calls of
    /// two or more local turns named, running or just ended (`overlap_grace`), is reported to each
    /// running one (`overlap`, naming another), once per file per turn. A change no tool call
    /// names is nobody's.
    pub fn note_changes(&self, project: &Path, changed: &[String]) {
        let grace = self.inner.opts.overlap_grace;
        let turns: Vec<_> = lock(&self.inner.sessions)
            .values()
            .filter(|s| {
                let record = lock(&s.record);
                let ended = || lock(&s.turn_ended).is_some_and(|at| at.elapsed() < grace);
                record.mode == Mode::Local && record.project_path == project && (s.recording.load(Ordering::SeqCst) || ended())
            })
            .cloned()
            .collect();
        if turns.len() < 2 {
            return;
        }
        for rel in changed {
            let path = project.join(rel);
            let by: Vec<_> = turns.iter().filter(|s| lock(&s.touched).contains(&path)).collect();
            if by.len() < 2 {
                continue;
            }
            for state in by.iter().filter(|s| s.recording.load(Ordering::SeqCst)) {
                let Some(other) = by.iter().find(|o| o.id != state.id) else { continue };
                if lock(&state.overlaps).insert(path.clone()) {
                    tracing::info!(session = %state.id, other = %other.id, path = %rel, "two running turns changed one file");
                    state.emit("overlap", json!({ "path": rel, "other": { "id": other.id, "title": other.record().title } }));
                }
            }
        }
    }

    /// `session/cancel` for the running turn; pending permission requests are answered
    /// `cancelled`. The turn ends with `turn-end` `cancelled` once the agent stopped; a queued one
    /// at once, without reaching the agent.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let state = self.get(id)?;
        state.cancel_requested.store(true, Ordering::SeqCst);
        self.inner.drop_held(&state);
        if !state.turn_running.load(Ordering::SeqCst) || self.inner.leave_queue(&state) {
            return Ok(());
        }
        match state.conn() {
            Some(conn) => conn.cancel(),
            // Still starting: the turn sees `cancel_requested` before it prompts.
            None => Ok(()),
        }
    }

    /// The user's answer to a permission request: an option id, or `None` to cancel it.
    pub fn respond_permission(&self, id: &str, request_id: &str, option_id: Option<String>) -> Result<(), String> {
        let state = self.get(id)?;
        let conn = state.conn().ok_or("the agent is not running")?;
        conn.respond_permission(request_id, option_id)?;
        if conn.pending_permissions().is_empty() && state.turn_running.load(Ordering::SeqCst) {
            self.inner.set_status(&state, SessionStatus::Working, None);
        }
        Ok(())
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
        let session = {
            let mut record = lock(&state.record);
            record.title = title.to_owned();
            record.title_source = TitleSource::User;
            Session::from(&*record)
        };
        self.inner.persist();
        Ok(session)
    }

    /// Gives a renamed session back the title its agent gave it, which it then keeps up to date.
    pub fn reset_title(&self, id: &str) -> Result<Session, String> {
        let state = self.get(id)?;
        let session = {
            let mut record = lock(&state.record);
            let title = record.agent_title.clone().ok_or("the agent hasn't named this session")?;
            record.title = title;
            record.title_source = TitleSource::Agent;
            Session::from(&*record)
        };
        self.inner.persist();
        Ok(session)
    }

    /// Asks an agent for its config options (models, thought levels, modes) without a session:
    /// it starts in a scratch folder in app data, answers `initialize` and `session/new` (no prompt,
    /// so no model call), and is stopped. For the pickers before the agent's first session. One
    /// that answers AuthRequired is noted as needing a sign-in ([`Probed::SignIn`]).
    pub async fn probe_options(&self, project: Option<&Path>, agent_id: &str) -> Result<Probed, String> {
        let agent = self.inner.startable(project, agent_id)?;
        match self.inner.scratch_start(&agent, None).await {
            Ok(started) => {
                if let Some(version) = &started.agent_version {
                    self.inner.opts.configs.note_version(&agent.id, version);
                }
                tracing::info!(agent = %agent.id, options = started.config_options.len(), "probed the agent's options");
                // It's signed in (a login elsewhere): whatever waited for that needn't.
                self.inner.signed_in(&LaunchKey::of(&agent));
                Ok(Probed::Options(started.config_options))
            }
            Err(ConnectError::SignIn { methods, .. }) => {
                tracing::info!(agent = %agent.id, methods = methods.len(), "the probed agent asks to sign in");
                let need = SignInNeed { key: LaunchKey::of(&agent), agent_id: agent.id.clone(), agent_name: agent.name.clone(), methods };
                lock(&self.inner.sign_ins_needed).insert(need.key.clone(), need.clone());
                Ok(Probed::SignIn { sign_in: need.methods })
            }
            Err(ConnectError::Failed(e)) => Err(e),
        }
    }

    /// Signs an agent in with one of its methods: an `agent` method goes to `authenticate` in a
    /// process of its own (the agent opens the browser), confirmed by a `session/new`; no method
    /// (Retry, after a login in a terminal) only checks with a `session/new`. One runs per
    /// launch; a second call joins it. The launch must be trusted, as for a start. Once it
    /// worked, every session waiting for it starts again and sends its held prompt. A `terminal`
    /// or `command` method isn't run here: the result's `login` is for a Terminal tab, whose end
    /// the caller reports (`login_ended`).
    pub async fn sign_in(&self, project: Option<&Path>, agent_id: &str, method_id: Option<&str>) -> Result<SignIn, String> {
        let agent = self.inner.startable(project, agent_id)?;
        let key = LaunchKey::of(&agent);
        if let Some(joined) = self.inner.join_sign_in(&key, &agent.name) {
            return Ok(joined);
        }
        let method = method_id.and_then(|id| {
            let needed = lock(&self.inner.sign_ins_needed);
            needed.get(&key)?.methods.iter().find(|m| m.id == id).cloned()
        });
        let login = match method.as_ref().and_then(|m| m.login.clone().map(|login| (m, login))) {
            Some((method, login)) => Some(self.inner.login_for(&agent, method, &login).await?),
            None => None,
        };
        // Joined meanwhile (the env took a while).
        if let Some(joined) = self.inner.join_sign_in(&key, &agent.name) {
            return Ok(joined);
        }
        tracing::info!(agent = %agent.id, method = ?method_id, terminal = login.is_some(), "signing in");
        let (done, receiver) = watch::channel(None);
        let done = Arc::new(done);
        let agent_name = agent.name.clone();
        let mut running = lock(&self.inner.signing_in);
        if let Some((tab, login)) = login {
            running.insert(key, SignInRun { abort: None, login: Some(tab.clone()), done });
            return Ok(SignIn { agent_name, tab: Some(tab), login: Some(login), done: receiver });
        }
        let method = method_id.map(str::to_owned);
        let task = tokio::spawn(Arc::clone(&self.inner).run_sign_in(agent, key.clone(), method, Arc::clone(&done)));
        running.insert(key, SignInRun { abort: Some(task.abort_handle()), login: None, done });
        Ok(SignIn { agent_name, tab: None, login: None, done: receiver })
    }

    /// A login's terminal ended: exit 0 signed the agent in (its waiting sessions start again);
    /// another exit failed, a closed tab cancelled.
    pub fn login_ended(&self, terminal_id: &str, exit: LoginExit) {
        let found = {
            let mut running = lock(&self.inner.signing_in);
            let key = running.iter().find(|(_, run)| run.login.as_ref().is_some_and(|l| l.terminal_id == terminal_id)).map(|(k, _)| k.clone());
            key.and_then(|key| running.remove(&key).map(|run| (key, run)))
        };
        let Some((key, run)) = found else { return };
        let title = run.login.map(|l| l.title).unwrap_or_default();
        let end = match exit {
            LoginExit::Code(0) => SignInEnd::Done,
            LoginExit::Code(code) => SignInEnd::Failed(format!("{title} exited with {code}")),
            LoginExit::Signal(signal) => SignInEnd::Failed(format!("{title} was ended by {signal}")),
            LoginExit::Closed => SignInEnd::Cancelled,
        };
        tracing::info!(terminal = %terminal_id, ?end, "login ended");
        if end == SignInEnd::Done {
            self.inner.signed_in(&key);
        }
        run.done.send_replace(Some(end));
    }

    /// Stops an agent's running sign-in (its process group); `None` when none runs. A login's
    /// terminal is the caller's to close.
    pub fn cancel_sign_in(&self, project: Option<&Path>, agent_id: &str) -> Option<Cancelled> {
        let merged = self.inner.opts.configs.merged(project);
        let agent = merged.agent(agent_id)?;
        let run = lock(&self.inner.signing_in).remove(&LaunchKey::of(agent))?;
        tracing::info!(agent = %agent_id, "sign-in cancelled");
        if let Some(abort) = &run.abort {
            abort.abort();
        }
        run.done.send_replace(Some(SignInEnd::Cancelled));
        Some(Cancelled { terminal_id: run.login.map(|l| l.terminal_id) })
    }

    /// The agents of a project (the user's without one), each marked when it waits for a sign-in.
    pub fn agent_list(&self, project: Option<&Path>) -> crate::config::AgentList {
        let mut list = self.inner.opts.configs.list(project);
        for agent in &mut list.agents {
            agent.sign_in = agent.enabled && self.sign_in_state(project, &agent.id).is_some_and(|s| !s.methods.is_empty());
        }
        list
    }

    /// Whether an agent asked for a sign-in (at a start, a prompt or a probe), or one runs.
    pub fn sign_in_state(&self, project: Option<&Path>, agent_id: &str) -> Option<SignInState> {
        let merged = self.inner.opts.configs.merged(project);
        let key = LaunchKey::of(merged.agent(agent_id)?);
        let pending = lock(&self.inner.signing_in).contains_key(&key);
        let methods = lock(&self.inner.sign_ins_needed).get(&key).map(|need| need.methods.clone());
        (pending || methods.is_some()).then(|| SignInState { methods: methods.unwrap_or_default(), pending })
    }

    /// Removes a session for good: its agent is stopped (a running turn ends `cancelled`), it's no
    /// longer listed, and its transcript and log are deleted. Its folder is discarded by its
    /// environment: `local` keeps the project as it is, `worktree` keeps a worktree with
    /// uncommitted changes and a branch with commits.
    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let state = self.get(id)?;
        self.inner.stop(&state).await;
        if lock(&self.inner.sessions).remove(id).is_none() {
            return Err(format!("unknown session {id}"));
        }
        self.inner.persist();
        state.transcript.close();
        let record = state.record();
        let dir = self.inner.data_dir().join("sessions").join(id);
        tokio::task::spawn_blocking(move || {
            if let Err(e) = env::for_session(&record).and_then(|env| env.discard()) {
                tracing::warn!(session = %record.session_id, "discarding the session's folder failed: {e}");
            }
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
    /// says why).
    pub async fn resume(&self, id: &str) -> Result<bool, String> {
        let state = self.get(id)?;
        let record = state.record();
        if record.status != SessionStatus::Stopped {
            return Ok(record.status.is_active());
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

    /// The session's conversation as recorded (see `transcript`), oldest first. Blocking.
    pub fn history(&self, id: &str) -> Result<Vec<Value>, String> {
        self.get(id)?;
        transcript::read(&transcript_path(self.inner.data_dir(), id))
    }

    /// Sets one of the agent's config options (model, thought level, mode); the options as they
    /// are then arrive as `config-options`. The agent must be running.
    pub async fn set_config_option(&self, id: &str, config_id: &str, value: &str) -> Result<(), String> {
        let state = self.get(id)?;
        let conn = state.conn().ok_or("The agent isn't running; the choice applies when it starts")?;
        let options = conn.set_config_option(config_id, value).await?;
        remember_config(&state, &options);
        self.inner.persist();
        state.emit("config-options", json!({ "configOptions": options }));
        Ok(())
    }

    /// Applies a worktree session's work since its base (commits and uncommitted changes) to the
    /// project's checkout, unstaged; a checkout that moved on gets a three-way merge. Refused while
    /// a turn runs.
    pub async fn apply_locally(&self, id: &str) -> Result<crate::git::apply::ApplyOutcome, String> {
        let state = self.get(id)?;
        let (dir, base) = self.worktree_of(id)?;
        let _slot = Self::idle_worktree(&state)?;
        let project = state.record().project_path;
        let outcome = tokio::task::spawn_blocking(move || {
            crate::git::apply::apply_locally(crate::git::binary::git()?, &dir, &base, &project)
        })
        .await
        .map_err(|e| e.to_string())??;
        tracing::info!(session = %id, ?outcome, "applied the worktree's work to the project");
        Ok(outcome)
    }

    /// Hands a worktree session's branch to the project: stops the agent and checks the branch out
    /// in the project's checkout (the worktree is left detached; the session goes on only once the
    /// project is on another branch). Refused while a turn runs or the worktree has uncommitted
    /// changes, which a checkout would leave behind.
    pub async fn check_out_branch(&self, id: &str) -> Result<(), String> {
        let state = self.get(id)?;
        self.worktree_of(id)?;
        let _slot = Self::idle_worktree(&state)?;
        let record = state.record();
        let (Some(root), Some(branch)) = (record.worktree_path, record.branch) else {
            return Err("the session's worktree is missing from its record".to_owned());
        };
        let check = root.clone();
        let dirty = tokio::task::spawn_blocking(move || crate::git::worktree::is_dirty(crate::git::binary::git()?, &check))
            .await
            .map_err(|e| e.to_string())??;
        if dirty {
            return Err("The worktree has uncommitted changes, which a checkout would leave behind: Apply Locally brings them, or ask the agent to commit them".to_owned());
        }
        self.inner.stop(&state).await;
        self.inner.set_status(&state, SessionStatus::Stopped, None);
        let project = record.project_path;
        let handed = branch.clone();
        tokio::task::spawn_blocking(move || {
            crate::git::apply::check_out_branch(crate::git::binary::git()?, &root, &handed, &project)
        })
        .await
        .map_err(|e| e.to_string())??;
        tracing::info!(session = %id, %branch, "checked the session's branch out in the project");
        Ok(())
    }

    /// Takes the session's turn slot for git work on its worktree, so no prompt starts while it runs
    /// (`send_prompt` then refuses); released when the guard drops. Refused while a turn runs.
    fn idle_worktree(state: &Arc<SessionState>) -> Result<SlotGuard, String> {
        if state.turn_running.swap(true, Ordering::SeqCst) {
            return Err("The agent is working in the worktree; wait for its turn to end, or stop it".to_owned());
        }
        Ok(SlotGuard(Arc::clone(state)))
    }

    /// A worktree session's changed files since its base commit, relative to its folder. Blocking.
    pub fn changes(&self, id: &str) -> Result<Vec<crate::git::repo::FileStatus>, String> {
        let (dir, base) = self.worktree_of(id)?;
        crate::git::apply::changed_since(crate::git::binary::git()?, &dir, &base)
    }

    /// A worktree session's file (relative to its folder) at its base commit; `None` when it
    /// wasn't there, is binary or too large. Blocking.
    pub fn file_at_base(&self, id: &str, path: &str) -> Result<Option<String>, String> {
        crate::workspace::checked_rel(path)?;
        let (dir, base) = self.worktree_of(id)?;
        crate::git::blob::file_at(crate::git::binary::git()?, &dir, &base, path)
    }

    /// A worktree session's folder and base commit.
    fn worktree_of(&self, id: &str) -> Result<(PathBuf, String), String> {
        let record = self.get(id)?.record();
        match (record.mode, record.base_commit) {
            (Mode::Worktree, Some(base)) if record.agent_cwd.is_dir() => Ok((record.agent_cwd, base)),
            (Mode::Worktree, Some(_)) => Err(format!("{}: the worktree isn't checked out", record.agent_cwd.display())),
            _ => Err("only worktree sessions have changes of their own".to_owned()),
        }
    }

    /// The agent's stderr log of a session.
    pub fn log_path(&self, id: &str) -> Result<PathBuf, String> {
        self.get(id)?;
        Ok(self.inner.log_path(id))
    }

    /// At launch: drops the worktree metadata of deleted folders in every project with worktree
    /// sessions, and removes the worktrees in app data no session owns (left by a removal that
    /// failed), unless they hold uncommitted work. Branches stay. Blocking.
    pub fn tidy_worktrees(&self) {
        let records: Vec<SessionRecord> = lock(&self.inner.sessions).values().map(|s| s.record()).collect();
        let worktrees: Vec<&SessionRecord> = records.iter().filter(|r| r.mode == Mode::Worktree).collect();
        let projects: std::collections::HashSet<&Path> = worktrees.iter().map(|r| r.project_path.as_path()).collect();
        if let Ok(git) = crate::git::binary::git() {
            for project in projects.into_iter().filter(|p| p.is_dir()) {
                if let Err(e) = crate::git::worktree::prune(git, project) {
                    tracing::info!(project = %project.display(), "pruning worktrees failed: {e}");
                }
            }
        }
        let Ok(groups) = std::fs::read_dir(self.inner.data_dir().join("worktrees")) else { return };
        for group in groups.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()) {
            let Ok(group) = dunce::canonicalize(&group) else { continue };
            for path in std::fs::read_dir(&group).into_iter().flatten().filter_map(Result::ok).map(|e| e.path()) {
                // Asked of the live sessions, not a list read earlier: one created meanwhile may be
                // checking this folder out.
                if !path.is_dir() || self.owns_worktree(&path) {
                    continue;
                }
                if let Err(e) = env::remove_orphan(&path) {
                    if e.contains("uncommitted") {
                        tracing::warn!("{e}");
                    } else {
                        tracing::info!("{e}");
                    }
                }
            }
            // Only when empty.
            let _ = std::fs::remove_dir(&group);
        }
    }

    /// Whether a listed session's worktree is at `path`.
    fn owns_worktree(&self, path: &Path) -> bool {
        lock(&self.inner.sessions).values().any(|s| lock(&s.record).worktree_path.as_deref() == Some(path))
    }

    /// App exit: every agent process group is stopped, every session saved as `stopped`.
    pub fn shutdown(&self) {
        let states: Vec<_> = lock(&self.inner.sessions).values().cloned().collect();
        for state in &states {
            state.stopping.store(true, Ordering::SeqCst);
            if let Some(cancel) = lock(&state.prepare_cancel).take() {
                cancel.store(true, Ordering::SeqCst);
            }
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

/// The conversation of a session, kept next to its agent log.
fn transcript_path(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("sessions").join(id).join("transcript.jsonl")
}

fn new_state(record: SessionRecord, data_dir: &Path) -> SessionState {
    SessionState {
        transcript: Transcript::new(transcript_path(data_dir, &record.session_id)),
        recording: AtomicBool::new(false),
        unconfigured: Mutex::new(None),
        running: Mutex::new(None),
        outdated: AtomicBool::new(false),
        touched: Mutex::default(),
        overlaps: Mutex::default(),
        tool_kinds: Mutex::default(),
        turn_ended: Mutex::default(),
        sign_in: Mutex::default(),
        held: Mutex::default(),
        id: record.session_id.clone(),
        record: Mutex::new(record),
        sinks: Mutex::default(),
        seq: AtomicU64::new(0),
        live: tokio::sync::Mutex::new(None),
        conn: Mutex::new(None),
        env: Mutex::new(None),
        starting: Mutex::new(None),
        prepare_cancel: Mutex::new(None),
        start_attempts: AtomicU64::new(0),
        start_error: Mutex::new(None),
        generation: AtomicU64::new(0),
        turn_running: AtomicBool::new(false),
        cancel_requested: AtomicBool::new(false),
        stopping: AtomicBool::new(false),
    }
}

/// Sets a freshly started agent to the session's config: each value it offers and doesn't have
/// yet. One choice can change the others (a model without thought levels), so each next one is
/// picked from the options the last answer brought. An agent that doesn't answer within `limit`
/// (or goes away) is left as it is. Returns the options as they are then.
async fn apply_config(
    conn: &Connection,
    wanted: &BTreeMap<String, String>,
    mut options: Vec<Value>,
    limit: Duration,
) -> Vec<Value> {
    let mut tried = std::collections::HashSet::new();
    while let Some((id, value)) =
        wanted.iter().find(|(id, value)| !tried.contains(id.as_str()) && offers_other(&options, id, value))
    {
        tried.insert(id.as_str());
        let answer = tokio::select! {
            answer = tokio::time::timeout(limit, conn.set_config_option(id, value)) => answer,
            _ = conn.closed() => break,
        };
        match answer {
            Ok(Ok(now)) => options = now,
            Ok(Err(e)) => tracing::info!(config = %id, value = %value, "the agent refused the session's choice: {e}"),
            Err(_) => {
                tracing::info!(config = %id, "the agent didn't answer within {}s; left as it is", limit.as_secs_f32());
                break;
            }
        }
    }
    options
}

/// Whether option `id` can be set to `value` and isn't already; values may come in groups.
fn offers_other(options: &[Value], id: &str, value: &str) -> bool {
    let Some(option) = options.iter().find(|o| o["id"] == id) else { return false };
    let values = option["options"].as_array().into_iter().flatten();
    let mut flat = values.flat_map(|v| v["options"].as_array().map_or_else(|| vec![v], |group| group.iter().collect()));
    option["currentValue"] != value && flat.any(|v| v["value"] == value)
}

/// The options' current values become the session's config; one the agent no longer lists keeps
/// its last value.
fn remember_config(state: &SessionState, options: &[Value]) {
    let current = options.iter().filter_map(|o| Some((o["id"].as_str()?.to_owned(), o["currentValue"].as_str()?.to_owned())));
    lock(&state.record).config.extend(current);
}

impl Inner {
    fn persist(&self) {
        let records: Vec<SessionRecord> = {
            let sessions = lock(&self.sessions);
            let mut records: Vec<_> = sessions.values().map(|s| s.record()).collect();
            for record in records.iter_mut().filter(|r| r.status == SessionStatus::Queued) {
                // The turn waits only in this process.
                record.status = SessionStatus::Idle;
            }
            records.sort_by(|a, b| a.created_at.cmp(&b.created_at));
            records
        };
        if let Err(e) = self.store.save(&records) {
            tracing::warn!("saving sessions failed: {e}");
        }
    }

    /// Marks the session active now (a prompt, a turn's end), which orders the list.
    fn touch(&self, state: &SessionState) {
        lock(&state.record).last_activity_at = Some(iso_now());
        self.persist();
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

    /// The session's connection, starting the agent if it isn't running. `attempts` is
    /// `start_attempts` as the caller saw it: a start that ran since (while this call waited) and
    /// failed is this call's failure too, so one message never starts the agent twice.
    async fn ensure_started(self: &Arc<Self>, state: &Arc<SessionState>, attempts: u64) -> Result<Arc<Connection>, StartError> {
        let mut live = state.live.lock().await;
        if let Some(live) = live.as_ref() {
            return Ok(Arc::clone(&live.conn));
        }
        if state.start_attempts.load(Ordering::SeqCst) != attempts {
            let failed = lock(&state.start_error).clone();
            return Err(failed.unwrap_or_else(|| StartError::Failed("the agent stopped".to_owned())));
        }
        let result = self.attempt_start(state).await;
        *lock(&state.start_error) = result.as_ref().err().cloned();
        state.start_attempts.fetch_add(1, Ordering::SeqCst);
        let (started, env) = result?;
        let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let conn = Arc::clone(&started.conn);
        *lock(&state.conn) = Some(Arc::clone(&conn));
        *lock(&state.env) = Some(env);
        *live = Some(Live { conn: Arc::clone(&conn), process: started.process, generation });
        drop(live);

        let inner = Arc::clone(self);
        let watched = Arc::clone(state);
        let closed = Arc::clone(&conn);
        tokio::spawn(async move {
            let reason = closed.closed().await;
            drop(closed);
            inner.on_agent_exit(&watched, generation, reason).await;
        });

        if let Some(launch) = lock(&state.running).as_ref() {
            lock(&self.sign_ins_needed).remove(&LaunchKey::new(&launch.command, &launch.args, &launch.env));
        }
        if lock(&state.sign_in).take().is_some() {
            state.emit("sign-in", Value::Null);
        }
        // A turn that held its prompt for this start (one that began while it was getting there).
        if let Some(held) = lock(&state.held).take() {
            let _ = held.send(true);
        }
        state.emit("config-options", json!({ "configOptions": started.config_options }));
        let message = (started.resumed && !started.history_restored).then_some("Agent history not restored");
        self.set_status(state, SessionStatus::Idle, message);
        Ok(conn)
    }

    /// Starts the session's agent in the background; a failure reaches the page as `error` (or
    /// `sign-in`, sent by the start).
    fn start_in_background(self: &Arc<Self>, state: &Arc<SessionState>) {
        let inner = Arc::clone(self);
        let state = Arc::clone(state);
        let attempts = state.start_attempts.load(Ordering::SeqCst);
        tokio::spawn(async move {
            if let Err(StartError::Failed(e)) = inner.ensure_started(&state, attempts).await {
                state.emit("error", json!({ "message": e }));
            }
        });
    }

    /// One start, with the session's `live` lock held.
    async fn attempt_start(self: &Arc<Self>, state: &Arc<SessionState>) -> Result<(StartedAgent, Arc<dyn SessionEnv>), StartError> {
        // A new attempt: whatever happens now isn't the earlier Stop's doing.
        state.stopping.store(false, Ordering::SeqCst);
        // In a task of its own, so Stop can abort it: dropping it drops the process, which kills
        // the group.
        let task = tokio::spawn(Arc::clone(self).start_agent(Arc::clone(state)));
        *lock(&state.starting) = Some(task.abort_handle());
        let result = task.await;
        lock(&state.starting).take();
        match result {
            Ok(Ok(started)) => Ok(started),
            Ok(Err(StartFailure::Untrusted(untrusted))) => {
                tracing::info!(session = %state.id, "agent not started: the project's launch isn't trusted");
                self.set_status(state, SessionStatus::Error, Some(&untrusted.message));
                state.emit("untrusted", json!({ "launch": untrusted.launch, "message": untrusted.message }));
                Err(StartError::Failed(untrusted.message))
            }
            Ok(Err(StartFailure::Unconfigured { agent_id, ran, absence })) => {
                tracing::info!(session = %state.id, agent = %agent_id, ?absence, "agent not started");
                Err(StartError::Failed(self.report_unconfigured(state, &agent_id, ran.as_deref(), absence, true)))
            }
            Ok(Err(StartFailure::SignIn(need))) => {
                tracing::info!(session = %state.id, agent = %need.agent_id, "agent not started: it asks to sign in");
                self.report_sign_in(state, *need);
                Err(StartError::SignIn)
            }
            Ok(Err(StartFailure::Failed(e))) => {
                tracing::warn!(session = %state.id, "agent failed to start: {e}");
                self.set_status(state, SessionStatus::Error, Some(&e));
                Err(StartError::Failed(e))
            }
            Err(_) => Err(StartError::Failed("stopped while starting".to_owned())),
        }
    }

    /// The session's agent asks for a sign-in: `error` with "Sign in to …", and `sign-in` with
    /// its methods; the launch is noted as needing one.
    fn report_sign_in(&self, state: &SessionState, need: SignInNeed) {
        let message = format!("Sign in to {}", need.agent_name);
        lock(&self.sign_ins_needed).insert(need.key.clone(), need.clone());
        self.set_status(state, SessionStatus::Error, Some(&message));
        state.emit("sign-in", json!({ "agentId": need.agent_id, "agentName": need.agent_name, "methods": need.methods }));
        *lock(&state.sign_in) = Some(need);
    }

    /// An agent that may run for `project` (the user's agents without one): in its agents.json,
    /// on, and trusted.
    fn startable(&self, project: Option<&Path>, agent_id: &str) -> Result<AgentConfig, String> {
        let merged = self.opts.configs.merged(project);
        let agent = merged.agent(agent_id).cloned().ok_or_else(|| format!("Unknown agent \"{agent_id}\""))?;
        if merged.enabled(agent_id).is_none() {
            return Err(Absence::Off.message(&merged, agent_id));
        }
        if let Some(project) = project {
            self.check_trust(project, &merged, agent_id).map_err(|untrusted| untrusted.message)?;
        }
        Ok(agent)
    }

    /// Starts `agent` in a scratch folder in app data (`initialize`, then `authenticate` with
    /// `authenticate` if given, then `session/new`; no prompt) and stops it again.
    async fn scratch_start(&self, agent: &AgentConfig, authenticate: Option<String>) -> Result<acp::Started, ConnectError> {
        let dir = self.data_dir().join("probe");
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let dir = dunce::canonicalize(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let base_env = Arc::clone(&self.opts.base_env);
        let secrets = Arc::clone(&self.opts.secrets);
        let agent_env = agent.env.clone();
        let process_env = tokio::task::spawn_blocking(move || {
            crate::config::env::agent_env(&base_env(), crate::git::exec::SCRUBBED_ENV, &agent_env, &*secrets)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {e}", agent.name))?;
        let log_path = dir.join(format!("{}.log", agent.id.replace(['/', '\\'], "_")));
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("{}: {e}", log_path.display()))?;
        let env = env::LocalEnv::new(dir.clone());
        let Launched { mut process, writer, reader } = self.opts.launcher.launch(&env, agent, &process_env, log)?;
        drop(process_env);
        let opts = StartOptions {
            cwd: dir,
            mcp_servers: Vec::new(),
            resume: None,
            agent_name: agent.name.clone(),
            initialize_timeout: self.opts.initialize_timeout,
            authenticate,
        };
        // Dropping `process` (a cancelled sign-in) kills its group too.
        let started = Connection::start(writer, reader, Arc::new(ProbeHost), opts).await;
        if let Some(process) = process.as_mut() {
            process.stop().await;
        }
        started.map(|(_, started)| started)
    }

    /// The sign-in already running for `key`, joined.
    fn join_sign_in(&self, key: &LaunchKey, agent_name: &str) -> Option<SignIn> {
        let running = lock(&self.signing_in);
        let run = running.get(key)?;
        Some(SignIn { agent_name: agent_name.to_owned(), tab: run.login.clone(), login: None, done: run.done.subscribe() })
    }

    /// The Terminal tab and command of a `terminal` / `command` method: the agent's launch with
    /// its env resolved, in the probe folder.
    async fn login_for(&self, agent: &AgentConfig, method: &SignInMethod, login: &acp::auth::Login) -> Result<(LoginTab, Login), String> {
        let base_env = Arc::clone(&self.opts.base_env);
        let secrets = Arc::clone(&self.opts.secrets);
        let agent_env = agent.env.clone();
        let env = tokio::task::spawn_blocking(move || {
            crate::config::env::agent_env(&base_env(), crate::git::exec::SCRUBBED_ENV, &agent_env, &*secrets)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {e}", agent.name))?;
        let command = acp::auth::login_command(&agent.command, &agent.args, &env, login);
        let cwd = self.data_dir().join("probe");
        std::fs::create_dir_all(&cwd).map_err(|e| format!("{}: {e}", cwd.display()))?;
        let cwd = dunce::canonicalize(&cwd).map_err(|e| format!("{}: {e}", cwd.display()))?;
        let n = self.next_login.fetch_add(1, Ordering::SeqCst) + 1;
        let tab = LoginTab {
            terminal_id: format!("sign-in-{n}"),
            title: method.label.clone().unwrap_or_else(|| method.name.clone()),
            command_line: std::iter::once(command.program.as_str()).chain(command.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" "),
        };
        Ok((tab, Login { cwd, command }))
    }

    /// One sign-in of `Sessions::sign_in`, to its end (at most `SIGN_IN_LIMIT`).
    async fn run_sign_in(self: Arc<Self>, agent: AgentConfig, key: LaunchKey, method: Option<String>, done: Arc<watch::Sender<Option<SignInEnd>>>) {
        let end = match tokio::time::timeout(SIGN_IN_LIMIT, self.scratch_start(&agent, method)).await {
            Err(_) => SignInEnd::Failed(format!("Signing in to {} took over {} minutes", agent.name, SIGN_IN_LIMIT.as_secs() / 60)),
            Ok(Ok(_)) => SignInEnd::Done,
            Ok(Err(ConnectError::SignIn { .. })) => SignInEnd::Failed(format!("{} still asks to sign in", agent.name)),
            Ok(Err(ConnectError::Failed(e))) => SignInEnd::Failed(e),
        };
        {
            let mut running = lock(&self.signing_in);
            if !running.get(&key).is_some_and(|run| Arc::ptr_eq(&run.done, &done)) {
                // Cancelled after it ended, past the abort's last chance: Cancel said so already.
                return;
            }
            running.remove(&key);
        }
        match &end {
            SignInEnd::Done => {
                tracing::info!(agent = %agent.id, "signed in");
                self.signed_in(&key);
            }
            SignInEnd::Failed(e) => tracing::info!(agent = %agent.id, "sign-in failed: {e}"),
            SignInEnd::Cancelled => {}
        }
        done.send_replace(Some(end));
    }

    /// A launch signed in: it no longer needs to, and every session waiting for it starts again,
    /// sending its held prompt (one without goes `idle`).
    /// A session counts when its agent asked under that launch, or runs it now (agents.json
    /// changed it since).
    fn signed_in(self: &Arc<Self>, key: &LaunchKey) {
        lock(&self.sign_ins_needed).remove(key);
        let sessions: Vec<_> = lock(&self.sessions).values().cloned().collect();
        let waiting = sessions.into_iter().filter(|s| {
            let Some(asked) = lock(&s.sign_in).as_ref().map(|need| need.key.clone()) else { return false };
            asked == *key || {
                let record = s.record();
                let merged = self.opts.configs.merged(Some(&record.project_path));
                merged.agent(&record.agent_id).is_some_and(|agent| LaunchKey::of(agent) == *key)
            }
        });
        for state in waiting {
            tracing::info!(session = %state.id, "signed in: starting the agent again");
            match lock(&state.held).take() {
                Some(held) => {
                    let _ = held.send(true);
                }
                None => self.start_in_background(&state),
            }
        }
    }

    /// Drops the prompt a turn holds for a sign-in, if any; the turn then ends `cancelled`.
    fn drop_held(&self, state: &SessionState) {
        if let Some(held) = lock(&state.held).take() {
            let _ = held.send(false);
        }
    }

    /// Holds a turn's prompt until its agent signed in (`true`) or it's dropped (`false`: Stop,
    /// cancel, Remove, its agent gone), which gives the page the prompt back (`prompt-returned`).
    async fn hold(&self, state: &SessionState, prompt: &[PromptInput]) -> bool {
        let (held, answer) = oneshot::channel();
        *lock(&state.held) = Some(held);
        // A Stop or cancel that came first.
        if state.cancel_requested.load(Ordering::SeqCst) || state.stopping.load(Ordering::SeqCst) {
            lock(&state.held).take();
        } else if lock(&state.sign_in).is_none() && lock(&state.held).take().is_some() {
            // A start worked between the failure and now (a sign-in that just ended).
            return true;
        } else {
            tracing::info!(session = %state.id, "prompt held until the agent is signed in");
            state.emit("held", json!({ "prompt": prompt }));
        }
        let send = answer.await.unwrap_or(false);
        if !send {
            state.emit("prompt-returned", json!({ "prompt": prompt }));
        }
        send
    }

    /// Refuses an agent whose launch the project's agents.json chose until the user trusted it.
    /// `merged` is the config the caller is about to launch from.
    fn check_trust(&self, project: &Path, merged: &Merged, agent_id: &str) -> Result<(), Untrusted> {
        let Some(launch) = merged.launch(agent_id) else { return Ok(()) };
        if !merged.needs_trust(agent_id) || self.opts.configs.is_trusted(project, &launch) {
            return Ok(());
        }
        let name = merged.agent(agent_id).map_or(agent_id, |a| a.name.as_str());
        let command = std::iter::once(launch.command.as_str()).chain(launch.args.iter().map(String::as_str)).collect::<Vec<_>>();
        let mut message = format!("This project's .brama/agents.json sets what \"{name}\" runs: {}", command.join(" "));
        let servers: Vec<&str> = launch.mcp_servers.iter().filter_map(|s| s["name"].as_str()).collect();
        if merged.project_mcp && !servers.is_empty() {
            message.push_str(&format!(", with MCP servers {}", servers.join(", ")));
        }
        message.push_str(". Start it only if you trust this project.");
        Err(Untrusted { launch: Box::new(launch), message })
    }

    async fn start_agent(
        self: Arc<Self>,
        state: Arc<SessionState>,
    ) -> Result<(StartedAgent, Arc<dyn SessionEnv>), StartFailure> {
        let record = state.record();
        self.set_status(&state, SessionStatus::Preparing, None);
        let env: Arc<dyn SessionEnv> = Arc::from(env::for_session(&record)?);
        let preparing = Arc::clone(&env);
        let cancel = Arc::new(AtomicBool::new(false));
        *lock(&state.prepare_cancel) = Some(Arc::clone(&cancel));
        let prepared = tokio::task::spawn_blocking(move || preparing.prepare(&cancel)).await;
        lock(&state.prepare_cancel).take();
        prepared.map_err(|e| e.to_string())??;

        self.set_status(&state, SessionStatus::Starting, Some("Starting agent…"));
        let merged = self.opts.configs.merged(Some(&record.project_path));
        let agent = match merged.enabled(&record.agent_id) {
            Some(agent) => agent.clone(),
            None => self.follow_agent(&state, &record, &merged)?,
        };
        self.check_trust(&record.project_path, &merged, &agent.id).map_err(StartFailure::Untrusted)?;
        let base_env = Arc::clone(&self.opts.base_env);
        let secrets = Arc::clone(&self.opts.secrets);
        let agent_env = agent.env.clone();
        let process_env = tokio::task::spawn_blocking(move || {
            crate::config::env::agent_env(&base_env(), crate::git::exec::SCRUBBED_ENV, &agent_env, &*secrets)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {e}", agent.name))?;

        *lock(&state.running) = merged.launch(&agent.id);
        state.outdated.store(false, Ordering::SeqCst);
        // Its agent is there: whatever said it was gone is over.
        lock(&state.unconfigured).take();
        let launch = AgentLaunch { command: agent.command.clone(), args: agent.args.clone() };
        if record.launch.as_ref() != Some(&launch) || record.agent_name.as_ref() != Some(&agent.name) {
            let mut record = lock(&state.record);
            record.launch = Some(launch);
            record.agent_name = Some(agent.name.clone());
            drop(record);
            self.persist();
        }
        let log = self.open_log(&state.id, &agent)?;
        let launched = self.opts.launcher.launch(&*env, &agent, &process_env, log)?;
        drop(process_env);
        if let Some(pid) = launched.process.as_ref().and_then(AgentProcess::pid) {
            tracing::info!(session = %state.id, agent = %agent.id, pid, "agent process started");
        }

        let host = Arc::new(SessionHost { state: Arc::downgrade(&state) });
        let opts = StartOptions {
            cwd: env.agent_cwd().to_path_buf(),
            mcp_servers: merged.mcp_servers.clone(),
            resume: record.acp_session_id.clone(),
            agent_name: agent.name.clone(),
            initialize_timeout: self.opts.initialize_timeout,
            authenticate: None,
        };
        let Launched { mut process, writer, reader } = launched;
        let (conn, started) = match Connection::start(writer, reader, host, opts).await {
            Ok(ok) => ok,
            Err(e) => {
                if let Some(process) = process.as_mut() {
                    process.stop().await;
                }
                return Err(match e {
                    ConnectError::SignIn { methods, .. } => StartFailure::SignIn(Box::new(SignInNeed {
                        key: LaunchKey::of(&agent),
                        agent_id: agent.id.clone(),
                        agent_name: agent.name.clone(),
                        methods,
                    })),
                    ConnectError::Failed(e) => StartFailure::Failed(e),
                });
            }
        };
        tracing::info!(
            session = %state.id,
            mode = ?env.mode(),
            load_supported = started.load_supported,
            history_restored = started.history_restored,
            "agent ready"
        );
        if let Some(version) = &started.agent_version {
            self.opts.configs.note_version(&agent.id, version);
        }
        // Still in the task Stop aborts, and before anyone gets the connection: the first prompt
        // runs with the session's choices.
        let options = apply_config(&conn, &record.config, started.config_options, self.opts.initialize_timeout).await;
        remember_config(&state, &options);
        lock(&state.record).acp_session_id = Some(started.acp_session_id.clone());
        self.persist();
        Ok((
            StartedAgent {
                conn: Arc::new(conn),
                process,
                resumed: record.acp_session_id.is_some(),
                history_restored: started.history_restored,
                config_options: options,
            },
            env,
        ))
    }

    /// Appends a start marker to the session's log and returns the file for the agent's stderr.
    /// The command line is from the config (no resolved env), so it holds no secret.
    /// Brings one session in line with its project's agents.json (see `Sessions::sync_agents`).
    async fn check_agent(self: &Arc<Self>, state: &Arc<SessionState>) {
        let record = state.record();
        // A start checks for itself.
        if matches!(record.status, SessionStatus::Preparing | SessionStatus::Starting) {
            return;
        }
        let merged = self.opts.configs.merged(Some(&record.project_path));
        let found = merged.enabled(&record.agent_id).is_some() || self.follow_agent(state, &record, &merged).is_ok();
        let reported = *lock(&state.unconfigured);
        match (found, reported) {
            (true, Some(was_active)) => {
                lock(&state.unconfigured).take();
                tracing::info!(session = %state.id, "its agent is in agents.json again");
                self.set_status(state, SessionStatus::Stopped, None);
                if was_active {
                    self.start_in_background(state);
                }
            }
            (true, None) if state.conn().is_some() => self.check_launch(state, &merged),
            // A queued turn ends (`cancelled`) without reaching the agent; its end checks again.
            (false, None) if record.status == SessionStatus::Queued => {
                state.cancel_requested.store(true, Ordering::SeqCst);
                self.leave_queue(state);
            }
            // So does a turn holding its prompt for a sign-in.
            (false, None) if lock(&state.held).is_some() => {
                state.cancel_requested.store(true, Ordering::SeqCst);
                self.drop_held(state);
            }
            (false, None) if !state.turn_running.load(Ordering::SeqCst) => {
                let ran = record.launch.as_ref().map(|l| format!("{} {}", l.command, l.args.join(" ")));
                let absence = Absence::of(&merged, &record.agent_id);
                tracing::info!(session = %state.id, agent = %record.agent_id, ?absence, "its agent can't run: stopped");
                self.stop(state).await;
                self.report_unconfigured(state, &record.agent_id, ran.as_deref(), absence, record.status.is_active());
            }
            _ => {}
        }
    }

    /// Tells the page, once, when agents.json now gives the running agent another command, args,
    /// env or MCP servers than it was started with (a Restart picks them up), and again (`null`)
    /// when it's back to those.
    fn check_launch(&self, state: &SessionState, merged: &Merged) {
        let record = state.record();
        let Some(running) = lock(&state.running).clone() else { return };
        let changed = merged.launch(&record.agent_id).is_none_or(|now| LaunchConfig { agent_id: running.agent_id.clone(), ..now } != running);
        if state.outdated.swap(changed, Ordering::SeqCst) == changed {
            return;
        }
        let name = merged.agent(&record.agent_id).map_or(record.agent_id.as_str(), |a| a.name.as_str());
        let message = changed.then(|| format!("agents.json changed what {name} runs. Restart to use it."));
        tracing::info!(session = %state.id, changed, "the running agent's launch in agents.json");
        state.emit("agent-outdated", json!({ "message": message }));
    }

    /// The session's agent isn't in agents.json, or is turned off: `error` with a message that
    /// says so, and an `unconfigured` event (`reason`: `removed` / `off`). Returns the message.
    fn report_unconfigured(&self, state: &SessionState, agent_id: &str, ran: Option<&str>, absence: Absence, was_active: bool) -> String {
        let message = absence.message(&self.opts.configs.merged(Some(&state.record().project_path)), agent_id);
        *lock(&state.unconfigured) = Some(was_active);
        self.set_status(state, SessionStatus::Error, Some(&message));
        state.emit("unconfigured", json!({ "agentId": agent_id, "message": message, "ran": ran, "reason": absence.reason() }));
        message
    }

    /// The agent that runs what the session's agent ran, its id gone from agents.json (removed and
    /// added again under another): the session takes it, and the page hears of it.
    fn follow_agent(&self, state: &SessionState, record: &SessionRecord, merged: &Merged) -> Result<AgentConfig, StartFailure> {
        // A session from before launches were kept: its log's last start line says what it ran.
        let ran = match &record.launch {
            Some(launch) => Some(format!("{} {}", launch.command, launch.args.join(" "))),
            None => self.logged_launch(&state.id, &record.agent_id),
        };
        let absence = Absence::of(merged, &record.agent_id);
        // Only an agent that left the file is followed: one turned off stays the session's agent.
        let agent = ran
            .as_ref()
            .filter(|_| absence == Absence::Removed)
            .and_then(|ran| merged.agents.iter().filter(|a| merged.enabled(&a.id).is_some()).find(|a| log_line(a) == *ran))
            .ok_or_else(|| StartFailure::Unconfigured { agent_id: record.agent_id.clone(), ran: ran.clone(), absence })?;
        tracing::info!(session = %state.id, from = %record.agent_id, to = %agent.id, "session follows its agent to a new id");
        let session = {
            let mut record = lock(&state.record);
            record.agent_id.clone_from(&agent.id);
            Session::from(&*record)
        };
        self.persist();
        state.emit("session", serde_json::to_value(session).unwrap_or_default());
        Ok(agent.clone())
    }

    /// What the last start of `agent_id` in the session's log ran, as `log_line` wrote it.
    fn logged_launch(&self, id: &str, agent_id: &str) -> Option<String> {
        let log = std::fs::read_to_string(self.log_path(id)).ok()?;
        let marker = format!(" starting {agent_id}: ");
        log.lines().rev().filter(|l| l.starts_with("--- ")).find_map(|l| l.split_once(&marker).map(|(_, ran)| ran.to_owned()))
    }

    fn open_log(&self, id: &str, agent: &AgentConfig) -> Result<File, String> {
        let path = self.log_path(id);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let mut file =
            OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let _ = writeln!(file, "--- {} starting {}: {}", iso_now(), agent.id, log_line(agent));
        Ok(file)
    }

    /// A turn; one its agent wants a sign-in for (at the start, or answering the prompt) holds
    /// the prompt until then, and is run again.
    async fn run_turn(
        self: &Arc<Self>,
        state: &Arc<SessionState>,
        prompt: Vec<PromptInput>,
        mut attempts: u64,
    ) -> Result<String, String> {
        loop {
            match self.try_turn(state, prompt.clone(), attempts).await {
                Ok(stop_reason) => return Ok(stop_reason),
                Err(StartError::Failed(e)) => return Err(e),
                Err(StartError::SignIn) => {
                    if !self.hold(state, &prompt).await {
                        return Ok("cancelled".to_owned());
                    }
                    attempts = state.start_attempts.load(Ordering::SeqCst);
                }
            }
        }
    }

    async fn try_turn(
        self: &Arc<Self>,
        state: &Arc<SessionState>,
        prompt: Vec<PromptInput>,
        attempts: u64,
    ) -> Result<String, StartError> {
        let conn = self.ensure_started(state, attempts).await?;
        if state.cancel_requested.load(Ordering::SeqCst) {
            return Ok("cancelled".to_owned());
        }
        // Held until the turn returns.
        let _slot = self.take_slot(state).await?;
        if state.cancel_requested.load(Ordering::SeqCst) {
            return Ok("cancelled".to_owned());
        }
        let env = lock(&state.env).clone().ok_or_else(|| "the agent is not running".to_owned())?;
        let blocks = tokio::task::spawn_blocking(move || prompt_blocks(&*env, prompt))
            .await
            .map_err(|e| e.to_string())??;
        lock(&state.touched).clear();
        lock(&state.overlaps).clear();
        lock(&state.tool_kinds).clear();
        *lock(&state.turn_ended) = None;
        state.recording.store(true, Ordering::SeqCst);
        state.emit("turn-start", json!({}));
        self.set_status(state, SessionStatus::Working, None);
        // HOOK(git): checkpoint before the turn. `turn_running` is set, so the git layer can
        // snapshot the session's folder here and refuse user mutations until the turn ends. Not
        // for a local session without a slot (`_slot` is `None`: `localTurns: "parallel"`): other
        // turns write the same checkout meanwhile, so a checkpoint couldn't say whose change is whose.
        let stop_reason = match conn.prompt(blocks).await {
            Ok(stop_reason) => stop_reason,
            Err(ConnectError::SignIn { methods, .. }) => return Err(self.prompt_wants_sign_in(state, methods).await),
            Err(ConnectError::Failed(e)) => return Err(e.into()),
        };
        // HOOK(git): checkpoint after the turn, while `turn_running` is still set.
        Ok(stop_reason)
    }

    /// The running agent answered a prompt with AuthRequired (its login ran out): it's stopped,
    /// so the start after the sign-in finds the new login, and the session asks for one.
    async fn prompt_wants_sign_in(&self, state: &SessionState, methods: Vec<SignInMethod>) -> StartError {
        state.recording.store(false, Ordering::SeqCst);
        let taken = state.live.lock().await.take();
        lock(&state.conn).take();
        lock(&state.env).take();
        if let Some(process) = taken.and_then(|live| live.process).as_mut() {
            process.stop().await;
        }
        let record = state.record();
        let Some(launch) = lock(&state.running).clone() else {
            return StartError::Failed("the agent asks to sign in".to_owned());
        };
        tracing::info!(session = %state.id, agent = %record.agent_id, "the agent asks to sign in: stopped");
        let need = SignInNeed {
            key: LaunchKey::new(&launch.command, &launch.args, &launch.env),
            agent_name: record.agent_name.unwrap_or_else(|| record.agent_id.clone()),
            agent_id: record.agent_id,
            methods,
        };
        self.report_sign_in(state, need);
        StartError::SignIn
    }

    /// A local session's turn slot in its project, waited for (`queued`) while another session's
    /// turn has it. `None` when the turn needs none: a worktree session, or `localTurns:
    /// "parallel"` (read at each turn, so a change applies to the next one), or it was cancelled.
    async fn take_slot(&self, state: &SessionState) -> Result<Option<TurnPermit>, String> {
        let record = state.record();
        if record.mode != Mode::Local {
            return Ok(None);
        }
        let project = record.project_path.clone();
        let turns = tokio::task::spawn_blocking(move || crate::config::workspace_settings(&project).local_turns)
            .await
            .map_err(|e| e.to_string())?;
        if turns == LocalTurns::Parallel {
            return Ok(None);
        }
        let (mut holder, mut ticket) = match self.slots.enter(&record.project_path, &state.id) {
            Entry::Granted(permit) => return Ok(Some(permit)),
            Entry::Queued { holder, ticket } => (holder, ticket),
        };
        // A cancel that came before it queued (dropping the ticket leaves the queue).
        if state.cancel_requested.load(Ordering::SeqCst) {
            return Ok(None);
        }
        tracing::info!(session = %state.id, %holder, "turn queued behind another local session's");
        self.set_status(state, SessionStatus::Queued, None);
        loop {
            state.emit("queued", json!({ "holder": { "id": holder, "title": self.title_of(&holder) } }));
            match ticket.next().await {
                Turn::Granted(permit) => return Ok(Some(permit)),
                Turn::Behind(next) => holder = next,
                Turn::Left if state.cancel_requested.load(Ordering::SeqCst) => return Ok(None),
                Turn::Left => return Err("The agent stopped before the turn's start".to_owned()),
            }
        }
    }

    /// Drops the session's queued turn, if it has one.
    fn leave_queue(&self, state: &SessionState) -> bool {
        let project = lock(&state.record).project_path.clone();
        self.slots.leave(&project, &state.id)
    }

    fn title_of(&self, id: &str) -> Option<String> {
        let state = lock(&self.sessions).get(id).cloned()?;
        Some(state.record().title)
    }

    async fn stop(&self, state: &SessionState) {
        state.stopping.store(true, Ordering::SeqCst);
        self.leave_queue(state);
        self.drop_held(state);
        if lock(&state.sign_in).take().is_some() {
            state.emit("sign-in", Value::Null);
        }
        if let Some(cancel) = lock(&state.prepare_cancel).take() {
            cancel.store(true, Ordering::SeqCst);
        }
        if let Some(start) = lock(&state.starting).take() {
            start.abort();
        }
        let taken = state.live.lock().await.take();
        lock(&state.conn).take();
        lock(&state.env).take();
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
    /// with its transcript kept, and the leftovers of its process group are killed.
    async fn on_agent_exit(&self, state: &Arc<SessionState>, generation: u64, reason: String) {
        let mut live = state.live.lock().await;
        if live.as_ref().map(|l| l.generation) != Some(generation) {
            return;
        }
        let taken = live.take();
        drop(live);
        lock(&state.conn).take();
        lock(&state.env).take();
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

/// A session's turn slot held for git work; released on drop.
struct SlotGuard(Arc<SessionState>);

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.0.turn_running.store(false, Ordering::SeqCst);
    }
}

enum StartFailure {
    Untrusted(Untrusted),
    /// The session's agent isn't in the project's agents.json, or is off; `ran` is
    /// what it ran (`log_line`), which an agent under another id may run again.
    Unconfigured { agent_id: String, ran: Option<String>, absence: Absence },
    SignIn(Box<SignInNeed>),
    Failed(String),
}

/// A start or turn that failed, as the callers waiting for it see it.
#[derive(Debug, Clone)]
enum StartError {
    /// The agent asks for a sign-in (the page was sent `sign-in`).
    SignIn,
    Failed(String),
}

impl From<String> for StartError {
    fn from(e: String) -> StartError {
        StartError::Failed(e)
    }
}

/// Why a session's agent can't run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Absence {
    /// Not in agents.json.
    Removed,
    /// Turned off by the user.
    Off,
}

impl Absence {
    fn of(merged: &Merged, agent_id: &str) -> Absence {
        if merged.agent(agent_id).is_some() { Absence::Off } else { Absence::Removed }
    }

    fn message(self, merged: &Merged, agent_id: &str) -> String {
        match (self, merged.agent(agent_id)) {
            (Absence::Off, Some(agent)) => format!("{} is off", agent.name),
            _ => format!("Agent \"{agent_id}\" is no longer configured"),
        }
    }

    fn reason(self) -> &'static str {
        match self {
            Absence::Removed => "removed",
            Absence::Off => "off",
        }
    }
}

impl From<String> for StartFailure {
    fn from(e: String) -> StartFailure {
        StartFailure::Failed(e)
    }
}

/// An agent the project's config chose and the user hasn't trusted yet.
struct Untrusted {
    launch: Box<crate::config::LaunchConfig>,
    message: String,
}

struct StartedAgent {
    conn: Arc<Connection>,
    process: Option<AgentProcess>,
    resumed: bool,
    history_restored: bool,
    config_options: Vec<Value>,
}

/// The page's prompt as ACP blocks: paths checked, mapped to the agent's side, selections read. A
/// relative path is the session's own file; an absolute one is the user's, in the project (a
/// worktree session then gets the project's text, as the user selected it).
fn prompt_blocks(env: &dyn SessionEnv, prompt: Vec<PromptInput>) -> Result<Vec<PromptBlock>, String> {
    let resolve = |path: &str| -> Result<(PathBuf, PathBuf), String> {
        if Path::new(path).is_absolute() {
            let host = env::confine(env.project_dir(), Path::new(path), Access::Read)?;
            return Ok((host.clone(), host));
        }
        let rel = crate::workspace::checked_rel(path)?;
        let host = env::confine(env.host_dir(), &env.host_dir().join(rel), Access::Read).map_err(|e| {
            if env.host_dir() != env.project_dir() && env.project_dir().join(rel).exists() {
                format!("{path}: not in this session's worktree (untracked or ignored in the project)")
            } else {
                e
            }
        })?;
        Ok((host, env.agent_cwd().join(rel)))
    };
    prompt
        .into_iter()
        .map(|input| match input {
            PromptInput::Text { text } => Ok(PromptBlock::Text(text)),
            PromptInput::Mention { path } => {
                let (_, agent_path) = resolve(&path)?;
                let name = agent_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(path);
                Ok(PromptBlock::Mention { name, uri: file_uri(&agent_path) })
            }
            PromptInput::Selection { path, from_line, to_line } => {
                let (host, agent_path) = resolve(&path)?;
                let (from, to) = (from_line.max(1), to_line.max(from_line.max(1)));
                let text = read_lines(&host, Some(from), Some(to - from + 1), MAX_READ).map_err(|e| format!("{path}: {e}"))?;
                Ok(PromptBlock::Selection { uri: format!("{}#L{from}-{to}", file_uri(&agent_path)), text })
            }
        })
        .collect()
}

/// `file://` URI of an absolute path, with the characters that would break one escaped.
fn file_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for ch in path.to_string_lossy().replace('\\', "/").chars() {
        match ch {
            '%' => uri.push_str("%25"),
            ' ' => uri.push_str("%20"),
            '#' => uri.push_str("%23"),
            '?' => uri.push_str("%3F"),
            c => uri.push(c),
        }
    }
    uri
}

/// Lines `line..line + limit` (1-based) of a UTF-8 file, line endings kept. Never holds more than
/// `max` bytes of it: a whole file over that fails, and so does a part over that; skipped lines
/// are passed over without being kept.
fn read_lines(path: &Path, line: Option<u32>, limit: Option<u32>, max: u64) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Read};
    let file = File::open(path).map_err(|e| e.to_string())?;
    let too_large = |what: &str| format!("{what} is too large (over {max} bytes); read it in parts");
    let mut out = Vec::new();
    if line.is_none() && limit.is_none() {
        file.take(max + 1).read_to_end(&mut out).map_err(|e| e.to_string())?;
        if out.len() as u64 > max {
            return Err(too_large("the file"));
        }
    } else {
        let mut reader = BufReader::new(file);
        for _ in 1..line.unwrap_or(1) {
            if reader.skip_until(b'\n').map_err(|e| e.to_string())? == 0 {
                break;
            }
        }
        for _ in 0..limit.map_or(u64::MAX, u64::from) {
            let room = max + 1 - out.len() as u64;
            if (&mut reader).take(room).read_until(b'\n', &mut out).map_err(|e| e.to_string())? == 0 {
                break;
            }
            if out.len() as u64 > max {
                return Err(too_large("that part"));
            }
        }
    }
    String::from_utf8(out).map_err(|_| "not UTF-8 text".to_owned())
}

/// The app's side of a probe: no session, so nothing to show and no files to give.
struct ProbeHost;

impl ClientHost for ProbeHost {
    fn on_update(&self, _update: Value) {}

    fn on_permission_request(&self, _request: PermissionRequest) {}

    fn read_text_file(&self, path: PathBuf, _line: Option<u32>, _limit: Option<u32>) -> Result<String, FsError> {
        Err(FsError::Denied(format!("{}: no files while probing", path.display())))
    }

    fn write_text_file(&self, path: PathBuf, _content: String) -> Result<(), FsError> {
        Err(FsError::Denied(format!("{}: no files while probing", path.display())))
    }
}

/// The app's side of one session's ACP connection.
struct SessionHost {
    state: Weak<SessionState>,
}

impl SessionHost {
    /// `session_info_update`'s title: `None` clears it. It becomes the session's title unless the
    /// user named the session; saved with the next status change or turn end, like config options.
    fn on_agent_title(&self, state: &SessionState, title: Option<&str>) {
        let title = title.map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);
        let session = {
            let mut record = lock(&state.record);
            if record.agent_title == title {
                return;
            }
            record.agent_title.clone_from(&title);
            if let (Some(title), false) = (title, record.title_source == TitleSource::User) {
                record.title = title;
                record.title_source = TitleSource::Agent;
            }
            Session::from(&*record)
        };
        state.emit("session", serde_json::to_value(session).unwrap_or_default());
    }

    /// The files a tool call changes, as the turn's: its diffs, and its locations unless its kind
    /// (sent once, usually with `tool_call`) only looks at them.
    fn note_touched(&self, state: &SessionState, update: &Value) {
        let Some(env) = lock(&state.env).clone() else { return };
        let looks = {
            let mut kinds = lock(&state.tool_kinds);
            let id = update["toolCallId"].as_str().unwrap_or_default();
            if let Some(kind) = update["kind"].as_str() {
                kinds.insert(id.to_owned(), kind.to_owned());
            }
            kinds.get(id).is_some_and(|kind| LOOKING_TOOL_KINDS.contains(&kind.as_str()))
        };
        let locations =
            update["locations"].as_array().into_iter().flatten().filter(|_| !looks).map(|l| &l["path"]);
        let diffs = update["content"].as_array().into_iter().flatten().filter(|c| c["type"] == "diff").map(|c| &c["path"]);
        let named = locations.chain(diffs).filter_map(Value::as_str).filter_map(|path| {
            let path = normalize(&env.agent_cwd().join(path));
            env.to_host_path(&path).ok()
        });
        lock(&state.touched).extend(named);
    }

    fn env(&self) -> Result<Arc<dyn SessionEnv>, FsError> {
        let state = self.state.upgrade().ok_or_else(|| FsError::Io("the session is gone".to_owned()))?;
        let env = lock(&state.env).clone();
        env.ok_or_else(|| FsError::Io("the session is not running".to_owned()))
    }

    /// An agent path as a checked host path.
    fn host_path(&self, path: &Path, access: Access) -> Result<PathBuf, FsError> {
        let env = self.env()?;
        let host = env.to_host_path(path).map_err(FsError::Denied)?;
        env::confine(env.host_dir(), &host, access).map_err(|e| {
            if access == Access::Read && !host.exists() && !e.contains("outside") && !e.contains(".git") {
                FsError::NotFound(e)
            } else {
                tracing::info!(path = %path.display(), "agent file access refused: {e}");
                FsError::Denied(e)
            }
        })
    }
}

/// `path` without `.` and `..` (lexically: a symlink is left as named), so that two names of one
/// file match the watcher's.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    out
}

/// ACP tool kinds whose locations are files read, not changed.
const LOOKING_TOOL_KINDS: [&str; 4] = ["read", "search", "fetch", "think"];

impl ClientHost for SessionHost {
    fn on_update(&self, update: Value) {
        let Some(state) = self.state.upgrade() else { return };
        if state.recording.load(Ordering::SeqCst) && update["sessionUpdate"] != "usage_update" {
            state.transcript.append(&json!({ "kind": "update", "update": &update }));
        }
        let options = state.conn().and_then(|conn| conn.note_update(&update));
        if update["sessionUpdate"] == "session_info_update" {
            if let Some(title) = update.get("title") {
                self.on_agent_title(&state, title.as_str());
            }
        }
        if update["sessionUpdate"] == "tool_call" || update["sessionUpdate"] == "tool_call_update" {
            self.note_touched(&state, &update);
        }
        state.emit("update", update);
        if let Some(options) = options {
            // Saved with the next status change.
            remember_config(&state, &options);
            state.emit("config-options", json!({ "configOptions": options }));
        }
    }

    fn on_permission_request(&self, request: PermissionRequest) {
        let Some(state) = self.state.upgrade() else { return };
        state.emit(
            "permission-request",
            json!({ "requestId": request.request_id, "toolCall": request.tool_call, "options": request.options }),
        );
        lock(&state.record).status = SessionStatus::Waiting;
        state.emit("status", json!({ "status": SessionStatus::Waiting }));
    }

    // TODO: serve unsaved editor buffers instead of the disk version of the same file.
    fn read_text_file(&self, path: PathBuf, line: Option<u32>, limit: Option<u32>) -> Result<String, FsError> {
        let host = self.host_path(&path, Access::Read)?;
        read_lines(&host, line, limit, MAX_READ).map_err(|e| FsError::Io(format!("{}: {e}", path.display())))
    }

    fn write_text_file(&self, path: PathBuf, content: String) -> Result<(), FsError> {
        let host = self.host_path(&path, Access::Write)?;
        // What it runs is the user's to decide (a changed launch needs trust again, but an agent
        // shouldn't get to try).
        if crate::config::project_of_agents_file(&host).is_some() {
            tracing::info!(path = %path.display(), "agent file access refused: agents.json");
            return Err(FsError::Denied(format!("{}: agents.json is the user's to edit", path.display())));
        }
        env::write_atomic(&host, content.as_bytes()).map_err(|e| FsError::Io(format!("{}: {e}", path.display())))
    }
}

mod slots;
#[cfg(test)]
mod tests;

/// An agent's command line as its session log's start line shows it.
fn log_line(agent: &AgentConfig) -> String {
    format!("{} {}", agent.command, agent.args.join(" "))
}
