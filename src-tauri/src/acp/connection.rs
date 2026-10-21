//! The client side of one agent connection: handshake, session setup, prompts, cancel, and the
//! agent's requests (permissions, files).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, ContentBlock, EmbeddedResource, EmbeddedResourceResource,
    ErrorCode, FileSystemCapabilities, Implementation, InitializeRequest, LoadSessionRequest, McpServer,
    NewSessionRequest, PromptRequest, ReadTextFileRequest, SessionConfigOption, SessionModeState,
    SetSessionConfigOptionRequest, SetSessionModeRequest, ReadTextFileResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, ResourceLink, SelectedPermissionOutcome, SessionId,
    SessionNotification, TextContent, TextResourceContents, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo, Responder};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{oneshot, watch};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

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
}

#[derive(Debug, Clone)]
pub struct Started {
    pub acp_session_id: String,
    pub load_supported: bool,
    /// `resume` was asked for and the agent replayed it; `false` means a new ACP session.
    pub history_restored: bool,
    /// The session's config options (model, thought level, mode…) as ACP `SessionConfigOption`s.
    pub config_options: Vec<serde_json::Value>,
    /// `agentInfo.version` from `initialize`, when the agent sends it.
    pub agent_version: Option<String>,
}

/// Id of the option standing in for an agent's legacy `modes` when it has no config options.
pub const MODE_OPTION_ID: &str = "_brama_mode";

struct Shared {
    host: Arc<dyn ClientHost>,
    /// Permission requests waiting for the user, by our request id.
    pending: Mutex<HashMap<String, Responder<RequestPermissionResponse>>>,
    next_request: AtomicU64,
}

impl Shared {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, Responder<RequestPermissionResponse>>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
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
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.driver.abort();
    }
}

