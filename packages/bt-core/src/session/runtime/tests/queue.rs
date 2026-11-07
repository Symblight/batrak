use super::turns::idle_sessions;
use super::*;

/// `id` takes the slot for a turn of `ms`.
async fn hold_slot(f: &Fixture, id: &str, events: &Recorder, ms: u32) {
    f.sessions.send_prompt(id, text(&format!("sleep {ms}"))).unwrap();
    events.wait_for("turn-start", |e| e.kind == "turn-start").await;
}

async fn queue_turn(f: &Fixture, id: &str, events: &Recorder, prompt: &str) {
    f.sessions.send_prompt(id, text(prompt)).unwrap();
    events.wait_status("queued").await;
}

#[tokio::test]
async fn local_sessions_of_one_project_all_run_and_their_turns_queue() {
    let f = fixture("slot", FakeAgentOptions::default());
    let [first, second] = idle_sessions(&f, ["first", "second"]).await;

    hold_slot(&f, "first", &first, 300).await;
    f.sessions.send_prompt("second", text("hello")).unwrap();
    let queued = second.wait_for("queued", |e| e.kind == "queued").await;
    assert_eq!(queued.payload["holder"], json!({ "id": "first", "title": "Session first" }));
    second.wait_status("queued").await;
    assert_eq!(status_of(&f, "second"), SessionStatus::Queued);
    let stored = std::fs::read_to_string(f.dir.join("data/sessions.json")).unwrap();
    assert!(!stored.contains("queued"), "no status is kept: {stored}");
    assert!(f.sessions.send_prompt("second", text("hello")).unwrap_err().contains("still working"), "one prompt at a time");
    assert!(!has(&second, "turn-start"), "it waits for the holder");

    assert_eq!(first.wait_turn_end().await, "end_turn");
    assert_eq!(second.wait_turn_end().await, "end_turn");
    assert_eq!(second.texts(), ["Hello", ", world"]);
}

