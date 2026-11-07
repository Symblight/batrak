//! A scripted ACP agent for tests, built with the crate's agent side and run in-process over a
//! duplex pipe. The prompt's first word picks the script:
//!
//! - `hello` → two message chunks, `end_turn`
//! - `permission` → a tool call, a permission request, then a chunk naming the answer
//! - `read <path>` / `write <path> <text>` → the client's fs methods; a chunk with the result
//! - `slow [<chunks>]` → a chunk every 20 ms until cancelled (`cancelled`) or that many chunks (200)
//! - `sleep <ms>` → waits that long (or until cancelled), then a chunk
//! - `edit <path> <ms>` → a tool call naming the file (location, then a diff), written straight to
//!   disk as agents' own tools do; then like `sleep`
//! - `look <path> <ms>` → a read tool call naming the file (location only); then like `sleep`
//! - `crash` → one chunk, then the agent's side of the pipe closes mid-turn
//! - `subagent` → announces subagent `child-1` (`subagent_update`: title, description, cancel,
//!   running); under its id a title, a tool call, a chunk and a permission request; then `child-1` idle
//!   (`end_turn`, or `cancelled` when the request was cancelled) and a chunk of the parent's
//!
//! With `require_auth`, any prompt is answered AuthRequired while `signed_in` is unset (a login
//! that ran out).
//!
//! Its stored sessions (`stored`) answer `session/list` (by `cwd`, `page_size` a page) and
//! `session/delete` when the options advertise them.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, AuthMethod, AuthenticateRequest, AuthenticateResponse, CancelNotification, ContentBlock, ContentChunk, DeleteSessionRequest,
    DeleteSessionResponse, Implementation, InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse,
    LoadSessionRequest, LoadSessionResponse, ResumeSessionRequest, ResumeSessionResponse, SessionCapabilities,
    SessionDeleteCapabilities, SessionInfo, SessionListCapabilities, SessionResumeCapabilities, NewSessionRequest, NewSessionResponse, PermissionOption,
    PermissionOptionKind, PromptRequest, PromptResponse, ReadTextFileRequest, RequestPermissionOutcome,
    RequestPermissionRequest, SessionConfigOption, SessionConfigOptionCategory, SessionConfigOptionValue,
    SessionConfigSelectOption, SessionId, SessionInfoUpdate, SessionNotification, SessionUpdate, SetSessionConfigOptionRequest,
    SetSessionConfigOptionResponse, StopReason, SubagentSessionCapabilities, SubagentUpdate, SessionCancelCapabilities,
    StateUpdate, RunningStateUpdate, IdleStateUpdate, IdleStopReason, TextContent, ToolCall, ToolCallContent, ToolCallLocation, ToolCallStatus,
    ToolCallUpdate, ToolCallUpdateFields, ToolKind, WriteTextFileRequest, Diff,
};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo, Responder};
use tokio::io::DuplexStream;
use tokio::sync::Notify;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

