//! The client side of one agent connection: handshake, session setup, prompts, cancel, and the
//! agent's requests (permissions, files).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, AuthCapabilities, AuthenticateRequest, CancelNotification, ClientCapabilities, ContentBlock, DeleteSessionRequest,
    EmbeddedResource, EmbeddedResourceResource, ErrorCode, FileSystemCapabilities, Implementation, InitializeRequest,
    InitializeResponse, ListSessionsRequest, LoadSessionRequest, McpServer, NewSessionRequest, ResumeSessionRequest, PromptRequest, ReadTextFileRequest, SessionConfigOption, SessionModeState,
    SetSessionConfigOptionRequest, SetSessionModeRequest, ReadTextFileResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, ResourceLink, SelectedPermissionOutcome, SessionId,
    SessionNotification, SessionUpdate, SubagentCapabilities, TextContent, TextResourceContents, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo, Responder};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{oneshot, watch};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::auth::{self, SignInMethod};
use super::{ClientHost, FsError, PermissionRequest, PromptBlock};

pub struct StartOptions {
    /// The agent's working directory, as the agent sees it (`SessionEnv::agent_cwd`).
    pub cwd: PathBuf,
    /// `mcpServers` from the config, as ACP `McpServer` objects; invalid ones are skipped.
    pub mcp_servers: Vec<serde_json::Value>,
    /// The ACP session to continue (`session/load`), if the agent supports it.
    pub resume: Option<String>,
    /// For "Sign in to <agent>".
    pub agent_name: String,
    pub initialize_timeout: Duration,
    /// A sign-in: `authenticate` with this method after `initialize` (no answer timeout: the
    /// user is in the browser), then `session/new` as usual.
    pub authenticate: Option<String>,
}

/// Why a connection couldn't start, or a prompt failed.
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectError {
    /// The agent answered AuthRequired; `methods` are its `authMethods`.
    SignIn { agent: String, methods: Vec<SignInMethod> },
    Failed(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::SignIn { agent, .. } => write!(f, "Sign in to {agent}"),
            ConnectError::Failed(message) => f.write_str(message),
        }
    }
}

impl From<String> for ConnectError {
    fn from(message: String) -> ConnectError {
        ConnectError::Failed(message)
    }
}

#[derive(Debug, Clone)]
pub struct Started {
    pub acp_session_id: String,
    pub load_supported: bool,
    /// `resume` was asked for and the agent replayed it; `false` means a new ACP session.
    pub history_restored: bool,
    /// `resume` was asked for and the agent continues it (`session/load`, or `session/resume`,
    /// which replays nothing).
    pub continued: bool,
    /// The session's config options (model, thought level, mode…) as ACP `SessionConfigOption`s.
    pub config_options: Vec<serde_json::Value>,
    /// `agentInfo.version` from `initialize`, when the agent sends it.
    pub agent_version: Option<String>,
}

/// What an agent can do with sessions besides `session/new`, from `initialize`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionCaps {
    pub list: bool,
    pub load: bool,
    pub resume: bool,
    pub delete: bool,
}

impl SessionCaps {
    fn of(capabilities: &AgentCapabilities) -> SessionCaps {
        let session = &capabilities.session_capabilities;
        SessionCaps {
            list: session.list.is_some(),
            load: capabilities.load_session,
            resume: session.resume.is_some(),
            delete: session.delete.is_some(),
        }
    }
}

/// A session of the agent's, from `session/list`.
#[derive(Debug, Clone, PartialEq)]
pub struct ListedSession {
    pub session_id: String,
    pub cwd: PathBuf,
    pub title: Option<String>,
    /// ISO 8601, as the agent wrote it.
    pub updated_at: Option<String>,
}

/// A folder's sessions; `complete` when every page was read (not cut at the cap).
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub sessions: Vec<ListedSession>,
    pub complete: bool,
}

pub struct CatalogOptions {
    pub agent_name: String,
    pub initialize_timeout: Duration,
}

/// Id of the option standing in for an agent's legacy `modes` when it has no config options.
pub const MODE_OPTION_ID: &str = "_batrak_mode";

struct Shared {
    host: Arc<dyn ClientHost>,
    /// Permission requests waiting for the user, by our request id.
    pending: Mutex<HashMap<String, Pending>>,
    next_request: AtomicU64,
    /// ACP session ids of the subagents the agent announced (`subagent_update`): their traffic
    /// comes on this connection under their own id.
    subagents: Mutex<HashSet<String>>,
}

struct Pending {
    /// The subagent that asked, `None` for the session.
    subagent: Option<String>,
    responder: Responder<RequestPermissionResponse>,
}

impl Shared {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pending>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn subagents(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.subagents.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The subagent `session_id` is, if the agent announced it as one.
    fn subagent(&self, session_id: &SessionId) -> Option<String> {
        let id = session_id.to_string();
        self.subagents().contains(&id).then_some(id)
    }

    /// Answers the pending requests `which` keeps `cancelled`, as ACP asks of a cancel.
    fn cancel_pending(&self, which: impl Fn(&Pending) -> bool) {
        let cancelled: Vec<Pending> = {
            let mut pending = self.pending();
            let ids: Vec<String> = pending.iter().filter(|(_, p)| which(p)).map(|(id, _)| id.clone()).collect();
            ids.iter().filter_map(|id| pending.remove(id)).collect()
        };
        for p in cancelled {
            let _ = p.responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
        }
    }
}

/// A live connection to an agent with one ACP session. Dropping it stops reading from the agent;
/// the process itself is owned (and killed) by the caller.
pub struct Connection {
    cx: ConnectionTo<Agent>,
    session_id: SessionId,
    shared: Arc<Shared>,
    /// `Some(reason)` once the agent's output closed or the connection failed.
    closed: watch::Receiver<Option<String>>,
    driver: tokio::task::JoinHandle<()>,
    /// The options as last known, for an agent whose mode is set through `session/set_mode` (its
    /// answer carries no options to replace them with).
    options: Mutex<Vec<serde_json::Value>>,
    agent_name: String,
    sign_in_methods: Vec<SignInMethod>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.driver.abort();
    }
}

