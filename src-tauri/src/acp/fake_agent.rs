//! A scripted ACP agent for tests, built with the crate's agent side and run in-process over a
//! duplex pipe. The prompt's first word picks the script:
//!
//! - `hello` → two message chunks, `end_turn`
//! - `permission` → a tool call, a permission request, then a chunk naming the answer
//! - `read <path>` / `write <path> <text>` → the client's fs methods; a chunk with the result
//! - `slow` → a chunk every 20 ms until cancelled (`cancelled`) or 200 chunks
//! - `sleep <ms>` → waits that long (or until cancelled), then a chunk
//! - `edit <path> <ms>` → a tool call naming the file (location, then a diff), written straight to
//!   disk as agents' own tools do; then like `sleep`
//! - `look <path> <ms>` → a read tool call naming the file (location only); then like `sleep`
//! - `crash` → one chunk, then the agent's side of the pipe closes mid-turn
//!
//! With `require_auth`, any prompt is answered AuthRequired while `signed_in` is unset (a login
//! that ran out).

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, AuthMethod, AuthenticateRequest, AuthenticateResponse, CancelNotification, ContentBlock, ContentChunk, Implementation, InitializeRequest, InitializeResponse,
    LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PermissionOption,
    PermissionOptionKind, PromptRequest, PromptResponse, ReadTextFileRequest, RequestPermissionOutcome,
    RequestPermissionRequest, SessionConfigOption, SessionConfigOptionCategory, SessionConfigOptionValue,
    SessionConfigSelectOption, SessionId, SessionInfoUpdate, SessionNotification, SessionUpdate, SetSessionConfigOptionRequest,
    SetSessionConfigOptionResponse, StopReason, TextContent, ToolCall, ToolCallContent, ToolCallLocation, ToolCallStatus,
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
}

/// What the test can observe of the agent.
#[derive(Default)]
pub struct FakeAgentState {
    /// The model the client last set (`fast` / `smart`); `smart` until then.
    pub model: std::sync::Mutex<String>,
    pub cancelled: AtomicBool,
    pub cancel_count: AtomicUsize,
    pub loads: AtomicUsize,
    /// Prompts it got, in order.
    pub prompts: std::sync::Mutex<Vec<String>>,
    /// `initialize`'s `clientCapabilities`, as JSON.
    pub client_capabilities: std::sync::Mutex<Option<serde_json::Value>>,
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
    let hang_set_config = options.hang_set_config;
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
                        .agent_capabilities(AgentCapabilities::new().load_session(options.load_session))
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
            async move |_request: NewSessionRequest, responder: Responder<NewSessionResponse>, _cx| {
                if new_options.needs_sign_in() {
                    return responder.respond_with_error(agent_client_protocol::Error::auth_required());
                }
                if new_options.fail_new_session {
                    return responder.respond_with_error(agent_client_protocol::Error::new(-32603, "no session today"));
                }
                responder.respond(NewSessionResponse::new("fake-session-1").config_options(config_options("smart")))
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
            async move |_n: CancelNotification, _cx| {
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
                // The turn runs outside the dispatch loop, so cancel notifications and responses
                // to our own requests keep flowing.
                tokio::spawn(async move {
                    let stop = run_turn(&cx, request, &state).await.unwrap_or(StopReason::EndTurn);
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

/// A model option (`smart` / `fast`) and a thought level that only `smart` has.
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
            for i in 0..200 {
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
        other => say(cx, &sid, &format!("unknown script {other:?}"))?,
    }
    Ok(StopReason::EndTurn)
}

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