#[tokio::test]
async fn queued_turns_start_in_the_order_they_were_sent() {
    let f = fixture("slot-order", FakeAgentOptions::default());
    let events = Arc::new(Recorder::default());
    for id in ["a", "b", "c"] {
        f.sessions.create(f.request(id, "fake", None), "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    }
    for id in ["a", "b", "c"] {
        events.wait_for("idle", |e| e.session_id == id && e.kind == "status" && e.payload["status"] == "idle").await;
    }
    f.sessions.send_prompt("a", text("sleep 200")).unwrap();
    events.wait_for("a's turn", |e| e.session_id == "a" && e.kind == "turn-start").await;
    for id in ["b", "c"] {
        f.sessions.send_prompt(id, text("sleep 20")).unwrap();
        events.wait_for("queued", |e| e.session_id == id && e.kind == "queued").await;
    }
    events.wait_for("c's turn end", |e| e.session_id == "c" && e.kind == "turn-end").await;
    let all = lock(&events.events).clone();
    let starts: Vec<_> = all.iter().filter(|e| e.kind == "turn-start").map(|e| e.session_id.as_str()).collect();
    assert_eq!(starts, ["a", "b", "c"]);
    let behind: Vec<_> = all.iter().filter(|e| e.session_id == "c" && e.kind == "queued").map(|e| &e.payload["holder"]["id"]).collect();
    assert_eq!(behind, ["a", "b"], "c hears who it waits for");
}

#[tokio::test]
async fn cancelling_a_queued_turn_ends_it_without_reaching_the_agent() {
    let f = fixture("slot-cancel", FakeAgentOptions::default());
    let [first, second] = idle_sessions(&f, ["first", "second"]).await;
    hold_slot(&f, "first", &first, 200).await;
    queue_turn(&f, "second", &second, "hello").await;

    f.sessions.cancel("second").unwrap();
    assert_eq!(second.wait_turn_end().await, "cancelled");
    second.wait_for("idle after it", |e| e.kind == "status" && e.payload["status"] == "idle" && e.seq > 5).await;
    let agent = Arc::clone(&lock(&f.launcher.agents)[1]);
    assert!(lock(&agent.prompts).is_empty());
    assert_eq!(agent.cancel_count.load(Ordering::SeqCst), 0, "nothing to cancel in the agent");
    assert_eq!(first.wait_turn_end().await, "end_turn", "the holder goes on");
    second.clear();
    f.sessions.send_prompt("second", text("hello")).unwrap();
    assert_eq!(second.wait_turn_end().await, "end_turn", "and the slot is free");
}

#[tokio::test]
async fn stopping_or_crashing_the_holder_hands_the_slot_on() {
    let f = fixture("slot-stop", FakeAgentOptions::default());
    let [a, b, c] = idle_sessions(&f, ["a", "b", "c"]).await;
    f.sessions.send_prompt("a", text("slow")).unwrap();
    a.wait_for("first chunk", |e| e.kind == "update").await;
    queue_turn(&f, "b", &b, "crash").await;
    queue_turn(&f, "c", &c, "hello").await;

    f.sessions.stop("a").await.unwrap();
    assert_eq!(a.wait_turn_end().await, "cancelled");
    b.wait_for("b's turn", |e| e.kind == "turn-start").await;
    b.wait_status("error").await;
    assert_eq!(c.wait_turn_end().await, "end_turn", "b's crash freed it too");
}

#[tokio::test]
async fn stopping_or_removing_a_queued_session_drops_its_turn() {
    let f = fixture("slot-leave", FakeAgentOptions::default());
    let [a, b, c, d] = idle_sessions(&f, ["a", "b", "c", "d"]).await;
    hold_slot(&f, "a", &a, 300).await;
    for (id, e) in [("b", &b), ("c", &c), ("d", &d)] {
        queue_turn(&f, id, e, "hello").await;
    }
    f.sessions.stop("b").await.unwrap();
    assert_eq!(b.wait_turn_end().await, "cancelled");
    b.wait_status("stopped").await;
    f.sessions.remove("c").await.unwrap();
    assert_eq!(a.wait_turn_end().await, "end_turn");
    assert_eq!(d.wait_turn_end().await, "end_turn");
    for agent in [1, 2] {
        assert!(lock(&lock(&f.launcher.agents)[agent].prompts).is_empty(), "agent {agent}");
    }
}

#[tokio::test]
async fn a_queued_turn_whose_agent_leaves_agents_json_leaves_the_queue() {
    let f = fixture("slot-unconfigured", FakeAgentOptions::default());
    let [first, second] = idle_sessions(&f, ["first", "second"]).await;
    hold_slot(&f, "first", &first, 300).await;
    queue_turn(&f, "second", &second, "hello").await;

    f.set_agents(&f.project, r#"{"version":1,"agents":{}}"#);
    f.sessions.sync_agents(&f.project).await;
    assert_eq!(second.wait_turn_end().await, "cancelled");
    second.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    assert!(!has(&first, "turn-end"), "the holder's turn goes on");
    assert_eq!(first.wait_turn_end().await, "end_turn");
    assert!(lock(&lock(&f.launcher.agents)[1].prompts).is_empty());
}

/// `second`'s turn runs to its end, never queued, while `first`'s still runs.
async fn runs_beside(f: &Fixture, first: (&str, &Recorder), second: (&str, &Recorder)) {
    hold_slot(f, first.0, first.1, 500).await;
    f.sessions.send_prompt(second.0, text("hello")).unwrap();
    assert_eq!(second.1.wait_turn_end().await, "end_turn");
    assert!(!has(second.1, "queued"));
    assert!(!has(first.1, "turn-end"), "both turns ran at once");
}

#[tokio::test]
async fn a_worktree_session_never_queues_behind_a_local_one() {
    let f = git_fixture("slot-worktree");
    let [local] = idle_sessions(&f, ["local"]).await;
    let (_, tree) = f.create_in("tree", "fake", f.new_workspace(None)).unwrap();
    tree.wait_status("idle").await;
    runs_beside(&f, ("local", &local), ("tree", &tree)).await;
}

#[tokio::test]
async fn with_parallel_local_turns_two_turns_run_at_once() {
    let f = fixture("slot-parallel", FakeAgentOptions::default());
    std::fs::write(f.project.join(".bt/workspace.json"), r#"{"version":1,"localTurns":"parallel"}"#).unwrap();
    let [first, second] = idle_sessions(&f, ["first", "second"]).await;
    runs_beside(&f, ("first", &first), ("second", &second)).await;
}
