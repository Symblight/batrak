//! Starting a session's agent: workspace, trust, environment, `initialize` and its config, and scratch agents.

use super::*;

/// Sets a freshly started agent to the session's config: each value it offers and doesn't have
/// yet. One choice can change the others (a model without thought levels), so each next one is
/// picked from the options the last answer brought. An agent that doesn't answer within `limit`
/// (or goes away) is left as it is. Returns the options as they are then.
async fn apply_config(
    conn: &Connection,
    wanted: &BTreeMap<String, String>,
    mut options: Vec<Value>,
    limit: Duration,
) -> Vec<Value> {
    let mut tried = std::collections::HashSet::new();
    while let Some((id, value)) =
        wanted.iter().find(|(id, value)| !tried.contains(id.as_str()) && offers_other(&options, id, value))
    {
        tried.insert(id.as_str());
        let answer = tokio::select! {
            answer = tokio::time::timeout(limit, conn.set_config_option(id, value)) => answer,
            _ = conn.closed() => break,
        };
        match answer {
            Ok(Ok(now)) => options = now,
            Ok(Err(e)) => tracing::info!(config = %id, value = %value, "the agent refused the session's choice: {e}"),
            Err(_) => {
                tracing::info!(config = %id, "the agent didn't answer within {}s; left as it is", limit.as_secs_f32());
                break;
            }
        }
    }
    options
}

/// Whether option `id` can be set to `value` and isn't already; values may come in groups.
fn offers_other(options: &[Value], id: &str, value: &str) -> bool {
    let Some(option) = options.iter().find(|o| o["id"] == id) else { return false };
    let values = option["options"].as_array().into_iter().flatten();
    let mut flat = values.flat_map(|v| v["options"].as_array().map_or_else(|| vec![v], |group| group.iter().collect()));
    option["currentValue"] != value && flat.any(|v| v["value"] == value)
}

/// The options' current values become the session's config; one the agent no longer lists keeps
/// its last value.
pub(super) fn remember_config(state: &SessionState, options: &[Value]) {
    let current = options.iter().filter_map(|o| Some((o["id"].as_str()?.to_owned(), o["currentValue"].as_str()?.to_owned())));
    lock(&state.record).config.extend(current);
}

impl Inner {
    /// The session's connection, starting the agent if it isn't running. `attempts` is
    /// `start_attempts` as the caller saw it: a start that ran since (while this call waited) and
    /// failed is this call's failure too, so one message never starts the agent twice.
    pub(super) async fn ensure_started(self: &Arc<Self>, state: &Arc<SessionState>, attempts: u64) -> Result<Arc<Connection>, StartError> {
        let mut live = state.live.lock().await;
        if let Some(live) = live.as_ref() {
            return Ok(Arc::clone(&live.conn));
        }
        if lock(&state.cli).is_some() {
            return Err(StartError::Failed(OPEN_IN_TERMINAL.to_owned()));
        }
        if state.start_attempts.load(Ordering::SeqCst) != attempts {
            let failed = lock(&state.start_error).clone();
            return Err(failed.unwrap_or_else(|| StartError::Failed("the agent stopped".to_owned())));
        }
        let result = self.attempt_start(state).await;
        if result.is_err() {
            state.end_replay();
        }
        *lock(&state.start_error) = result.as_ref().err().cloned();
        state.start_attempts.fetch_add(1, Ordering::SeqCst);
        let (started, env) = result?;
        let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let conn = Arc::clone(&started.conn);
        *lock(&state.conn) = Some(Arc::clone(&conn));
        *lock(&state.env) = Some(env);
        *live = Some(Live { conn: Arc::clone(&conn), process: started.process, generation });
        drop(live);

        let inner = Arc::clone(self);
        let watched = Arc::clone(state);
        let closed = Arc::clone(&conn);
        tokio::spawn(async move {
            let reason = closed.closed().await;
            drop(closed);
            inner.on_agent_exit(&watched, generation, reason).await;
        });

        if let Some(launch) = lock(&state.running).as_ref() {
            lock(&self.sign_ins_needed).remove(&LaunchKey::new(&launch.command, &launch.args, &launch.env));
        }
        if lock(&state.sign_in).take().is_some() {
            state.emit("sign-in", Value::Null);
        }
        // A turn that held its prompt for this start (one that began while it was getting there).
        if let Some(held) = lock(&state.held).take() {
            let _ = held.send(true);
        }
        state.emit_options(started.config_options.clone());
        let message = match (started.resumed, started.continued, started.history_restored) {
            (true, false, _) => Some("Agent history not restored"),
            (true, true, false) => Some("The agent continues this session but doesn't give its history"),
            _ => None,
        };
        self.set_status(state, SessionStatus::Idle, message);
        Ok(conn)
    }

