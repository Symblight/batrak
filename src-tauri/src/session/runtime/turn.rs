//! Turns: prompts, the local turn slot, cancel, permissions and overlapping edits.

use super::*;

impl Sessions {
    /// Starts a turn and returns once it's accepted; it runs in the background, its updates and
    /// `turn-end` arrive as events. Starts the agent first if needed. Returns the stamp the
    /// prompt gave the session's activity.
    pub fn send_prompt(&self, id: &str, prompt: Vec<PromptInput>) -> Result<String, String> {
        let state = self.get(id)?;
        if prompt.is_empty() {
            return Err("empty prompt".to_owned());
        }
        if lock(&state.cli).is_some() {
            return Err(OPEN_IN_TERMINAL.to_owned());
        }
        if state.turn_running.swap(true, Ordering::SeqCst) {
            return Err("The agent is still working on the previous message".to_owned());
        }
        state.cancel_requested.store(false, Ordering::SeqCst);
        let stamp = self.inner.touch(&state);
        let inner = Arc::clone(&self.inner);
        let attempts = state.start_attempts.load(Ordering::SeqCst);
        tokio::spawn(async move {
            let result = inner.run_turn(&state, prompt, attempts).await;
            state.turn_running.store(false, Ordering::SeqCst);
            if state.in_turn.swap(false, Ordering::SeqCst) {
                *lock(&state.turn_ended) = Some(Instant::now());
            }
            let at = inner.touch(&state);
            match result {
                Ok(stop_reason) => {
                    state.emit("turn-end", json!({ "stopReason": stop_reason, "at": at }));
                    if state.conn().is_some() {
                        inner.set_status(&state, SessionStatus::Idle, None);
                    }
                }
                // A turn cut short by Stop ends as cancelled, not as a failure.
                Err(_) if state.stopping.load(Ordering::SeqCst) => {
                    state.emit("turn-end", json!({ "stopReason": "cancelled", "at": at }));
                }
                Err(e) => {
                    tracing::info!(session = %state.id, "turn failed: {e}");
                    state.emit("error", json!({ "message": e, "turn": true, "at": at }));
                    if state.conn().is_some() {
                        inner.set_status(&state, SessionStatus::Idle, None);
                    }
                }
            }
            // agents.json may have lost the agent during the turn.
            inner.check_agent(&state).await;
        });
        Ok(stamp)
    }

    /// Files that changed in a folder (root-relative, a watcher batch of Main or a workspace): each
    /// one the tool calls of two or more turns of chats in that folder named, running or just ended (`overlap_grace`), is reported to each
    /// running one (`overlap`, naming another), once per file per turn. A change no tool call
    /// names is nobody's.
    pub fn note_changes(&self, folder: &Path, changed: &[String]) {
        let grace = self.inner.opts.overlap_grace;
        let turns: Vec<_> = lock(&self.inner.sessions)
            .values()
            .filter(|s| {
                let record = lock(&s.record);
                let ended = || lock(&s.turn_ended).is_some_and(|at| at.elapsed() < grace);
                shares_folder(&record) && record.agent_cwd == folder && (s.in_turn.load(Ordering::SeqCst) || ended())
            })
            .cloned()
            .collect();
        if turns.len() < 2 {
            return;
        }
        for rel in changed {
            let path = folder.join(rel);
            let by: Vec<_> = turns.iter().filter(|s| lock(&s.touched).contains(&path)).collect();
            if by.len() < 2 {
                continue;
            }
            for state in by.iter().filter(|s| s.in_turn.load(Ordering::SeqCst)) {
                let Some(other) = by.iter().find(|o| o.id != state.id) else { continue };
                if lock(&state.overlaps).insert(path.clone()) {
                    tracing::info!(session = %state.id, other = %other.id, path = %rel, "two running turns changed one file");
                    state.emit("overlap", json!({ "path": rel, "other": { "id": other.id, "title": other.record().title } }));
                }
            }
        }
    }

