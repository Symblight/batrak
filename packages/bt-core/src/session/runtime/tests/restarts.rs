use super::turns::idle_sessions;
use super::*;

/// The app closed and launched again, a page open on session `id`.
async fn reopened_with_page(f: &Fixture, id: &str) -> (Sessions, Arc<Recorder>) {
    f.sessions.shutdown();
    let reopened = f.reopen().await;
    let events = attach_page(&reopened, id, "main");
    (reopened, events)
}

#[tokio::test]
async fn a_crash_mid_turn_is_an_error_and_restart_brings_the_agent_back() {
    let f = fixture("crash", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["c"]).await;
    f.sessions.send_prompt("c", text("crash")).unwrap();
    events.wait_for("turn error", |e| e.kind == "error" && e.payload["turn"] == true).await;
    let status = events.wait_status("error").await;
    assert!(status.payload["message"].as_str().unwrap().starts_with("The agent stopped"));
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Error);
    assert_eq!(events.texts(), ["about to crash"], "the transcript so far was delivered");

    events.clear();
    f.sessions.restart("c").await.unwrap();
    events.wait_status("idle").await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 2);
    f.sessions.send_prompt("c", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
}

#[tokio::test]
async fn resume_starts_a_stopped_agent_once_without_reporting_it_stopped() {
    let f = fixture("resume", FakeAgentOptions { load_session: true, ..Default::default() });
    let [events] = idle_sessions(&f, ["r"]).await;
    f.sessions.stop("r").await.unwrap();
    events.wait_status("stopped").await;

    events.clear();
    assert!(f.sessions.resume("r").await.unwrap());
    assert!(f.sessions.resume("r").await.unwrap(), "a second resume while it starts is a no-op");
    events.wait_status("idle").await;
    assert!(f.sessions.resume("r").await.unwrap(), "a running agent stays as it is");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 2);
    let agent = Arc::clone(&lock(&f.launcher.agents)[1]);
    assert_eq!(agent.loads.load(Ordering::SeqCst), 1, "it continues its ACP session");
    let events = lock(&events.events).clone();
    assert!(!events.iter().any(|e| e.kind == "error" || (e.kind == "status" && e.payload["status"] == "stopped")), "{events:#?}");
}

#[tokio::test]
async fn a_page_attaching_to_a_running_session_gets_its_history_before_its_status() {
    let f = fixture("snapshot", FakeAgentOptions { load_session: true, ..Default::default() });
    let [events] = idle_sessions(&f, ["s"]).await;
    f.sessions.stop("s").await.unwrap();
    f.sessions.resume("s").await.unwrap();
    events.wait_status("idle").await;
    f.ask("s", &events, "hello").await;

    let page = attach_page(&f.sessions, "s", "reloaded");

    let got = lock(&page.events).clone();
    assert_eq!((got[0].kind, got[1].kind), ("snapshot", "status"), "{got:#?}");
    assert_eq!(
        snapshot_messages(&got[0]),
        [
            pair("user_message_chunk", "earlier question"),
            pair("agent_message_chunk", "earlier answer"),
            pair("user_message_chunk", "hello"),
            pair("agent_message_chunk", "Hello, world"),
        ],
        "the agent's replay, then the turn: its prompt and its reply's chunks merged"
    );
    assert!(lock(&events.events).iter().all(|e| e.kind != "snapshot"), "only the attaching page gets it");
}

#[tokio::test]
async fn a_page_attaching_mid_turn_gets_the_reply_so_far_then_the_rest() {
    let f = fixture("snapshot-turn", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["t"]).await;
    f.sessions.send_prompt("t", text("slow")).unwrap();
    events.wait_for("a few chunks", |e| e.payload["content"]["text"] == "3 ").await;

    let page = attach_page(&f.sessions, "t", "reloaded");
    page.wait_for("more chunks", |e| e.kind == "update").await;
    f.sessions.cancel("t").unwrap();
    page.wait_turn_end().await;

    let snapshot = page.wait_for("snapshot", |e| e.kind == "snapshot").await;
    let messages = snapshot_messages(&snapshot);
    assert_eq!(messages[0], pair("user_message_chunk", "slow"));
    let so_far = &messages[1].1;
    assert_eq!(format!("{so_far}{}", page.texts().join("")), events.texts().join(""), "nothing lost or repeated");
}

