//! How tool calls reach the page: worded, hidden or turned into the plan by the agent's crate.
use super::*;
use super::turns::idle_sessions;

/// The `update` payloads a turn sent, without the user's own message.
fn shown(updates: impl Iterator<Item = Value>) -> Vec<Value> {
    updates.filter(|u| u["sessionUpdate"] != "user_message_chunk").collect()
}

#[tokio::test]
async fn the_agents_crate_words_hides_and_turns_tool_calls_into_the_plan_for_live_and_attaching_pages() {
    // Arrange
    let f = fixture("tool-calls", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["p"]).await;
    let plan = |entries: &[(&str, &str)]| {
        let entries: Vec<_> = entries.iter().map(|(c, s)| json!({ "content": c, "priority": "medium", "status": s })).collect();
        json!({ "sessionUpdate": "plan", "entries": entries })
    };
    let expected = vec![
        json!({ "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "ls -la", "kind": "execute", "shownLabel": "List files", "shownCommand": "ls -la" }),
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed" }),
        plan(&[("a", "pending"), ("b", "pending")]),
        plan(&[("a", "completed"), ("b", "pending")]),
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "tools done" } }),
    ];
    // Act
    f.sessions.send_prompt("p", text("tools")).unwrap();
    events.wait_turn_end().await;
    let page = attach_page(&f.sessions, "p", "reloaded");
    // Assert
    let live = shown(lock(&events.events).iter().filter(|e| e.kind == "update").map(|e| e.payload.clone()));
    assert_eq!(live, expected, "c2 hidden, c3 and c4 the plan, each once");
    let snapshot = lock(&page.events).iter().find(|e| e.kind == "snapshot").cloned().unwrap();
    assert_eq!(shown(snapshot.payload["updates"].as_array().unwrap().iter().cloned()), expected, "a snapshot replays the same");
}