    /// `session/cancel` for the running turn; pending permission requests are answered
    /// `cancelled`. The turn ends with `turn-end` `cancelled` once the agent stopped; a queued one
    /// at once, without reaching the agent.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let state = self.get(id)?;
        state.cancel_requested.store(true, Ordering::SeqCst);
        self.inner.drop_held(&state);
        if !state.turn_running.load(Ordering::SeqCst) || self.inner.leave_queue(&state) {
            return Ok(());
        }
        match state.conn() {
            Some(conn) => conn.cancel(),
            // Still starting: the turn sees `cancel_requested` before it prompts.
            None => Ok(()),
        }
    }

    /// `session/cancel` of one of the session's subagents (its ACP session id); its pending
    /// permission requests are answered `cancelled`, the session's turn goes on.
    pub fn cancel_subagent(&self, id: &str, subagent: &str) -> Result<(), String> {
        let state = self.get(id)?;
        let conn = state.conn().ok_or("the agent is not running")?;
        conn.cancel_subagent(subagent)?;
        if conn.pending_permissions().is_empty() && state.turn_running.load(Ordering::SeqCst) {
            self.inner.set_status(&state, SessionStatus::Working, None);
        }
        Ok(())
    }

    /// The user's answer to a permission request: an option id, or `None` to cancel it.
    pub fn respond_permission(&self, id: &str, request_id: &str, option_id: Option<String>) -> Result<(), String> {
        let state = self.get(id)?;
        let conn = state.conn().ok_or("the agent is not running")?;
        conn.respond_permission(request_id, option_id)?;
        if conn.pending_permissions().is_empty() && state.turn_running.load(Ordering::SeqCst) {
            self.inner.set_status(&state, SessionStatus::Working, None);
        }
        Ok(())
    }
}

impl Inner {
    /// A turn; one its agent wants a sign-in for (at the start, or answering the prompt) holds
    /// the prompt until then, and is run again.
    async fn run_turn(
        self: &Arc<Self>,
        state: &Arc<SessionState>,
        prompt: Vec<PromptInput>,
        mut attempts: u64,
    ) -> Result<String, String> {
        loop {
            match self.try_turn(state, prompt.clone(), attempts).await {
                Ok(stop_reason) => return Ok(stop_reason),
                Err(StartError::Failed(e)) => return Err(e),
                Err(StartError::SignIn) => {
                    if !self.hold(state, &prompt).await {
                        return Ok("cancelled".to_owned());
                    }
                    attempts = state.start_attempts.load(Ordering::SeqCst);
                }
            }
        }
    }

    async fn try_turn(
        self: &Arc<Self>,
        state: &Arc<SessionState>,
        prompt: Vec<PromptInput>,
        attempts: u64,
    ) -> Result<String, StartError> {
        let conn = self.ensure_started(state, attempts).await?;
        if state.cancel_requested.load(Ordering::SeqCst) {
            return Ok("cancelled".to_owned());
        }
        // Held until the turn returns.
        let _slot = self.take_slot(state).await?;
        if state.cancel_requested.load(Ordering::SeqCst) {
            return Ok("cancelled".to_owned());
        }
        let env = lock(&state.env).clone().ok_or_else(|| "the agent is not running".to_owned())?;
        let blocks = tokio::task::spawn_blocking(move || prompt_blocks(&*env, prompt))
            .await
            .map_err(|e| e.to_string())??;
        lock(&state.touched).clear();
        lock(&state.overlaps).clear();
        lock(&state.tool_kinds).clear();
        *lock(&state.turn_ended) = None;
        state.in_turn.store(true, Ordering::SeqCst);
        state.replay_prompt(&blocks);
        state.emit("turn-start", json!({}));
        self.set_status(state, SessionStatus::Working, None);
        // HOOK(git): checkpoint before the turn. `turn_running` is set, so the git layer can
        // snapshot the session's folder here and refuse user mutations until the turn ends. Not
        // for a local session without a slot (`_slot` is `None`: `localTurns: "parallel"`): other
        // turns write the same checkout meanwhile, so a checkpoint couldn't say whose change is whose.
        let stop_reason = match conn.prompt(blocks).await {
            Ok(stop_reason) => stop_reason,
            Err(ConnectError::SignIn { methods, .. }) => return Err(self.prompt_wants_sign_in(state, methods).await),
            Err(ConnectError::Failed(e)) => return Err(e.into()),
        };
        // HOOK(git): checkpoint after the turn, while `turn_running` is still set.
        Ok(stop_reason)
    }

