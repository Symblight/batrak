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
/// Its diffs become `shownDiff`, the lines they add and remove.
pub(super) fn keep_shown_fields(tool_call: &mut Value) {
    let failed = tool_call["status"] == "failed";
    let diff = shown_diff(&tool_call["content"]);
    if let Some(fields) = tool_call.as_object_mut() {
        fields.retain(|key, _| {
            matches!(key.as_str(), "sessionUpdate" | "toolCallId" | "title" | "kind" | "status" | "locations" | "shownLabel") || (failed && key == "content")
        });
        if let Some(diff) = diff {
            fields.insert("shownDiff".to_owned(), diff);
        }
    }
    if let Some(blocks) = tool_call.get_mut("content").and_then(Value::as_array_mut) {
        blocks.retain(|block| block["content"]["type"] == "text");
    }
}

/// `{ added, removed, created }` of a tool call's `diff` blocks; `None` without one. A block is a
/// whole file before and after (a Write) or one hunk of it with context lines around the change
/// (Claude's Edit); either way the lines are counted by their edit distance (`changed_lines`).
/// `oldText` null is a new file.
fn shown_diff(content: &Value) -> Option<Value> {
    let diffs: Vec<_> = content.as_array()?.iter().filter(|block| block["type"] == "diff").collect();
    if diffs.is_empty() {
        return None;
    }
    let (mut added, mut removed) = (0, 0);
    for diff in &diffs {
        let old: Vec<_> = diff["oldText"].as_str().unwrap_or_default().lines().collect();
        let new: Vec<_> = diff["newText"].as_str().unwrap_or_default().lines().collect();
        let (plus, minus) = changed_lines(&old, &new);
        added += plus;
        removed += minus;
    }
    let created = diffs.iter().any(|diff| diff["oldText"].is_null());
    Some(json!({ "added": added, "removed": removed, "created": created }))
}

/// Past this many changed lines a block counts every line between its first and last change, so a
/// rewritten file costs no more than `MAX_EDITS` passes over it.
const MAX_EDITS: usize = 2000;

/// The lines `new` adds to `old` and removes from it: the shortest edit's inserts and deletes
/// (Myers' greedy algorithm, which needs only its length: inserts − deletes is `new` − `old`).
fn changed_lines(old: &[&str], new: &[&str]) -> (usize, usize) {
    // The lines both share at the start and the end, first: most blocks are only that.
    let head = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let (old, new) = (&old[head..], &new[head..]);
    let tail = old.iter().rev().zip(new.iter().rev()).take_while(|(a, b)| a == b).count();
    let (old, new) = (&old[..old.len() - tail], &new[..new.len() - tail]);
    let (n, m) = (old.len(), new.len());
    let edits = myers_distance(old, new).unwrap_or(n + m);
    // edits = inserts + deletes, inserts - deletes = m - n.
    ((edits + m - n) / 2, (edits + n - m) / 2)
}

/// The length of the shortest edit script from `a` to `b`, or `None` past `MAX_EDITS`.
fn myers_distance(a: &[&str], b: &[&str]) -> Option<usize> {
    let (n, m) = (a.len(), b.len());
    let max = (n + m).min(MAX_EDITS);
    // v[k + offset]: the furthest x on diagonal k = x - y.
    let offset = max + 1;
    let mut v = vec![0usize; 2 * max + 3];
    for d in 0..=max {
        for k in (0..=2 * d).map(|i| i as isize - d as isize).step_by(2) {
            let at = |k: isize| (k + offset as isize) as usize;
            let mut x = if k == -(d as isize) || (k != d as isize && v[at(k - 1)] < v[at(k + 1)]) { v[at(k + 1)] } else { v[at(k - 1)] + 1 };
            let mut y = (x as isize - k) as usize;
            while x < n && y < m && a[x] == b[y] {
                x += 1;
                y += 1;
            }
            v[at(k)] = x;
            if x >= n && y >= m {
                return Some(d);
            }
        }
    }
    None
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

    /// A 1000-line file, lines 3 and 900 replaced by `changed`.
    fn far_apart(changed: Option<(&str, &str)>) -> String {
        let line = |i: usize| match (i, changed) {
            (3, Some((third, _))) => third.to_owned(),
            (900, Some((_, nine_hundredth))) => nine_hundredth.to_owned(),
            _ => format!("line {i}"),
        };
        (1..=1000).map(line).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn a_tool_updates_diffs_become_the_lines_it_added_and_removed() {
        let diff = |old: Value, new: &str| json!({ "type": "diff", "path": "a.rs", "oldText": old, "newText": new });
        let cases = [
            // A hunk with context on both sides: only the changed lines count.
            (vec![diff(json!("a\nb\nc\nd"), "a\nB\nB2\nd")], Some(json!({ "added": 2, "removed": 2, "created": false }))),
            (vec![diff(json!("a\nb"), "a\nb\nc"), diff(json!("x\ny"), "y")], Some(json!({ "added": 1, "removed": 1, "created": false }))),
            (vec![diff(Value::Null, "one\ntwo\n")], Some(json!({ "added": 2, "removed": 0, "created": true }))),
            // A whole file before and after (a Write, an Edit with `replace_all`), changed far apart.
            (vec![diff(json!(far_apart(None)), &far_apart(Some(("line 3!", "line 900!"))))], Some(json!({ "added": 2, "removed": 2, "created": false }))),
            (vec![diff(json!("a\nb\nc"), "a\nx\nb\nc\ny")], Some(json!({ "added": 2, "removed": 0, "created": false }))),
            (vec![json!({ "type": "content", "content": { "type": "text", "text": "hi" } })], None),
        ];
        for (content, expected) in cases {
            // Arrange
            let mut update = json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "content": content });
            // Act
            keep_shown_fields(&mut update);
            // Assert
            assert_eq!(update.get("shownDiff"), expected.as_ref(), "{content:?}");
            assert_eq!(update.get("content"), None);
        }
    }

    #[test]
    fn a_tool_update_keeps_what_the_page_shows_and_a_failures_reason() {
        let text = json!([{ "type": "content", "content": { "type": "text", "text": "boom" } }]);
        let mixed = json!([text[0], { "type": "diff", "path": "a.js", "newText": "x" }, { "type": "terminal", "terminalId": "t" }]);
        let full = |status: &str| {
            json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "Run", "kind": "execute", "status": status,
                "locations": [{ "path": "a.js" }], "shownLabel": "Run it", "content": mixed, "rawInput": { "big": 1 }, "rawOutput": { "big": 2 },
                "_meta": { "big": 3 },
            })
        };
        let shown = |status: &str| {
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "Run", "kind": "execute", "status": status, "locations": [{ "path": "a.js" }], "shownLabel": "Run it", "shownDiff": { "added": 1, "removed": 0, "created": true } })
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
