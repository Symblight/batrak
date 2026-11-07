use super::turns::idle_sessions;
use super::*;

#[tokio::test]
async fn shutting_down_twice_changes_nothing_the_second_time() {
    let f = fixture("shutdown-twice", FakeAgentOptions::default());
    let [running, _stopped] = idle_sessions(&f, ["running", "stopped"]).await;
    f.sessions.stop("stopped").await.unwrap();
    f.sessions.send_prompt("running", text("sleep 5000")).unwrap();
    running.wait_status("working").await;
    let stored = f.dir.join("data/sessions.json");

    f.sessions.shutdown();
    let first = std::fs::read(&stored).unwrap();
    f.sessions.shutdown();

    assert_eq!(std::fs::read(&stored).unwrap(), first);
    for session in f.sessions.list() {
        assert_eq!(session.status, SessionStatus::Stopped, "{}", session.id);
    }
}

#[tokio::test]
async fn after_a_shutdown_the_app_survives_the_page_hears_stopped_and_sessions_go_on() {
    let f = fixture("survived-shutdown", FakeAgentOptions::default());
    let [idle, working] = idle_sessions(&f, ["idle", "working"]).await;
    f.sessions.send_prompt("working", text("sleep 50")).unwrap();
    working.wait_status("working").await;
    f.sessions.shutdown();
    idle.clear();
    working.clear();

    f.sessions.report_stopped().await;

    idle.wait_status("stopped").await;
    working.wait_status("stopped").await;
    working.wait_turn_end().await;
    assert_eq!(status_of(&f, "working"), SessionStatus::Stopped, "the turn's end doesn't bring back a dead agent");

    assert!(f.sessions.resume("idle").await.unwrap());
    idle.wait_status("idle").await;
    idle.clear();
    f.sessions.send_prompt("idle", text("hello")).unwrap();
    assert_eq!(idle.wait_turn_end().await, "end_turn");
    working.clear();
    f.sessions.send_prompt("working", text("hello")).unwrap();
    assert_eq!(working.wait_turn_end().await, "end_turn", "a next message starts it, as after Stop");
    assert!(!has(&idle, "error") && !has(&working, "error"));
}

#[tokio::test]
async fn with_no_shutdown_there_is_nothing_to_report() {
    let f = fixture("no-shutdown", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["a"]).await;
    events.clear();

    f.sessions.report_stopped().await;

    assert!(!has(&events, "status"), "{:#?}", lock(&events.events));
    assert_eq!(status_of(&f, "a"), SessionStatus::Idle);
    f.sessions.send_prompt("a", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
}
