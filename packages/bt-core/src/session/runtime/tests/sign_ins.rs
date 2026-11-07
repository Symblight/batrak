use super::*;
use crate::session::runtime::sign_in::SignIn;

/// An agent that needs a sign-in: one `agent` method, `browser`.
fn needing_sign_in() -> FakeAgentOptions {
    FakeAgentOptions {
        require_auth: true,
        auth_methods: vec![json!({ "id": "browser", "name": "Log in", "description": "In your browser" })],
        ..Default::default()
    }
}

fn event_count(events: &Recorder, kind: &str) -> usize {
    lock(&events.events).iter().filter(|e| e.kind == kind).count()
}

/// A session of `fake` that asked to sign in and holds the prompt "hello".
async fn holding_a_prompt(f: &Fixture) -> Arc<Recorder> {
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("error").await;
    f.sessions.send_prompt("s", text("hello")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;
    events
}

/// `fake`'s sign-in with `method` (`None`: Retry), from the client "main".
async fn sign_in(f: &Fixture, method: Option<&str>) -> SignIn {
    f.sessions.sign_in(Some(&f.project), "fake", method, f.programs.client("main")).await.unwrap()
}

async fn assert_still_held(events: &Recorder) {
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(event_count(events, "prompt-returned") + event_count(events, "turn-end"), 0, "still held");
}

#[tokio::test]
async fn a_prompt_to_an_agent_that_asks_to_sign_in_is_held_not_lost() {
    let f = fixture("sign-in-held", needing_sign_in());
    let (_, events) = f.create("s", "fake").unwrap();
    let asked = events.wait_for("sign-in", |e| e.kind == "sign-in").await;
    assert_eq!(asked.payload["agentId"], "fake");
    assert_eq!(asked.payload["agentName"], "Fake");
    assert_eq!(asked.payload["methods"][0]["id"], "browser");
    assert_eq!(asked.payload["methods"][0]["kind"], "agent");
    let status = events.wait_status("error").await;
    assert_eq!(status.payload["message"], "Sign in to Fake");
    assert_eq!(event_count(&events, "error"), 0, "no error notice: the sign-in card says it");

    f.sessions.send_prompt("s", text("hello")).unwrap();
    let held = events.wait_for("held", |e| e.kind == "held").await;
    assert_eq!(held.payload["prompt"][0]["text"], "hello");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(event_count(&events, "turn-end"), 0, "the turn waits");
    assert_eq!(f.sessions.sign_in_state(Some(&f.project), "fake").unwrap().methods.len(), 1);

    events.clear();
    assert_eq!(sign_in(&f, Some("browser")).await.end().await, SignInEnd::Done);
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(events.texts().join(""), "Hello, world", "the held prompt was answered");
    events.wait_for("sign-in cleared", |e| e.kind == "sign-in" && e.payload.is_null()).await;
    let agents = lock(&f.launcher.agents).clone();
    assert_eq!(*agents.last().unwrap().prompts.lock().unwrap(), ["hello"]);
    assert!(agents.iter().any(|a| *a.authenticated.lock().unwrap() == ["browser"]));
    assert!(f.sessions.sign_in_state(Some(&f.project), "fake").is_none(), "it no longer needs one");
}

#[tokio::test]
async fn signing_in_brings_back_every_waiting_session_of_the_agent() {
    let f = fixture("sign-in-two", needing_sign_in());
    let (_, first) = f.create("a", "fake").unwrap();
    let (_, second) = f.create("b", "fake").unwrap();
    first.wait_status("error").await;
    second.wait_status("error").await;
    f.sessions.send_prompt("a", text("hello")).unwrap();
    first.wait_for("held", |e| e.kind == "held").await;

    first.clear();
    second.clear();
    let started = sign_in(&f, Some("browser")).await;
    let joined = sign_in(&f, Some("browser")).await;
    assert_eq!(started.end().await, SignInEnd::Done);
    assert_eq!(joined.end().await, SignInEnd::Done, "a second call joins the first");
    assert_eq!(first.wait_turn_end().await, "end_turn");
    second.wait_status("idle").await;
    assert_eq!(event_count(&second, "turn-end"), 0, "nothing was held there");
    let authenticated: usize = lock(&f.launcher.agents).iter().map(|a| a.authenticated.lock().unwrap().len()).sum();
    assert_eq!(authenticated, 1, "one sign-in");
}

#[tokio::test]
async fn cancel_stop_or_the_agent_leaving_gives_a_held_prompt_back() {
    let f = fixture("sign-in-drop", needing_sign_in());
    let events = holding_a_prompt(&f).await;

    f.sessions.cancel("s").unwrap();
    let back = events.wait_for("prompt-returned", |e| e.kind == "prompt-returned").await;
    assert_eq!(back.payload["prompt"][0]["text"], "hello");
    assert_eq!(events.wait_turn_end().await, "cancelled");

    events.clear();
    f.sessions.send_prompt("s", text("again")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;
    f.sessions.stop("s").await.unwrap();
    events.wait_for("prompt-returned", |e| e.kind == "prompt-returned").await;
    events.wait_for("sign-in cleared", |e| e.kind == "sign-in" && e.payload.is_null()).await;
    events.wait_turn_end().await;

    f.sessions.restart("s").await.unwrap();
    events.clear();
    events.wait_status("error").await;
    f.sessions.send_prompt("s", text("third")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;
    f.set_agents(&f.project, r#"{"version":1,"agents":{}}"#);
    f.sessions.sync_agents(&f.project).await;
    events.wait_for("prompt-returned", |e| e.kind == "prompt-returned").await;
    events.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    let prompts: Vec<String> = lock(&f.launcher.agents).iter().flat_map(|a| a.prompts.lock().unwrap().clone()).collect();
    assert!(prompts.is_empty(), "none reached the agent: {prompts:?}");
}

#[tokio::test]
async fn a_failed_sign_in_keeps_the_prompt_waiting() {
    let f = fixture("sign-in-fail", FakeAgentOptions { fail_authenticate: Some((-32603, "login failed")), ..needing_sign_in() });
    let events = holding_a_prompt(&f).await;
    let SignInEnd::Failed(message) = sign_in(&f, Some("browser")).await.end().await else {
        panic!("signed in")
    };
    assert!(message.contains("login failed"), "{message}");
    assert_still_held(&events).await;
    assert!(f.sessions.sign_in_state(Some(&f.project), "fake").is_some_and(|s| !s.pending));
}

#[tokio::test]
async fn a_sign_in_runs_only_a_trusted_launch() {
    let f = fixture("sign-in-trust", FakeAgentOptions::default());
    f.set_agents(&f.project, r#"{"version":1,"agents":{"repo":{"name":"Repo","command":"./agent"}}}"#);
    let refused = f.sessions.sign_in(Some(&f.project), "repo", Some("browser"), f.programs.client("main")).await.err().unwrap();
    assert!(refused.contains("trust"), "{refused}");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 0, "nothing ran");
    assert!(f.sessions.cancel_sign_in(Some(&f.project), "repo").is_none(), "none runs");
}

#[tokio::test]
async fn a_login_that_ran_out_mid_session_holds_the_prompt_until_signed_in_again() {
    let options = FakeAgentOptions { signed_in: Arc::new(true.into()), ..needing_sign_in() };
    let signed_in = Arc::clone(&options.signed_in);
    let f = fixture("sign-in-expired", options);
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("idle").await;
    signed_in.store(false, Ordering::SeqCst);
    events.clear();
    f.sessions.send_prompt("s", text("hello")).unwrap();
    events.wait_for("sign-in", |e| e.kind == "sign-in" && !e.payload.is_null()).await;
    events.wait_for("held", |e| e.kind == "held").await;
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Error);

    assert_eq!(sign_in(&f, Some("browser")).await.end().await, SignInEnd::Done);
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(events.texts().join(""), "Hello, world");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 3, "the session's, the sign-in's, the session's again");
}

#[tokio::test]
async fn a_probe_that_asks_to_sign_in_says_so_the_tab_shows_it_and_no_probe_starts_it_again_until_signed_in() {
    let options = needing_sign_in();
    let signed_in = Arc::clone(&options.signed_in);
    let f = fixture("sign-in-probe", options);
    let probe_sign_in = || async {
        let Probed::SignIn { sign_in } = f.sessions.probe_options(Some(&f.project), "fake").await.unwrap() else {
            panic!("options without a sign-in")
        };
        sign_in
    };
    let methods = probe_sign_in().await;
    assert_eq!(methods.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["browser"]);
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1);
    let state = f.sessions.sign_in_state(Some(&f.project), "fake").unwrap();
    assert!(!state.pending && state.methods == methods);
    assert!(f.sessions.sign_in_state(Some(&f.project), "locked").is_none());
    let list = f.sessions.agent_list(Some(&f.project));
    let needs = |id: &str| list.agents.iter().find(|a| a.id == id).unwrap().sign_in;
    assert!(needs("fake") && !needs("locked"), "the picker says which one needs a sign-in");
    let json = serde_json::to_value(Probed::SignIn { sign_in: methods.clone() }).unwrap();
    assert_eq!(json["signIn"][0]["name"], "Log in");

    // An agent may open the browser whenever it's started signed out: a page reload's probe
    // mustn't start it again until the user signs in or presses Retry.
    assert_eq!(probe_sign_in().await, methods, "the noted methods");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1, "not started again");

    signed_in.store(true, Ordering::SeqCst);
    assert_eq!(sign_in(&f, None).await.end().await, SignInEnd::Done);
    assert!(matches!(f.sessions.probe_options(Some(&f.project), "fake").await.unwrap(), Probed::Options(_)), "probed once signed in");
}

