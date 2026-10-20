//! Agent configuration: `.brama/agents.json` in the project over the user's
//! `<config dir>/brama/agents.json`, merged by agent id; nothing is configured by default. The last valid
//! version of each file is kept, so a typo mid-edit doesn't drop the agents.

pub mod env;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};

/// Tauri event after a project's agents.json changed on disk: `{ projectPath }`.
pub const AGENTS_CHANGED_EVENT: &str = "agents://changed";

pub const DIR: &str = ".brama";
pub const AGENTS_FILE: &str = "agents.json";
/// Per-user, untracked state inside `.brama/`; the snapshot never shows it.
pub const LOCAL_DIR: &str = "local";

const DEFAULT_AGENTS: &str = "{\n  \"version\": 1,\n  \"agents\": {}\n}\n";
const DEFAULT_WORKSPACE: &str = "{\n  \"version\": 1,\n  \"defaultMode\": \"local\"\n}\n";
const WORKSPACE_FILE: &str = "workspace.json";
const DEFAULT_GITIGNORE: &str = "local/\n";

/// Creates `.brama/` with default files when they're missing; never overwrites one.
pub fn ensure_project_dir(project: &Path) -> Result<(), String> {
    let dir = project.join(DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for (name, content) in
        [(AGENTS_FILE, DEFAULT_AGENTS), (WORKSPACE_FILE, DEFAULT_WORKSPACE), (".gitignore", DEFAULT_GITIGNORE)]
    {
        let path = dir.join(name);
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                std::io::Write::write_all(&mut file, content.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))?;
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    Ok(())
}

/// `.brama/workspace.json`: how the project's sessions start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettings {
    /// Run target a new session starts with: `local` or `worktree`.
    pub default_mode: String,
}

/// The project's workspace.json; a missing, invalid or unknown setting is the default (`local`).
/// Blocking.
pub fn workspace_settings(project: &Path) -> WorkspaceSettings {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct File {
        version: u32,
        default_mode: Option<String>,
    }
    let path = project.join(DIR).join(WORKSPACE_FILE);
    let parsed = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<File>(&text).map_err(|e| format!("{}:{}:{}: {e}", path.display(), e.line(), e.column())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(File { version: 1, default_mode: None }),
        Err(e) => Err(format!("{}: {e}", path.display())),
    };
    let default_mode = match parsed {
        Ok(File { version: 1, default_mode }) => default_mode.filter(|m| m == "local" || m == "worktree"),
        Ok(File { version, .. }) => {
            tracing::info!("{}: unsupported version {version} (expected 1)", path.display());
            None
        }
        Err(e) => {
            tracing::info!("{e}");
            None
        }
    };
    WorkspaceSettings { default_mode: default_mode.unwrap_or_else(|| "local".to_owned()) }
}

/// One agent as configured. `env` values are templates (`${env:NAME}`, `${keychain:name}`),
/// resolved only when the agent starts, so no secret is held here.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// The project's agents.json sets its command, args or env: cloning a repo must not be enough
    /// to run something, so it starts only once the user trusts it ([`AgentConfigs::trust`]).
    pub from_project: bool,
}

/// Everything a session start runs, as the user trusts it: the agent's command line and env
/// templates, and the MCP servers the agent is told to start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub agent_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub mcp_servers: Vec<serde_json::Value>,
}

/// A launch the user trusted in a project (`trusted-agents.json` in app data).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustedLaunch {
    project: PathBuf,
    launch: LaunchConfig,
}

/// A project's agent waiting for the user's trust (`agents_untrusted`): its name and what it runs.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UntrustedAgent {
    pub name: String,
    pub launch: LaunchConfig,
}

/// What the agent list shows: no command line, no environment.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentList {
    pub agents: Vec<AgentSummary>,
    pub default_agent: Option<String>,
    /// Problems with the files (`file:line:column: message`); their last valid version is in use.
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Merged {
    pub agents: Vec<AgentConfig>,
    pub default_agent: Option<String>,
    /// ACP `McpServer` objects for every `session/new`; validated by the ACP host.
    pub mcp_servers: Vec<serde_json::Value>,
    /// One of `mcp_servers` comes from the project's file.
    pub project_mcp: bool,
    pub errors: Vec<String>,
}