impl Connection {
    /// Handshake (`initialize`), then `session/load` of `resume` when the agent supports it, else
    /// `session/resume` (nothing replayed), else `session/new`. Updates replayed by a load reach
    /// `host` before this returns.
    pub async fn start<W, R>(
        writer: W,
        reader: R,
        host: Arc<dyn ClientHost>,
        opts: StartOptions,
    ) -> Result<(Connection, Started), ConnectError>
    where
        W: AsyncWrite + Send + Unpin + 'static,
        R: AsyncRead + Send + Unpin + 'static,
    {
        let Handshake { cx, shared, closed: closed_rx, driver, init, sign_in_methods } =
            handshake(writer, reader, host, &opts.agent_name, opts.initialize_timeout, opts.authenticate.as_deref()).await?;
        let capabilities = SessionCaps::of(&init.agent_capabilities);
        let load_supported = capabilities.load;
        let fail = |e: agent_client_protocol::Error| describe(&e, &opts.agent_name, &sign_in_methods, &closed_rx);
        let mcp_servers: Vec<McpServer> = opts
            .mcp_servers
            .iter()
            .filter_map(|value| match serde_json::from_value(value.clone()) {
                Ok(server) => Some(server),
                Err(e) => {
                    tracing::warn!("mcpServers: skipped an invalid entry: {e}");
                    None
                }
            })
            .collect();

        let mut history_restored = false;
        let mut session_id = None;
        let mut options = None;
        match &opts.resume {
            Some(resume) if load_supported => {
                let load = LoadSessionRequest::new(resume.clone(), opts.cwd.clone()).mcp_servers(mcp_servers.clone());
                match cx.send_request(load).block_task().await {
                    Ok(loaded) => {
                        session_id = Some(SessionId::new(resume.clone()));
                        history_restored = true;
                        options = Some(config_options(loaded.config_options, loaded.modes));
                    }
                    Err(e) if e.code == ErrorCode::AuthRequired => return Err(fail(e)),
                    Err(e) => tracing::info!(agent = %opts.agent_name, "session/load failed, starting anew: {}", e.message),
                }
            }
            Some(resume) if capabilities.resume => {
                let request = ResumeSessionRequest::new(resume.clone(), opts.cwd.clone()).mcp_servers(mcp_servers.clone());
                match cx.send_request(request).block_task().await {
                    Ok(resumed) => {
                        session_id = Some(SessionId::new(resume.clone()));
                        options = Some(config_options(resumed.config_options, resumed.modes));
                    }
                    Err(e) if e.code == ErrorCode::AuthRequired => return Err(fail(e)),
                    Err(e) => tracing::info!(agent = %opts.agent_name, "session/resume failed, starting anew: {}", e.message),
                }
            }
            _ => {}
        }
        let continued = session_id.is_some();
        let session_id = match session_id {
            Some(id) => id,
            None => {
                let new = NewSessionRequest::new(opts.cwd.clone()).mcp_servers(mcp_servers);
                let created = cx
                    .send_request(new)
                    .block_task()
                    .await
                    .map_err(fail)?;
                options = Some(config_options(created.config_options, created.modes));
                created.session_id
            }
        };
        let config_options = options.unwrap_or_default();
        let started = Started {
            acp_session_id: session_id.to_string(),
            load_supported,
            history_restored,
            continued,
            config_options: config_options.clone(),
            agent_version: init.agent_info.map(|info| info.version),
        };
        let options = Mutex::new(config_options);
        let agent_name = opts.agent_name;
        Ok((Connection { cx, session_id, shared, closed: closed_rx, driver, options, agent_name, sign_in_methods }, started))
    }

    /// Sets a config option (`session/set_config_option`, or `session/set_mode` for the legacy
    /// mode option) and returns the options as they are now: one choice may change others.
    pub async fn set_config_option(&self, config_id: &str, value: &str) -> Result<Vec<serde_json::Value>, String> {
        if config_id == MODE_OPTION_ID {
            let request = SetSessionModeRequest::new(self.session_id.clone(), value.to_owned());
            self.cx.send_request(request).block_task().await.map_err(|e| e.message)?;
            let mut options = self.options.lock().unwrap_or_else(PoisonError::into_inner);
            for option in options.iter_mut().filter(|o| o["id"] == MODE_OPTION_ID) {
                option["currentValue"] = value.into();
            }
            return Ok(options.clone());
        }
        let request = SetSessionConfigOptionRequest::new(self.session_id.clone(), config_id.to_owned(), value);
        let response = self.cx.send_request(request).block_task().await.map_err(|e| e.message)?;
        let options: Vec<serde_json::Value> =
            response.config_options.iter().filter_map(|o| serde_json::to_value(o).ok()).collect();
        options.clone_into(&mut self.options.lock().unwrap_or_else(PoisonError::into_inner));
        Ok(options)
    }

    /// Keeps the options current after the agent's own `config_option_update` /
    /// `current_mode_update`; returns them when they changed.
    pub fn note_update(&self, update: &serde_json::Value) -> Option<Vec<serde_json::Value>> {
        let mut options = self.options.lock().unwrap_or_else(PoisonError::into_inner);
        match update["sessionUpdate"].as_str()? {
            "config_option_update" => *options = update["configOptions"].as_array()?.clone(),
            "current_mode_update" => {
                let mode = update["currentModeId"].clone();
                let legacy = options.iter_mut().find(|o| o["id"] == MODE_OPTION_ID)?;
                legacy["currentValue"] = mode;
            }
            _ => return None,
        }
        Some(options.clone())
    }

