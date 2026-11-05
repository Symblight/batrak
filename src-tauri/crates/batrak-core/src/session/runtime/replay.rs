//! A running agent's conversation, kept for a page that attaches to it later (a reload, another
//! window): the agent's `session/load` replay and each turn since it started, as ACP updates
//! (tool calls without what the page never shows, `keep_shown_fields`), and the permission
//! requests it asked.
//! In memory only, and only while the agent runs, like the page's own copy: a stopped session's
//! history is its agent's replay at the next start (spec: `docs/specs/session-reattach.md`).

use serde_json::{json, Value};

use crate::acp::PromptBlock;

#[derive(Default)]
pub(super) struct ReplayLog {
    updates: Vec<Value>,
    /// The `permission-request`s it asked; the connection says which still wait.
    permissions: Vec<Value>,
}

impl ReplayLog {
    /// An update as the agent sent it; a text chunk continuing the last one of its kind is merged
    /// into it. A context-usage report isn't conversation.
    pub(super) fn push(&mut self, update: &Value) {
        if update["sessionUpdate"] == "usage_update" {
            return;
        }
        if let (Some(text), Some(last)) = (chunk_text(update), self.updates.last_mut()) {
            // A subagent's chunk (`subagentId`) never continues the session's or another's.
            if last["sessionUpdate"] == update["sessionUpdate"] && last.get("subagentId") == update.get("subagentId") {
                if let Some(before) = chunk_text(last) {
                    last["content"]["text"] = Value::String(format!("{before}{text}"));
                    return;
                }
            }
        }
        self.updates.push(update.clone());
    }

    /// A turn's prompt, as the agent got it: the user's message in its replay.
    pub(super) fn push_prompt(&mut self, blocks: &[PromptBlock]) {
        for block in blocks {
            let content = match block {
                PromptBlock::Text(text) => json!({ "type": "text", "text": text }),
                PromptBlock::Mention { name, uri } => json!({ "type": "resource_link", "name": name, "uri": uri }),
                PromptBlock::Selection { uri, text } => json!({ "type": "resource", "resource": { "uri": uri, "text": text } }),
            };
            self.push(&json!({ "sessionUpdate": "user_message_chunk", "content": content }));
        }
    }

    pub(super) fn push_permission(&mut self, request: &Value) {
        self.permissions.push(request.clone());
    }

    pub(super) fn updates(&self) -> &[Value] {
        &self.updates
    }

    /// The requests asked whose id is among `pending`.
    pub(super) fn permissions_in(&self, pending: &[String]) -> Vec<Value> {
        self.permissions.iter().filter(|r| r["requestId"].as_str().is_some_and(|id| pending.iter().any(|p| p == id))).cloned().collect()
    }
}

/// A tool call as the page and this log keep it: what its card shows, and the text of `content`
/// only for the reason of a failure. Diffs, terminal output and raw input and output can be large,
/// and nothing after `note_touched` reads them.
pub(super) fn keep_shown_fields(tool_call: &mut Value) {
    let failed = tool_call["status"] == "failed";
    if let Some(fields) = tool_call.as_object_mut() {
        fields.retain(|key, _| {
            matches!(key.as_str(), "sessionUpdate" | "toolCallId" | "title" | "kind" | "status" | "locations") || (failed && key == "content")
        });
    }
    if let Some(blocks) = tool_call.get_mut("content").and_then(Value::as_array_mut) {
        blocks.retain(|block| block["content"]["type"] == "text");
    }
}

/// The text of a text chunk (agent, user or thought).
fn chunk_text(update: &Value) -> Option<&str> {
    let kind = update["sessionUpdate"].as_str()?;
    if !matches!(kind, "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk") || update["content"]["type"] != "text" {
        return None;
    }
    update["content"]["text"].as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(text: &str, subagent: Option<&str>) -> Value {
        let mut update = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } });
        if let Some(id) = subagent {
            update["subagentId"] = json!(id);
        }
        update
    }

    #[test]
    fn chunks_merge_only_within_one_speaker() {
        // Arrange
        let mut log = ReplayLog::default();
        // Act
        for update in [chunk("Hel", None), chunk("lo", None), chunk("fo", Some("c1")), chunk("und", Some("c1")), chunk("!", None)] {
            log.push(&update);
        }
        // Assert
        let texts: Vec<_> = log.updates().iter().map(|u| (u["subagentId"].as_str(), u["content"]["text"].as_str().unwrap())).collect();
        assert_eq!(texts, [(None, "Hello"), (Some("c1"), "found"), (None, "!")]);
    }

    #[test]
    fn a_tool_update_keeps_what_the_page_shows_and_a_failures_reason() {
        let text = json!([{ "type": "content", "content": { "type": "text", "text": "boom" } }]);
        let mixed = json!([text[0], { "type": "diff", "path": "a.js", "newText": "x" }, { "type": "terminal", "terminalId": "t" }]);
        let full = |status: &str| {
            json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "Run", "kind": "execute", "status": status,
                "locations": [{ "path": "a.js" }], "content": mixed, "rawInput": { "big": 1 }, "rawOutput": { "big": 2 },
                "_meta": { "big": 3 },
            })
        };
        let shown = |status: &str| {
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "Run", "kind": "execute", "status": status, "locations": [{ "path": "a.js" }] })
        };
        let mut failed_shown = shown("failed");
        failed_shown["content"] = text.clone();
        for (status, expected) in [("completed", shown("completed")), ("in_progress", shown("in_progress")), ("failed", failed_shown)] {
            // Arrange
            let mut update = full(status);
            // Act
            keep_shown_fields(&mut update);
            // Assert
            assert_eq!(update, expected, "{status}");
        }
    }
}
