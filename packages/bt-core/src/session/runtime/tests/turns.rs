use super::*;

/// Sessions of these ids, their agents started and idle, each with its events.
pub(super) async fn idle_sessions<const N: usize>(f: &Fixture, ids: [&str; N]) -> [Arc<Recorder>; N] {
    let mut all = Vec::new();
    for id in ids {
        let (_, events) = f.create(id, "fake").unwrap();
        events.wait_status("idle").await;
        all.push(events);
    }
    all.try_into().unwrap()
}

#[tokio::test]
async fn a_new_session_tells_the_page_its_acp_id_once_its_agent_is_ready() {
    let f = fixture("acp-id", FakeAgentOptions::default());
    let (session, events) = f.create("s1", "fake").unwrap();
    assert_eq!(session.acp_session_id, None);
    let told = events.wait_for("the session with its ACP id", |e| e.kind == "session" && e.payload["acpSessionId"].is_string()).await;
    assert_eq!(told.payload["status"], "idle");
}

#[tokio::test]
async fn a_turn_streams_updates_in_order_between_turn_start_and_turn_end() {
    let f = fixture("turn", FakeAgentOptions::default());
    let (session, events) = f.create("s1", "fake").unwrap();
    assert_eq!(session.status, SessionStatus::Preparing);
    events.wait_status("starting").await;
    events.wait_status("idle").await;
    assert_eq!(listed_version(&f, "fake").as_deref(), Some("1.2.3"), "a start keeps the agent's version");

    f.sessions.send_prompt("s1", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    events.wait_for("idle after the turn", |e| e.kind == "status" && e.payload["status"] == "idle" && e.seq > 4).await;

    let all = lock(&events.events).clone();
    let kinds: Vec<_> = all.iter().map(|e| e.kind).collect();
    let start = kinds.iter().position(|k| *k == "turn-start").unwrap();
    let end = kinds.iter().position(|k| *k == "turn-end").unwrap();
    assert!(start < end);
    assert_eq!(events.texts(), ["Hello", ", world"]);
    assert!(all.windows(2).all(|w| w[0].seq < w[1].seq), "seq is monotonic");
    assert!(all.iter().all(|e| e.session_id == "s1"));

    // The agent got the login env without git redirects, plus its resolved secret.
    let env: HashMap<_, _> = lock(&f.launcher.env).iter().cloned().collect();
    assert_eq!(env.get("TOKEN").map(String::as_str), Some("s3cret-value"));
    assert!(!env.contains_key("GIT_INDEX_FILE"));
    // …and the secret went nowhere else.
    let stored = std::fs::read_to_string(f.dir.join("data/sessions.json")).unwrap();
    let log = std::fs::read_to_string(f.sessions.log_path("s1").unwrap()).unwrap_or_default();
    let sent = serde_json::to_string(&all).unwrap();
    for place in [&stored, &log, &sent] {
        assert!(!place.contains("s3cret-value"));
    }
}

#[tokio::test]
async fn a_second_prompt_during_a_turn_is_refused_and_cancel_or_stop_ends_it_as_cancelled() {
    let f = fixture("busy", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["b"]).await;
    f.sessions.send_prompt("b", text("slow")).unwrap();
    assert!(f.sessions.send_prompt("b", text("hello")).unwrap_err().contains("still working"));
    events.wait_for("first chunk", |e| e.kind == "update").await;
    f.sessions.cancel("b").unwrap();
    assert_eq!(events.wait_turn_end().await, "cancelled");

    events.clear();
    f.sessions.send_prompt("b", text("slow")).unwrap();
    events.wait_for("first chunk", |e| e.kind == "update").await;
    f.sessions.stop("b").await.unwrap();
    assert_eq!(events.wait_turn_end().await, "cancelled");
    events.wait_status("stopped").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!has(&events, "error"), "a requested stop is no error");
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Stopped);
}

#[tokio::test]
async fn a_missing_secret_fails_the_start_naming_the_variable() {
    let f = fixture("secret", FakeAgentOptions::default());
    let (_, events) = f.create("x", "locked").unwrap();
    let status = events.wait_status("error").await;
    assert_eq!(status.payload["message"], "Locked: env KEY: no keychain item \"missing\"");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn unknown_agents_are_refused() {
    let f = fixture("refuse", FakeAgentOptions::default());
    assert!(f.create("u", "nope").unwrap_err().contains("Unknown agent"));
}
