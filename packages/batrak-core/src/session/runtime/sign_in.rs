//! Agents that ask to sign in: launch keys, sign-ins (in the browser or a Terminal tab), held prompts, probes.

use super::*;
use crate::session::program::{Program, ProgramExit, ProgramRunner};

/// The longest a sign-in may wait for the user in the browser.
const SIGN_IN_LIMIT: Duration = Duration::from_secs(10 * 60);

/// An agent's launch as far as its login goes: the same command line and env names (not values)
/// sign in to the same account.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct LaunchKey {
    pub(super) command: String,
    pub(super) args: Vec<String>,
    pub(super) env: Vec<String>,
}

impl LaunchKey {
    pub(super) fn new(command: &str, args: &[String], env: &BTreeMap<String, String>) -> LaunchKey {
        LaunchKey { command: command.to_owned(), args: args.to_vec(), env: env.keys().cloned().collect() }
    }

    pub(super) fn of(agent: &AgentConfig) -> LaunchKey {
        LaunchKey::new(&agent.command, &agent.args, &agent.env)
    }
}

/// A launch that answered AuthRequired, and how it can sign in.
#[derive(Debug, Clone)]
pub(super) struct SignInNeed {
    pub(super) key: LaunchKey,
    pub(super) agent_id: String,
    pub(super) agent_name: String,
    pub(super) methods: Vec<SignInMethod>,
}

pub(super) struct SignInRun {
    /// An `authenticate` sign-in's task.
    pub(super) abort: Option<AbortHandle>,
    /// A terminal sign-in's login, which the user runs to its end.
    pub(super) login: Option<LoginTab>,
    pub(super) done: Arc<watch::Sender<Option<SignInEnd>>>,
}

/// A login that runs in a Terminal tab (`terminal` / `command` methods): the page opens the tab
/// `terminal_id`, titled `title`, with `command_line` (no env) as its tooltip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginTab {
    pub terminal_id: String,
    pub title: String,
    pub command_line: String,
}

/// What a login tab's terminal runs. Its env holds the agent's resolved secrets, so it never leaves
/// the backend.
struct Login {
    cwd: PathBuf,
    command: acp::auth::LoginCommand,
}

/// How a login's terminal ended.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LoginExit {
    Code(i32),
    Signal(String),
    /// Its tab was closed first: a cancel.
    Closed,
}

impl LoginExit {
    fn of(exit: Option<&ProgramExit>) -> LoginExit {
        match exit {
            None => LoginExit::Closed,
            Some(ProgramExit { code: Some(code), .. }) => LoginExit::Code(*code),
            Some(ProgramExit { signal, .. }) => LoginExit::Signal(signal.clone().unwrap_or_else(|| "a signal".to_owned())),
        }
    }
}

/// A cancelled sign-in; a login's terminal is the caller's to close.
pub struct Cancelled {
    pub terminal_id: Option<String>,
}

/// How a sign-in ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInEnd {
    Done,
    Failed(String),
    Cancelled,
}

/// A sign-in started (or joined) by `Sessions::sign_in`.
pub struct SignIn {
    pub agent_name: String,
    /// A login shown in a Terminal tab (also for a call that joined it).
    pub tab: Option<LoginTab>,
    done: watch::Receiver<Option<SignInEnd>>,
}

impl SignIn {
    pub async fn end(mut self) -> SignInEnd {
        match self.done.wait_for(Option::is_some).await {
            Ok(end) => end.clone().unwrap_or(SignInEnd::Cancelled),
            Err(_) => SignInEnd::Cancelled,
        }
    }
}

/// What a probe learned: the agent's options, or that it wants a sign-in first.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Probed {
    Options(Vec<Value>),
    #[serde(rename_all = "camelCase")]
    SignIn { sign_in: Vec<SignInMethod> },
}