    /// Starts the session's agent in the background; a failure reaches the page as `error` (or
    /// `sign-in`, sent by the start).
    pub(super) fn start_in_background(self: &Arc<Self>, state: &Arc<SessionState>) {
        let inner = Arc::clone(self);
        let state = Arc::clone(state);
        let attempts = state.start_attempts.load(Ordering::SeqCst);
        tokio::spawn(async move {
            if let Err(StartError::Failed(e)) = inner.ensure_started(&state, attempts).await {
                state.emit("error", json!({ "message": e }));
            }
        });
    }

    /// One start, with the session's `live` lock held.
    async fn attempt_start(self: &Arc<Self>, state: &Arc<SessionState>) -> Result<(StartedAgent, Arc<dyn SessionEnv>), StartError> {
        // A new attempt: whatever happens now isn't the earlier Stop's doing.
        state.stopping.store(false, Ordering::SeqCst);
        // In a task of its own, so Stop can abort it: dropping it drops the process, which kills
        // the group.
        let task = tokio::spawn(Arc::clone(self).start_agent(Arc::clone(state)));
        *lock(&state.starting) = Some(task.abort_handle());
        let result = task.await;
        lock(&state.starting).take();
        match result {
            Ok(Ok(started)) => Ok(started),
            Ok(Err(StartFailure::Untrusted(untrusted))) => {
                tracing::info!(session = %state.id, "agent not started: the project's launch isn't trusted");
                self.set_status(state, SessionStatus::Error, Some(&untrusted.message));
                state.emit("untrusted", json!({ "launch": untrusted.launch, "message": untrusted.message }));
                Err(StartError::Failed(untrusted.message))
            }
            Ok(Err(StartFailure::Unconfigured { agent_id, ran, absence })) => {
                tracing::info!(session = %state.id, agent = %agent_id, ?absence, "agent not started");
                Err(StartError::Failed(self.report_unconfigured(state, &agent_id, ran.as_deref(), absence, true)))
            }
            Ok(Err(StartFailure::SignIn(need))) => {
                tracing::info!(session = %state.id, agent = %need.agent_id, "agent not started: it asks to sign in");
                self.report_sign_in(state, *need);
                Err(StartError::SignIn)
            }
            Ok(Err(StartFailure::Failed(e))) => {
                tracing::warn!(session = %state.id, "agent failed to start: {e}");
                self.set_status(state, SessionStatus::Error, Some(&e));
                Err(StartError::Failed(e))
            }
            Err(_) => Err(StartError::Failed("stopped while starting".to_owned())),
        }
    }

    /// An agent that may run for `project` (the user's agents without one): in its agents.json,
    /// on, and trusted.
    pub(super) fn startable(&self, project: Option<&Path>, agent_id: &str) -> Result<AgentConfig, String> {
        let merged = self.opts.configs.merged(project);
        let agent = merged.agent(agent_id).cloned().ok_or_else(|| format!("Unknown agent \"{agent_id}\""))?;
        if merged.enabled(agent_id).is_none() {
            return Err(Absence::Off.message(&merged, agent_id));
        }
        if let Some(project) = project {
            self.check_trust(project, &merged, agent_id).map_err(|untrusted| untrusted.message)?;
        }
        Ok(agent)
    }

    /// A spawn's error; an agent's program on PATH that isn't there says how to install it.
    fn launch_error(&self, agent: &AgentConfig, error: String) -> String {
        // `os error 2`: not found, on unix (ENOENT) and Windows (ERROR_FILE_NOT_FOUND) alike.
        if !error.ends_with("(os error 2)") {
            return error;
        }
        crate::config::registry::not_installed(&self.opts.configs.registry().agents(), &agent.command).unwrap_or(error)
    }

    /// Starts `agent` in a scratch folder in app data (`initialize`, then `authenticate` with
    /// `authenticate` if given, then `session/new`; no prompt) and stops it again.
    pub(super) async fn scratch_start(&self, agent: &AgentConfig, authenticate: Option<String>) -> Result<acp::Started, ConnectError> {
        let Launched { mut process, writer, reader } = self.scratch_launch(agent).await?;
        let opts = StartOptions {
            cwd: self.probe_dir()?,
            mcp_servers: Vec::new(),
            resume: None,
            agent_name: agent.name.clone(),
            initialize_timeout: self.opts.initialize_timeout,
            authenticate,
        };
        // Dropping `process` (a cancelled sign-in) kills its group too.
        let started = Connection::start(writer, reader, Arc::new(ProbeHost), opts).await;
        if let Some(process) = process.as_mut() {
            process.stop().await;
        }
        started.map(|(_, started)| started)
    }

    /// `<app data>/probe`, canonical: where agents run without a session.
    fn probe_dir(&self) -> Result<PathBuf, String> {
        let dir = self.data_dir().join("probe");
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        dunce::canonicalize(&dir).map_err(|e| format!("{}: {e}", dir.display()))
    }

