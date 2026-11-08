//! One session's in-memory state: its record, event sinks, connection and turn bookkeeping.

use super::*;

/// A started agent of a session.
pub(super) struct Live {
    pub(super) conn: Arc<Connection>,
    pub(super) process: Option<AgentProcess>,
    /// Matches `SessionState::generation` at start; a watcher for an older start does nothing.
    pub(super) generation: u64,
}

pub(super) struct SessionState {
    pub(super) id: String,
    /// Its agent's crate, from its last start: what its modes mean (`emit_options`).
    pub(super) agent: Mutex<Option<Arc<dyn agent_api::Agent>>>,
    pub(super) record: Mutex<SessionRecord>,
    pub(super) sinks: Mutex<HashMap<String, Arc<dyn EventSink>>>,
    /// Guarded by `sinks`, so the order of `seq` is the order of sending.
    pub(super) seq: AtomicU64,
    /// The running agent's conversation (`replay`), written under `sinks` in `seq` order; `None`
    /// while no agent runs.
    pub(super) replay: Mutex<Option<replay::ReplayLog>>,
    /// Held while starting, so one start runs at a time.
    pub(super) live: tokio::sync::Mutex<Option<Live>>,
    /// For cancel and permission answers, which must not wait for a start in progress.
    pub(super) conn: Mutex<Option<Arc<Connection>>>,
    pub(super) env: Mutex<Option<Arc<dyn SessionEnv>>>,
    /// The start in progress, aborted by Stop (dropping it kills the agent's process group).
    pub(super) starting: Mutex<Option<AbortHandle>>,
    /// Starts attempted so far. A caller notes it before waiting for a start in progress; when that
    /// start failed, the caller fails with it (`start_error`) instead of starting again.
    pub(super) start_attempts: AtomicU64,
    pub(super) start_error: Mutex<Option<StartError>>,
    pub(super) generation: AtomicU64,
    /// A turn is running, its startup included. The git layer will gate mutations on it.
    pub(super) turn_running: AtomicBool,
    pub(super) cancel_requested: AtomicBool,
    /// Stop was asked for: the agent going away is not an error.
    pub(super) stopping: AtomicBool,
    /// Between `turn-start` and the turn's end.
    pub(super) in_turn: AtomicBool,
    /// When Batrak last saw activity in it (a prompt, a turn's end), in ms: later activity the agent
    /// reports was another app's.
    pub(super) active_here: Mutex<Option<i64>>,
    /// When its output was last stamped (`activity`), to stamp it at most once per `output_stamp`.
    pub(super) output_stamped: Mutex<Option<Instant>>,
    /// The last activity its agent listed (`updatedAt`), in ms.
    pub(super) listed_activity: Mutex<Option<i64>>,
    /// agents.json no longer has the session's agent (reported, status `error`); `Some(true)`: it
    /// was running or asked to start, so it starts again once the agent is back.
    pub(super) unconfigured: Mutex<Option<bool>>,
    /// What the running agent was started with, and whether the page was told agents.json now
    /// says otherwise (`agent-outdated`).
    pub(super) running: Mutex<Option<LaunchConfig>>,
    pub(super) outdated: AtomicBool,
    /// Files the running turn's tool calls changed (host paths: diffs, and locations of calls that
    /// don't only look), and those of them it was told another running turn changed too
    /// (`overlap`). Cleared at turn start, with the kinds of its tool calls by id.
    pub(super) touched: Mutex<HashSet<PathBuf>>,
    pub(super) overlaps: Mutex<HashSet<PathBuf>>,
    pub(super) tool_kinds: Mutex<HashMap<String, String>>,
    /// Tool calls its agent's crate hid or turned into the plan (`shown_tool_call`): their later
    /// updates aren't shown. And the plan they made, which the next one starts from. Both for the
    /// running agent's conversation (`start_replay`).
    pub(super) settled_tools: Mutex<HashSet<String>>,
    /// Plan tools whose input hasn't come yet (`Plan(None)`): their updates aren't shown meanwhile.
    pub(super) planning_tools: Mutex<HashSet<String>>,
    pub(super) plan: Mutex<Vec<agent_api::PlanEntry>>,
    /// When the last turn ended (`None` while one runs): its `touched` still count for a while.
    pub(super) turn_ended: Mutex<Option<Instant>>,
    /// The agent asked for a sign-in at its last start or prompt (the page was sent `sign-in`);
    /// a start that works, or a Stop, clears it (`sign-in: null`).
    pub(super) sign_in: Mutex<Option<SignInNeed>>,
    /// The turn whose prompt waits for that sign-in: `true` sends it, `false` drops it.
    pub(super) held: Mutex<Option<oneshot::Sender<bool>>>,
    /// Its agent's CLI holds it, in a terminal (`cli`): the agent isn't started here meanwhile.
    pub(super) cli: Mutex<Option<CliHeld>>,
    /// Its subagents as the page last heard of them (`subagents` event; `subagents.rs`).
    pub(super) subagents: Mutex<Vec<subagents::Subagent>>,
}