impl Connection {
    /// Handshake (`initialize`), then `session/load` of `resume` when the agent supports it, else
    /// `session/new`. Updates replayed by a load reach `host` before this returns.
    pub async fn start<W, R>(
        writer: W,
        reader: R,
        host: Arc<dyn ClientHost>,
        opts: StartOptions,
    ) -> Result<(Connection, Started), String>
    where
        W: AsyncWrite + Send + Unpin + 'static,
        R: AsyncRead + Send + Unpin + 'static,
    {
        let shared = Arc::new(Shared { host, pending: Mutex::default(), next_request: AtomicU64::new(0) });
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
            .name("brama")
            .on_receive_notification(
                async move |notification: SessionNotification, _cx| {
                    match serde_json::to_value(&notification.update) {
                        Ok(update) => on_update.host.on_update(update),
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
                    on_permission.pending().insert(request_id.clone(), responder);
                    on_permission.host.on_permission_request(PermissionRequest { request_id, tool_call, options });
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
            _ = closed.wait_for(Option::is_some) => return Err(closed_reason(&closed_rx)),
        };

        let initialize = InitializeRequest::new(ProtocolVersion::V1)
            .client_capabilities(
                ClientCapabilities::new()
                    .fs(FileSystemCapabilities::new().read_text_file(true).write_text_file(true))
                    .terminal(false),
            )
            .client_info(Implementation::new("brama", env!("CARGO_PKG_VERSION")));
        let init = match tokio::time::timeout(opts.initialize_timeout, cx.send_request(initialize).block_task()).await
        {
            Err(_) => {
                driver.abort();
                return Err(format!("{} did not answer within {}s", opts.agent_name, opts.initialize_timeout.as_secs()));
            }
            Ok(result) => result.map_err(|e| describe(&e, &opts.agent_name, &closed_rx))?,
        };
        let load_supported = init.agent_capabilities.load_session;
        tracing::info!(
            agent = %opts.agent_name,
            agent_info = ?init.agent_info.as_ref().map(|i| format!("{} {}", i.name, i.version)),
            load_supported,
            auth_methods = init.auth_methods.len(),
            "agent initialized"
        );

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
        if let (Some(resume), true) = (&opts.resume, load_supported) {
            let load = LoadSessionRequest::new(resume.clone(), opts.cwd.clone()).mcp_servers(mcp_servers.clone());
            match cx.send_request(load).block_task().await {
                Ok(loaded) => {
                    session_id = Some(SessionId::new(resume.clone()));
                    history_restored = true;
                    options = Some(config_options(loaded.config_options, loaded.modes));
                }
                Err(e) if e.code == ErrorCode::AuthRequired => return Err(sign_in(&opts.agent_name)),
                Err(e) => tracing::info!(agent = %opts.agent_name, "session/load failed, starting anew: {}", e.message),
            }
        }
        let session_id = match session_id {
            Some(id) => id,
            None => {
                let new = NewSessionRequest::new(opts.cwd.clone()).mcp_servers(mcp_servers);
                let created = cx
                    .send_request(new)
                    .block_task()
                    .await
                    .map_err(|e| describe(&e, &opts.agent_name, &closed_rx))?;
                options = Some(config_options(created.config_options, created.modes));
                created.session_id
            }
        };
        let config_options = options.unwrap_or_default();
        let started = Started {
            acp_session_id: session_id.to_string(),
            load_supported,
            history_restored,
            config_options: config_options.clone(),
            agent_version: init.agent_info.map(|info| info.version),
        };
        let options = Mutex::new(config_options);
        Ok((Connection { cx, session_id, shared, closed: closed_rx, driver, options }, started))
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
    pub async fn prompt(&self, blocks: Vec<PromptBlock>) -> Result<String, String> {
        let prompt = blocks.into_iter().map(content_block).collect();
        let request = PromptRequest::new(self.session_id.clone(), prompt);
        let mut closed = self.closed.clone();
        let response = tokio::select! {
            response = self.cx.send_request(request).block_task() => response.map_err(|e| e.message)?,
            _ = closed.wait_for(Option::is_some) => return Err(closed_reason(&self.closed)),
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
        let pending: Vec<_> = self.shared.pending().drain().map(|(_, responder)| responder).collect();
        for responder in pending {
            let _ = responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
        }
        sent
    }

    /// Answers a permission request: the chosen option, or `None` for cancelled.
    pub fn respond_permission(&self, request_id: &str, option_id: Option<String>) -> Result<(), String> {
        let responder = self
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

    /// Resolves with the reason once the agent's side is gone (exit, crash, closed pipe).
    pub async fn closed(&self) -> String {
        let mut closed = self.closed.clone();
        let _ = closed.wait_for(Option::is_some).await;
        closed_reason(&self.closed)
    }
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

fn sign_in(agent: &str) -> String {
    format!("Sign in to {agent}")
}

/// A failed request as the user reads it: the agent wants a sign-in, it went away, or its message.
fn describe(e: &agent_client_protocol::Error, agent: &str, closed: &watch::Receiver<Option<String>>) -> String {
    if e.code == ErrorCode::AuthRequired {
        return sign_in(agent);
    }
    if agent_client_protocol::is_incoming_transport_closed(e) {
        return format!("{agent} exited during startup");
    }
    if let Some(reason) = closed.borrow().clone() {
        return reason;
    }
    e.message.clone()
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
    use std::sync::atomic::Ordering;

    use tokio::sync::mpsc;

    use super::*;
    use crate::acp::fake_agent::{self, FakeAgentOptions};

    /// Everything the agent sent, in order: updates' text and permission requests.
    #[derive(Debug, Clone, PartialEq)]
    enum Seen {
        Update(String),
        Permission(String),
    }

    struct RecordingHost {
        tx: mpsc::UnboundedSender<Seen>,
    }

    impl ClientHost for RecordingHost {
        fn on_update(&self, update: serde_json::Value) {
            let kind = update["sessionUpdate"].as_str().unwrap_or_default();
            let text = update["content"]["text"].as_str().unwrap_or_default();
            let _ = self.tx.send(Seen::Update(format!("{kind}:{text}")));
        }

        fn on_permission_request(&self, request: PermissionRequest) {
            assert_eq!(request.options[0]["optionId"], "allow");
            let _ = self.tx.send(Seen::Permission(request.request_id));
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

    async fn connect(
        options: FakeAgentOptions,
        resume: Option<&str>,
    ) -> Result<(Connection, Started, mpsc::UnboundedReceiver<Seen>, Arc<fake_agent::FakeAgentState>), String> {
        let (writer, reader, state) = fake_agent::start(options);
        let (tx, rx) = mpsc::unbounded_channel();
        let opts = StartOptions {
            cwd: PathBuf::from("/work"),
            mcp_servers: vec![],
            resume: resume.map(str::to_owned),
            agent_name: "Fake Agent".to_owned(),
            initialize_timeout: Duration::from_secs(5),
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
    async fn a_crash_mid_turn_fails_the_turn_and_closes() {
        let (conn, _, mut rx, _) = connect(FakeAgentOptions::default(), None).await.unwrap();
        let err = tokio::time::timeout(Duration::from_secs(2), conn.prompt(text("crash"))).await.unwrap().unwrap_err();
        assert!(!err.is_empty());
        assert_eq!(rx.recv().await, Some(Seen::Update("agent_message_chunk:about to crash".into())));
        let reason = tokio::time::timeout(Duration::from_secs(2), conn.closed()).await.unwrap();
        assert!(reason.contains("closed") || reason.contains("failed"), "{reason}");
    }

    #[tokio::test]
    async fn auth_required_asks_to_sign_in() {
        let options = FakeAgentOptions { require_auth: true, ..Default::default() };
        let err = connect(options, None).await.err().unwrap();
        assert_eq!(err, "Sign in to Fake Agent");
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
