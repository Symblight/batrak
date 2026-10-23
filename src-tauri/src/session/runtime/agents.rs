//! Following agents.json: sessions whose agent left it, was turned off, came back, or now runs differently.

use super::*;

impl Sessions {
    /// The project's agents.json changed: each of its sessions whose agent left it is stopped and
    /// in `error` at once, a running turn finished first; one whose agent is back (or one that
    /// runs the same) is put back as it was, started if it ran.
    pub async fn sync_agents(&self, project: &Path) {
        let states: Vec<_> =
            lock(&self.inner.sessions).values().filter(|s| lock(&s.record).project_path == project).cloned().collect();
        for state in states {
            self.inner.check_agent(&state).await;
        }
    }
}

impl Inner {
    /// Brings one session in line with its project's agents.json (see `Sessions::sync_agents`).
    pub(super) async fn check_agent(self: &Arc<Self>, state: &Arc<SessionState>) {
        let record = state.record();
        // A start checks for itself.
        if matches!(record.status, SessionStatus::Preparing | SessionStatus::Starting) {
            return;
        }
        let merged = self.opts.configs.merged(Some(&record.project_path));
        let found = merged.enabled(&record.agent_id).is_some() || self.follow_agent(state, &record, &merged).is_ok();
        let reported = *lock(&state.unconfigured);
        match (found, reported) {
            (true, Some(was_active)) => {
                lock(&state.unconfigured).take();
                tracing::info!(session = %state.id, "its agent is in agents.json again");
                self.set_status(state, SessionStatus::Stopped, None);
                if was_active {
                    self.start_in_background(state);
                }
            }
            (true, None) if state.conn().is_some() => self.check_launch(state, &merged),
            // A queued turn ends (`cancelled`) without reaching the agent; its end checks again.
            (false, None) if record.status == SessionStatus::Queued => {
                state.cancel_requested.store(true, Ordering::SeqCst);
                self.leave_queue(state);
            }
            // So does a turn holding its prompt for a sign-in.
            (false, None) if lock(&state.held).is_some() => {
                state.cancel_requested.store(true, Ordering::SeqCst);
                self.drop_held(state);
            }
            (false, None) if !state.turn_running.load(Ordering::SeqCst) => {
                let ran = record.launch.as_ref().map(|l| format!("{} {}", l.command, l.args.join(" ")));
                let absence = Absence::of(&merged, &record.agent_id);
                tracing::info!(session = %state.id, agent = %record.agent_id, ?absence, "its agent can't run: stopped");
                self.stop(state).await;
                self.report_unconfigured(state, &record.agent_id, ran.as_deref(), absence, record.status.is_active());
            }
            _ => {}
        }
    }

    /// Tells the page, once, when agents.json now gives the running agent another command, args,
    /// env or MCP servers than it was started with (a Restart picks them up), and again (`null`)
    /// when it's back to those.
    fn check_launch(&self, state: &SessionState, merged: &Merged) {
        let record = state.record();
        let Some(running) = lock(&state.running).clone() else { return };
        let changed = merged.launch(&record.agent_id).is_none_or(|now| LaunchConfig { agent_id: running.agent_id.clone(), ..now } != running);
        if state.outdated.swap(changed, Ordering::SeqCst) == changed {
            return;
        }
        let name = merged.agent(&record.agent_id).map_or(record.agent_id.as_str(), |a| a.name.as_str());
        let message = changed.then(|| format!("agents.json changed what {name} runs. Restart to use it."));
        tracing::info!(session = %state.id, changed, "the running agent's launch in agents.json");
        state.emit("agent-outdated", json!({ "message": message }));
    }

    /// The session's agent isn't in agents.json, or is turned off: `error` with a message that
    /// says so, and an `unconfigured` event (`reason`: `removed` / `off`). Returns the message.
    pub(super) fn report_unconfigured(&self, state: &SessionState, agent_id: &str, ran: Option<&str>, absence: Absence, was_active: bool) -> String {
        let message = absence.message(&self.opts.configs.merged(Some(&state.record().project_path)), agent_id);
        *lock(&state.unconfigured) = Some(was_active);
        self.set_status(state, SessionStatus::Error, Some(&message));
        state.emit("unconfigured", json!({ "agentId": agent_id, "message": message, "ran": ran, "reason": absence.reason() }));
        message
    }

    /// The agent that runs what the session's agent ran, its id gone from agents.json (removed and
    /// added again under another): the session takes it, and the page hears of it.
    pub(super) fn follow_agent(&self, state: &SessionState, record: &SessionRecord, merged: &Merged) -> Result<AgentConfig, StartFailure> {
        // A session from before launches were kept: its log's last start line says what it ran.
        let ran = match &record.launch {
            Some(launch) => Some(format!("{} {}", launch.command, launch.args.join(" "))),
            None => self.logged_launch(&state.id, &record.agent_id),
        };
        let absence = Absence::of(merged, &record.agent_id);
        // Only an agent that left the file is followed: one turned off stays the session's agent.
        let agent = ran
            .as_ref()
            .filter(|_| absence == Absence::Removed)
            .and_then(|ran| merged.agents.iter().filter(|a| merged.enabled(&a.id).is_some()).find(|a| log_line(a) == *ran))
            .ok_or_else(|| StartFailure::Unconfigured { agent_id: record.agent_id.clone(), ran: ran.clone(), absence })?;
        tracing::info!(session = %state.id, from = %record.agent_id, to = %agent.id, "session follows its agent to a new id");
        let session = {
            let mut record = lock(&state.record);
            record.agent_id.clone_from(&agent.id);
            Session::from(&*record)
        };
        self.persist();
        state.emit("session", serde_json::to_value(session).unwrap_or_default());
        Ok(agent.clone())
    }
}

/// Why a session's agent can't run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Absence {
    /// Not in agents.json.
    Removed,
    /// Turned off by the user.
    Off,
}

impl Absence {
    pub(super) fn of(merged: &Merged, agent_id: &str) -> Absence {
        if merged.agent(agent_id).is_some() { Absence::Off } else { Absence::Removed }
    }

    pub(super) fn message(self, merged: &Merged, agent_id: &str) -> String {
        match (self, merged.agent(agent_id)) {
            (Absence::Off, Some(agent)) => format!("{} is off", agent.name),
            _ => format!("Agent \"{agent_id}\" is no longer configured"),
        }
    }

    pub(super) fn reason(self) -> &'static str {
        match self {
            Absence::Removed => "removed",
            Absence::Off => "off",
        }
    }
}