impl SessionState {
    /// The session as the page gets it (`sync::listed`): every `Session` sent goes through here.
    pub(super) fn page(&self) -> Session {
        sync::listed(self)
    }

    pub(super) fn record(&self) -> SessionRecord {
        lock(&self.record).clone()
    }

    pub(super) fn status(&self) -> SessionStatus {
        lock(&self.record).status
    }

    pub(super) fn conn(&self) -> Option<Arc<Connection>> {
        lock(&self.conn).clone()
    }

    /// The agent's config options to the page (`config-options`), its modes tagged with their risk
    /// by its crate (`agents::tag_modes`).
    pub(super) fn emit_options(&self, options: Vec<Value>) {
        let agent = lock(&self.agent).clone();
        let options = match agent {
            Some(agent) => crate::agents::tag_modes(&*agent, options),
            None => options,
        };
        self.emit("config-options", serde_json::json!({ "configOptions": options }));
    }

    pub(super) fn emit(&self, kind: &'static str, payload: Value) {
        let mut sinks = lock(&self.sinks);
        if let Some(log) = lock(&self.replay).as_mut() {
            match kind {
                "update" => log.push(&payload),
                "permission-request" => log.push_permission(&payload),
                _ => {}
            }
        }
        let envelope = self.envelope(kind, payload);
        sinks.retain(|_, sink| sink.send(&envelope));
    }

    /// Takes `sink` as `key`'s; while an agent runs, it first gets the conversation so far
    /// (`snapshot`) and the permission requests still waiting, in `seq` order with the events
    /// around it.
    pub(super) fn add_sink(&self, key: &str, sink: Arc<dyn EventSink>) {
        let mut sinks = lock(&self.sinks);
        let pending = self.conn().map(|conn| conn.pending_permissions()).unwrap_or_default();
        let replay = lock(&self.replay).as_ref().map(|log| (log.updates().to_vec(), log.permissions_in(&pending)));
        // Its subagents first: the snapshot's cards name them.
        let subagents = lock(&self.subagents).clone();
        if !subagents.is_empty() && !sink.send(&self.envelope("subagents", serde_json::json!({ "subagents": subagents }))) {
            return;
        }
        if let Some((updates, permissions)) = replay {
            let events = std::iter::once(("snapshot", serde_json::json!({ "updates": updates })))
                .chain(permissions.into_iter().map(|request| ("permission-request", request)));
            for (kind, payload) in events {
                if !sink.send(&self.envelope(kind, payload)) {
                    return;
                }
            }
        }
        sinks.insert(key.to_owned(), sink);
    }

    /// A new agent's conversation starts: its `session/load` replay comes first.
    pub(super) fn start_replay(&self) {
        *lock(&self.replay) = Some(replay::ReplayLog::default());
        lock(&self.settled_tools).clear();
        lock(&self.planning_tools).clear();
        lock(&self.plan).clear();
    }

    /// The turn's prompt, as the agent gets it.
    pub(super) fn replay_prompt(&self, blocks: &[PromptBlock]) {
        let _sinks = lock(&self.sinks);
        if let Some(log) = lock(&self.replay).as_mut() {
            log.push_prompt(blocks);
        }
    }

    /// The agent is gone: its conversation is its next start's replay.
    pub(super) fn end_replay(&self) {
        lock(&self.replay).take();
    }

    /// Call with `sinks` held.
    fn envelope(&self, kind: &'static str, payload: Value) -> Envelope {
        Envelope { session_id: self.id.clone(), seq: self.seq.fetch_add(1, Ordering::SeqCst) + 1, kind, payload }
    }
}

pub(super) fn new_state(record: SessionRecord) -> SessionState {
    SessionState {
        in_turn: AtomicBool::new(false),
        active_here: Mutex::new(None),
        listed_activity: Mutex::new(None),
        output_stamped: Mutex::new(None),
        unconfigured: Mutex::new(None),
        running: Mutex::new(None),
        outdated: AtomicBool::new(false),
        touched: Mutex::default(),
        overlaps: Mutex::default(),
        tool_kinds: Mutex::default(),
        settled_tools: Mutex::default(),
        planning_tools: Mutex::default(),
        plan: Mutex::default(),
        turn_ended: Mutex::default(),
        sign_in: Mutex::default(),
        held: Mutex::default(),
        cli: Mutex::default(),
        subagents: Mutex::default(),
        agent: Mutex::default(),
        id: record.session_id.clone(),
        record: Mutex::new(record),
        sinks: Mutex::default(),
        seq: AtomicU64::new(0),
        replay: Mutex::new(None),
        live: tokio::sync::Mutex::new(None),
        conn: Mutex::new(None),
        env: Mutex::new(None),
        starting: Mutex::new(None),
        start_attempts: AtomicU64::new(0),
        start_error: Mutex::new(None),
        generation: AtomicU64::new(0),
        turn_running: AtomicBool::new(false),
        cancel_requested: AtomicBool::new(false),
        stopping: AtomicBool::new(false),
    }
}

/// A session's turn slot held for git work; released on drop.
pub(super) struct SlotGuard(pub(super) Arc<SessionState>);

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.0.turn_running.store(false, Ordering::SeqCst);
    }
}