#[derive(Clone, Default)]
pub struct FakeAgentOptions {
    pub load_session: bool,
    /// `session/new`, `session/load` and prompts fail with AuthRequired until `signed_in`.
    pub require_auth: bool,
    /// `session/new` fails (not AuthRequired).
    pub fail_new_session: bool,
    /// The agent's credential store: shared by every agent started with these options, so one
    /// that signed in is seen by the next.
    pub signed_in: Arc<AtomicBool>,
    /// `initialize`'s `authMethods`, as JSON.
    pub auth_methods: Vec<serde_json::Value>,
    /// `authenticate` fails with this error code and message instead of signing in.
    pub fail_authenticate: Option<(i32, &'static str)>,
    /// `authenticate` is never answered (a login the user hasn't finished).
    pub hang_authenticate: bool,
    /// `session/set_config_option` is never answered.
    pub hang_set_config: bool,
    /// `sessionCapabilities`: `list`, `resume`, `delete`.
    pub list_sessions: bool,
    pub resume_session: bool,
    pub delete_session: bool,
    /// How many `session/delete` calls ran at once, at most; each takes 50 ms.
    pub deletes_peak: Arc<std::sync::atomic::AtomicUsize>,
    /// How many `session/delete` calls run now.
    pub deletes_running: Arc<std::sync::atomic::AtomicUsize>,
    /// `session/list` is never answered.
    pub hang_list: bool,
    /// Sessions a page of `session/list` holds; 0 is 50.
    pub page_size: usize,
    /// The agent's session store: shared by every agent started with these options. A
    /// `session/new` adds to it.
    pub stored: Arc<Mutex<Vec<FakeSession>>>,
    /// Numbers new sessions (`fake-session-<n>`) across the agents started with these options.
    pub created: Arc<AtomicUsize>,
}

/// A session in the fake agent's store.
#[derive(Debug, Clone, PartialEq)]
pub struct FakeSession {
    pub id: String,
    pub cwd: PathBuf,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

impl FakeSession {
    pub fn new(id: &str, cwd: &std::path::Path, title: Option<&str>, updated_at: Option<&str>) -> FakeSession {
        FakeSession { id: id.to_owned(), cwd: cwd.to_path_buf(), title: title.map(str::to_owned), updated_at: updated_at.map(str::to_owned) }
    }
}

/// What the test can observe of the agent.
#[derive(Default)]
pub struct FakeAgentState {
    /// The model the client last set (`fast` / `smart`); `smart` until then.
    pub model: std::sync::Mutex<String>,
    pub cancelled: AtomicBool,
    /// The sessions `session/cancel` named, in order (a subagent's doesn't set `cancelled`).
    pub cancelled_sessions: std::sync::Mutex<Vec<String>>,
    pub cancel_count: AtomicUsize,
    pub loads: AtomicUsize,
    pub resumes: AtomicUsize,
    pub lists: AtomicUsize,
    pub new_sessions: AtomicUsize,
    /// Prompts it got, in order.
    pub prompts: std::sync::Mutex<Vec<String>>,
    /// `initialize`'s `clientCapabilities`, as JSON.
    pub client_capabilities: std::sync::Mutex<Option<serde_json::Value>>,
    /// The title the running turn gave its session (`title …`).
    pub title: std::sync::Mutex<Option<String>>,
    /// Methods `authenticate` was called with.
    pub authenticated: std::sync::Mutex<Vec<String>>,
    pub crash: Notify,
}

/// Starts the agent; returns the client's ends of the pipe (`writer` to the agent, `reader` from it).
pub fn start(options: FakeAgentOptions) -> (DuplexStream, DuplexStream, Arc<FakeAgentState>) {
    let (client_out, agent_in) = tokio::io::duplex(64 * 1024);
    let (agent_out, client_in) = tokio::io::duplex(64 * 1024);
    let state = Arc::new(FakeAgentState::default());
    let run_state = Arc::clone(&state);
    tokio::spawn(async move {
        let crash = Arc::clone(&run_state);
        tokio::select! {
            _ = serve(agent_out, agent_in, options, run_state) => {}
            // Dropping `serve` drops both pipe ends: the client sees EOF, like a dead process.
            _ = crash.crash.notified() => {}
        }
    });
    (client_out, client_in, state)
}

async fn serve(out: DuplexStream, input: DuplexStream, options: FakeAgentOptions, state: Arc<FakeAgentState>) {
    let on_cancel = Arc::clone(&state);
    let on_load = Arc::clone(&state);
    let on_prompt = Arc::clone(&state);
    let new_options = options.clone();
    let on_set = Arc::clone(&state);
    let load_options = options.clone();
    let auth_options = options.clone();
    let prompt_options = options.clone();
    let on_init = Arc::clone(&state);
    let on_auth = Arc::clone(&state);
    let on_new = Arc::clone(&state);
    let on_resume = Arc::clone(&state);
    let on_list = Arc::clone(&state);
    let list_options = options.clone();
    let delete_options = options.clone();
    let hang_set_config = options.hang_set_config;
    let capabilities = SessionCapabilities::new()
        .list(options.list_sessions.then(SessionListCapabilities::new))
        .resume(options.resume_session.then(SessionResumeCapabilities::new))
        .delete(options.delete_session.then(SessionDeleteCapabilities::new));
    let result = Agent
        .builder()
        .name("fake-agent")
        .on_receive_request(
            async move |request: InitializeRequest, responder: Responder<InitializeResponse>, _cx| {
                *on_init.client_capabilities.lock().unwrap() = serde_json::to_value(&request.client_capabilities).ok();
                let methods: Vec<AuthMethod> =
                    options.auth_methods.iter().filter_map(|m| serde_json::from_value(m.clone()).ok()).collect();
                responder.respond(
                    InitializeResponse::new(request.protocol_version)
                        .agent_capabilities(
                            AgentCapabilities::new().load_session(options.load_session).session_capabilities(capabilities.clone()),
                        )
                        .agent_info(Implementation::new("fake-agent", "1.2.3"))
                        .auth_methods(methods),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: AuthenticateRequest, responder: Responder<AuthenticateResponse>, _cx| {
                on_auth.authenticated.lock().unwrap().push(request.method_id.to_string());
                if auth_options.hang_authenticate {
                    tokio::spawn(async move {
                        std::future::pending::<()>().await;
                        drop(responder);
                    });
                    return Ok(());
                }
                if let Some((code, message)) = auth_options.fail_authenticate {
                    return responder.respond_with_error(agent_client_protocol::Error::new(code, message));
                }
                auth_options.signed_in.store(true, Ordering::SeqCst);
                responder.respond(AuthenticateResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: NewSessionRequest, responder: Responder<NewSessionResponse>, _cx| {
                on_new.new_sessions.fetch_add(1, Ordering::SeqCst);
                if new_options.needs_sign_in() {
                    return responder.respond_with_error(agent_client_protocol::Error::auth_required());
                }
                if new_options.fail_new_session {
                    return responder.respond_with_error(agent_client_protocol::Error::new(-32603, "no session today"));
                }
                let id = format!("fake-session-{}", new_options.created.fetch_add(1, Ordering::SeqCst) + 1);
                new_options.stored.lock().unwrap().push(FakeSession { id: id.clone(), cwd: request.cwd, title: None, updated_at: None });
                responder.respond(NewSessionResponse::new(id).config_options(config_options("smart")))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: LoadSessionRequest, responder: Responder<LoadSessionResponse>, cx: ConnectionTo<Client>| {
                on_load.loads.fetch_add(1, Ordering::SeqCst);
                if load_options.needs_sign_in() {
                    return responder.respond_with_error(agent_client_protocol::Error::auth_required());
                }
                // History is replayed as updates before the response.
                let sid = request.session_id.clone();
                cx.send_notification(SessionNotification::new(
                    sid.clone(),
                    SessionUpdate::UserMessageChunk(ContentChunk::new(text("earlier question"))),
                ))?;
                cx.send_notification(SessionNotification::new(
                    sid,
                    SessionUpdate::AgentMessageChunk(ContentChunk::new(text("earlier answer"))),
                ))?;
                // A new process: the model is the default again.
                responder.respond(LoadSessionResponse::new().config_options(config_options("smart")))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ResumeSessionRequest, responder: Responder<ResumeSessionResponse>, _cx| {
                on_resume.resumes.fetch_add(1, Ordering::SeqCst);
                responder.respond(ResumeSessionResponse::new().config_options(config_options("smart")))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ListSessionsRequest, responder: Responder<ListSessionsResponse>, _cx| {
                on_list.lists.fetch_add(1, Ordering::SeqCst);
                if list_options.hang_list {
                    tokio::spawn(async move {
                        std::future::pending::<()>().await;
                        drop(responder);
                    });
                    return Ok(());
                }
                if list_options.needs_sign_in() {
                    return responder.respond_with_error(agent_client_protocol::Error::auth_required());
                }
                let in_cwd: Vec<FakeSession> = {
                    let stored = list_options.stored.lock().unwrap();
                    stored.iter().filter(|s| request.cwd.as_ref().is_none_or(|cwd| *cwd == s.cwd)).cloned().collect()
                };
                let size = if list_options.page_size == 0 { 50 } else { list_options.page_size };
                let from: usize = request.cursor.as_deref().and_then(|c| c.parse().ok()).unwrap_or(0);
                let page = in_cwd.iter().skip(from).take(size).map(|s| {
                    SessionInfo::new(s.id.clone(), s.cwd.clone()).title(s.title.clone()).updated_at(s.updated_at.clone())
                });
                let next = (from + size < in_cwd.len()).then(|| (from + size).to_string());
                responder.respond(ListSessionsResponse::new(page.collect()).next_cursor(next))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: DeleteSessionRequest, responder: Responder<DeleteSessionResponse>, _cx| {
                {
                    use std::sync::atomic::Ordering::SeqCst;
                    let running = delete_options.deletes_running.fetch_add(1, SeqCst) + 1;
                    delete_options.deletes_peak.fetch_max(running, SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    delete_options.deletes_running.fetch_sub(1, SeqCst);
                }
                delete_options.stored.lock().unwrap().retain(|s| s.id != request.session_id.to_string());
                responder.respond(DeleteSessionResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SetSessionConfigOptionRequest, responder: Responder<SetSessionConfigOptionResponse>, _cx| {
                if hang_set_config {
                    tokio::spawn(async move {
                        std::future::pending::<()>().await;
                        drop(responder);
                    });
                    return Ok(());
                }
                let SessionConfigOptionValue::ValueId { value } = request.value else {
                    return responder.respond_with_error(agent_client_protocol::Error::invalid_params());
                };
                let value = value.to_string();
                if request.config_id.to_string() != "model" || !["smart", "fast"].contains(&value.as_str()) {
                    return responder.respond_with_error(agent_client_protocol::Error::invalid_params());
                }
                value.clone_into(&mut on_set.model.lock().unwrap());
                responder.respond(SetSessionConfigOptionResponse::new(config_options(&value)))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |n: CancelNotification, _cx| {
                let id = n.session_id.to_string();
                on_cancel.cancelled_sessions.lock().unwrap().push(id.clone());
                if id.starts_with(SUBAGENT_PREFIX) {
                    return Ok(());
                }
                on_cancel.cancelled.store(true, Ordering::SeqCst);
                on_cancel.cancel_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: PromptRequest, responder: Responder<PromptResponse>, cx: ConnectionTo<Client>| {
                on_prompt.cancelled.store(false, Ordering::SeqCst);
                if prompt_options.needs_sign_in() {
                    return responder.respond_with_error(agent_client_protocol::Error::auth_required());
                }
                let state = Arc::clone(&on_prompt);
                let stored = Arc::clone(&prompt_options.stored);
                // The turn runs outside the dispatch loop, so cancel notifications and responses
                // to our own requests keep flowing.
                tokio::spawn(async move {
                    let sid = request.session_id.to_string();
                    let stop = run_turn(&cx, request, &state).await.unwrap_or(StopReason::EndTurn);
                    // Like an agent's store: the session's last activity, and the title it gave.
                    let title = state.title.lock().unwrap().take();
                    for session in stored.lock().unwrap().iter_mut().filter(|s| s.id == sid) {
                        session.updated_at = Some(iso_now());
                        if title.is_some() {
                            session.title.clone_from(&title);
                        }
                    }
                    let _ = responder.respond(PromptResponse::new(stop));
                });
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(ByteStreams::new(out.compat_write(), input.compat()))
        .await;
    if let Err(e) = result {
        eprintln!("fake agent: {}", e.message);
    }
}

impl FakeAgentOptions {
    fn needs_sign_in(&self) -> bool {
        self.require_auth && !self.signed_in.load(Ordering::SeqCst)
    }
}

/// A model option (`smart` / `fast`), a thought level that only `smart` has, and a mode (`ask` /
/// `full`).
fn config_options(model: &str) -> Vec<SessionConfigOption> {
    let model_option = SessionConfigOption::select(
        "model",
        "Model",
        model.to_owned(),
        vec![SessionConfigSelectOption::new("smart", "Smart"), SessionConfigSelectOption::new("fast", "Fast")],
    )
    .category(SessionConfigOptionCategory::Model);
    let mut options = vec![model_option];
    if model == "smart" {
        options.push(
            SessionConfigOption::select(
                "effort",
                "Effort",
                "high",
                vec![SessionConfigSelectOption::new("low", "Low"), SessionConfigSelectOption::new("high", "High")],
            )
            .category(SessionConfigOptionCategory::ThoughtLevel),
        );
    }
    options.push(
        SessionConfigOption::select("mode", "Mode", "ask", vec![SessionConfigSelectOption::new("ask", "Ask"), SessionConfigSelectOption::new("full", "Full access")])
            .category(SessionConfigOptionCategory::Mode),
    );
    options
}

fn text(s: &str) -> ContentBlock {
    ContentBlock::Text(TextContent::new(s))
}

fn say(cx: &ConnectionTo<Client>, sid: &SessionId, s: &str) -> agent_client_protocol::Result<()> {
    cx.send_notification(SessionNotification::new(
        sid.clone(),
        SessionUpdate::AgentMessageChunk(ContentChunk::new(text(s))),
    ))
}

async fn run_turn(
    cx: &ConnectionTo<Client>,
    request: PromptRequest,
    state: &FakeAgentState,
) -> agent_client_protocol::Result<StopReason> {
    let sid = request.session_id.clone();
    let prompt: String = request
        .prompt
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(t) => Some(t.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    state.prompts.lock().unwrap().push(prompt.clone());
    let mut words = prompt.split_whitespace();
    match words.next().unwrap_or_default() {
        "hello" => {
            say(cx, &sid, "Hello")?;
            say(cx, &sid, ", world")?;
        }
        "title" => {
            let title: Vec<&str> = words.collect();
            *state.title.lock().unwrap() = Some(title.join(" "));
            cx.send_notification(SessionNotification::new(
                sid.clone(),
                SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new().title(title.join(" "))),
            ))?;
            say(cx, &sid, "titled")?;
        }
        "permission" => {
            cx.send_notification(SessionNotification::new(
                sid.clone(),
                SessionUpdate::ToolCall(ToolCall::new("call-1", "Edit a.txt").status(ToolCallStatus::Pending)),
            ))?;
            let ask = RequestPermissionRequest::new(
                sid.clone(),
                ToolCallUpdate::new("call-1", ToolCallUpdateFields::new().title("Edit a.txt")),
                vec![
                    PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
                    PermissionOption::new("deny", "Deny", PermissionOptionKind::RejectOnce),
                ],
            );
            let answer = cx.send_request(ask).block_task().await?;
            match answer.outcome {
                RequestPermissionOutcome::Selected(selected) => say(cx, &sid, &format!("chose {}", selected.option_id))?,
                _ => return Ok(StopReason::Cancelled),
            }
        }
        "read" => {
            let path = words.next().unwrap_or_default();
            let read = cx.send_request(ReadTextFileRequest::new(sid.clone(), path)).block_task().await;
            match read {
                Ok(r) => say(cx, &sid, &format!("read:{}", r.content))?,
                Err(e) => say(cx, &sid, &format!("error:{}", e.message))?,
            }
        }
        "write" => {
            let path = words.next().unwrap_or_default();
            let content: Vec<&str> = words.collect();
            let written =
                cx.send_request(WriteTextFileRequest::new(sid.clone(), path, content.join(" "))).block_task().await;
            match written {
                Ok(_) => say(cx, &sid, "written")?,
                Err(e) => say(cx, &sid, &format!("error:{}", e.message))?,
            }
        }
        "slow" => {
            let chunks: u32 = words.next().and_then(|w| w.parse().ok()).unwrap_or(200);
            for i in 0..chunks {
                if state.cancelled.load(Ordering::SeqCst) {
                    return Ok(StopReason::Cancelled);
                }
                say(cx, &sid, &format!("{i} "))?;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        "sleep" => {
            let ms: u64 = words.next().and_then(|w| w.parse().ok()).unwrap_or(100);
            if !sleep(state, ms).await {
                return Ok(StopReason::Cancelled);
            }
            say(cx, &sid, "slept")?;
        }
        "edit" => {
            let path = words.next().unwrap_or_default().to_owned();
            let ms: u64 = words.next().and_then(|w| w.parse().ok()).unwrap_or(0);
            cx.send_notification(SessionNotification::new(
                sid.clone(),
                SessionUpdate::ToolCall(ToolCall::new("call-edit", format!("Edit {path}")).kind(ToolKind::Edit).locations(vec![ToolCallLocation::new(&path)])),
            ))?;
            let _ = std::fs::write(&path, "edited\n");
            let diff = ToolCallContent::from(Diff::new(&path, "edited\n"));
            cx.send_notification(SessionNotification::new(
                sid.clone(),
                SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                    "call-edit",
                    ToolCallUpdateFields::new().status(ToolCallStatus::Completed).content(vec![diff]),
                )),
            ))?;
            if !sleep(state, ms).await {
                return Ok(StopReason::Cancelled);
            }
            say(cx, &sid, "edited")?;
        }
        "look" => {
            let path = words.next().unwrap_or_default().to_owned();
            let ms: u64 = words.next().and_then(|w| w.parse().ok()).unwrap_or(0);
            cx.send_notification(SessionNotification::new(
                sid.clone(),
                SessionUpdate::ToolCall(ToolCall::new("call-look", format!("Read {path}")).kind(ToolKind::Read).locations(vec![ToolCallLocation::new(&path)])),
            ))?;
            cx.send_notification(SessionNotification::new(
                sid.clone(),
                SessionUpdate::ToolCallUpdate(ToolCallUpdate::new("call-look", ToolCallUpdateFields::new().status(ToolCallStatus::Completed))),
            ))?;
            if !sleep(state, ms).await {
                return Ok(StopReason::Cancelled);
            }
            say(cx, &sid, "looked")?;
        }
        "crash" => {
            say(cx, &sid, "about to crash")?;
            tokio::time::sleep(Duration::from_millis(50)).await;
            state.crash.notify_one();
            // Never answered: the pipe is gone.
            std::future::pending::<()>().await;
        }
        "subagent" => {
            let child = SessionId::new(format!("{SUBAGENT_PREFIX}1"));
            let announce = SubagentUpdate::new(child.clone())
                .title("find usages")
                .description("Explore")
                .capabilities(SubagentSessionCapabilities::new().cancel(SessionCancelCapabilities::new()))
                .state(StateUpdate::Running(RunningStateUpdate::new()));
            cx.send_notification(SessionNotification::new(sid.clone(), SessionUpdate::SubagentUpdate(announce)))?;
            cx.send_notification(SessionNotification::new(
                child.clone(),
                SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new().title("child title")),
            ))?;
            cx.send_notification(SessionNotification::new(
                child.clone(),
                SessionUpdate::ToolCall(ToolCall::new("child-call", "Read a.txt").kind(ToolKind::Read)),
            ))?;
            say(cx, &child, "found")?;
            let ask = RequestPermissionRequest::new(
                child.clone(),
                ToolCallUpdate::new("child-call", ToolCallUpdateFields::new().title("Read a.txt")),
                vec![
                    PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
                    PermissionOption::new("deny", "Deny", PermissionOptionKind::RejectOnce),
                ],
            );
            let answer = cx.send_request(ask).block_task().await?;
            let stop = match answer.outcome {
                RequestPermissionOutcome::Selected(_) => IdleStopReason::EndTurn,
                _ => IdleStopReason::Cancelled,
            };
            let cancelled = matches!(stop, IdleStopReason::Cancelled);
            let idle = SubagentUpdate::new(child).state(StateUpdate::Idle(IdleStateUpdate::new().stop_reason(stop)));
            cx.send_notification(SessionNotification::new(sid.clone(), SessionUpdate::SubagentUpdate(idle)))?;
            say(cx, &sid, if cancelled { "child cancelled" } else { "done" })?;
        }
        other => say(cx, &sid, &format!("unknown script {other:?}"))?,
    }
    Ok(StopReason::EndTurn)
}

/// Session ids of the `subagent` script's children.
const SUBAGENT_PREFIX: &str = "child-";

/// Waits `ms` in steps; `false` when the turn was cancelled meanwhile.
async fn sleep(state: &FakeAgentState, ms: u64) -> bool {
    for _ in 0..ms.div_ceil(10) {
        if state.cancelled.load(Ordering::SeqCst) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    true
}

/// Now as an ISO 8601 UTC timestamp with milliseconds, as agents write `updatedAt`.
fn iso_now() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}