    /// Starts `agent` in the probe folder, its stderr appended to `<agent id>.log` there.
    pub(super) async fn scratch_launch(&self, agent: &AgentConfig) -> Result<Launched, String> {
        let dir = self.probe_dir()?;
        let base_env = Arc::clone(&self.opts.base_env);
        let secrets = Arc::clone(&self.opts.secrets);
        let agent_env = agent.env.clone();
        let process_env = tokio::task::spawn_blocking(move || {
            crate::config::env::agent_env(&base_env(), crate::git::exec::SCRUBBED_ENV, &agent_env, &*secrets)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {e}", agent.name))?;
        let log_path = dir.join(format!("{}.log", agent.id.replace(['/', '\\'], "_")));
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("{}: {e}", log_path.display()))?;
        let env = env::LocalEnv::new(dir);
        self.opts.launcher.launch(&env, agent, &process_env, log).map_err(|e| self.launch_error(agent, e))
    }

    /// Refuses an agent whose launch the project's agents.json chose until the user trusted it.
    /// `merged` is the config the caller is about to launch from.
    pub(super) fn check_trust(&self, project: &Path, merged: &Merged, agent_id: &str) -> Result<(), Untrusted> {
        let Some(launch) = merged.launch(agent_id) else { return Ok(()) };
        if !merged.needs_trust(agent_id) || self.opts.configs.is_trusted(project, &launch) {
            return Ok(());
        }
        let name = merged.agent(agent_id).map_or(agent_id, |a| a.name.as_str());
        let command = std::iter::once(launch.command.as_str()).chain(launch.args.iter().map(String::as_str)).collect::<Vec<_>>();
        let mut message = format!("This project's .brama/agents.json sets what \"{name}\" runs: {}", command.join(" "));
        let servers: Vec<&str> = launch.mcp_servers.iter().filter_map(|s| s["name"].as_str()).collect();
        if merged.project_mcp && !servers.is_empty() {
            message.push_str(&format!(", with MCP servers {}", servers.join(", ")));
        }
        message.push_str(". Start it only if you trust this project.");
        Err(Untrusted { launch: Box::new(launch), message })
    }

    async fn start_agent(
        self: Arc<Self>,
        state: Arc<SessionState>,
    ) -> Result<(StartedAgent, Arc<dyn SessionEnv>), StartFailure> {
        let record = state.record();
        state.start_replay();
        self.set_status(&state, SessionStatus::Preparing, None);
        if let Some(id) = record.workspace_id.clone() {
            // Its workspace's checkout: the first, or one that runs.
            let workspaces = self.workspaces.clone();
            tokio::task::spawn_blocking(move || workspaces.ready(&id)).await.map_err(|e| e.to_string())??;
        }
        let env: Arc<dyn SessionEnv> = Arc::from(env::for_session(&record)?);
        let preparing = Arc::clone(&env);
        let cancel = Arc::new(AtomicBool::new(false));
        *lock(&state.prepare_cancel) = Some(Arc::clone(&cancel));
        let prepared = tokio::task::spawn_blocking(move || preparing.prepare(&cancel)).await;
        lock(&state.prepare_cancel).take();
        prepared.map_err(|e| e.to_string())??;

        self.set_status(&state, SessionStatus::Starting, Some("Starting agent…"));
        let merged = self.opts.configs.merged(Some(&record.project_path));
        let agent = match merged.enabled(&record.agent_id) {
            Some(agent) => agent.clone(),
            None => self.follow_agent(&state, &record, &merged)?,
        };
        self.check_trust(&record.project_path, &merged, &agent.id).map_err(StartFailure::Untrusted)?;
        let base_env = Arc::clone(&self.opts.base_env);
        let secrets = Arc::clone(&self.opts.secrets);
        let agent_env = agent.env.clone();
        let process_env = tokio::task::spawn_blocking(move || {
            crate::config::env::agent_env(&base_env(), crate::git::exec::SCRUBBED_ENV, &agent_env, &*secrets)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {e}", agent.name))?;

        *lock(&state.running) = merged.launch(&agent.id);
        state.outdated.store(false, Ordering::SeqCst);
        // Its agent is there: whatever said it was gone is over.
        lock(&state.unconfigured).take();
        *lock(&state.agent) = Some(Arc::clone(self.opts.agents.shared_for_launch(&crate::agents::launch_of(&agent))));
        let launch = AgentLaunch { command: agent.command.clone(), args: agent.args.clone() };
        if record.launch.as_ref() != Some(&launch) || record.agent_name.as_ref() != Some(&agent.name) {
            let mut record = lock(&state.record);
            record.launch = Some(launch);
            record.agent_name = Some(agent.name.clone());
            drop(record);
            self.persist();
        }
        let log = self.open_log(&state.id, &agent)?;
        let launched = self.opts.launcher.launch(&*env, &agent, &process_env, log).map_err(|e| self.launch_error(&agent, e))?;
        drop(process_env);
        if let Some(pid) = launched.process.as_ref().and_then(AgentProcess::pid) {
            tracing::info!(session = %state.id, agent = %agent.id, pid, "agent process started");
        }

        let host = Arc::new(SessionHost { state: Arc::downgrade(&state), inner: Arc::downgrade(&self) });
        let opts = StartOptions {
            cwd: env.agent_cwd().to_path_buf(),
            mcp_servers: merged.mcp_servers.clone(),
            resume: record.acp_session_id.clone(),
            agent_name: agent.name.clone(),
            initialize_timeout: self.opts.initialize_timeout,
            authenticate: None,
        };
        let Launched { mut process, writer, reader } = launched;
        let (conn, started) = match Connection::start(writer, reader, host, opts).await {
            Ok(ok) => ok,
            Err(e) => {
                if let Some(process) = process.as_mut() {
                    process.stop().await;
                }
                return Err(match e {
                    ConnectError::SignIn { methods, .. } => StartFailure::SignIn(Box::new(SignInNeed {
                        key: LaunchKey::of(&agent),
                        agent_id: agent.id.clone(),
                        agent_name: agent.name.clone(),
                        methods,
                    })),
                    ConnectError::Failed(e) => StartFailure::Failed(e),
                });
            }
        };
        tracing::info!(
            session = %state.id,
            mode = ?env.mode(),
            load_supported = started.load_supported,
            history_restored = started.history_restored,
            "agent ready"
        );
        if let Some(version) = &started.agent_version {
            self.opts.configs.note_version(&agent.id, version);
        }
        // Kept before anything else can fail: the agent has the session now.
        lock(&state.record).acp_session_id = Some(started.acp_session_id.clone());
        self.persist();
        // Still in the task Stop aborts, and before anyone gets the connection: the first prompt
        // runs with the session's choices.
        let options = apply_config(&conn, &record.config, started.config_options, self.opts.initialize_timeout).await;
        remember_config(&state, &options);
        self.persist();
        Ok((
            StartedAgent {
                conn: Arc::new(conn),
                process,
                resumed: record.acp_session_id.is_some(),
                continued: started.continued,
                history_restored: started.history_restored,
                config_options: options,
            },
            env,
        ))
    }

    /// What the last start of `agent_id` in the session's log ran, as `log_line` wrote it.
    pub(super) fn logged_launch(&self, id: &str, agent_id: &str) -> Option<String> {
        let log = std::fs::read_to_string(self.log_path(id)).ok()?;
        let marker = format!(" starting {agent_id}: ");
        log.lines().rev().filter(|l| l.starts_with("--- ")).find_map(|l| l.split_once(&marker).map(|(_, ran)| ran.to_owned()))
    }

    /// Appends a start marker to the session's log and returns the file for the agent's stderr.
    /// The command line is from the config (no resolved env), so it holds no secret.
    fn open_log(&self, id: &str, agent: &AgentConfig) -> Result<File, String> {
        let path = self.log_path(id);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let mut file =
            OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let _ = writeln!(file, "--- {} starting {}: {}", iso_now(), agent.id, log_line(agent));
        Ok(file)
    }
}

pub(super) enum StartFailure {
    Untrusted(Untrusted),
    /// The session's agent isn't in the project's agents.json, or is off; `ran` is
    /// what it ran (`log_line`), which an agent under another id may run again.
    Unconfigured { agent_id: String, ran: Option<String>, absence: Absence },
    SignIn(Box<SignInNeed>),
    Failed(String),
}

/// A start or turn that failed, as the callers waiting for it see it.
#[derive(Debug, Clone)]
pub(super) enum StartError {
    /// The agent asks for a sign-in (the page was sent `sign-in`).
    SignIn,
    Failed(String),
}

impl From<String> for StartError {
    fn from(e: String) -> StartError {
        StartError::Failed(e)
    }
}

impl From<String> for StartFailure {
    fn from(e: String) -> StartFailure {
        StartFailure::Failed(e)
    }
}

/// An agent the project's config chose and the user hasn't trusted yet.
pub(super) struct Untrusted {
    pub(super) launch: Box<crate::config::LaunchConfig>,
    pub(super) message: String,
}

struct StartedAgent {
    pub(super) conn: Arc<Connection>,
    pub(super) process: Option<AgentProcess>,
    pub(super) resumed: bool,
    pub(super) continued: bool,
    pub(super) history_restored: bool,
    pub(super) config_options: Vec<Value>,
}

/// An agent's command line as its session log's start line shows it.
pub(super) fn log_line(agent: &AgentConfig) -> String {
    format!("{} {}", agent.command, agent.args.join(" "))
}
