//! A session continued in its agent's own CLI, in a terminal, instead of the chat (spec:
//! `docs/specs/session-terminal.md`). The agent owns the session, so its CLI resumes it by its ACP
//! id. One process per session at a time: while the CLI holds it, the ACP agent isn't started.

use super::*;
use crate::terminal::{OpenRequest, PasteWait, Program, TerminalEvent, Terminals};

/// How long closing the CLI waits for it to be gone.
const CLOSE_WAIT: Duration = Duration::from_secs(3);
/// How often a running CLI's session is read from its agent's records.
const CLI_POLL: Duration = Duration::from_secs(3);

/// A session's CLI: its terminal (once started) and who hears it's gone.
pub(in crate::session) struct CliHeld {
    terminal_id: String,
    /// Tells this hold from a later one of the same session.
    token: u64,
    /// `None` while getting ready (a worktree's checkout).
    terminals: Option<Terminals>,
    gone: Arc<watch::Sender<bool>>,
    /// What it's doing, as its agent's records last told.
    pub(super) activity: Option<agent_api::SessionActivity>,
}

/// A session opened in its agent's CLI: the terminal the page attaches to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliOpened {
    pub terminal_id: String,
}

/// A draft that starts in the CLI: what its first message would have created it with.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDraft {
    pub project_path: String,
    pub agent_id: String,
    pub title: String,
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    /// `None`: Main.
    pub workspace_id: Option<String>,
    /// The draft's first message, which the CLI starts with.
    #[serde(default)]
    pub prompt: Option<String>,
}

/// How a CLI starts: continuing the session, or starting it (with its first message).
enum CliStart {
    Resume,
    New { prompt: Option<String> },
}

/// Where the CLI's terminal goes: the calling window's, at the page's size.
pub struct CliWindow<'a> {
    pub terminals: &'a Terminals,
    pub group: &'a str,
    pub cols: u16,
    pub rows: u16,
}

/// The terminal id of a session's CLI.
pub fn terminal_id(session_id: &str) -> String {
    format!("cli-{session_id}")
}

/// When a first prompt that isn't on the command line is pasted: `npx` may install the CLI first, in
/// silence; a CLI that shows its screen and settles reads.
const FIRST_PROMPT_WAIT: PasteWait = PasteWait { quiet: Duration::from_secs(3), give_up: Duration::from_secs(180) };

/// Why the agent doesn't start, or take a prompt, while the CLI holds the session.
pub(super) const OPEN_IN_TERMINAL: &str = "This session is open in the terminal: continue in the chat to send it a message";

/// Why another window can't show a session's CLI: its terminal is the window's that opened it.
pub(super) const OTHER_WINDOW: &str = "Shown in the terminal of another window";

/// Numbers holds, so a late exit of an earlier CLI doesn't end a later one.
static NEXT_HOLD: AtomicU64 = AtomicU64::new(0);

impl Sessions {
    /// Continues the session in its agent's CLI, in a terminal of the calling window, in its
    /// folder (a worktree's checked out first). Refused while its ACP agent runs (the caller stops
    /// it first), for an agent without a CLI, or one that can't start (off, untrusted). A `draft`
    /// creates the session under its id (a UUID), which becomes its ACP id: the CLI starts it
    /// under that id (`newArgs`). A CLI already running is answered with its terminal.
    pub async fn open_cli(&self, id: &str, draft: Option<CliDraft>, window: CliWindow<'_>) -> Result<CliOpened, String> {
        let (created, start) = match draft {
            Some(mut draft) if self.get(id).is_err() => {
                let prompt = draft.prompt.take();
                (Some(self.create_for_cli(id, draft).await?), CliStart::New { prompt })
            }
            _ => (None, CliStart::Resume),
        };
        let state = match &created {
            Some(state) => Arc::clone(state),
            None => self.get(id)?,
        };
        let opened = self.inner.open_cli(&state, start, window).await;
        if opened.is_err() && created.is_some() {
            self.forget_failed_draft(&state).await;
        }
        opened
    }

    /// Closes the session's CLI and returns once it's gone (at most `CLOSE_WAIT`); nothing when
    /// none runs.
    pub async fn close_cli(&self, id: &str) -> Result<(), String> {
        let state = self.get(id)?;
        self.inner.close_cli(&state).await;
        Ok(())
    }

