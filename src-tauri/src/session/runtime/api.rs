//! What callers give the session runtime and get from it: options, launchers, event sinks, requests.

use super::*;

/// One message to the frontend: `seq` is monotonic per session across every window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub session_id: String,
    pub seq: u64,
    /// `update` (payload: ACP `SessionUpdate`), `status`, `permission-request`, `turn-start`,
    /// `turn-end` (`{ stopReason }`), `error`, `config-options` (`{ configOptions }`: the
    /// agent's model, thought level and mode options as they are now), or `session` (the `Session`
    /// after the agent named it), `sign-in` (`{ agentId, agentName, methods }`: the agent asks
    /// for a sign-in; `null` once a start works or Stop), `held` (`{ prompt }`: the turn's prompt
    /// waits for that sign-in), `prompt-returned` (`{ prompt }`: a held prompt was dropped) or
    /// `cli-exited` (`{ code, signal }`: its agent's CLI, in a terminal, exited).
    pub kind: &'static str,
    pub payload: Value,
}

/// Where a session's events go: one per window that opened it (a Tauri channel).
pub trait EventSink: Send + Sync {
    /// `false` once the receiver is gone; the sink is then dropped.
    fn send(&self, envelope: &Envelope) -> bool;
}

/// A started agent: its process (none for an in-process test agent) and the pipes ACP runs over.
pub struct Launched {
    pub process: Option<AgentProcess>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
}

/// Starts agents; the app spawns processes through the session's environment, tests run a fake
/// agent in-process.
pub trait Launcher: Send + Sync {
    fn launch(&self, env: &dyn SessionEnv, agent: &AgentConfig, process_env: &[(String, String)], stderr: File)
        -> Result<Launched, String>;
}

/// The real thing: the agent's command in its own process group, through `env.spawn_agent`.
pub struct ProcessLauncher;

impl Launcher for ProcessLauncher {
    fn launch(&self, env: &dyn SessionEnv, agent: &AgentConfig, process_env: &[(String, String)], stderr: File)
        -> Result<Launched, String> {
        let launch = Launch { program: &agent.command, args: &agent.args, env: process_env, stderr };
        let (process, pipes) = env.spawn_agent(launch)?;
        Ok(Launched { process: Some(process), writer: Box::new(pipes.stdin), reader: Box::new(pipes.stdout) })
    }
}

pub struct SessionsOptions {
    /// App data: `sessions.json` and `sessions/<id>/agent.log`.
    pub data_dir: PathBuf,
    pub configs: AgentConfigs,
    pub secrets: Arc<dyn SecretStore + Send + Sync>,
    /// The environment agents start from (the login shell's). Blocking.
    pub base_env: Arc<dyn Fn() -> HashMap<String, String> + Send + Sync>,
    pub launcher: Arc<dyn Launcher>,
    /// How long a starting agent may take to answer `initialize`, and each config option the
    /// session is set to.
    pub initialize_timeout: Duration,
    /// How long after its end a turn's changes still count for an overlap: the watcher reports a
    /// write a debounce later, so the batch with a turn's last edits may come after it ended.
    pub overlap_grace: Duration,
    /// How long one agent may take to list its sessions in a sync.
    pub sync_timeout: Duration,
}

/// Several watcher debounces (150 ms), FSEvents' latency included.
pub(super) const OVERLAP_GRACE: Duration = Duration::from_secs(1);

impl SessionsOptions {
    pub fn for_app(data_dir: PathBuf, configs: AgentConfigs) -> SessionsOptions {
        SessionsOptions {
            data_dir,
            configs,
            secrets: Arc::new(crate::config::env::OsKeychain),
            base_env: Arc::new(|| crate::config::env::login_shell_env().clone()),
            launcher: Arc::new(ProcessLauncher),
            initialize_timeout: acp::INITIALIZE_TIMEOUT,
            overlap_grace: OVERLAP_GRACE,
            sync_timeout: sync::SYNC_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSession {
    /// The frontend's id for it (the draft's), so its conversation keeps its id.
    pub session_id: String,
    pub project_path: String,
    pub agent_id: String,
    pub mode: Mode,
    pub title: String,
    /// The agent's config options picked in the draft (model, thought level, mode), by id.
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    /// `worktree`: the branch or commit to start from; `None` for the project's HEAD.
    #[serde(default)]
    pub base_branch: Option<String>,
}

/// A prompt piece from the page. Paths are relative to the session's folder; the backend maps and
/// checks them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PromptInput {
    Text { text: String },
    /// An `@`-mentioned file or folder.
    Mention { path: String },
    /// Lines from an editor, 1-based and inclusive.
    Selection { path: String, from_line: u32, to_line: u32 },
}