    /// Runs one turn: resolves with the response's `stopReason` (`"end_turn"`, `"cancelled"`, …)
    /// once the agent ends it; updates arrive through the host meanwhile.
    /// An agent whose login ran out answers AuthRequired: [`ConnectError::SignIn`].
    pub async fn prompt(&self, blocks: Vec<PromptBlock>) -> Result<String, ConnectError> {
        let prompt = blocks.into_iter().map(content_block).collect();
        let request = PromptRequest::new(self.session_id.clone(), prompt);
        let mut closed = self.closed.clone();
        let response = tokio::select! {
            response = self.cx.send_request(request).block_task() => response.map_err(|e| match e.code {
                ErrorCode::AuthRequired => self.sign_in(),
                _ => ConnectError::Failed(e.message),
            })?,
            _ = closed.wait_for(Option::is_some) => return Err(closed_reason(&self.closed).into()),
        };
        Ok(serde_json::to_value(response.stop_reason)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "end_turn".to_owned()))
    }

    /// `session/cancel`, then every pending permission request answered `cancelled`, as ACP asks.
    /// The running `prompt` resolves with `"cancelled"` once the agent has stopped.
    pub fn cancel(&self) -> Result<(), String> {
        let sent = self.cx.send_notification(CancelNotification::new(self.session_id.clone())).map_err(|e| e.message);
        self.shared.cancel_pending(|_| true);
        sent
    }

    /// `session/cancel` of one of the session's subagents, then its pending permission requests
    /// answered `cancelled`. Refused for an id the agent didn't announce as a subagent.
    pub fn cancel_subagent(&self, subagent: &str) -> Result<(), String> {
        let id = SessionId::new(subagent.to_owned());
        if self.shared.subagent(&id).is_none() {
            return Err(format!("{subagent} is not a subagent of this session"));
        }
        let sent = self.cx.send_notification(CancelNotification::new(id)).map_err(|e| e.message);
        self.shared.cancel_pending(|p| p.subagent.as_deref() == Some(subagent));
        sent
    }

    /// Answers a permission request: the chosen option, or `None` for cancelled.
    pub fn respond_permission(&self, request_id: &str, option_id: Option<String>) -> Result<(), String> {
        let Pending { responder, .. } = self
            .shared
            .pending()
            .remove(request_id)
            .ok_or_else(|| format!("no pending permission request {request_id}"))?;
        let outcome = match option_id {
            Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
            None => RequestPermissionOutcome::Cancelled,
        };
        responder.respond(RequestPermissionResponse::new(outcome)).map_err(|e| e.message)
    }

    /// Ids of the permission requests still waiting for an answer.
    pub fn pending_permissions(&self) -> Vec<String> {
        self.shared.pending().keys().cloned().collect()
    }

    fn sign_in(&self) -> ConnectError {
        ConnectError::SignIn { agent: self.agent_name.clone(), methods: self.sign_in_methods.clone() }
    }

    /// Resolves with the reason once the agent's side is gone (exit, crash, closed pipe).
    pub async fn closed(&self) -> String {
        let mut closed = self.closed.clone();
        let _ = closed.wait_for(Option::is_some).await;
        closed_reason(&self.closed)
    }
}


/// A connection for the agent's session store only: `initialize`, then `session/list` and
/// `session/delete`, no session of its own. Dropping it stops reading from the agent.
pub struct Catalog {
    cx: ConnectionTo<Agent>,
    closed: watch::Receiver<Option<String>>,
    driver: tokio::task::JoinHandle<()>,
    capabilities: SessionCaps,
    agent_version: Option<String>,
    agent_name: String,
    sign_in_methods: Vec<SignInMethod>,
}

impl Drop for Catalog {
    fn drop(&mut self) {
        self.driver.abort();
    }
}

impl Catalog {
    pub async fn open<W, R>(writer: W, reader: R, opts: CatalogOptions) -> Result<Catalog, ConnectError>
    where
        W: AsyncWrite + Send + Unpin + 'static,
        R: AsyncRead + Send + Unpin + 'static,
    {
        let Handshake { cx, closed, driver, init, sign_in_methods, .. } =
            handshake(writer, reader, Arc::new(NoSession), &opts.agent_name, opts.initialize_timeout, None).await?;
        Ok(Catalog {
            cx,
            closed,
            driver,
            capabilities: SessionCaps::of(&init.agent_capabilities),
            agent_version: init.agent_info.map(|info| info.version),
            agent_name: opts.agent_name,
            sign_in_methods,
        })
    }

    pub fn capabilities(&self) -> SessionCaps {
        self.capabilities
    }

    pub fn agent_version(&self) -> Option<&str> {
        self.agent_version.as_deref()
    }

    /// The agent went away (exited, crashed, closed its side).
    pub fn is_closed(&self) -> bool {
        self.closed.borrow().is_some()
    }

    /// The agent's sessions in `cwd`, page by page, at most `max`.
    pub async fn list_sessions(&self, cwd: &Path, max: usize) -> Result<Listed, ConnectError> {
        let mut sessions = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let request = ListSessionsRequest::new().cwd(cwd.to_path_buf()).cursor(cursor.clone());
            let page = self.answer(self.cx.send_request(request).block_task()).await?;
            sessions.extend(page.sessions.into_iter().map(|s| ListedSession {
                session_id: s.session_id.to_string(),
                cwd: s.cwd,
                title: s.title,
                updated_at: s.updated_at,
            }));
            if sessions.len() >= max {
                let complete = sessions.len() == max && page.next_cursor.is_none();
                sessions.truncate(max);
                return Ok(Listed { sessions, complete });
            }
            match page.next_cursor {
                // An agent that hands the same cursor back would page forever.
                Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
                Some(_) => return Ok(Listed { sessions, complete: false }),
                None => return Ok(Listed { sessions, complete: true }),
            }
        }
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<(), ConnectError> {
        self.answer(self.cx.send_request(DeleteSessionRequest::new(session_id.to_owned())).block_task()).await?;
        Ok(())
    }

    /// A request's answer, or why there is none (a sign-in, the agent gone).
    async fn answer<T>(
        &self,
        request: impl std::future::Future<Output = Result<T, agent_client_protocol::Error>>,
    ) -> Result<T, ConnectError> {
        let mut closed = self.closed.clone();
        tokio::select! {
            answer = request => answer.map_err(|e| describe(&e, &self.agent_name, &self.sign_in_methods, &self.closed)),
            _ = closed.wait_for(Option::is_some) => Err(closed_reason(&self.closed).into()),
        }
    }
}

/// The app's side of a [`Catalog`]: no session, so nothing to show and no files to give.
struct NoSession;

impl ClientHost for NoSession {
    fn on_update(&self, _update: serde_json::Value, _subagent: Option<String>) {}

