//! A session's subagents as the page gets them: one list (`subagents` event), whatever tells of
//! them. A chat's agent announces and patches them over ACP (`subagent_update`); a CLI-run
//! session's agent keeps records of them, read while its CLI runs (`Agent::subagents`).

use super::*;

/// How often a running CLI's subagents are read from its agent's records.
const CLI_POLL: Duration = Duration::from_secs(3);

/// A subagent as the page shows it (`Subagent` in `hooks/sessions/types.js`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Subagent {
    /// Its ACP session id, or its agent's own id of it.
    id: String,
    title: Option<String>,
    /// What kind it is (`Explore`, `Plan`, …).
    description: Option<String>,
    /// `running`, `requires_action`, `idle` or `unknown`; `None` while not reported.
    state: Option<String>,
    /// `idle`: why (`end_turn`, `cancelled`, `error`, …).
    stop_reason: Option<String>,
    /// The user may stop it (`session_cancel_subagent`).
    cancellable: bool,
    /// ISO time it was first seen or started.
    announced_at: String,
}

/// Folds an ACP `subagent_update` into the list: the first for an id announces it, later ones
/// patch it (an omitted field stays, `null` clears it). `false` when it changed nothing.
pub(super) fn apply_update(list: &mut Vec<Subagent>, update: &Value, now: &str) -> bool {
    let Some(id) = update["sessionId"].as_str() else { return false };
    let known = list.iter().position(|s| s.id == id);
    let index = known.unwrap_or_else(|| {
        list.push(Subagent {
            id: id.to_owned(),
            title: None,
            description: None,
            state: None,
            stop_reason: None,
            cancellable: false,
            announced_at: now.to_owned(),
        });
        list.len() - 1
    });
    let before = list[index].clone();
    let subagent = &mut list[index];
    let text = |value: &Value| value.as_str().map(str::to_owned);
    if let Some(title) = update.get("title") {
        subagent.title = text(title);
    }
    if let Some(description) = update.get("description") {
        subagent.description = text(description);
    }
    if let Some(capabilities) = update.get("capabilities") {
        subagent.cancellable = capabilities.get("cancel").is_some_and(|cancel| !cancel.is_null());
    }
    if let Some(state) = update.get("state") {
        subagent.state = text(&state["state"]);
        subagent.stop_reason = match state.get("stopReason") {
            None | Some(Value::Null) => None,
            Some(Value::String(reason)) => Some(reason.clone()),
            Some(_) => Some("error".to_owned()),
        };
    }
    known.is_none() || *subagent != before
}

/// An agent's records of its subagents as the page's list.
pub(super) fn of_records(records: Vec<agent_api::SubagentRecord>) -> Vec<Subagent> {
    use agent_api::SubagentState;
    records
        .into_iter()
        .map(|record| {
            let (state, stop_reason) = match record.state {
                SubagentState::Running => ("running", None),
                SubagentState::Done => ("idle", Some("end_turn")),
                SubagentState::Stopped => ("idle", Some("cancelled")),
                SubagentState::Unknown => ("unknown", None),
            };
            Subagent {
                id: record.id,
                title: record.title,
                description: record.kind,
                state: Some(state.to_owned()),
                stop_reason: stop_reason.map(str::to_owned),
                cancellable: false,
                announced_at: record.started_at.unwrap_or_default(),
            }
        })
        .collect()
}

impl SessionState {
    /// The `subagents` event with the list as it is now.
    pub(super) fn emit_subagents(&self) {
        let list = lock(&self.subagents).clone();
        self.emit("subagents", json!({ "subagents": list }));
    }

    /// Takes `list` as the session's subagents; the page hears of it only when it changed.
    fn set_subagents(&self, list: Vec<Subagent>) {
        {
            let mut held = lock(&self.subagents);
            if *held == list {
                return;
            }
            *held = list;
        }
        self.emit_subagents();
    }
}

impl Inner {
    /// While the session's CLI runs (until `gone`), reads its subagents from its agent's records.
    pub(super) fn watch_cli_subagents(&self, state: &Arc<SessionState>, agent: Arc<dyn agent_api::Agent>, mut gone: watch::Receiver<bool>) {
        let Some(acp_id) = state.record().acp_session_id else { return };
        let state = Arc::downgrade(state);
        tokio::spawn(async move {
            loop {
                let (agent, id) = (Arc::clone(&agent), acp_id.clone());
                let Ok(records) = tokio::task::spawn_blocking(move || agent.subagents(&id)).await else { return };
                let Some(state) = state.upgrade() else { return };
                state.set_subagents(of_records(records));
                drop(state);
                tokio::select! {
                    _ = tokio::time::sleep(CLI_POLL) => {}
                    _ = gone.wait_for(|gone| *gone) => return,
                }
            }
        });
    }
}