    /// Whether closing the CLI may stop work: its agent doesn't say it's at its prompt, or a program
    /// it runs is in the terminal's foreground.
    pub fn cli_busy(&self, id: &str) -> Result<bool, String> {
        let state = self.get(id)?;
        let Some((terminals, terminal_id, activity)) =
            lock(&state.cli).as_ref().and_then(|h| Some((h.terminals.clone()?, h.terminal_id.clone(), h.activity)))
        else {
            return Ok(false);
        };
        let at_prompt = activity == Some(agent_api::SessionActivity::Idle);
        Ok(!at_prompt || !terminals.busy(&[terminal_id]).is_empty())
    }

    /// Undoes a draft created for a CLI that didn't start: unlisted, its files gone (its workspace
    /// stays). The page never listed it, so nothing is announced.
    async fn forget_failed_draft(&self, state: &Arc<SessionState>) {
        lock(&self.inner.sessions).remove(&state.id);
        self.inner.persist();
        let dir = self.inner.data_dir().join("sessions").join(&state.id);
        let discarded = tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(&dir);
        })
        .await;
        if let Err(e) = discarded {
            tracing::warn!(session = %state.id, "discarding a draft's folder failed: {e}");
        }
    }

    /// Lists a draft whose first run is its CLI's: `stopped`, its id its ACP id.
    async fn create_for_cli(&self, id: &str, draft: CliDraft) -> Result<Arc<SessionState>, String> {
        if !is_uuid(id) {
            return Err(format!("A session started in the terminal needs a UUID for its id, not {id:?}"));
        }
        let project = dunce::canonicalize(&draft.project_path).map_err(|e| format!("{}: {e}", draft.project_path))?;
        let merged = self.inner.opts.configs.merged(Some(&project));
        if let Some(agent) = merged.agent(&draft.agent_id) {
            match crate::config::cli::cli_for(&self.inner.opts.agents, agent, &draft.config) {
                None => return Err(format!("{} has no terminal mode", agent.name)),
                Some(spec) if spec.new_args.is_none() => {
                    return Err(format!("{}'s CLI can't start a session Brama names: send a first message in the chat", agent.name));
                }
                Some(_) => {}
            }
        }
        let request = CreateSession {
            session_id: id.to_owned(),
            project_path: draft.project_path,
            agent_id: draft.agent_id,
            title: draft.title,
            config: draft.config,
            workspace_id: draft.workspace_id,
        };
        let sessions = self.clone();
        let mut record = tokio::task::spawn_blocking(move || sessions.new_record(&request)).await.map_err(|e| e.to_string())??;
        record.acp_session_id = Some(id.to_owned());
        record.status = SessionStatus::Stopped;
        let state = self.insert(record, None)?;
        tracing::info!(session = %id, agent = %state.record().agent_id, "session created for its agent's CLI");
        Ok(state)
    }
}

impl Inner {
    async fn open_cli(self: &Arc<Self>, state: &Arc<SessionState>, start: CliStart, window: CliWindow<'_>) -> Result<CliOpened, String> {
        let terminal_id = terminal_id(&state.id);
        let token = NEXT_HOLD.fetch_add(1, Ordering::SeqCst) + 1;
        {
            // Under the start lock: a start of the ACP agent sees the hold, or this sees the agent.
            let live = state.live.lock().await;
            let mut cli = lock(&state.cli);
            if let Some(held) = cli.as_ref() {
                return match &held.terminals {
                    Some(terminals) if terminals.owns(window.group, &held.terminal_id) => Ok(CliOpened { terminal_id: held.terminal_id.clone() }),
                    Some(_) => Err(OTHER_WINDOW.to_owned()),
                    None => Err("The terminal is getting ready".to_owned()),
                };
            }
            if live.is_some() || state.status().is_active() {
                return Err("The agent is running in the chat: stop it first".to_owned());
            }
            let gone = Arc::new(watch::channel(false).0);
            *cli = Some(CliHeld { terminal_id: terminal_id.clone(), token, terminals: None, gone, activity: None });
        }
        match self.start_cli(state, start, token, &terminal_id, &window).await {
            Ok(()) => {
                // A failure of the chat's agent would hide what its CLI is doing.
                if state.status() == SessionStatus::Error {
                    self.set_status(state, SessionStatus::Stopped, None);
                }
                state.emit("session", serde_json::to_value(state.page()).unwrap_or_default());
                Ok(CliOpened { terminal_id })
            }
            Err(e) => {
                self.end_cli(state, token, None);
                Err(e)
            }
        }
    }