    fn on_permission_request(&self, _request: PermissionRequest) {}

    fn read_text_file(&self, path: PathBuf, _line: Option<u32>, _limit: Option<u32>) -> Result<String, FsError> {
        Err(FsError::Denied(format!("{}: no files without a session", path.display())))
    }

    fn write_text_file(&self, path: PathBuf, _content: String) -> Result<(), FsError> {
        Err(FsError::Denied(format!("{}: no files without a session", path.display())))
    }
}

/// A connection after `initialize` (and `authenticate` when asked), before any session.
struct Handshake {
    cx: ConnectionTo<Agent>,
    shared: Arc<Shared>,
    closed: watch::Receiver<Option<String>>,
    driver: tokio::task::JoinHandle<()>,
    init: InitializeResponse,
    sign_in_methods: Vec<SignInMethod>,
}

async fn handshake<W, R>(
    writer: W,
    reader: R,
    host: Arc<dyn ClientHost>,
    agent_name: &str,
    initialize_timeout: Duration,
    authenticate: Option<&str>,
) -> Result<Handshake, ConnectError>
where
    W: AsyncWrite + Send + Unpin + 'static,
    R: AsyncRead + Send + Unpin + 'static,
{
    let shared = Arc::new(Shared { host, pending: Mutex::default(), next_request: AtomicU64::new(0), subagents: Mutex::default() });
    let (cx_tx, cx_rx) = oneshot::channel();
    let (closed_tx, closed_rx) = watch::channel(None);

    let on_update = Arc::clone(&shared);
    let on_permission = Arc::clone(&shared);
    let on_read = Arc::clone(&shared);
    let on_write = Arc::clone(&shared);
    // Every callback returns quickly: they run inside the dispatch loop, which holds later
    // messages (and the updates' order) until they finish. A permission waits for the user
    // outside it, its responder parked in `pending`.
    let builder = Client
        .builder()
        .name("batrak")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                if let SessionUpdate::SubagentUpdate(announced) = &notification.update {
                    on_update.subagents().insert(announced.session_id.to_string());
                }
                let subagent = on_update.subagent(&notification.session_id);
                match serde_json::to_value(&notification.update) {
                    Ok(update) => on_update.host.on_update(update, subagent),
                    Err(e) => tracing::warn!("unserializable session update: {e}"),
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder: Responder<RequestPermissionResponse>, _cx| {
                let n = on_permission.next_request.fetch_add(1, Ordering::Relaxed) + 1;
                let request_id = format!("permission-{n}");
                let to_json = |value: Result<serde_json::Value, serde_json::Error>| value.unwrap_or_default();
                let tool_call = to_json(serde_json::to_value(&request.tool_call));
                let options = to_json(serde_json::to_value(&request.options));
                let subagent = on_permission.subagent(&request.session_id);
                on_permission.pending().insert(request_id.clone(), Pending { subagent: subagent.clone(), responder });
                on_permission.host.on_permission_request(PermissionRequest { request_id, tool_call, options, subagent });
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ReadTextFileRequest, responder: Responder<ReadTextFileResponse>, _cx| {
                let host = Arc::clone(&on_read.host);
                let read = tokio::task::spawn_blocking(move || {
                    host.read_text_file(request.path, request.line, request.limit)
                })
                .await
                .unwrap_or_else(|e| Err(FsError::Io(e.to_string())));
                match read {
                    Ok(content) => responder.respond(ReadTextFileResponse::new(content)),
                    Err(e) => responder.respond_with_error(fs_error(e)),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WriteTextFileRequest, responder: Responder<WriteTextFileResponse>, _cx| {
                let host = Arc::clone(&on_write.host);
                let written = tokio::task::spawn_blocking(move || host.write_text_file(request.path, request.content))
                    .await
                    .unwrap_or_else(|e| Err(FsError::Io(e.to_string())));
                match written {
                    Ok(()) => responder.respond(WriteTextFileResponse::new()),
                    Err(e) => responder.respond_with_error(fs_error(e)),
                }
            },
            agent_client_protocol::on_receive_request!(),
        );
    // Anything else the agent asks (`terminal/*`, which we don't advertise, or a newer method)
    // is answered with MethodNotFound by the dispatch loop itself.

    let transport = ByteStreams::new(writer.compat_write(), reader.compat());
    let driver = tokio::spawn(async move {
        let result = builder
            .connect_with(transport, async move |cx: ConnectionTo<Agent>| {
                let _ = cx_tx.send(cx.clone());
                cx.incoming_closed().await;
                Ok(())
            })
            .await;
        let reason = match result {
            Ok(()) => "the agent closed its connection".to_owned(),
            Err(e) => format!("connection to the agent failed: {}", e.message),
        };
        let _ = closed_tx.send(Some(reason));
    });

    let mut closed = closed_rx.clone();
    let cx = tokio::select! {
        cx = cx_rx => cx.map_err(|_| "the agent connection ended before it started".to_owned())?,
        _ = closed.wait_for(Option::is_some) => return Err(closed_reason(&closed_rx).into()),
    };

    let initialize = InitializeRequest::new(ProtocolVersion::V1)
        .client_capabilities(
            ClientCapabilities::new()
                .fs(FileSystemCapabilities::new().read_text_file(true).write_text_file(true))
                .terminal(false)
                // A `terminal` method reruns the agent's launch in a Terminal tab; the meta
                // flag is for agents that still read Zed's pre-standard one.
                .auth(AuthCapabilities::new().terminal(true))
                .subagents(SubagentCapabilities::new())
                .meta(serde_json::Map::from_iter([("terminal-auth".to_owned(), serde_json::Value::Bool(true))])),
        )
        .client_info(Implementation::new("batrak", env!("CARGO_PKG_VERSION")));
    let init = match tokio::time::timeout(initialize_timeout, cx.send_request(initialize).block_task()).await
    {
        Err(_) => {
            driver.abort();
            return Err(format!("{} did not answer within {}s", agent_name, initialize_timeout.as_secs()).into());
        }
        Ok(result) => result.map_err(|e| describe(&e, agent_name, &[], &closed_rx))?,
    };
    let methods: Vec<serde_json::Value> =
        init.auth_methods.iter().filter_map(|m| serde_json::to_value(m).ok()).collect();
    let sign_in_methods = auth::parse_methods(&methods);
    tracing::info!(
        agent = %agent_name,
        agent_info = ?init.agent_info.as_ref().map(|i| format!("{} {}", i.name, i.version)),
        capabilities = ?SessionCaps::of(&init.agent_capabilities),
        auth_methods = init.auth_methods.len(),
        "agent initialized"
    );
    let fail = |e: agent_client_protocol::Error| describe(&e, agent_name, &sign_in_methods, &closed_rx);
    if let Some(method) = authenticate {
        tracing::info!(agent = %agent_name, method = %method, "signing in");
        let mut closed = closed_rx.clone();
        tokio::select! {
            // A refusal here is the agent's answer, AuthRequired's code or not (Gemini CLI
            // sends -32000 for an account Google no longer serves): say what it said.
            answer = cx.send_request(AuthenticateRequest::new(method.to_owned())).block_task() => {
                answer.map_err(|e| match fail(e.clone()) {
                    ConnectError::SignIn { .. } if !e.message.is_empty() => ConnectError::Failed(e.message),
                    other => other,
                })?;
            }
            _ = closed.wait_for(Option::is_some) => return Err(closed_reason(&closed_rx).into()),
        }
    }

    Ok(Handshake { cx, shared, closed: closed_rx, driver, init, sign_in_methods })
}

/// The session's options as JSON; an agent with only legacy `modes` gets one select option of
/// category `mode` standing in for them ([`MODE_OPTION_ID`]).
fn config_options(options: Option<Vec<SessionConfigOption>>, modes: Option<SessionModeState>) -> Vec<serde_json::Value> {
    let mut options: Vec<serde_json::Value> =
        options.unwrap_or_default().iter().filter_map(|o| serde_json::to_value(o).ok()).collect();
    let has_mode = options.iter().any(|o| o["category"] == "mode");
    if let (false, Some(modes)) = (has_mode, modes) {
        let values: Vec<serde_json::Value> = modes
            .available_modes
            .iter()
            .map(|m| serde_json::json!({ "value": m.id.to_string(), "name": m.name, "description": m.description }))
            .collect();
        options.push(serde_json::json!({
            "id": MODE_OPTION_ID,
            "name": "Mode",
            "category": "mode",
            "type": "select",
            "currentValue": modes.current_mode_id.to_string(),
            "options": values,
        }));
    }
    options
}

fn closed_reason(closed: &watch::Receiver<Option<String>>) -> String {
    closed.borrow().clone().unwrap_or_else(|| "the agent connection ended".to_owned())
}

/// A failed request as the user reads it: the agent wants a sign-in (with `methods`), it went
/// away, or its message.
fn describe(
    e: &agent_client_protocol::Error,
    agent: &str,
    methods: &[SignInMethod],
    closed: &watch::Receiver<Option<String>>,
) -> ConnectError {
    if e.code == ErrorCode::AuthRequired {
        return ConnectError::SignIn { agent: agent.to_owned(), methods: methods.to_vec() };
    }
    if agent_client_protocol::is_incoming_transport_closed(e) {
        return ConnectError::Failed(format!("{agent} exited during startup"));
    }
    if let Some(reason) = closed.borrow().clone() {
        return ConnectError::Failed(reason);
    }
    ConnectError::Failed(e.message.clone())
}

fn fs_error(e: FsError) -> agent_client_protocol::Error {
    match e {
        FsError::Denied(message) => agent_client_protocol::Error::new(-32602, message),
        FsError::NotFound(message) => agent_client_protocol::Error::resource_not_found(None).data(message),
        FsError::Io(message) => agent_client_protocol::Error::internal_error().data(message),
    }
}

fn content_block(block: PromptBlock) -> ContentBlock {
    match block {
        PromptBlock::Text(text) => ContentBlock::Text(TextContent::new(text)),
        PromptBlock::Mention { name, uri } => ContentBlock::ResourceLink(ResourceLink::new(name, uri)),
        PromptBlock::Selection { uri, text } => ContentBlock::Resource(EmbeddedResource::new(
            EmbeddedResourceResource::TextResourceContents(TextResourceContents::new(text, uri)),
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::atomic::Ordering;

    use tokio::sync::mpsc;

    use super::*;
    use crate::fake_agent::{self, FakeAgentOptions};

    /// Everything the agent sent, in order: updates' text and permission requests.
    #[derive(Debug, Clone, PartialEq)]
    enum Seen {
        /// `kind:text`, prefixed with `<subagent>/` for a subagent's.
        Update(String),
        Permission(String),
        SubagentPermission { subagent: String, id: String },
    }

    struct RecordingHost {
        tx: mpsc::UnboundedSender<Seen>,
    }

    impl ClientHost for RecordingHost {
        fn on_update(&self, update: serde_json::Value, subagent: Option<String>) {
            let kind = update["sessionUpdate"].as_str().unwrap_or_default();
            let text = update["content"]["text"].as_str().unwrap_or_default();
            let prefix = subagent.map(|id| format!("{id}/")).unwrap_or_default();
            let _ = self.tx.send(Seen::Update(format!("{prefix}{kind}:{text}")));
        }

        fn on_permission_request(&self, request: PermissionRequest) {
            assert_eq!(request.options[0]["optionId"], "allow");
            let _ = self.tx.send(match request.subagent {
                Some(subagent) => Seen::SubagentPermission { subagent, id: request.request_id },
                None => Seen::Permission(request.request_id),
            });
        }

        fn read_text_file(&self, path: PathBuf, line: Option<u32>, limit: Option<u32>) -> Result<String, FsError> {
            match path.to_str() {
                Some("/work/a.txt") => Ok(format!("a line={line:?} limit={limit:?}")),
                _ => Err(FsError::Denied(format!("{}: outside the session", path.display()))),
            }
        }

        fn write_text_file(&self, path: PathBuf, _content: String) -> Result<(), FsError> {
            Err(FsError::Denied(format!("{}: outside the session", path.display())))
        }
    }

    type Connected = (Connection, Started, mpsc::UnboundedReceiver<Seen>, Arc<fake_agent::FakeAgentState>);

    async fn connect(options: FakeAgentOptions, resume: Option<&str>) -> Result<Connected, ConnectError> {
        connect_with(options, resume, None).await
    }

    async fn connect_with(
        options: FakeAgentOptions,
        resume: Option<&str>,
        authenticate: Option<&str>,
    ) -> Result<Connected, ConnectError> {
        let (writer, reader, state) = fake_agent::start(options);
        let (tx, rx) = mpsc::unbounded_channel();
        let opts = StartOptions {
            cwd: PathBuf::from("/work"),
            mcp_servers: vec![],
            resume: resume.map(str::to_owned),
            agent_name: "Fake Agent".to_owned(),
            initialize_timeout: Duration::from_secs(5),
            authenticate: authenticate.map(str::to_owned),
        };
        let (conn, started) = Connection::start(writer, reader, Arc::new(RecordingHost { tx }), opts).await?;
        Ok((conn, started, rx, state))
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<Seen>) -> Vec<Seen> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    fn text(s: &str) -> Vec<PromptBlock> {
        vec![PromptBlock::Text(s.to_owned())]
    }

    #[tokio::test]
    async fn handshake_then_updates_in_order_and_the_stop_reason() {
        let (conn, started, mut rx, _) = connect(FakeAgentOptions::default(), None).await.unwrap();
        assert_eq!(started.acp_session_id, "fake-session-1");
        assert!(!started.load_supported && !started.history_restored);

        let stop = conn.prompt(text("hello")).await.unwrap();
        assert_eq!(stop, "end_turn");
        assert_eq!(
            drain(&mut rx),
            vec![Seen::Update("agent_message_chunk:Hello".into()), Seen::Update("agent_message_chunk:, world".into())]
        );
    }

    #[tokio::test]
    async fn a_permission_waits_for_the_answer() {
        let (conn, _, mut rx, _) = connect(FakeAgentOptions::default(), None).await.unwrap();
        let conn = Arc::new(conn);
        let turn = tokio::spawn({
            let conn = Arc::clone(&conn);
            async move { conn.prompt(text("permission")).await }
        });
        assert_eq!(rx.recv().await, Some(Seen::Update("tool_call:".into())));
        let Some(Seen::Permission(id)) = rx.recv().await else { panic!("no permission request") };
        assert_eq!(conn.pending_permissions(), vec![id.clone()]);
        conn.respond_permission(&id, Some("allow".into())).unwrap();
        assert_eq!(turn.await.unwrap().unwrap(), "end_turn");
        assert_eq!(drain(&mut rx), vec![Seen::Update("agent_message_chunk:chose allow".into())]);
        assert!(conn.respond_permission(&id, None).is_err(), "answered once only");
    }

    /// Runs the fake's `subagent` script up to its subagent's permission request: its id.
    async fn until_subagent_asks(conn: &Arc<Connection>, rx: &mut mpsc::UnboundedReceiver<Seen>) -> (tokio::task::JoinHandle<Result<String, ConnectError>>, String) {
        let turn = tokio::spawn({
            let conn = Arc::clone(conn);
            async move { conn.prompt(text("subagent")).await }
        });
        assert_eq!(rx.recv().await, Some(Seen::Update("subagent_update:".into())), "announced on the parent's stream");
        assert_eq!(rx.recv().await, Some(Seen::Update("child-1/session_info_update:".into())));
        assert_eq!(rx.recv().await, Some(Seen::Update("child-1/tool_call:".into())));
        assert_eq!(rx.recv().await, Some(Seen::Update("child-1/agent_message_chunk:found".into())));
        let Some(Seen::SubagentPermission { subagent, id }) = rx.recv().await else { panic!("no subagent permission request") };
        assert_eq!(subagent, "child-1");
        (turn, id)
    }

    #[tokio::test]
    async fn a_subagents_updates_and_permission_requests_name_it() {
        // Arrange
        let (conn, _, mut rx, _) = connect(FakeAgentOptions::default(), None).await.unwrap();
        let conn = Arc::new(conn);
        // Act
        let (turn, id) = until_subagent_asks(&conn, &mut rx).await;
        conn.respond_permission(&id, Some("allow".into())).unwrap();
        // Assert
        assert_eq!(turn.await.unwrap().unwrap(), "end_turn");
        assert_eq!(drain(&mut rx), vec![Seen::Update("subagent_update:".into()), Seen::Update("agent_message_chunk:done".into())]);
    }

    #[tokio::test]
    async fn cancelling_a_subagent_cancels_it_alone() {
        // Arrange
        let (conn, _, mut rx, agent) = connect(FakeAgentOptions::default(), None).await.unwrap();
        let conn = Arc::new(conn);
        let (turn, _) = until_subagent_asks(&conn, &mut rx).await;
        // Act
        conn.cancel_subagent("child-1").unwrap();
        // Assert: its request is answered cancelled, the parent's turn goes on
        assert_eq!(turn.await.unwrap().unwrap(), "end_turn");
        assert_eq!(*agent.cancelled_sessions.lock().unwrap(), ["child-1"]);
        assert_eq!(drain(&mut rx)[1], Seen::Update("agent_message_chunk:child cancelled".into()));
        assert!(conn.cancel_subagent("child-9").is_err(), "not a subagent of this session");
    }

    #[tokio::test]
    async fn cancel_answers_a_pending_permission_and_ends_the_turn() {
        let (conn, _, mut rx, agent) = connect(FakeAgentOptions::default(), None).await.unwrap();
        let conn = Arc::new(conn);
        let turn = tokio::spawn({
            let conn = Arc::clone(&conn);
            async move { conn.prompt(text("permission")).await }
        });
        rx.recv().await;
        let Some(Seen::Permission(_)) = rx.recv().await else { panic!("no permission request") };
        conn.cancel().unwrap();
        assert_eq!(turn.await.unwrap().unwrap(), "cancelled");
        assert!(conn.pending_permissions().is_empty());
        assert_eq!(agent.cancel_count.load(Ordering::SeqCst), 1, "session/cancel reached the agent");
    }

    #[tokio::test]
    async fn cancel_stops_a_slow_turn() {
        let (conn, _, mut rx, _) = connect(FakeAgentOptions::default(), None).await.unwrap();
        let conn = Arc::new(conn);
        let turn = tokio::spawn({
            let conn = Arc::clone(&conn);
            async move { conn.prompt(text("slow")).await }
        });
        rx.recv().await; // the first chunk: the turn is running
        conn.cancel().unwrap();
        let stop = tokio::time::timeout(Duration::from_secs(2), turn).await.unwrap().unwrap().unwrap();
        assert_eq!(stop, "cancelled");
        assert!(drain(&mut rx).len() < 199, "it stopped early");
    }

    #[tokio::test]
    async fn a_slow_turn_with_a_count_ends_on_its_own_after_that_many_chunks() {
        let (conn, _, mut rx, _) = connect(FakeAgentOptions::default(), None).await.unwrap();
        let stop = tokio::time::timeout(Duration::from_secs(2), conn.prompt(text("slow 3"))).await.unwrap().unwrap();
        assert_eq!(stop, "end_turn");
        let chunks: Vec<_> = drain(&mut rx).into_iter().filter(|s| matches!(s, Seen::Update(_))).collect();
        assert_eq!(chunks.len(), 3, "{chunks:?}");
    }

    #[tokio::test]
    async fn a_crash_mid_turn_fails_the_turn_and_closes() {
        let (conn, _, mut rx, _) = connect(FakeAgentOptions::default(), None).await.unwrap();
        let err = tokio::time::timeout(Duration::from_secs(2), conn.prompt(text("crash"))).await.unwrap().unwrap_err();
        assert!(!err.to_string().is_empty());
        assert_eq!(rx.recv().await, Some(Seen::Update("agent_message_chunk:about to crash".into())));
        let reason = tokio::time::timeout(Duration::from_secs(2), conn.closed()).await.unwrap();
        assert!(reason.contains("closed") || reason.contains("failed"), "{reason}");
    }

    fn needing_sign_in() -> FakeAgentOptions {
        FakeAgentOptions {
            require_auth: true,
            auth_methods: vec![
                serde_json::json!({ "id": "browser", "name": "Log in", "description": "In your browser" }),
                serde_json::json!({ "type": "terminal", "id": "tui", "name": "Terminal", "args": ["login"] }),
            ],
            ..Default::default()
        }
    }

    fn method_ids(err: &ConnectError) -> Vec<&str> {
        match err {
            ConnectError::SignIn { methods, .. } => methods.iter().map(|m| m.id.as_str()).collect(),
            ConnectError::Failed(e) => panic!("not a sign-in: {e}"),
        }
    }

    #[tokio::test]
    async fn auth_required_asks_to_sign_in_with_the_agents_methods() {
        let err = connect(needing_sign_in(), None).await.err().unwrap();
        assert_eq!(err.to_string(), "Sign in to Fake Agent");
        assert_eq!(method_ids(&err), ["browser", "tui"]);
        let ConnectError::SignIn { methods, .. } = &err else { unreachable!() };
        assert_eq!(methods[1].kind, auth::SignInKind::Terminal);
    }

    #[tokio::test]
    async fn auth_required_from_a_load_asks_to_sign_in_too() {
        let options = FakeAgentOptions { load_session: true, ..needing_sign_in() };
        let err = connect(options, Some("old-session")).await.err().unwrap();
        assert_eq!(method_ids(&err), ["browser", "tui"]);
    }

    #[tokio::test]
    async fn the_client_offers_terminal_sign_ins() {
        let (_, _, _, agent) = connect(FakeAgentOptions::default(), None).await.unwrap();
        let capabilities = agent.client_capabilities.lock().unwrap().clone().unwrap();
        assert_eq!(capabilities["auth"]["terminal"], true);
        assert_eq!(capabilities["_meta"]["terminal-auth"], true);
    }

    #[tokio::test]
    async fn the_client_offers_subagent_sessions() {
        let (_, _, _, agent) = connect(FakeAgentOptions::default(), None).await.unwrap();
        let capabilities = agent.client_capabilities.lock().unwrap().clone().unwrap();
        assert_eq!(capabilities["subagents"], serde_json::json!({}));
    }

    #[tokio::test]
    async fn authenticate_then_the_session_starts_and_the_next_agent_is_signed_in() {
        let options = needing_sign_in();
        let (_, started, _, agent) = connect_with(options.clone(), None, Some("browser")).await.unwrap();
        assert_eq!(*agent.authenticated.lock().unwrap(), ["browser"]);
        assert_eq!(started.acp_session_id, "fake-session-1");
        let (_, _, _, again) = connect(options, None).await.unwrap();
        assert!(again.authenticated.lock().unwrap().is_empty(), "no second sign-in");
    }

    #[tokio::test]
    async fn a_failed_authenticate_is_its_message() {
        let options = FakeAgentOptions { fail_authenticate: Some((-32603, "login failed")), ..needing_sign_in() };
        let err = connect_with(options, None, Some("browser")).await.err().unwrap();
        let ConnectError::Failed(message) = err else { panic!("{err:?}") };
        assert_eq!(message, "login failed");
    }

    #[tokio::test]
    async fn an_authenticate_refused_as_auth_required_is_its_message_too() {
        // Gemini CLI answers an account Google no longer serves with -32000 (AuthRequired).
        let refused = "This client is no longer supported for Gemini Code Assist for individuals.";
        let options = FakeAgentOptions { fail_authenticate: Some((-32000, refused)), ..needing_sign_in() };
        let err = connect_with(options, None, Some("browser")).await.err().unwrap();
        let ConnectError::Failed(message) = err else { panic!("not the agent's message: {err:?}") };
        assert_eq!(message, refused);
    }

    #[tokio::test]
    async fn a_prompt_answered_auth_required_asks_to_sign_in() {
        let options = FakeAgentOptions { signed_in: Arc::new(true.into()), ..needing_sign_in() };
        let (conn, _, _, _) = connect(options.clone(), None).await.unwrap();
        options.signed_in.store(false, Ordering::SeqCst);
        let err = conn.prompt(text("hello")).await.unwrap_err();
        assert_eq!(method_ids(&err), ["browser", "tui"]);
    }

    #[tokio::test]
    async fn resume_loads_the_session_and_replays_history_first() {
        let options = FakeAgentOptions { load_session: true, ..Default::default() };
        let (_, started, mut rx, agent) = connect(options, Some("old-session")).await.unwrap();
        assert!(started.history_restored);
        assert_eq!(started.acp_session_id, "old-session");
        assert_eq!(agent.loads.load(Ordering::SeqCst), 1);
        assert_eq!(
            drain(&mut rx),
            vec![
                Seen::Update("user_message_chunk:earlier question".into()),
                Seen::Update("agent_message_chunk:earlier answer".into())
            ]
        );
    }

    #[tokio::test]
    async fn resume_without_load_support_starts_a_new_session() {
        let (_, started, _, agent) = connect(FakeAgentOptions::default(), Some("old-session")).await.unwrap();
        assert!(!started.history_restored);
        assert_eq!(started.acp_session_id, "fake-session-1");
        assert_eq!(agent.loads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn resume_without_load_continues_through_session_resume() {
        let options = FakeAgentOptions { resume_session: true, ..Default::default() };
        let (_, started, mut rx, agent) = connect(options, Some("old-session")).await.unwrap();
        assert_eq!(started.acp_session_id, "old-session");
        assert!(started.continued && !started.history_restored);
        assert_eq!(agent.resumes.load(Ordering::SeqCst), 1);
        assert_eq!(agent.new_sessions.load(Ordering::SeqCst), 0);
        assert!(drain(&mut rx).is_empty(), "nothing replayed");
    }

    async fn open_catalog(options: FakeAgentOptions) -> Result<(Catalog, Arc<fake_agent::FakeAgentState>), ConnectError> {
        let (writer, reader, state) = fake_agent::start(options);
        let opts = CatalogOptions { agent_name: "Fake Agent".to_owned(), initialize_timeout: Duration::from_secs(5) };
        Ok((Catalog::open(writer, reader, opts).await?, state))
    }

    fn stored(ids: &[(&str, &str)]) -> Arc<Mutex<Vec<fake_agent::FakeSession>>> {
        let sessions = ids.iter().map(|(id, cwd)| fake_agent::FakeSession::new(id, Path::new(cwd), Some(id), Some("2026-10-20T10:00:00Z")));
        Arc::new(Mutex::new(sessions.collect()))
    }

    #[tokio::test]
    async fn a_catalog_lists_every_page_of_the_folder_without_starting_a_session() {
        let stored = stored(&[("a", "/work"), ("b", "/work"), ("x", "/elsewhere"), ("c", "/work"), ("d", "/work"), ("e", "/work")]);
        let options = FakeAgentOptions { list_sessions: true, page_size: 2, stored, ..Default::default() };
        let (catalog, agent) = open_catalog(options).await.unwrap();
        assert!(catalog.capabilities().list);
        let listed = catalog.list_sessions(Path::new("/work"), 500).await.unwrap();
        let ids: Vec<&str> = listed.sessions.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c", "d", "e"]);
        assert!(listed.complete);
        assert_eq!(listed.sessions[0].title.as_deref(), Some("a"));
        assert_eq!(listed.sessions[0].updated_at.as_deref(), Some("2026-10-20T10:00:00Z"));
        assert_eq!(listed.sessions[0].cwd, PathBuf::from("/work"));
        assert_eq!(agent.lists.load(Ordering::SeqCst), 3);
        assert_eq!(agent.new_sessions.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_catalog_stops_listing_at_the_cap() {
        let stored = stored(&[("a", "/work"), ("b", "/work"), ("c", "/work"), ("d", "/work")]);
        let options = FakeAgentOptions { list_sessions: true, page_size: 2, stored, ..Default::default() };
        let (catalog, _) = open_catalog(options).await.unwrap();
        let listed = catalog.list_sessions(Path::new("/work"), 3).await.unwrap();
        assert_eq!(listed.sessions.len(), 3);
        assert!(!listed.complete);
    }

    #[tokio::test]
    async fn a_catalog_says_what_the_agent_can() {
        let (catalog, _) = open_catalog(FakeAgentOptions::default()).await.unwrap();
        assert_eq!(catalog.capabilities(), SessionCaps::default());
        let options = FakeAgentOptions { load_session: true, resume_session: true, delete_session: true, ..Default::default() };
        let (catalog, _) = open_catalog(options).await.unwrap();
        assert_eq!(catalog.capabilities(), SessionCaps { list: false, load: true, resume: true, delete: true });
    }

    #[tokio::test]
    async fn a_catalog_deletes_a_session() {
        let stored = stored(&[("a", "/work"), ("b", "/work")]);
        let options = FakeAgentOptions { list_sessions: true, delete_session: true, stored: Arc::clone(&stored), ..Default::default() };
        let (catalog, _) = open_catalog(options).await.unwrap();
        catalog.delete_session("a").await.unwrap();
        assert_eq!(stored.lock().unwrap().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["b"]);
    }

    #[tokio::test]
    async fn a_catalog_listing_answered_auth_required_asks_to_sign_in() {
        let options = FakeAgentOptions { list_sessions: true, ..needing_sign_in() };
        let (catalog, _) = open_catalog(options).await.unwrap();
        let err = catalog.list_sessions(Path::new("/work"), 500).await.unwrap_err();
        assert_eq!(method_ids(&err), ["browser", "tui"]);
    }

    #[tokio::test]
    async fn file_requests_go_through_the_host() {
        let (conn, _, mut rx, _) = connect(FakeAgentOptions::default(), None).await.unwrap();
        conn.prompt(text("read /work/a.txt")).await.unwrap();
        assert_eq!(drain(&mut rx), vec![Seen::Update("agent_message_chunk:read:a line=None limit=None".into())]);
        conn.prompt(text("write /etc/passwd x")).await.unwrap();
        let seen = drain(&mut rx);
        let [Seen::Update(reply)] = seen.as_slice() else { panic!("{seen:?}") };
        assert!(reply.starts_with("agent_message_chunk:error:/etc/passwd: outside the session"), "{reply}");
    }
}
