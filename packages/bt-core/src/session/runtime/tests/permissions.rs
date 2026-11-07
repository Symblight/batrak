use super::turns::idle_sessions;
use super::*;

#[tokio::test]
async fn permission_allow_then_cancel_with_a_pending_one() {
    let f = fixture("permission", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["p"]).await;

    f.sessions.send_prompt("p", text("permission")).unwrap();
    let request = events.wait_for("permission request", |e| e.kind == "permission-request").await;
    events.wait_status("waiting").await;
    assert_eq!(request.payload["options"][1]["optionId"], "deny");
    let id = request.payload["requestId"].as_str().unwrap().to_owned();
    f.sessions.respond_permission("p", &id, Some("allow".to_owned())).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(events.texts(), ["chose allow"]);

    events.clear();
    f.sessions.send_prompt("p", text("permission")).unwrap();
    events.wait_for("permission request", |e| e.kind == "permission-request").await;
    f.sessions.cancel("p").unwrap();
    assert_eq!(events.wait_turn_end().await, "cancelled");
    assert_eq!(lock(&f.launcher.agents)[0].cancel_count.load(Ordering::SeqCst), 1);
    events.clear();
    f.sessions.send_prompt("p", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn", "the next turn runs");
}

/// The `update` events' (subagentId, sessionUpdate), `-` for the session's own.
fn tagged_updates<'a>(updates: impl Iterator<Item = &'a Value>) -> Vec<(String, String)> {
    updates
        .map(|u| (u["subagentId"].as_str().unwrap_or("-").to_owned(), u["sessionUpdate"].as_str().unwrap_or_default().to_owned()))
        .collect()
}

/// The `subagents` events' lists, in order.
fn subagent_lists(events: &Recorder) -> Vec<Value> {
    lock(&events.events).iter().filter(|e| e.kind == "subagents").map(|e| e.payload["subagents"].clone()).collect()
}

#[tokio::test]
async fn a_subagents_updates_request_and_list_reach_live_and_attaching_pages_tagged_with_it() {
    let f = fixture("subagent", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["p"]).await;
    f.sessions.send_prompt("p", text("subagent")).unwrap();
    let request = events.wait_for("permission request", |e| e.kind == "permission-request").await;
    let page = attach_page(&f.sessions, "p", "reloaded");

    assert_eq!(request.payload["subagentId"], "child-1");
    let expected = [pair("-", "subagent_update"), pair("child-1", "session_info_update"), pair("child-1", "tool_call"), pair("child-1", "agent_message_chunk")];
    let live: Vec<Value> = lock(&events.events).iter().filter(|e| e.kind == "update").map(|e| e.payload.clone()).collect();
    assert_eq!(tagged_updates(live.iter()), expected);
    let snapshot = lock(&page.events).iter().find(|e| e.kind == "snapshot").cloned().unwrap();
    assert_eq!(tagged_updates(snapshot.payload["updates"].as_array().unwrap().iter().filter(|u| u["sessionUpdate"] != "user_message_chunk")), expected);
    assert_ne!(f.sessions.get("p").unwrap().record().title, "child title", "a subagent's title isn't the chat's");
    assert_eq!(lock(&page.events)[0].kind, "subagents", "an attaching page gets them before the snapshot");

    let id = request.payload["requestId"].as_str().unwrap();
    f.sessions.respond_permission("p", id, Some("allow".to_owned())).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");

    let order: Vec<&str> = lock(&events.events)
        .iter()
        .filter(|e| e.kind == "subagents" || (e.kind == "update" && e.payload["sessionUpdate"] == "subagent_update"))
        .map(|e| e.kind)
        .collect();
    assert_eq!(order, ["subagents", "update", "subagents", "update"], "each list before its update");
    let lists = subagent_lists(&events);
    let mut first = lists[0][0].clone();
    assert!(first["announcedAt"].as_str().is_some_and(|at| !at.is_empty()));
    first["announcedAt"] = json!("");
    assert_eq!(first, json!({ "id": "child-1", "title": "find usages", "description": "Explore", "state": "running", "stopReason": null, "cancellable": true, "announcedAt": "" }));
    assert_eq!((&lists[1][0]["state"], &lists[1][0]["stopReason"], &lists[1][0]["cancellable"]), (&json!("idle"), &json!("end_turn"), &json!(true)), "patched, not replaced");
}

#[tokio::test]
async fn a_cli_run_chats_running_subagents_reach_the_page_from_its_agents_records_as_its_cli_shows_them() {
    let f = fixture("subagent-cli", FakeAgentOptions::default());
    f.give_cli_agents();
    let (acp, events) = f.started_then_stopped("s1", "fake").await;
    f.sessions.open_cli("s1", None, f.programs.client("main"), None).await.unwrap();
    events.wait_for("subagents", |e| e.kind == "subagents").await;
    assert_eq!(
        subagent_lists(&events)[0],
        json!([
            { "id": "running", "title": format!("running of {acp}"), "description": "Explore", "state": "running", "stopReason": null, "cancellable": false, "announcedAt": "2026-11-03T10:00:00Z" },
        ]),
        "done, stopped and stale ones are gone from its CLI too"
    );
}

#[tokio::test]
async fn cancelling_a_subagent_answers_its_request_and_the_turn_goes_on() {
    let f = fixture("subagent-cancel", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["p"]).await;
    f.sessions.send_prompt("p", text("subagent")).unwrap();
    events.wait_status("waiting").await;
    f.sessions.cancel_subagent("p", "child-1").unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(*lock(&lock(&f.launcher.agents)[0].cancelled_sessions), ["child-1"]);
    assert!(events.texts().contains(&"child cancelled".to_owned()));
    assert!(f.sessions.cancel_subagent("p", "child-9").is_err());
}

#[tokio::test]
async fn a_page_attaching_while_a_permission_waits_is_asked_it_again_until_it_is_answered() {
    let f = fixture("permission-attach", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["p"]).await;
    f.sessions.send_prompt("p", text("permission")).unwrap();
    let asked = events.wait_for("permission request", |e| e.kind == "permission-request").await;

    let page = attach_page(&f.sessions, "p", "reloaded");

    let kinds: Vec<_> = lock(&page.events).iter().map(|e| e.kind).collect();
    assert_eq!(kinds, ["snapshot", "permission-request", "status"]);
    assert_eq!(lock(&page.events)[1].payload, asked.payload);

    let id = asked.payload["requestId"].as_str().unwrap();
    f.sessions.respond_permission("p", id, Some("allow".to_owned())).unwrap();
    events.wait_turn_end().await;
    let later = attach_page(&f.sessions, "p", "later");
    assert!(!has(&later, "permission-request"), "answered: not asked again");
}