    /// The running agent answered a prompt with AuthRequired (its login ran out): it's stopped,
    /// so the start after the sign-in finds the new login, and the session asks for one.
    async fn prompt_wants_sign_in(&self, state: &SessionState, methods: Vec<SignInMethod>) -> StartError {
        state.in_turn.store(false, Ordering::SeqCst);
        let taken = state.live.lock().await.take();
        lock(&state.conn).take();
        lock(&state.env).take();
        state.end_replay();
        if let Some(process) = taken.and_then(|live| live.process).as_mut() {
            process.stop().await;
        }
        let record = state.record();
        let Some(launch) = lock(&state.running).clone() else {
            return StartError::Failed("the agent asks to sign in".to_owned());
        };
        tracing::info!(session = %state.id, agent = %record.agent_id, "the agent asks to sign in: stopped");
        let need = SignInNeed {
            key: LaunchKey::new(&launch.command, &launch.args, &launch.env),
            agent_name: record.agent_name.unwrap_or_else(|| record.agent_id.clone()),
            agent_id: record.agent_id,
            methods,
        };
        self.report_sign_in(state, need);
        StartError::SignIn
    }

    /// A chat's turn slot in its folder (Main's, or its workspace's), waited for (`queued`) while
    /// another chat's turn there has it. `None` when the turn needs none: a worktree session of
    /// its own (no workspace), or `localTurns: "parallel"` (the project's, read at each turn, so a
    /// change applies to the next one), or it was cancelled.
    async fn take_slot(&self, state: &SessionState) -> Result<Option<TurnPermit>, String> {
        let record = state.record();
        if !shares_folder(&record) {
            return Ok(None);
        }
        let project = record.project_path.clone();
        let turns = tokio::task::spawn_blocking(move || crate::config::project_settings(&project).local_turns)
            .await
            .map_err(|e| e.to_string())?;
        if turns == LocalTurns::Parallel {
            return Ok(None);
        }
        let (mut holder, mut ticket) = match self.slots.enter(&record.agent_cwd, &state.id) {
            Entry::Granted(permit) => return Ok(Some(permit)),
            Entry::Queued { holder, ticket } => (holder, ticket),
        };
        // A cancel that came before it queued (dropping the ticket leaves the queue).
        if state.cancel_requested.load(Ordering::SeqCst) {
            return Ok(None);
        }
        tracing::info!(session = %state.id, %holder, "turn queued behind another local session's");
        self.set_status(state, SessionStatus::Queued, None);
        loop {
            state.emit("queued", json!({ "holder": { "id": holder, "title": self.title_of(&holder) } }));
            match ticket.next().await {
                Turn::Granted(permit) => return Ok(Some(permit)),
                Turn::Behind(next) => holder = next,
                Turn::Left if state.cancel_requested.load(Ordering::SeqCst) => return Ok(None),
                Turn::Left => return Err("The agent stopped before the turn's start".to_owned()),
            }
        }
    }

    /// Drops the session's queued turn, if it has one.
    pub(super) fn leave_queue(&self, state: &SessionState) -> bool {
        let folder = lock(&state.record).agent_cwd.clone();
        self.slots.leave(&folder, &state.id)
    }

    fn title_of(&self, id: &str) -> Option<String> {
        let state = lock(&self.sessions).get(id).cloned()?;
        Some(state.record().title)
    }
}