impl Sessions {
    /// Asks an agent for its config options (models, thought levels, modes) without a session:
    /// it starts in a scratch folder in app data, answers `initialize` and `session/new` (no prompt,
    /// so no model call), and is stopped. For the pickers before the agent's first session. One
    /// that answers AuthRequired is noted as needing a sign-in ([`Probed::SignIn`]).
    pub async fn probe_options(&self, project: Option<&Path>, agent_id: &str) -> Result<Probed, String> {
        let agent = self.inner.startable(project, agent_id)?;
        if !self.inner.starts_in_background(&agent) {
            return Err(format!("{} starts only when you use it", agent.name));
        }
        // Waiting for a sign-in, it isn't started again (one may open the browser at each start
        // while signed out); a sign-in or Retry clears that.
        let key = LaunchKey::of(&agent);
        if self.inner.waits_for_sign_in(&key) {
            let methods = lock(&self.inner.sign_ins_needed).get(&key).map(|need| need.methods.clone());
            return Ok(Probed::SignIn { sign_in: methods.unwrap_or_default() });
        }
        match self.inner.scratch_start(&agent, None).await {
            Ok(started) => {
                if let Some(version) = &started.agent_version {
                    self.inner.opts.configs.note_version(&agent.id, version);
                }
                tracing::info!(agent = %agent.id, options = started.config_options.len(), "probed the agent's options");
                // It's signed in (a login elsewhere): whatever waited for that needn't.
                self.inner.signed_in(&LaunchKey::of(&agent));
                let kind = self.inner.opts.agents.for_launch(&crate::agents::launch_of(&agent));
                Ok(Probed::Options(crate::agents::tag_modes(kind, started.config_options)))
            }
            Err(ConnectError::SignIn { methods, .. }) => {
                tracing::info!(agent = %agent.id, methods = methods.len(), "the probed agent asks to sign in");
                let need = SignInNeed { key: LaunchKey::of(&agent), agent_id: agent.id.clone(), agent_name: agent.name.clone(), methods };
                lock(&self.inner.sign_ins_needed).insert(need.key.clone(), need.clone());
                Ok(Probed::SignIn { sign_in: need.methods })
            }
            Err(ConnectError::Failed(e)) => Err(e),
        }
    }

    /// Signs an agent in with one of its methods: an `agent` method goes to `authenticate` in a
    /// process of its own (the agent opens the browser), confirmed by a `session/new`; no method
    /// (Retry, after a login in a terminal) only checks with a `session/new`. One runs per
    /// launch; a second call joins it. The launch must be trusted, as for a start. Once it
    /// worked, every session waiting for it starts again and sends its held prompt. A `terminal`
    /// or `command` method isn't run here: the result's `login` is for a Terminal tab, whose end
    /// the caller reports (`login_ended`).
    pub async fn sign_in(&self, project: Option<&Path>, agent_id: &str, method_id: Option<&str>, runner: Arc<dyn ProgramRunner>) -> Result<SignIn, String> {
        let agent = self.inner.startable(project, agent_id)?;
        let key = LaunchKey::of(&agent);
        if let Some(joined) = self.inner.join_sign_in(&key, &agent.name) {
            return Ok(joined);
        }
        let method = method_id.and_then(|id| {
            let needed = lock(&self.inner.sign_ins_needed);
            needed.get(&key)?.methods.iter().find(|m| m.id == id).cloned()
        });
        let login = match method.as_ref().and_then(|m| m.login.clone().map(|login| (m, login))) {
            Some((method, login)) => Some(self.inner.login_for(&agent, method, &login).await?),
            None => None,
        };
        // Joined meanwhile (the env took a while).
        if let Some(joined) = self.inner.join_sign_in(&key, &agent.name) {
            return Ok(joined);
        }
        tracing::info!(agent = %agent.id, method = ?method_id, terminal = login.is_some(), "signing in");
        let (done, receiver) = watch::channel(None);
        let done = Arc::new(done);
        let agent_name = agent.name.clone();
        if let Some((tab, login)) = login {
            lock(&self.inner.signing_in).insert(key, SignInRun { abort: None, login: Some(tab.clone()), done });
            if let Err(e) = self.run_login(&tab, login, runner).await {
                self.cancel_sign_in(project, agent_id);
                return Err(e);
            }
            return Ok(SignIn { agent_name, tab: Some(tab), done: receiver });
        }
        let mut running = lock(&self.inner.signing_in);
        let method = method_id.map(str::to_owned);
        let task = tokio::spawn(Arc::clone(&self.inner).run_sign_in(agent, key.clone(), method, Arc::clone(&done)));
        running.insert(key, SignInRun { abort: Some(task.abort_handle()), login: None, done });
        Ok(SignIn { agent_name, tab: None, done: receiver })
    }

    /// Starts a login where `runner` shows programs; its end goes to `login_ended`.
    async fn run_login(&self, tab: &LoginTab, login: Login, runner: Arc<dyn ProgramRunner>) -> Result<(), String> {
        let (id, sessions) = (tab.terminal_id.clone(), self.clone());
        let on_exit = {
            let id = id.clone();
            Box::new(move |exit: Option<&ProgramExit>| sessions.login_ended(&id, LoginExit::of(exit)))
        };
        let program = Program { program: login.command.program, args: login.command.args, env: login.command.env, paste: None };
        tokio::task::spawn_blocking(move || runner.run(&id, &login.cwd, program, None, on_exit)).await.map_err(|e| e.to_string())?
    }