#[tokio::test]
async fn a_page_attaching_to_a_stopped_or_crashed_session_gets_no_snapshot() {
    let f = fixture("snapshot-stopped", FakeAgentOptions::default());
    let [a, b] = idle_sessions(&f, ["a", "b"]).await;
    f.ask("a", &a, "hello").await;
    f.sessions.stop("a").await.unwrap();
    f.sessions.send_prompt("b", text("crash")).unwrap();
    b.wait_status("error").await;

    for id in ["a", "b"] {
        let page = attach_page(&f.sessions, id, "reloaded");
        assert!(!has(&page, "snapshot"), "{id}: its agent's next start replays it");
    }
}

#[tokio::test]
async fn sessions_come_back_after_a_restart_and_load_their_acp_session() {
    let f = fixture("reload", FakeAgentOptions { load_session: true, ..listing() });
    let _ = idle_sessions(&f, ["r"]).await;

    let (reopened, events) = reopened_with_page(&f, "r").await;
    let listed = reopened.list();
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0].id.as_str(), listed[0].status), ("r", SessionStatus::Stopped));
    reopened.send_prompt("r", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    let agent = Arc::clone(lock(&f.launcher.agents).last().unwrap());
    assert_eq!(agent.loads.load(Ordering::SeqCst), 1, "session/load was used");
    assert_eq!(events.texts(), ["earlier question", "earlier answer", "Hello", ", world"]);
    let idle = events.wait_status("idle").await;
    assert!(idle.payload["message"].is_null(), "history restored: no banner");
    reopened.shutdown();
}

#[tokio::test]
async fn without_load_support_a_reopened_session_says_history_was_not_restored() {
    let f = fixture("noload", listing());
    let _ = idle_sessions(&f, ["n"]).await;

    let (reopened, events) = reopened_with_page(&f, "n").await;
    reopened.send_prompt("n", text("hello")).unwrap();
    let idle = events.wait_status("idle").await;
    assert_eq!(idle.payload["message"], "Agent history not restored");
    assert_eq!(events.wait_turn_end().await, "end_turn");
    reopened.shutdown();
}

#[tokio::test]
async fn resuming_without_load_continues_the_agents_session() {
    let f = fixture("resume-only", FakeAgentOptions { resume_session: true, ..listing() });
    let _ = idle_sessions(&f, ["r"]).await;

    let (reopened, events) = reopened_with_page(&f, "r").await;
    assert!(reopened.resume("r").await.unwrap());
    let idle = events.wait_status("idle").await;
    assert_eq!(idle.payload["message"], "The agent continues this session but doesn't give its history");
    let agent = Arc::clone(lock(&f.launcher.agents).last().unwrap());
    assert_eq!((agent.resumes.load(Ordering::SeqCst), agent.new_sessions.load(Ordering::SeqCst)), (1, 0));
    reopened.shutdown();
}

#[tokio::test]
async fn a_renamed_session_keeps_its_title_after_a_restart() {
    let f = fixture("rename", listing());
    let _ = idle_sessions(&f, ["n"]).await;

    let renamed = f.sessions.rename("n", "  Fix the parser \n").unwrap();
    assert_eq!(renamed.title, "Fix the parser", "trimmed");
    assert_eq!(f.sessions.list()[0].title, "Fix the parser");
    assert!(f.sessions.rename("n", "   ").is_err(), "an empty title is refused");
    assert!(f.sessions.rename("missing", "x").is_err());

    f.sessions.shutdown();
    let reopened = f.reopen().await;
    assert_eq!(reopened.list()[0].title, "Fix the parser");
}
