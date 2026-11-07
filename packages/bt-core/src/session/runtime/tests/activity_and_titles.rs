use super::turns::idle_sessions;
use super::*;

fn listed_ids(sessions: &Sessions) -> Vec<String> {
    sessions.list().into_iter().map(|s| s.id).collect()
}

#[tokio::test]
async fn sessions_are_listed_by_last_activity_which_a_prompt_and_its_turn_end_set() {
    let f = fixture("activity", FakeAgentOptions { resume_session: true, ..listing() });
    let (first, events) = f.create("a", "fake").unwrap();
    events.wait_status("idle").await;
    assert_eq!(first.last_activity_at, first.created_at, "no activity yet: its creation");
    f.sessions.stop("a").await.unwrap();
    let (second, second_events) = f.create("b", "fake").unwrap();
    second_events.wait_status("idle").await;
    f.sessions.stop("b").await.unwrap();
    assert_eq!(listed_ids(&f.sessions), ["b", "a"]);

    // Timestamps have milliseconds: the prompt comes strictly after `b` was created.
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(f.ask("a", &events, "hello").await, "Hello, world");
    assert_eq!(listed_ids(&f.sessions), ["a", "b"]);
    assert!(listed_activity(&f, "a") > second.created_at);
    f.sessions.shutdown();

    // After a restart the order is the agent's: its last activity in each.
    let reopened = f.reopen().await;
    assert_eq!(listed_ids(&reopened), ["a", "b"]);
    assert!(reopened.list()[0].last_activity_at > second.created_at);
}

fn stamp_ms(stamp: &Value) -> i64 {
    parse_iso_millis(stamp.as_str().expect("a stamp")).expect("an ISO stamp")
}

fn listed_activity(f: &Fixture, id: &str) -> String {
    f.sessions.list().into_iter().find(|s| s.id == id).unwrap().last_activity_at
}

#[tokio::test]
async fn a_prompt_and_a_turns_end_carry_the_stamp_touch_wrote_and_so_does_a_failed_turn() {
    let f = fixture("stamps", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["s"]).await;

    let sent = f.sessions.send_prompt("s", text("sleep 100")).unwrap();
    assert_eq!(listed_activity(&f, "s"), sent, "the prompt's stamp is the session's activity");
    let end = events.wait_for("turn-end", |e| e.kind == "turn-end").await;
    assert_eq!(end.payload["at"], listed_activity(&f, "s"), "the end's stamp is the session's activity");
    assert!(stamp_ms(&end.payload["at"]) > parse_iso_millis(&sent).unwrap());

    let failing = fixture("stamps-failed", FakeAgentOptions { fail_new_session: true, ..Default::default() });
    let (_, events) = failing.create("o", "fake").unwrap();
    let sent = failing.sessions.send_prompt("o", text("hello")).unwrap();
    let failed = events.wait_for("turn error", |e| e.kind == "error" && e.payload["turn"] == true).await;
    assert_eq!(failed.payload["at"], listed_activity(&failing, "o"), "a failed turn touches too");
    assert!(stamp_ms(&failed.payload["at"]) >= parse_iso_millis(&sent).unwrap());
}

#[tokio::test]
async fn output_emits_activity_with_a_stamp_at_most_once_per_output_stamp() {
    let mut f = fixture("output-stamp", FakeAgentOptions::default());
    let interval = Duration::from_millis(150);
    f.sessions = Sessions::new(SessionsOptions { output_stamp: interval, ..options_for(&f.dir, &f.launcher) });
    f.give_agents(&f.project);
    let [events] = idle_sessions(&f, ["s"]).await;

    f.sessions.send_prompt("s", text("slow")).unwrap();
    let activity = |events: &Recorder| -> Vec<Envelope> { lock(&events.events).iter().filter(|e| e.kind == "activity").cloned().collect() };
    let started = Instant::now();
    while activity(&events).len() < 3 {
        assert!(started.elapsed() < Duration::from_secs(5), "no third activity in {:#?}", lock(&events.events));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    f.sessions.cancel("s").unwrap();
    events.wait_turn_end().await;

    let stamps: Vec<i64> = activity(&events).iter().map(|e| stamp_ms(&e.payload["at"])).collect();
    let first_chunk = lock(&events.events).iter().position(|e| e.kind == "update").unwrap();
    let first_activity = lock(&events.events).iter().position(|e| e.kind == "activity").unwrap();
    assert!(first_activity.abs_diff(first_chunk) <= 1, "the first output stamps at once");
    let chunks = lock(&events.events).iter().filter(|e| e.kind == "update").count();
    assert!(stamps.len() < chunks, "{} stamps for {chunks} chunks", stamps.len());
    for pair in stamps.windows(2) {
        assert!(pair[1] - pair[0] >= interval.as_millis() as i64 - 1, "stamps {pair:?} are closer than {interval:?}");
    }
}

#[tokio::test]
async fn the_agents_title_replaces_the_prompts_and_comes_from_its_list_after_a_restart() {
    let f = fixture("agent-title", listing());
    let (created, events) = f.create("t", "fake").unwrap();
    assert_eq!((created.title.as_str(), created.title_source), ("Session t", TitleSource::Prompt));
    assert_eq!(f.ask("t", &events, "title Tree view gaps").await, "titled");

    let changed = events.wait_for("session", |e| e.kind == "session" && e.payload["title"] == "Tree view gaps").await;
    assert_eq!(changed.payload["titleSource"], "agent");
    f.sessions.shutdown();

    let listed = f.reopen().await.list();
    assert_eq!((listed[0].title.as_str(), listed[0].title_source), ("Tree view gaps", TitleSource::Agent));
}

#[tokio::test]
async fn after_a_rename_the_agent_no_longer_changes_the_title_until_it_is_reset() {
    let f = fixture("user-title", FakeAgentOptions::default());
    let (_, events) = f.create("t", "fake").unwrap();
    let renamed = f.sessions.rename("t", "Mine").unwrap();
    assert_eq!(renamed.title_source, TitleSource::User);
    assert!(f.sessions.reset_title("t").is_err(), "no agent title to go back to yet");

    f.ask("t", &events, "title Tree view gaps").await;
    let listed = &f.sessions.list()[0];
    assert_eq!((listed.title.as_str(), listed.agent_title.as_deref()), ("Mine", Some("Tree view gaps")));

    let reset = f.sessions.reset_title("t").unwrap();
    assert_eq!((reset.title.as_str(), reset.title_source), ("Tree view gaps", TitleSource::Agent));
}