    /// A login's terminal ended: exit 0 signed the agent in (its waiting sessions start again);
    /// another exit failed, a closed tab cancelled.
    fn login_ended(&self, terminal_id: &str, exit: LoginExit) {
        let found = {
            let mut running = lock(&self.inner.signing_in);
            let key = running.iter().find(|(_, run)| run.login.as_ref().is_some_and(|l| l.terminal_id == terminal_id)).map(|(k, _)| k.clone());
            key.and_then(|key| running.remove(&key).map(|run| (key, run)))
        };
        let Some((key, run)) = found else { return };
        let title = run.login.map(|l| l.title).unwrap_or_default();
        let end = match exit {
            LoginExit::Code(0) => SignInEnd::Done,
            LoginExit::Code(code) => SignInEnd::Failed(format!("{title} exited with {code}")),
            LoginExit::Signal(signal) => SignInEnd::Failed(format!("{title} was ended by {signal}")),
            LoginExit::Closed => SignInEnd::Cancelled,
        };
        tracing::info!(terminal = %terminal_id, ?end, "login ended");
        if end == SignInEnd::Done {
            self.inner.signed_in(&key);
        }
        run.done.send_replace(Some(end));
    }

    /// Stops an agent's running sign-in (its process group); `None` when none runs. A login's
    /// terminal is the caller's to close.
    pub fn cancel_sign_in(&self, project: Option<&Path>, agent_id: &str) -> Option<Cancelled> {
        let merged = self.inner.opts.configs.merged(project);
        let agent = merged.agent(agent_id)?;
        let run = lock(&self.inner.signing_in).remove(&LaunchKey::of(agent))?;
        tracing::info!(agent = %agent_id, "sign-in cancelled");
        if let Some(abort) = &run.abort {
            abort.abort();
        }
        run.done.send_replace(Some(SignInEnd::Cancelled));
        Some(Cancelled { terminal_id: run.login.map(|l| l.terminal_id) })
    }

    /// The agents of a project (the user's without one), each marked when it waits for a sign-in.
    pub fn agent_list(&self, project: Option<&Path>) -> crate::config::AgentList {
        let mut list = self.inner.opts.configs.list(project);
        for agent in &mut list.agents {
            agent.sign_in = agent.enabled && self.sign_in_state(project, &agent.id).is_some_and(|s| !s.methods.is_empty());
        }
        list
    }

    /// Whether an agent asked for a sign-in (at a start, a prompt or a probe), or one runs.
    pub fn sign_in_state(&self, project: Option<&Path>, agent_id: &str) -> Option<SignInState> {
        let merged = self.inner.opts.configs.merged(project);
        let key = LaunchKey::of(merged.agent(agent_id)?);
        let pending = lock(&self.inner.signing_in).contains_key(&key);
        let methods = lock(&self.inner.sign_ins_needed).get(&key).map(|need| need.methods.clone());
        (pending || methods.is_some()).then(|| SignInState { methods: methods.unwrap_or_default(), pending })
    }
}

impl Inner {
    /// The session's agent asks for a sign-in: `error` with "Sign in to …", and `sign-in` with
    /// its methods; the launch is noted as needing one.
    pub(super) fn report_sign_in(&self, state: &SessionState, need: SignInNeed) {
        let message = format!("Sign in to {}", need.agent_name);
        lock(&self.sign_ins_needed).insert(need.key.clone(), need.clone());
        self.set_status(state, SessionStatus::Error, Some(&message));
        state.emit("sign-in", json!({ "agentId": need.agent_id, "agentName": need.agent_name, "methods": need.methods }));
        *lock(&state.sign_in) = Some(need);
    }

    /// The sign-in already running for `key`, joined.
    fn join_sign_in(&self, key: &LaunchKey, agent_name: &str) -> Option<SignIn> {
        let running = lock(&self.signing_in);
        let run = running.get(key)?;
        Some(SignIn { agent_name: agent_name.to_owned(), tab: run.login.clone(), done: run.done.subscribe() })
    }