    /// Resolves the CLI, gets the session's folder ready and starts the CLI there.
    async fn start_cli(self: &Arc<Self>, state: &Arc<SessionState>, start: CliStart, token: u64, terminal_id: &str, window: &CliWindow<'_>) -> Result<(), String> {
        let record = state.record();
        let merged = self.opts.configs.merged(Some(&record.project_path));
        let agent = match merged.enabled(&record.agent_id) {
            Some(agent) => agent.clone(),
            None => self
                .follow_agent(state, &record, &merged)
                .map_err(|_| Absence::of(&merged, &record.agent_id).message(&merged, &record.agent_id))?,
        };
        self.check_trust(&record.project_path, &merged, &agent.id).map_err(|untrusted| untrusted.message)?;
        // The session's picks (the composer's, then each the chat applied) as its CLI's flags.
        let spec = crate::config::cli::cli_for(&self.opts.agents, &agent, &record.config)
            .ok_or_else(|| format!("{} has no terminal mode", agent.name))?;
        let acp_id = record.acp_session_id.clone().ok_or("This session hasn't started yet: send its first message in the chat")?;
        // A first prompt that can't go on the command line is pasted once the CLI reads.
        let mut pasted = None;
        let (program, args) = match start {
            CliStart::New { prompt } => {
                let prompt = prompt.filter(|p| !p.trim().is_empty());
                let on_argv = prompt.as_deref().is_none_or(|p| crate::config::cli::prompt_fits_argv(p, cfg!(windows)));
                let command = spec.start_new(&acp_id, if on_argv { prompt.as_deref() } else { None });
                if !on_argv {
                    pasted = prompt;
                }
                command.ok_or_else(|| format!("{}'s CLI can't start a session Brama names", agent.name))?
            }
            CliStart::Resume => spec.resume(&acp_id),
        };

        if record.mode == Mode::Worktree {
            self.set_status(state, SessionStatus::Preparing, None);
        }
        let prepared = self.prepare_folder(&record).await;
        if record.mode == Mode::Worktree {
            self.set_status(state, SessionStatus::Stopped, None);
        }
        prepared?;

        let base_env = Arc::clone(&self.opts.base_env);
        let secrets = Arc::clone(&self.opts.secrets);
        let agent_env = agent.env.clone();
        let process_env = tokio::task::spawn_blocking(move || {
            crate::config::env::agent_env(&base_env(), crate::git::exec::SCRUBBED_ENV, &agent_env, &*secrets)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {e}", agent.name))?;

        let inner = Arc::downgrade(self);
        let session_id = state.id.clone();
        let on_exit = Box::new(move |exit: Option<&TerminalEvent>| {
            if let Some(inner) = inner.upgrade() {
                inner.cli_ended(&session_id, token, exit);
            }
        });
        let terminals = window.terminals.clone();
        let (id, group, cwd, cols, rows) = (terminal_id.to_owned(), window.group.to_owned(), record.agent_cwd.clone(), window.cols, window.rows);
        let program = Program { program, args, env: process_env };
        tokio::task::spawn_blocking(move || {
            let req = OpenRequest { id: &id, group: &group, cwd: &cwd, fallback: None, cols, rows };
            terminals.open_program(&req, program, on_exit)
        })
        .await
        .map_err(|e| e.to_string())??;
        tracing::info!(session = %state.id, agent = %agent.id, terminal = %terminal_id, "session continues in its agent's CLI");
        if let Some(prompt) = pasted {
            window.terminals.paste_when_ready(terminal_id, &prompt, FIRST_PROMPT_WAIT);
        }
        let gone = match lock(&state.cli).as_mut().filter(|held| held.token == token) {
            Some(held) => {
                held.terminals = Some(window.terminals.clone());
                Some(held.gone.subscribe())
            }
            None => None,
        };
        let kept = gone.is_some();
        // A CLI tells nothing over ACP: its agent's records tell what it's doing.
        if let Some(gone) = gone {
            let kind = Arc::clone(self.opts.agents.shared_for_launch(&crate::agents::launch_of(&agent)));
            watch_cli_records(state, kind, gone);
        }
        // Closed while it started (or already exited): its terminal goes too.
        if !kept {
            window.terminals.close(&[terminal_id.to_owned()]);
        }
        Ok(())
    }

    /// The session's CLI is gone, its terminal closed, or Remove / its agent leaving closes it.
    pub(super) async fn close_cli(&self, state: &Arc<SessionState>) {
        let (gone, terminal, token) = {
            let cli = lock(&state.cli);
            let Some(held) = cli.as_ref() else { return };
            (held.gone.subscribe(), held.terminals.clone().map(|t| (t, held.terminal_id.clone())), held.token)
        };
        if let Some((terminals, terminal_id)) = terminal {
            terminals.close(&[terminal_id]);
            let mut gone = gone;
            let _ = tokio::time::timeout(CLOSE_WAIT, gone.wait_for(|gone| *gone)).await;
        }
        self.end_cli(state, token, None);
    }

    /// A CLI's terminal ended: closed (`None`), or the CLI exited.
    fn cli_ended(&self, session_id: &str, token: u64, exit: Option<&TerminalEvent>) {
        let Some(state) = lock(&self.sessions).get(session_id).cloned() else { return };
        self.end_cli(&state, token, exit);
    }

    /// Lets go of hold `token`, if it's still the session's: the agent may start again.
    fn end_cli(&self, state: &Arc<SessionState>, token: u64, exit: Option<&TerminalEvent>) {
        let held = {
            let mut cli = lock(&state.cli);
            if cli.as_ref().is_none_or(|held| held.token != token) {
                return;
            }
            cli.take()
        };
        if let Some(held) = held {
            // What its agent lists from now on, up to the slack, is this CLI's last writes.
            if held.terminals.is_some() {
                *lock(&state.active_here) = parse_iso_millis(&iso_now());
            }
            held.gone.send_replace(true);
            // Exited on its own: its terminal (and its output kept for a reattach) goes too; the
            // page keeps what it shows.
            if let (Some(TerminalEvent::Exit { .. }), Some(terminals)) = (exit, &held.terminals) {
                terminals.close(std::slice::from_ref(&held.terminal_id));
            }
        }
        if let Some(TerminalEvent::Exit { code, signal }) = exit {
            tracing::info!(session = %state.id, ?code, ?signal, "the agent's CLI exited");
            state.emit("cli-exited", json!({ "code": code, "signal": signal }));
        }
        state.emit("session", serde_json::to_value(state.page()).unwrap_or_default());
    }
}

/// While the session's CLI runs (until `gone`), reads what it's doing and its subagents from its
/// agent's records.
fn watch_cli_records(state: &Arc<SessionState>, agent: Arc<dyn agent_api::Agent>, mut gone: watch::Receiver<bool>) {
    let Some(acp_id) = state.record().acp_session_id else { return };
    let state = Arc::downgrade(state);
    tokio::spawn(async move {
        loop {
            let (agent, id) = (Arc::clone(&agent), acp_id.clone());
            let Ok((activity, subagents)) = tokio::task::spawn_blocking(move || (agent.session_activity(&id), agent.subagents(&id))).await else {
                return;
            };
            let Some(state) = state.upgrade() else { return };
            state.set_cli_activity(activity);
            state.set_subagents(subagents::of_records(subagents));
            drop(state);
            tokio::select! {
                _ = tokio::time::sleep(CLI_POLL) => {}
                _ = gone.wait_for(|gone| *gone) => return,
            }
        }
    });
}

impl SessionState {
    /// Takes `activity` as what its CLI is doing; the page hears of it only when it changed.
    fn set_cli_activity(&self, activity: Option<agent_api::SessionActivity>) {
        {
            let mut cli = lock(&self.cli);
            let Some(held) = cli.as_mut().filter(|held| held.activity != activity) else { return };
            held.activity = activity;
        }
        self.emit("session", serde_json::to_value(self.page()).unwrap_or_default());
    }
}

/// `8-4-4-4-12` hex digits, as the CLIs take for a new session's id.
fn is_uuid(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    groups.iter().map(|g| g.len()).eq([8, 4, 4, 4, 12]) && groups.iter().all(|g| g.bytes().all(|b| b.is_ascii_hexdigit()))
}