/// The page's prompt as ACP blocks: paths checked, mapped to the agent's side, selections read. A
/// relative path is the session's own file; an absolute one is the user's, in the project (a
/// worktree session then gets the project's text, as the user selected it).
pub(super) fn prompt_blocks(env: &dyn SessionEnv, prompt: Vec<PromptInput>) -> Result<Vec<PromptBlock>, String> {
    let resolve = |path: &str| -> Result<(PathBuf, PathBuf), String> {
        if Path::new(path).is_absolute() {
            let host = env::confine(env.project_dir(), Path::new(path), Access::Read)?;
            return Ok((host.clone(), host));
        }
        let rel = crate::roots::checked_rel(path)?;
        let host = env::confine(env.host_dir(), &env.host_dir().join(rel), Access::Read).map_err(|e| {
            if env.host_dir() != env.project_dir() && env.project_dir().join(rel).exists() {
                format!("{path}: not in this session's worktree (untracked or ignored in the project)")
            } else {
                e
            }
        })?;
        Ok((host, env.agent_cwd().join(rel)))
    };
    prompt
        .into_iter()
        .map(|input| match input {
            PromptInput::Text { text } => Ok(PromptBlock::Text(text)),
            PromptInput::Mention { path } => {
                let (_, agent_path) = resolve(&path)?;
                let name = agent_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(path);
                Ok(PromptBlock::Mention { name, uri: file_uri(&agent_path) })
            }
            PromptInput::Selection { path, from_line, to_line } => {
                let (host, agent_path) = resolve(&path)?;
                let (from, to) = (from_line.max(1), to_line.max(from_line.max(1)));
                let text = read_lines(&host, Some(from), Some(to - from + 1), MAX_READ).map_err(|e| format!("{path}: {e}"))?;
                Ok(PromptBlock::Selection { uri: format!("{}#L{from}-{to}", file_uri(&agent_path)), text })
            }
        })
        .collect()
}

/// `file://` URI of an absolute path, with the characters that would break one escaped.
pub(super) fn file_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for ch in path.to_string_lossy().replace('\\', "/").chars() {
        match ch {
            '%' => uri.push_str("%25"),
            ' ' => uri.push_str("%20"),
            '#' => uri.push_str("%23"),
            '?' => uri.push_str("%3F"),
            c => uri.push(c),
        }
    }
    uri
}

/// Lines `line..line + limit` (1-based) of a UTF-8 file, line endings kept. Never holds more than
/// `max` bytes of it: a whole file over that fails, and so does a part over that; skipped lines
/// are passed over without being kept.
pub(super) fn read_lines(path: &Path, line: Option<u32>, limit: Option<u32>, max: u64) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Read};
    let file = File::open(path).map_err(|e| e.to_string())?;
    let too_large = |what: &str| format!("{what} is too large (over {max} bytes); read it in parts");
    let mut out = Vec::new();
    if line.is_none() && limit.is_none() {
        file.take(max + 1).read_to_end(&mut out).map_err(|e| e.to_string())?;
        if out.len() as u64 > max {
            return Err(too_large("the file"));
        }
    } else {
        let mut reader = BufReader::new(file);
        for _ in 1..line.unwrap_or(1) {
            if reader.skip_until(b'\n').map_err(|e| e.to_string())? == 0 {
                break;
            }
        }
        for _ in 0..limit.map_or(u64::MAX, u64::from) {
            let room = max + 1 - out.len() as u64;
            if (&mut reader).take(room).read_until(b'\n', &mut out).map_err(|e| e.to_string())? == 0 {
                break;
            }
            if out.len() as u64 > max {
                return Err(too_large("that part"));
            }
        }
    }
    String::from_utf8(out).map_err(|_| "not UTF-8 text".to_owned())
}

/// Whether a chat shares its folder with other chats, and so its turn slot: Main's chats and a
/// workspace's.
pub(super) fn shares_folder(record: &SessionRecord) -> bool {
    record.mode == Mode::Local || record.workspace_id.is_some()
}
