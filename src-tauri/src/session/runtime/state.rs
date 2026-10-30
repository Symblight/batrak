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
    pub(super) record: Mutex<SessionRecord>,
    pub(super) sinks: Mutex<HashMap<String, Arc<dyn EventSink>>>,
    /// Guarded by `sinks`, so the order of `seq` is the order of sending.
    pub(super) seq: AtomicU64,
    /// Held while starting, so one start runs at a time.
    pub(super) live: tokio::sync::Mutex<Option<Live>>,
    /// For cancel and permission answers, which must not wait for a start in progress.
    pub(super) conn: Mutex<Option<Arc<Connection>>>,
    pub(super) env: Mutex<Option<Arc<dyn SessionEnv>>>,
    /// The start in progress, aborted by Stop (dropping it kills the agent's process group).
    pub(super) starting: Mutex<Option<AbortHandle>>,
    /// Set by Stop for the start in progress: its blocking `prepare` (a checkout) isn't aborted
    /// with the task, so it checks this and undoes its work.
    pub(super) prepare_cancel: Mutex<Option<Arc<AtomicBool>>>,
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
    /// When Brama last saw activity in it (a prompt, a turn's end), in ms: later activity the agent
    /// reports was another app's.
    pub(super) active_here: Mutex<Option<i64>>,
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
    /// When the last turn ended (`None` while one runs): its `touched` still count for a while.
    pub(super) turn_ended: Mutex<Option<Instant>>,
    /// The agent asked for a sign-in at its last start or prompt (the page was sent `sign-in`);
    /// a start that works, or a Stop, clears it (`sign-in: null`).
    pub(super) sign_in: Mutex<Option<SignInNeed>>,
    /// The turn whose prompt waits for that sign-in: `true` sends it, `false` drops it.
    pub(super) held: Mutex<Option<oneshot::Sender<bool>>>,
    /// Its agent's CLI holds it, in a terminal (`cli`): the agent isn't started here meanwhile.
    pub(super) cli: Mutex<Option<CliHeld>>,
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

    pub(super) fn emit(&self, kind: &'static str, payload: Value) {
        let mut sinks = lock(&self.sinks);
        let envelope = Envelope {
            session_id: self.id.clone(),
            seq: self.seq.fetch_add(1, Ordering::SeqCst) + 1,
            kind,
            payload,
        };
        sinks.retain(|_, sink| sink.send(&envelope));
    }
}

pub(super) fn new_state(record: SessionRecord) -> SessionState {
    SessionState {
        in_turn: AtomicBool::new(false),
        active_here: Mutex::new(None),
        listed_activity: Mutex::new(None),
        unconfigured: Mutex::new(None),
        running: Mutex::new(None),
        outdated: AtomicBool::new(false),
        touched: Mutex::default(),
        overlaps: Mutex::default(),
        tool_kinds: Mutex::default(),
        turn_ended: Mutex::default(),
        sign_in: Mutex::default(),
        held: Mutex::default(),
        cli: Mutex::default(),
        id: record.session_id.clone(),
        record: Mutex::new(record),
        sinks: Mutex::default(),
        seq: AtomicU64::new(0),
        live: tokio::sync::Mutex::new(None),
        conn: Mutex::new(None),
        env: Mutex::new(None),
        starting: Mutex::new(None),
        prepare_cancel: Mutex::new(None),
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