#[tokio::test]
async fn an_agent_that_signs_in_on_its_own_starts_only_when_the_user_acts() {
    use super::sync::SyncOutcome;
    let f = fixture("interactive", FakeAgentOptions { load_session: true, ..listing() });
    f.set_agents(&f.project, r#"{"version":1,"agents":{"agy":{"name":"Agy","command":"interactive-agent"}}}"#);
    let configs = &f.sessions.inner.opts.configs;
    configs.trust(&f.project, &configs.untrusted(&f.project).into_iter().map(|u| u.launch).collect::<Vec<_>>()).unwrap();
    let launches = || f.launcher.launches.load(Ordering::SeqCst);

    // Probe and sync: no user asked.
    assert!(f.sessions.probe_options(Some(&f.project), "agy").await.is_err(), "not probed");
    let agy = Some(&["agy".to_owned()][..]);
    assert_eq!(outcomes(&f.sessions.sync(&f.project, agy).await), [("agy", SyncOutcome::Unsupported, None)]);
    assert_eq!(launches(), 0, "neither started it");

    // A session the user made, stopped: showing it doesn't start it, a message does.
    let (_, events) = f.create("s", "agy").unwrap();
    events.wait_status("idle").await;
    f.sessions.stop("s").await.unwrap();
    events.wait_status("stopped").await;
    assert!(!f.sessions.resume("s").await.unwrap(), "stays stopped when shown");
    assert_eq!(launches(), 1);
    f.sessions.send_prompt("s", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(launches(), 2);
}

#[tokio::test]
async fn retry_after_a_login_elsewhere_sends_the_held_prompt() {
    let options = needing_sign_in();
    let signed_in = Arc::clone(&options.signed_in);
    let f = fixture("sign-in-retry", options);
    let events = holding_a_prompt(&f).await;

    let SignInEnd::Failed(message) = sign_in(&f, None).await.end().await else {
        panic!("signed in")
    };
    assert!(message.contains("still asks to sign in"), "{message}");
    assert_still_held(&events).await;

    // A login in a terminal, which the app doesn't see.
    signed_in.store(true, Ordering::SeqCst);
    assert_eq!(sign_in(&f, None).await.end().await, SignInEnd::Done);
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(events.texts().join(""), "Hello, world");
    let authenticated: usize = lock(&f.launcher.agents).iter().map(|a| a.authenticated.lock().unwrap().len()).sum();
    assert_eq!(authenticated, 0, "Retry only checks");
}

#[tokio::test]
async fn a_cancelled_sign_in_ends_cancelled_and_keeps_the_prompt_held() {
    let f = fixture("sign-in-cancel", FakeAgentOptions { hang_authenticate: true, ..needing_sign_in() });
    let events = holding_a_prompt(&f).await;

    let started = sign_in(&f, Some("browser")).await;
    while lock(&f.launcher.agents).iter().all(|a| a.authenticated.lock().unwrap().is_empty()) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(f.sessions.sign_in_state(Some(&f.project), "fake").unwrap().pending);
    assert!(f.sessions.cancel_sign_in(Some(&f.project), "fake").is_some());
    assert_eq!(started.end().await, SignInEnd::Cancelled);
    let state = f.sessions.sign_in_state(Some(&f.project), "fake").unwrap();
    assert!(!state.pending && state.methods.len() == 1, "it still needs one");
    assert_still_held(&events).await;
}

#[tokio::test]
async fn a_session_waiting_under_an_earlier_launch_comes_back_after_signing_in_to_the_new_one() {
    let f = fixture("sign-in-moved", needing_sign_in());
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("error").await;
    f.set_agents(&f.project, &AGENTS.replace(r#""command":"fake-agent""#, r#""command":"fake-agent","args":["--acp"]"#));
    let configs = &f.sessions.inner.opts.configs;
    let launches: Vec<_> = configs.untrusted(&f.project).into_iter().map(|u| u.launch).collect();
    configs.trust(&f.project, &launches).unwrap();
    f.sessions.sync_agents(&f.project).await;

    events.clear();
    assert_eq!(sign_in(&f, Some("browser")).await.end().await, SignInEnd::Done);
    events.wait_status("idle").await;
}

/// An agent whose only way in is a login in a terminal: Claude's `terminal` type, or Copilot's
/// `terminal-auth` command.
fn needing_a_terminal_login() -> FakeAgentOptions {
    FakeAgentOptions {
        require_auth: true,
        auth_methods: vec![
            json!({ "type": "terminal", "id": "tui", "name": "Subscription", "args": ["auth", "login"], "env": { "MODE": "login" } }),
            json!({ "id": "cli", "name": "CLI", "_meta": { "terminal-auth": { "command": "/opt/cli", "args": ["login"], "label": "CLI Login" } } }),
        ],
        ..Default::default()
    }
}

#[tokio::test]
async fn a_terminal_method_gives_a_login_to_run_and_its_exit_signs_in() {
    let options = needing_a_terminal_login();
    let signed_in = Arc::clone(&options.signed_in);
    let f = fixture("sign-in-terminal", options);
    let events = holding_a_prompt(&f).await;
    let launches = f.launcher.launches.load(Ordering::SeqCst);

    let started = sign_in(&f, Some("tui")).await;
    let tab = started.tab.clone().unwrap();
    assert_eq!(tab.title, "Subscription");
    assert_eq!(tab.command_line, "fake-agent auth login");
    let login = f.programs.program(&tab.terminal_id);
    assert_eq!(login.program, "fake-agent");
    assert!(login.env.contains(&("MODE".to_owned(), "login".to_owned())), "the method's env");
    assert!(login.env.contains(&("TOKEN".to_owned(), "s3cret-value".to_owned())), "the launch's, resolved");
    assert!(f.programs.owns("main", &tab.terminal_id), "the calling client's");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), launches, "no agent started for it");
    assert!(f.sessions.sign_in_state(Some(&f.project), "fake").unwrap().pending);
    let joined = f.sessions.sign_in(Some(&f.project), "fake", Some("tui"), f.programs.client("other")).await.unwrap();
    assert_eq!(joined.tab.as_ref(), Some(&tab), "a second call shows the same tab");
    assert!(f.programs.owns("main", &tab.terminal_id), "and runs nothing: it stays its first client's");

    // The login wrote its credentials, then exited 0.
    signed_in.store(true, Ordering::SeqCst);
    f.programs.exit(&tab.terminal_id, Some(0), None);
    assert_eq!(started.end().await, SignInEnd::Done);
    assert_eq!(joined.end().await, SignInEnd::Done);
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(events.texts().join(""), "Hello, world", "the held prompt was answered");
}

#[tokio::test]
async fn a_failed_or_closed_login_keeps_the_prompt_held() {
    let f = fixture("sign-in-terminal-fail", needing_a_terminal_login());
    let events = holding_a_prompt(&f).await;

    let exited = sign_in(&f, Some("cli")).await;
    let tab = exited.tab.clone().unwrap();
    assert_eq!(tab.title, "CLI Login");
    assert_eq!(f.programs.program(&tab.terminal_id).program, "/opt/cli");
    f.programs.exit(&tab.terminal_id, Some(1), None);
    assert_eq!(exited.end().await, SignInEnd::Failed("CLI Login exited with 1".to_owned()));

    let closed = sign_in(&f, Some("cli")).await;
    f.programs.close(&closed.tab.clone().unwrap().terminal_id);
    assert_eq!(closed.end().await, SignInEnd::Cancelled);

    let ended = sign_in(&f, Some("cli")).await;
    f.programs.exit(&ended.tab.clone().unwrap().terminal_id, None, Some("SIGKILL"));
    assert_eq!(ended.end().await, SignInEnd::Failed("CLI Login was ended by SIGKILL".to_owned()));

    let cancelled_login = sign_in(&f, Some("cli")).await;
    let cancelled = f.sessions.cancel_sign_in(Some(&f.project), "fake").unwrap();
    assert_eq!(cancelled.terminal_id, cancelled_login.tab.as_ref().map(|t| t.terminal_id.clone()), "its terminal is the caller's to close");
    assert_eq!(cancelled_login.end().await, SignInEnd::Cancelled);

    assert_still_held(&events).await;
}