    /// The Terminal tab and command of a `terminal` / `command` method: the agent's launch with
    /// its env resolved, in the probe folder.
    async fn login_for(&self, agent: &AgentConfig, method: &SignInMethod, login: &acp::auth::Login) -> Result<(LoginTab, Login), String> {
        let base_env = Arc::clone(&self.opts.base_env);
        let secrets = Arc::clone(&self.opts.secrets);
        let agent_env = agent.env.clone();
        let env = tokio::task::spawn_blocking(move || {
            crate::config::env::agent_env(&base_env(), crate::git::exec::SCRUBBED_ENV, &agent_env, &*secrets)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {e}", agent.name))?;
        let command = acp::auth::login_command(&agent.command, &agent.args, &env, login);
        let cwd = self.data_dir().join("probe");
        std::fs::create_dir_all(&cwd).map_err(|e| format!("{}: {e}", cwd.display()))?;
        let cwd = dunce::canonicalize(&cwd).map_err(|e| format!("{}: {e}", cwd.display()))?;
        let n = self.next_login.fetch_add(1, Ordering::SeqCst) + 1;
        let tab = LoginTab {
            terminal_id: format!("sign-in-{n}"),
            title: method.label.clone().unwrap_or_else(|| method.name.clone()),
            command_line: std::iter::once(command.program.as_str()).chain(command.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" "),
        };
        Ok((tab, Login { cwd, command }))
    }

    /// One sign-in of `Sessions::sign_in`, to its end (at most `SIGN_IN_LIMIT`).
    async fn run_sign_in(self: Arc<Self>, agent: AgentConfig, key: LaunchKey, method: Option<String>, done: Arc<watch::Sender<Option<SignInEnd>>>) {
        let end = match tokio::time::timeout(SIGN_IN_LIMIT, self.scratch_start(&agent, method)).await {
            Err(_) => SignInEnd::Failed(format!("Signing in to {} took over {} minutes", agent.name, SIGN_IN_LIMIT.as_secs() / 60)),
            Ok(Ok(_)) => SignInEnd::Done,
            Ok(Err(ConnectError::SignIn { .. })) => SignInEnd::Failed(format!("{} still asks to sign in", agent.name)),
            Ok(Err(ConnectError::Failed(e))) => SignInEnd::Failed(e),
        };
        {
            let mut running = lock(&self.signing_in);
            if !running.get(&key).is_some_and(|run| Arc::ptr_eq(&run.done, &done)) {
                // Cancelled after it ended, past the abort's last chance: Cancel said so already.
                return;
            }
            running.remove(&key);
        }
        match &end {
            SignInEnd::Done => {
                tracing::info!(agent = %agent.id, "signed in");
                self.signed_in(&key);
            }
            SignInEnd::Failed(e) => tracing::info!(agent = %agent.id, "sign-in failed: {e}"),
            SignInEnd::Cancelled => {}
        }
        done.send_replace(Some(end));
    }

    /// A launch signed in: it no longer needs to, and every session waiting for it starts again,
    /// sending its held prompt (one without goes `idle`).
    /// A session counts when its agent asked under that launch, or runs it now (agents.json
    /// changed it since).
    pub(super) fn signed_in(self: &Arc<Self>, key: &LaunchKey) {
        lock(&self.sign_ins_needed).remove(key);
        let sessions: Vec<_> = lock(&self.sessions).values().cloned().collect();
        let waiting = sessions.into_iter().filter(|s| {
            let Some(asked) = lock(&s.sign_in).as_ref().map(|need| need.key.clone()) else { return false };
            asked == *key || {
                let record = s.record();
                let merged = self.opts.configs.merged(Some(&record.project_path));
                merged.agent(&record.agent_id).is_some_and(|agent| LaunchKey::of(agent) == *key)
            }
        });
        for state in waiting {
            tracing::info!(session = %state.id, "signed in: starting the agent again");
            match lock(&state.held).take() {
                Some(held) => {
                    let _ = held.send(true);
                }
                None => self.start_in_background(&state),
            }
        }
    }

    /// Drops the prompt a turn holds for a sign-in, if any; the turn then ends `cancelled`.
    pub(super) fn drop_held(&self, state: &SessionState) {
        if let Some(held) = lock(&state.held).take() {
            let _ = held.send(false);
        }
    }

    /// Holds a turn's prompt until its agent signed in (`true`) or it's dropped (`false`: Stop,
    /// cancel, Remove, its agent gone), which gives the page the prompt back (`prompt-returned`).
    pub(super) async fn hold(&self, state: &SessionState, prompt: &[PromptInput]) -> bool {
        let (held, answer) = oneshot::channel();
        *lock(&state.held) = Some(held);
        // A Stop or cancel that came first.
        if state.cancel_requested.load(Ordering::SeqCst) || state.stopping.load(Ordering::SeqCst) {
            lock(&state.held).take();
        } else if lock(&state.sign_in).is_none() && lock(&state.held).take().is_some() {
            // A start worked between the failure and now (a sign-in that just ended).
            return true;
        } else {
            tracing::info!(session = %state.id, "prompt held until the agent is signed in");
            state.emit("held", json!({ "prompt": prompt }));
        }
        let send = answer.await.unwrap_or(false);
        if !send {
            state.emit("prompt-returned", json!({ "prompt": prompt }));
        }
        send
    }
}