impl Merged {
    pub fn agent(&self, id: &str) -> Option<&AgentConfig> {
        self.agents.iter().find(|a| a.id == id)
    }

    /// Whether starting the agent runs something the project's file chose.
    pub fn needs_trust(&self, id: &str) -> bool {
        self.project_mcp || self.agent(id).is_some_and(|a| a.from_project)
    }

    pub fn launch(&self, id: &str) -> Option<LaunchConfig> {
        self.agent(id).map(|a| LaunchConfig {
            agent_id: a.id.clone(),
            command: a.command.clone(),
            args: a.args.clone(),
            env: a.env.clone(),
            mcp_servers: self.mcp_servers.clone(),
        })
    }

    pub fn list(&self) -> AgentList {
        AgentList {
            agents: self.agents.iter().map(|a| AgentSummary { id: a.id.clone(), name: a.name.clone() }).collect(),
            default_agent: self.default_agent.clone(),
            errors: self.errors.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentsFile {
    version: u32,
    #[serde(default)]
    agents: BTreeMap<String, AgentEntry>,
    #[serde(default)]
    default_agent: Option<String>,
    #[serde(default)]
    mcp_servers: Vec<serde_json::Value>,
}

/// Every field optional: a project entry may only override part of a user-level agent, or only
/// say `"disabled": true`.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentEntry {
    name: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    disabled: bool,
}

impl AgentEntry {
    /// `self` over `base`, field by field.
    fn over(self, base: AgentEntry) -> AgentEntry {
        AgentEntry {
            name: self.name.or(base.name),
            command: self.command.or(base.command),
            args: self.args.or(base.args),
            env: self.env.or(base.env),
            disabled: self.disabled,
        }
    }
}

/// Parses one agents.json. Errors name the file and position.
fn parse(path: &Path, text: &str) -> Result<AgentsFile, String> {
    let file: AgentsFile = serde_json::from_str(text)
        .map_err(|e| format!("{}:{}:{}: {e}", path.display(), e.line(), e.column()))?;
    if file.version != 1 {
        return Err(format!("{}: unsupported version {} (expected 1)", path.display(), file.version));
    }
    Ok(file)
}

/// An agent's entry merged so far, and whether the project's file set what it runs.
struct Layered {
    entry: AgentEntry,
    from_project: bool,
    /// The project's file asked for a keychain item.
    refused: bool,
}

/// Layers from lowest to highest, then the project's file; agents merge by id, `mcpServers` by
/// `name` (higher wins), `defaultAgent` from the highest layer that sets it.
fn merge(layers: &[&AgentsFile], project: Option<&AgentsFile>) -> Merged {
    let mut entries: BTreeMap<String, Layered> = BTreeMap::new();
    let mut default_agent = None;
    let mut mcp: Vec<(serde_json::Value, bool)> = Vec::new();
    let all = layers.iter().map(|layer| (*layer, false)).chain(project.map(|p| (p, true)));
    for (layer, is_project) in all {
        for (id, entry) in &layer.agents {
            let sets_launch = entry.command.is_some() || entry.args.is_some() || entry.env.is_some();
            let asks_keychain = entry.env.iter().flat_map(|env| env.values()).any(|v| v.contains("${keychain:"));
            let merged = match entries.remove(id) {
                Some(base) => Layered {
                    entry: entry.clone().over(base.entry),
                    from_project: base.from_project || (is_project && sets_launch),
                    refused: base.refused || (is_project && asks_keychain),
                },
                None => Layered {
                    entry: entry.clone(),
                    from_project: is_project && sets_launch,
                    refused: is_project && asks_keychain,
                },
            };
            entries.insert(id.clone(), merged);
        }
        if layer.default_agent.is_some() {
            default_agent.clone_from(&layer.default_agent);
        }
        for server in &layer.mcp_servers {
            let name = server.get("name");
            mcp.retain(|(existing, _)| name.is_none() || existing.get("name") != name);
            mcp.push((server.clone(), is_project));
        }
    }
    let mut errors = Vec::new();
    let agents: Vec<AgentConfig> = entries
        .into_iter()
        .filter(|(_, layered)| !layered.entry.disabled)
        .filter_map(|(id, Layered { entry, from_project, refused })| match entry.command {
            // The project's file is the repository's: it could hand the user's secrets to its own command.
            _ if refused => {
                errors.push(format!("agent {id:?}: ${{keychain:…}} works only in the user's agents.json"));
                None
            }
            Some(command) if !command.trim().is_empty() => Some(AgentConfig {
                name: entry.name.unwrap_or_else(|| id.clone()),
                id,
                command,
                args: entry.args.unwrap_or_default(),
                env: entry.env.unwrap_or_default(),
                from_project,
            }),
            _ => {
                errors.push(format!("agent {id:?} has no command"));
                None
            }
        })
        .collect();
    let default_agent = default_agent
        .filter(|id| agents.iter().any(|a| &a.id == id))
        .or_else(|| agents.first().map(|a| a.id.clone()));
    let project_mcp = mcp.iter().any(|(_, from_project)| *from_project);
    let mcp_servers = mcp.into_iter().map(|(server, _)| server).collect();
    Merged { agents, default_agent, mcp_servers, project_mcp, errors }
}

/// One file's last valid parse and its current error.
#[derive(Default, Clone)]
struct FileState {
    last_valid: Option<AgentsFile>,
    error: Option<String>,
}

impl FileState {
    /// Re-reads the file: a missing file is an empty layer; an invalid one keeps the last valid.
    fn reload(&mut self, path: &Path) -> bool {
        let before = (self.last_valid.clone(), self.error.clone());
        match fs::read_to_string(path) {
            Ok(text) => match parse(path, &text) {
                Ok(file) => {
                    self.last_valid = Some(file);
                    self.error = None;
                }
                Err(e) => self.error = Some(e),
            },
            Err(e) if e.kind() == ErrorKind::NotFound => {
                self.last_valid = None;
                self.error = None;
            }
            Err(e) => self.error = Some(format!("{}: {e}", path.display())),
        }
        before != (self.last_valid.clone(), self.error.clone())
    }
}

/// Agent configs of every project seen, plus the user-level file. Cheap to clone.
#[derive(Clone)]
pub struct AgentConfigs {
    /// `<config dir>/brama/agents.json`; `None` when the OS has no config dir.
    user_file: Option<PathBuf>,
    /// `trusted-agents.json` in app data; `None` keeps trust in memory only (tests).
    trust_file: Option<Arc<crate::storage::JsonFile>>,
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    user: FileState,
    projects: HashMap<PathBuf, FileState>,
    trusted: Vec<TrustedLaunch>,
}

impl AgentConfigs {
    pub fn new(user_file: Option<PathBuf>, trust_file: Option<PathBuf>) -> AgentConfigs {
        let trust_file = trust_file.map(|path| Arc::new(crate::storage::JsonFile::new(path)));
        let trusted = trust_file.as_ref().map(|file| file.load()).unwrap_or_default();
        AgentConfigs { user_file, trust_file, inner: Arc::new(Mutex::new(Inner { trusted, ..Inner::default() })) }
    }

    /// Whether the user trusted exactly this launch in `project` (canonical).
    pub fn is_trusted(&self, project: &Path, launch: &LaunchConfig) -> bool {
        self.lock().trusted.iter().any(|t| t.project == project && &t.launch == launch)
    }

    /// The agents of `project` (canonical) that run something its agents.json chose and that the
    /// user hasn't trusted as they are now.
    pub fn untrusted(&self, project: &Path) -> Vec<UntrustedAgent> {
        let merged = self.merged(Some(project));
        merged
            .agents
            .iter()
            .filter(|a| merged.needs_trust(&a.id))
            .filter_map(|a| merged.launch(&a.id).map(|launch| UntrustedAgent { name: a.name.clone(), launch }))
            .filter(|u| !self.is_trusted(project, &u.launch))
            .collect()
    }

    /// Trusts `launches` in `project`, each replacing what was trusted for its agent there before.
    /// Refused, all of them, when one isn't what the project's config says now: the user trusts
    /// what they were shown.
    pub fn trust(&self, project: &Path, launches: &[LaunchConfig]) -> Result<(), String> {
        let merged = self.merged(Some(project));
        if launches.iter().any(|launch| merged.launch(&launch.agent_id).as_ref() != Some(launch)) {
            return Err("agents.json changed since; check it and try again".to_owned());
        }
        let trusted = {
            let mut inner = self.lock();
            for launch in launches {
                inner.trusted.retain(|t| t.project != project || t.launch.agent_id != launch.agent_id);
                inner.trusted.push(TrustedLaunch { project: project.to_path_buf(), launch: launch.clone() });
            }
            inner.trusted.clone()
        };
        for launch in launches {
            tracing::info!(project = %project.display(), agent = %launch.agent_id, "agent trusted");
        }
        match &self.trust_file {
            Some(file) => file.save(&trusted),
            None => Ok(()),
        }
    }

    /// `<config dir>/brama/agents.json`, whether it exists or not.
    pub fn user_file(&self) -> Option<&Path> {
        self.user_file.as_deref()
    }

    /// The agents.json to edit: the project's `.brama/agents.json`, or the user's without a
    /// project. Created with the defaults when missing; never overwritten.
    pub fn editable_file(&self, project: Option<&Path>) -> Result<PathBuf, String> {
        match project {
            Some(project) => {
                ensure_project_dir(project)?;
                Ok(project.join(DIR).join(AGENTS_FILE))
            }
            None => {
                let file = self.user_file.clone().ok_or("this system has no config folder")?;
                if let Some(dir) = file.parent() {
                    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
                }
                match fs::OpenOptions::new().write(true).create_new(true).open(&file) {
                    Ok(mut f) => std::io::Write::write_all(&mut f, DEFAULT_AGENTS.as_bytes())
                        .map_err(|e| format!("{}: {e}", file.display()))?,
                    Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(format!("{}: {e}", file.display())),
                }
                Ok(file)
            }
        }
    }

    /// Re-reads the user-level file only (it isn't watched). Returns whether it changed.
    pub fn reload_user(&self) -> bool {
        let Some(user_file) = &self.user_file else { return false };
        let mut inner = self.lock();
        let changed = inner.user.reload(user_file);
        if changed {
            if let Some(error) = &inner.user.error {
                tracing::warn!("agents.json: {error}");
            }
        }
        changed
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Re-reads both files for `project`. Returns whether anything changed; a newly invalid file
    /// is logged (and so shown) once.
    pub fn reload(&self, project: &Path) -> bool {
        let project_file = project.join(DIR).join(AGENTS_FILE);
        let mut inner = self.lock();
        let mut changed = false;
        if let Some(user_file) = &self.user_file {
            changed |= inner.user.reload(user_file);
        }
        let state = inner.projects.entry(project.to_path_buf()).or_default();
        changed |= state.reload(&project_file);
        if changed {
            for error in [&inner.user.error, &inner.projects[project].error].into_iter().flatten() {
                tracing::warn!("agents.json: {error}");
            }
        }
        changed
    }

    /// The merged config of `project`, read from disk on first use; `None`: no project open, the
    /// user's agents only.
    pub fn merged(&self, project: Option<&Path>) -> Merged {
        match project {
            Some(project) if !self.lock().projects.contains_key(project) => {
                self.reload(project);
            }
            None => {
                if let Some(user_file) = &self.user_file {
                    self.lock().user.reload(user_file);
                }
            }
            Some(_) => {}
        }
        let inner = self.lock();
        let empty = FileState::default();
        let project_state = project.and_then(|p| inner.projects.get(p)).unwrap_or(&empty);
        let layers: Vec<_> = inner.user.last_valid.iter().collect();
        let mut merged = merge(&layers, project_state.last_valid.as_ref());
        let errors = [&inner.user.error, &project_state.error].into_iter().flatten().cloned();
        merged.errors.splice(0..0, errors);
        merged
    }
}

/// Whether an absolute path is a project's `.brama/agents.json`; returns the project.
pub fn project_of_agents_file(path: &Path) -> Option<&Path> {
    let dir = path.parent()?;
    (path.file_name()? == AGENTS_FILE && dir.file_name()? == DIR).then(|| dir.parent()).flatten()
}

/// Whether a root-relative path from the watcher is the project's agents.json (or its folder,
/// which FSEvents may report alone).
pub fn is_agents_path(rel: &str) -> bool {
    rel == DIR || rel == format!("{DIR}/{AGENTS_FILE}")
}

/// Whether a root-relative path lies in `.brama/local/`, which the snapshot leaves out.
pub fn is_local_path(rel: &str) -> bool {
    rel.strip_prefix(DIR)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(|rest| rest.strip_prefix(LOCAL_DIR))
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brama-config-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn workspace_settings_fall_back_to_local() {
        let project = temp_project("workspace-settings");
        assert_eq!(workspace_settings(&project).default_mode, "local", "no file");
        ensure_project_dir(&project).unwrap();
        assert_eq!(workspace_settings(&project).default_mode, "local", "the default file");
        let file = project.join(".brama/workspace.json");
        fs::write(&file, r#"{"version":1,"defaultMode":"worktree"}"#).unwrap();
        assert_eq!(workspace_settings(&project).default_mode, "worktree");
        for invalid in [r#"{"version":1,"defaultMode":"cloud"}"#, "{ not json", r#"{"version":2,"defaultMode":"worktree"}"#] {
            fs::write(&file, invalid).unwrap();
            assert_eq!(workspace_settings(&project).default_mode, "local", "{invalid}");
        }
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn creates_defaults_once_and_never_overwrites() {
        let project = temp_project("defaults");
        ensure_project_dir(&project).unwrap();
        let agents = project.join(".brama/agents.json");
        assert_eq!(fs::read_to_string(&agents).unwrap(), DEFAULT_AGENTS);
        assert!(fs::read_to_string(project.join(".brama/workspace.json")).unwrap().contains("\"defaultMode\": \"local\""));
        assert_eq!(fs::read_to_string(project.join(".brama/.gitignore")).unwrap(), "local/\n");

        fs::write(&agents, "{\"version\":1,\"agents\":{\"x\":{\"command\":\"x\"}}}").unwrap();
        ensure_project_dir(&project).unwrap();
        assert!(fs::read_to_string(&agents).unwrap().contains("\"x\""), "kept the user's file");
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn a_new_project_lists_no_agents() {
        let project = temp_project("no-agents");
        ensure_project_dir(&project).unwrap();
        let merged = AgentConfigs::new(None, None).merged(Some(&project));
        assert!(merged.agents.is_empty(), "{:?}", merged.agents);
        assert_eq!(merged.default_agent, None);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn project_overrides_user_and_can_disable() {
        let user = parse(
            Path::new("user.json"),
            r#"{"version":1,"agents":{
                "codex":{"name":"Codex","command":"npx","args":["-y","codex-acp"],"env":{"OPENAI_API_KEY":"${keychain:openai}"}},
                "gemini":{"name":"Gemini","command":"gemini","args":["--acp"]}
            },"mcpServers":[{"name":"docs","command":"docs-mcp","args":[],"env":[]}]}"#,
        )
        .unwrap();
        let project = parse(
            Path::new("project.json"),
            r#"{"version":1,"defaultAgent":"codex","agents":{
                "gemini":{"disabled":true},
                "codex":{"args":["-y","codex-acp@2"]}
            },"mcpServers":[{"name":"docs","command":"docs-mcp-v2","args":[],"env":[]}]}"#,
        )
        .unwrap();
        let merged = merge(&[&user], Some(&project));
        let ids: Vec<_> = merged.agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["codex"]);
        let codex = merged.agent("codex").unwrap();
        assert_eq!(codex.name, "Codex", "name from the user layer");
        assert_eq!(codex.args, ["-y", "codex-acp@2"], "args from the project");
        assert_eq!(codex.env["OPENAI_API_KEY"], "${keychain:openai}", "templates stay unresolved");
        assert_eq!(merged.default_agent.as_deref(), Some("codex"));
        assert_eq!(merged.mcp_servers.len(), 1);
        assert_eq!(merged.mcp_servers[0]["command"], "docs-mcp-v2");
        assert!(merged.errors.is_empty());
    }

    #[test]
    fn invalid_file_reports_position_and_keeps_the_last_valid_version() {
        let project = temp_project("invalid");
        ensure_project_dir(&project).unwrap();
        let file = project.join(".brama/agents.json");
        fs::write(&file, r#"{"version":1,"agents":{"mine":{"name":"Mine","command":"mine"}}}"#).unwrap();
        let configs = AgentConfigs::new(None, None);
        assert!(configs.merged(Some(&project)).agent("mine").is_some());

        fs::write(&file, "{\n  \"version\": 1,\n  \"agents\": {\n    \"mine\": {\"command\": }\n  }\n}\n").unwrap();
        assert!(configs.reload(&project));
        let merged = configs.merged(Some(&project));
        assert!(merged.agent("mine").is_some(), "the last valid config stays");
        assert_eq!(merged.errors.len(), 1);
        assert!(merged.errors[0].contains("agents.json:4:"), "{}", merged.errors[0]);

        fs::write(&file, r#"{"version":1,"agents":{}}"#).unwrap();
        assert!(configs.reload(&project));
        let merged = configs.merged(Some(&project));
        assert!(merged.agent("mine").is_none() && merged.errors.is_empty());
        assert!(!configs.reload(&project), "nothing changed");
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn what_the_project_runs_needs_trust_and_never_reads_the_keychain() {
        let user = parse(
            Path::new("user.json"),
            r#"{"version":1,"agents":{"codex":{"command":"npx","args":["codex-acp"]},"claude":{"command":"npx"}}}"#,
        )
        .unwrap();
        let project = parse(
            Path::new("project.json"),
            r#"{"version":1,"agents":{
                "codex":{"name":"Codex here"},
                "repo":{"command":"./run-agent"},
                "claude":{"args":["-y","something-else"]},
                "thief":{"command":"curl","env":{"K":"${keychain:openai}"}}
            }}"#,
        )
        .unwrap();
        let merged = merge(&[&user], Some(&project));
        assert!(!merged.needs_trust("codex"), "a name from the project runs nothing new");
        assert!(merged.needs_trust("repo"));
        assert!(merged.needs_trust("claude"), "the project changed the user's args");
        assert!(merged.agent("thief").is_none());
        assert!(merged.errors.iter().any(|e| e.contains("thief") && e.contains("keychain")), "{:?}", merged.errors);

        let user_only = merge(&[&user], None);
        assert!(!user_only.needs_trust("claude") && !user_only.needs_trust("codex"));

        let with_mcp = parse(
            Path::new("project.json"),
            r#"{"version":1,"mcpServers":[{"name":"x","command":"x","args":[],"env":[]}]}"#,
        )
        .unwrap();
        let merged = merge(&[&user], Some(&with_mcp));
        assert!(merged.needs_trust("claude"), "the project's MCP servers start with any agent");
        assert_eq!(merged.launch("claude").unwrap().mcp_servers.len(), 1);
    }

    #[test]
    fn trust_is_kept_per_project_and_launch() {
        let base = temp_project("trust");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let file = project.join(".brama/agents.json");
        fs::write(&file, r#"{"version":1,"agents":{"repo":{"command":"./run-agent"}}}"#).unwrap();
        let trust_file = base.join("data/trusted-agents.json");
        let configs = AgentConfigs::new(None, Some(trust_file.clone()));
        let launch = configs.merged(Some(&project)).launch("repo").unwrap();
        assert!(!configs.is_trusted(&project, &launch));

        configs.trust(&project, std::slice::from_ref(&launch)).unwrap();
        assert!(configs.is_trusted(&project, &launch));
        assert!(!configs.is_trusted(&base.join("other"), &launch), "per project");
        assert!(AgentConfigs::new(None, Some(trust_file)).is_trusted(&project, &launch), "kept on disk");

        fs::write(&file, r#"{"version":1,"agents":{"repo":{"command":"./other-agent"}}}"#).unwrap();
        configs.reload(&project);
        let changed = configs.merged(Some(&project)).launch("repo").unwrap();
        assert!(!configs.is_trusted(&project, &changed), "a changed command needs trust again");
        assert!(configs.trust(&project, &[launch]).is_err(), "only what the file says now can be trusted");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn untrusted_lists_the_project_agents_waiting_for_trust() {
        let base = temp_project("untrusted");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let user_file = base.join("user.json");
        fs::write(&user_file, r#"{"version":1,"agents":{"mine":{"command":"mine"}}}"#).unwrap();
        fs::write(
            project.join(".brama/agents.json"),
            r#"{"version":1,"agents":{"repo":{"name":"Repo","command":"./run-agent","args":["--acp"]},"other":{"command":"./other"}}}"#,
        )
        .unwrap();
        let configs = AgentConfigs::new(Some(user_file), None);

        let waiting = configs.untrusted(&project);
        let ids: Vec<&str> = waiting.iter().map(|u| u.launch.agent_id.as_str()).collect();
        assert_eq!(ids, ["other", "repo"], "the user's own agent runs nothing the project chose");
        assert_eq!(waiting[1].name, "Repo");
        assert_eq!(waiting[1].launch.args, ["--acp"]);

        let launches: Vec<LaunchConfig> = waiting.into_iter().map(|u| u.launch).collect();
        configs.trust(&project, &launches).unwrap();
        assert!(configs.untrusted(&project).is_empty(), "all trusted at once");

        let mut stale = launches.clone();
        stale[0].command = "./something-else".to_owned();
        assert!(configs.trust(&project, &stale).is_err(), "one changed launch refuses them all");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn unknown_fields_and_versions_are_errors() {
        assert!(parse(Path::new("a.json"), r#"{"version":2}"#).unwrap_err().contains("unsupported version 2"));
        assert!(parse(Path::new("a.json"), r#"{"version":1,"agents":{"a":{"comand":"x"}}}"#).is_err());
    }

    #[test]
    fn an_agent_without_a_command_is_reported() {
        let file = parse(Path::new("a.json"), r#"{"version":1,"agents":{"half":{"name":"Half"}}}"#).unwrap();
        let merged = merge(&[&file], None);
        assert!(merged.agents.is_empty());
        assert_eq!(merged.errors, ["agent \"half\" has no command"]);
    }

    #[test]
    fn editable_file_is_created_once_for_the_user_and_the_project() {
        let base = temp_project("editable");
        let configs = AgentConfigs::new(Some(base.join("config/brama/agents.json")), None);
        let user = configs.editable_file(None).unwrap();
        assert_eq!(fs::read_to_string(&user).unwrap(), DEFAULT_AGENTS);
        fs::write(&user, "{\"version\":1,\"agents\":{\"u\":{\"command\":\"u\"}}}").unwrap();
        configs.editable_file(None).unwrap();
        assert!(fs::read_to_string(&user).unwrap().contains("\"u\""), "not overwritten");
        assert!(configs.reload_user());
        assert!(configs.merged(None).agent("u").is_some());

        let project = base.join("p");
        fs::create_dir_all(&project).unwrap();
        let file = configs.editable_file(Some(&project)).unwrap();
        assert_eq!(file, project.join(".brama/agents.json"));
        assert_eq!(project_of_agents_file(&file), Some(project.as_path()));
        assert_eq!(project_of_agents_file(&project.join("agents.json")), None);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn local_and_agents_paths() {
        assert!(is_local_path(".brama/local") && is_local_path(".brama/local/x.json"));
        assert!(!is_local_path(".brama/locale") && !is_local_path(".brama/agents.json") && !is_local_path("local"));
        assert!(is_agents_path(".brama/agents.json") && is_agents_path(".brama"));
        assert!(!is_agents_path(".brama/workspace.json"));
    }
}
