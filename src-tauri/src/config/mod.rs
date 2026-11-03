//! Agent configuration: a project's agents are its `.brama/agents.json`; the user's
//! `<config dir>/brama/agents.json` is the agents of no project. Nothing is configured by default. The last valid
//! version of each file is kept, so a typo mid-edit doesn't drop the agents.

pub mod cli;
pub mod env;
pub mod registry;
pub mod switches;
pub mod update;
pub mod view;
pub mod watch;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};

/// Tauri event after a project's agents.json changed on disk: `{ projectPath }`.
pub const AGENTS_CHANGED_EVENT: &str = "agents://changed";
/// How a sign-in goes (`agents_sign_in`): `{ projectPath, agentId, state, message, terminal }`.
pub const AGENTS_SIGN_IN_EVENT: &str = "agents://sign-in";

pub const DIR: &str = ".brama";
pub const AGENTS_FILE: &str = "agents.json";
/// Per-user, untracked state inside `.brama/`; the snapshot never shows it.
pub const LOCAL_DIR: &str = "local";

const DEFAULT_AGENTS: &str = "{\n  \"version\": 1,\n  \"agents\": {}\n}\n";
const DEFAULT_WORKSPACE: &str = "{\n  \"version\": 1,\n  \"defaultMode\": \"worktree\"\n}\n";
/// What older versions wrote for every project: its `local` was never the user's choice, so it reads as unset.
const LEGACY_DEFAULT_WORKSPACE: &str = "{\n  \"version\": 1,\n  \"defaultMode\": \"local\"\n}\n";
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
pub struct ProjectSettings {
    /// Run target a new session starts with: `local` or `worktree`.
    pub default_mode: String,
    pub local_turns: LocalTurns,
}

/// How turns of a project's local sessions share its checkout.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalTurns {
    /// One at a time; the others wait for it.
    #[default]
    Queue,
    /// At once, in the same checkout.
    Parallel,
}

/// The project's workspace.json; a missing, invalid or unknown setting is the default (`worktree`).
/// Blocking.
pub fn project_settings(project: &Path) -> ProjectSettings {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct File {
        version: u32,
        default_mode: Option<String>,
        // Any JSON, so an odd value of it doesn't lose the other settings.
        local_turns: Option<serde_json::Value>,
    }
    let unset = || File { version: 1, default_mode: None, local_turns: None };
    let path = project.join(DIR).join(WORKSPACE_FILE);
    let parsed = match fs::read_to_string(&path) {
        Ok(text) if text == LEGACY_DEFAULT_WORKSPACE => Ok(unset()),
        Ok(text) => serde_json::from_str::<File>(&text).map_err(|e| format!("{}:{}:{}: {e}", path.display(), e.line(), e.column())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(unset()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    };
    let file = match parsed {
        Ok(file) if file.version == 1 => file,
        Ok(File { version, .. }) => {
            tracing::info!("{}: unsupported version {version} (expected 1)", path.display());
            unset()
        }
        Err(e) => {
            tracing::info!("{e}");
            unset()
        }
    };
    let default_mode = file.default_mode.filter(|m| m == "local" || m == "worktree");
    let local_turns = match file.local_turns {
        Some(serde_json::Value::String(s)) if s == "parallel" => LocalTurns::Parallel,
        _ => LocalTurns::Queue,
    };
    ProjectSettings { default_mode: default_mode.unwrap_or_else(|| "worktree".to_owned()), local_turns }
}

/// One agent as configured. `env` values are templates (`${env:NAME}`, `${keychain:name}`),
/// resolved only when the agent starts, so no secret is held here.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// agents.json's `cli`: how its own CLI runs, over the one known for what it runs (`cli::cli_for`).
    pub cli: Option<cli::CliOverride>,
    /// The project's agents.json sets its command, args, env or cli: cloning a repo must not be enough
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
    /// agents.json's `cli`: running it in a terminal runs this too. Absent when unset, so a launch
    /// trusted before it existed stays trusted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<cli::CliOverride>,
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

/// Which agents.json chose what an agent runs.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    User,
    Project,
}

/// What the agent list shows: no environment.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    pub scope: Scope,
    /// The version installed: the one its args pin, else `agentInfo.version` from its last
    /// `initialize` (the latter only for an agent the registry doesn't list).
    pub version: Option<String>,
    /// The ACP registry's entry it runs (`registry::match_launch`), `None`: a custom agent.
    pub registry_id: Option<String>,
    /// A newer version the registry has.
    pub update: Option<registry::AgentUpdate>,
    /// Not turned off by the user (`switches`): only these are offered and started.
    pub enabled: bool,
    /// It asked to sign in (at a start, a prompt or a probe) and hasn't since; set by
    /// `Sessions::agent_list`.
    pub sign_in: bool,
    /// What it runs, for Settings' edit form; never its environment.
    pub command: String,
    pub args: Vec<String>,
    /// Whether a session of it can continue in its own CLI, in a terminal; `None`: it has none.
    pub terminal: Option<cli::TerminalMode>,
}

/// An agent added in Settings: written to the user's agents.json. A known agent runs its own
/// launch unless `command` replaces it, and is named after itself when `name` is blank.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAgent {
    #[serde(default)]
    pub name: String,
    /// A registry agent's id (`KnownAgent`).
    #[serde(default, alias = "registry")]
    pub known: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentList {
    pub agents: Vec<AgentSummary>,
    /// The file's default when it's on, else the first agent that's on.
    pub default_agent: Option<String>,
    /// The registry's agents Settings offers to add, pinned to its versions.
    pub known: Vec<registry::KnownAgent>,
    /// With a project open: the agents of the user's own file it lacks, which only apply with no
    /// project open; Settings offers to copy them in (`import_user_agents`).
    pub user_agents: Vec<AgentSummary>,
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
    /// Agents the user turned off in this scope: listed, never started.
    pub off: BTreeSet<String>,
}

impl Merged {
    /// An agent of the file, on or off.
    pub fn agent(&self, id: &str) -> Option<&AgentConfig> {
        self.agents.iter().find(|a| a.id == id)
    }

    /// An agent that may be started: in the file and not turned off.
    pub fn enabled(&self, id: &str) -> Option<&AgentConfig> {
        self.agent(id).filter(|a| !self.off.contains(&a.id))
    }

    /// Turns `off` off; a default that's off gives way to the first agent that's on.
    fn turn_off(&mut self, off: BTreeSet<String>) {
        self.off = off;
        if self.default_agent.as_ref().is_none_or(|id| self.off.contains(id)) {
            self.default_agent = self.agents.iter().find(|a| !self.off.contains(&a.id)).map(|a| a.id.clone());
        }
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
            cli: a.cli.clone(),
        })
    }

    /// Every agent, by id.
    pub fn list(&self) -> AgentList {
        let summary = |a: &AgentConfig| AgentSummary {
            id: a.id.clone(),
            name: a.name.clone(),
            scope: if a.from_project { Scope::Project } else { Scope::User },
            version: None,
            registry_id: None,
            update: None,
            enabled: !self.off.contains(&a.id),
            sign_in: false,
            command: a.command.clone(),
            args: a.args.clone(),
            terminal: cli::cli_for(crate::agents::standard(), a, &BTreeMap::new()).map(|spec| spec.mode()),
        };
        let mut agents: Vec<AgentSummary> = self.agents.iter().map(summary).collect();
        agents.sort_by(|a, b| a.id.cmp(&b.id));
        AgentList {
            agents,
            default_agent: self.default_agent.clone(),
            known: Vec::new(),
            user_agents: Vec::new(),
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

/// Every field optional: a project entry may only override part of a user-level agent.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentEntry {
    name: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<BTreeMap<String, String>>,
    cli: Option<cli::CliOverride>,
    /// From when agents could be turned off: read, ignored and reported, so such a file still loads.
    #[serde(default)]
    disabled: Option<serde_json::Value>,
}

impl AgentEntry {
    /// `self` over `base`, field by field.
    fn over(self, base: AgentEntry) -> AgentEntry {
        AgentEntry {
            name: self.name.or(base.name),
            command: self.command.or(base.command),
            args: self.args.or(base.args),
            env: self.env.or(base.env),
            cli: self.cli.or(base.cli),
            disabled: self.disabled.or(base.disabled),
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
            let sets_launch = entry.command.is_some() || entry.args.is_some() || entry.env.is_some() || entry.cli.is_some();
            let merged = match entries.remove(id) {
                Some(base) => Layered {
                    entry: entry.clone().over(base.entry),
                    from_project: base.from_project || (is_project && sets_launch),
                },
                None => Layered {
                    entry: entry.clone(),
                    from_project: is_project && sets_launch,
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
    let mut agents = Vec::new();
    for (id, Layered { entry, from_project }) in entries {
        if entry.disabled.is_some() {
            errors.push(format!("agent {id:?}: \"disabled\" is no longer supported; remove the agent instead"));
        }
        match entry.command.filter(|command| !command.trim().is_empty()) {
            Some(command) => agents.push(AgentConfig {
                name: entry.name.unwrap_or_else(|| id.clone()),
                id,
                command,
                args: entry.args.unwrap_or_default(),
                env: entry.env.unwrap_or_default(),
                cli: entry.cli,
                from_project,
            }),
            None => errors.push(format!("agent {id:?} has no command")),
        }
    }
    let default_agent = default_agent
        .filter(|id| agents.iter().any(|a| &a.id == id))
        .or_else(|| agents.first().map(|a| a.id.clone()));
    let project_mcp = mcp.iter().any(|(_, from_project)| *from_project);
    let mcp_servers = mcp.into_iter().map(|(server, _)| server).collect();
    Merged { agents, default_agent, mcp_servers, project_mcp, errors, off: BTreeSet::new() }
}

/// Changes an agents.json as JSON, keeping the rest of it and its key order. Refused while the
/// file doesn't parse: the user may be in the middle of editing it.
fn edit_file(
    path: &Path,
    change: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<(), String>,
) -> Result<(), String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => DEFAULT_AGENTS.to_owned(),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    parse(path, &text).map_err(|e| format!("{e}; fix agents.json first"))?;
    let mut value: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let root = value.as_object_mut().ok_or_else(|| format!("{}: not an object", path.display()))?;
    change(root)?;
    let mut out = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    out.push('\n');
    crate::session::env::write_atomic(path, out.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
}

/// The `agents` object of an agents.json, added when missing.
fn agents_of(root: &mut serde_json::Map<String, serde_json::Value>) -> Result<&mut serde_json::Map<String, serde_json::Value>, String> {
    root.entry("agents")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(|| "\"agents\" is not an object".to_owned())
}

/// An id from a name: lowercase letters, digits and dashes (`Codex` → `gemini-cli`).
fn slug(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() { "agent".to_owned() } else { slug.to_owned() }
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
    /// `agent-versions.json` beside `trust_file`.
    versions_file: Option<Arc<crate::storage::JsonFile>>,
    /// `agent-switches.json` beside `trust_file`.
    switches_file: Option<Arc<crate::storage::JsonFile>>,
    /// The ACP registry: the agents to add, and the versions to update to.
    registry: registry::Registry,
    inner: Arc<Mutex<Inner>>,
    /// Held by each change of an agents.json, from its read to its reload: two at once would
    /// each write over the other's.
    edits: Arc<Mutex<()>>,
}

#[derive(Default)]
struct Inner {
    user: FileState,
    projects: HashMap<PathBuf, FileState>,
    trusted: Vec<TrustedLaunch>,
    /// Agent id → `agentInfo.version` from its last `initialize`.
    versions: BTreeMap<String, String>,
    switches: switches::Switches,
    /// What `remove_agent` took out, by token, until `restore_agent` puts it back.
    removed: HashMap<u64, Removed>,
    next_token: u64,
}

/// An agents.json entry `remove_agent` took out, and where it was.
struct Removed {
    file: PathBuf,
    project: Option<PathBuf>,
    id: String,
    entry: serde_json::Value,
    position: usize,
    /// It was turned off; it comes back off.
    off: bool,
}

/// An agent whose launch `pin_versions` pinned to the registry's version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pinned {
    pub agent_id: String,
    pub name: String,
    /// What downloads it ahead of the agent's next start (its crate's `Agent::update`).
    pub download: agent_api::Command,
    pub version: String,
}

/// A removal `restore_agent` can undo with `token`; `project` is whose file changed (`None`: the user's).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub token: u64,
    #[serde(skip)]
    pub project: Option<PathBuf>,
}

/// A `NewAgent` with its launch decided.
struct Resolved {
    name: String,
    command: String,
    args: Vec<String>,
    known: Option<registry::KnownAgent>,
}

/// A registry agent runs its pinned launch unless `command` replaces it, and takes its name when
/// none is given.
fn resolve(agent: &NewAgent, known: &[registry::KnownAgent]) -> Result<Resolved, String> {
    let known = match agent.known.as_deref() {
        Some(id) => Some(known.iter().find(|k| k.id == id).cloned().ok_or_else(|| format!("no known agent {id}"))?),
        None => None,
    };
    let name = match (agent.name.trim(), &known) {
        ("", Some(known)) => known.name.clone(),
        (name, _) => name.to_owned(),
    };
    let (command, args) = match (agent.command.as_deref(), &known) {
        (Some(command), _) => (command.trim().to_owned(), agent.args.clone()),
        (None, Some(known)) => (known.command.clone(), known.args.clone()),
        (None, None) => (String::new(), Vec::new()),
    };
    if name.is_empty() {
        return Err("an agent needs a name".to_owned());
    }
    if command.is_empty() {
        return Err("an agent needs a command".to_owned());
    }
    Ok(Resolved { name, command, args, known })
}

/// Writes an entry's name and launch, keeping its other fields.
fn set_launch(entry: &mut serde_json::Map<String, serde_json::Value>, agent: &Resolved) {
    entry.insert("name".to_owned(), agent.name.as_str().into());
    entry.insert("command".to_owned(), agent.command.as_str().into());
    if agent.args.is_empty() {
        entry.remove("args");
    } else {
        entry.insert("args".to_owned(), agent.args.clone().into());
    }
}

impl AgentConfigs {
    pub fn new(user_file: Option<PathBuf>, trust_file: Option<PathBuf>) -> AgentConfigs {
        let beside = |name: &str| {
            trust_file.as_ref().and_then(|path| path.parent()).map(|dir| Arc::new(crate::storage::JsonFile::new(dir.join(name))))
        };
        let versions_file = beside("agent-versions.json");
        let switches_file = beside("agent-switches.json");
        let versions = versions_file.as_ref().map(|file| file.load()).unwrap_or_default();
        let switches = switches_file.as_ref().map(|file| file.load::<switches::Switches>().loaded()).unwrap_or_default();
        let trust_file = trust_file.map(|path| Arc::new(crate::storage::JsonFile::new(path)));
        let trusted = trust_file.as_ref().map(|file| file.load()).unwrap_or_default();
        let inner = Inner { trusted, versions, switches, ..Inner::default() };
        AgentConfigs {
            user_file,
            trust_file,
            versions_file,
            switches_file,
            registry: registry::Registry::empty(),
            inner: Arc::new(Mutex::new(inner)),
            edits: Arc::default(),
        }
    }

    /// Checks versions against `registry` and offers its agents (none by default).
    pub fn with_registry(mut self, registry: registry::Registry) -> AgentConfigs {
        self.registry = registry;
        self
    }

    pub fn registry(&self) -> &registry::Registry {
        &self.registry
    }

    /// The agent list of `project` (`None`: the user's agents only), with their versions and the
    /// registry's updates.
    pub fn list(&self, project: Option<&Path>) -> AgentList {
        let mut list = self.merged(project).list();
        if project.is_some() {
            let own = self.merged(None).list().agents;
            list.user_agents = own.into_iter().filter(|a| !list.agents.iter().any(|p| p.id == a.id)).collect();
        }
        let entries = self.registry.agents();
        list.known = entries.iter().map(registry::RegistryAgent::known).collect();
        let inner = self.lock();
        for agent in list.agents.iter_mut().chain(&mut list.user_agents) {
            let reported = inner.versions.get(&agent.id).map(String::as_str);
            match registry::match_launch(&entries, &agent.command, &agent.args) {
                Some(matched) => {
                    agent.update = registry::update_of(&matched, reported);
                    agent.version = matched.pinned.clone().or_else(|| reported.map(str::to_owned));
                    agent.registry_id = Some(matched.agent.id.clone());
                }
                None => agent.version = reported.map(str::to_owned),
            }
        }
        list
    }

    /// The Agents tab's data for `project` (`None`: the user's agents): `query` and `filter`
    /// applied, `updating` telling which agents an update is running for.
    pub fn view(&self, project: Option<&Path>, query: &str, filter: view::Filter, state: view::RowState<'_>) -> view::AgentsView {
        let list = self.list(project);
        let reported = self.lock().versions.keys().cloned().collect::<BTreeSet<_>>();
        view::build(view::Inputs {
            list,
            registry: &self.registry.agents(),
            registry_state: self.registry.state(),
            reported: &|id| reported.contains(id),
            updating: state.updating,
            sign_in: state.sign_in,
            query,
            filter,
        })
    }

    /// Keeps the version an agent reported in `initialize`. Returns whether it changed.
    pub fn note_version(&self, agent_id: &str, version: &str) -> bool {
        let versions = {
            let mut inner = self.lock();
            if inner.versions.get(agent_id).is_some_and(|v| v == version) {
                return false;
            }
            inner.versions.insert(agent_id.to_owned(), version.to_owned());
            inner.versions.clone()
        };
        if let Some(file) = &self.versions_file {
            if let Err(e) = file.save(&versions) {
                tracing::info!("agent versions not kept: {e}");
            }
        }
        true
    }

    /// Turns an agent of the project's agents.json (the user's without a project) on or off for
    /// this user; the file isn't touched. Returns the project whose agents changed.
    pub fn set_enabled(&self, project: Option<&Path>, agent_id: &str, enabled: bool) -> Result<Option<PathBuf>, String> {
        if self.merged(project).agent(agent_id).is_none() {
            return Err(format!("unknown agent \"{agent_id}\""));
        }
        let changed = self.lock().switches.set(project, agent_id, enabled);
        if changed {
            tracing::info!(agent = %agent_id, enabled, "agent switched");
            self.save_switches();
        }
        Ok(project.map(Path::to_path_buf))
    }

    fn save_switches(&self) {
        let switches = self.lock().switches.clone();
        if let Some(file) = &self.switches_file {
            if let Err(e) = file.save(&switches) {
                tracing::warn!("agent switches not kept: {e}");
            }
        }
    }

    /// Adds a supported registry agent (an agent crate names its registry id, `AgentHub::for_registry_id`), with the registry's pinned launch,
    /// to the open project's `.brama/agents.json`, trusting it, or without a project to the user's
    /// agents.json. Returns its id, unique in that file: the agent's own, else made from the name.
    pub fn add_agent(&self, project: Option<&Path>, agent: &NewAgent) -> Result<String, String> {
        let _editing = self.editing();
        if agent.known.is_none() {
            return Err("only Claude, Codex, Copilot or Antigravity can be added".to_owned());
        }
        if agent.command.is_some() {
            return Err("an added agent runs the registry's launch; edit it to change that".to_owned());
        }
        let chosen = resolve(agent, &self.registry.known())?;
        let file = self.file_of(project)?;
        let mut base = slug(&chosen.name);
        let mut id = base.clone();
        edit_file(&file, |root| {
            let agents = agents_of(root)?;
            // A registry agent under its own name keeps its id, numbered when taken (`gemini-2`).
            if let Some(known) = chosen.known.as_ref().filter(|k| !agents.contains_key(&k.id) || agent.name.trim().is_empty()) {
                base.clone_from(&known.id);
                id = base.clone();
            }
            let mut n = 1;
            while agents.contains_key(&id) {
                n += 1;
                id = format!("{base}-{n}");
            }
            let mut entry = serde_json::Map::new();
            set_launch(&mut entry, &chosen);
            agents.insert(id.clone(), entry.into());
            Ok(())
        })?;
        tracing::info!(agent = %id, "agent added");
        self.reload_and_trust(project, &id, &chosen)?;
        Ok(id)
    }

    /// Re-reads the file just written (the project's, else the user's) and trusts what `agent_id`
    /// runs now only when that is exactly what the user chose in Settings: `chosen`'s command and
    /// args, with no env and no project MCP servers. Anything else the file adds (an `env` the entry
    /// kept, the repository's `mcpServers`) is left for the trust dialog.
    fn reload_and_trust(&self, project: Option<&Path>, agent_id: &str, chosen: &Resolved) -> Result<(), String> {
        let Some(project) = project else {
            self.reload_user();
            return Ok(());
        };
        self.reload(project);
        let merged = self.merged(Some(project));
        let Some(launch) = merged.launch(agent_id).filter(|_| merged.needs_trust(agent_id)) else { return Ok(()) };
        let only_chosen = launch.command == chosen.command
            && launch.args == chosen.args
            && launch.env.is_empty()
            && launch.mcp_servers.is_empty();
        if only_chosen {
            self.trust(project, &[launch])
        } else {
            tracing::info!(agent = %agent_id, "agents.json adds env or MCP servers to what was chosen: not trusted");
            Ok(())
        }
    }

    /// The agents.json that holds `project`'s agents: its `.brama/agents.json` (created when
    /// missing), or the user's without a project.
    fn file_of(&self, project: Option<&Path>) -> Result<PathBuf, String> {
        match project {
            Some(project) => self.editable_file(Some(project)),
            None => self.user_file.clone().ok_or_else(|| "this system has no config folder".to_owned()),
        }
    }

    /// Re-reads the file `file_of(project)` names.
    fn reload_file(&self, project: Option<&Path>) {
        match project {
            Some(project) => self.reload(project),
            None => self.reload_user(),
        };
    }

    /// Copies the user's own agents the project lacks (by id) that run a supported registry agent,
    /// whole entries, into its agents.json, and trusts them: the user wrote them. One that the
    /// project's MCP servers would start with is left for the trust dialog. `ids`: only those.
    /// Returns the ids copied.
    pub fn import_user_agents(&self, project: &Path, ids: Option<&[String]>) -> Result<Vec<String>, String> {
        let _editing = self.editing();
        let supported: Vec<String> =
            self.list(Some(project)).user_agents.into_iter().filter(|a| a.registry_id.is_some()).map(|a| a.id).collect();
        let user_file = self.user_file.clone().ok_or("this system has no config folder")?;
        let text = fs::read_to_string(&user_file).map_err(|e| format!("{}: {e}", user_file.display()))?;
        parse(&user_file, &text)?;
        let mut user: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let own = user.get_mut("agents").and_then(serde_json::Value::as_object_mut).map(std::mem::take).unwrap_or_default();
        let mut copied = Vec::new();
        edit_file(&self.file_of(Some(project))?, |root| {
            let agents = agents_of(root)?;
            for (id, entry) in own {
                if !agents.contains_key(&id) && supported.contains(&id) && ids.is_none_or(|ids| ids.contains(&id)) {
                    agents.insert(id.clone(), entry);
                    copied.push(id);
                }
            }
            Ok(())
        })?;
        self.reload(project);
        let merged = self.merged(Some(project));
        let launches: Vec<_> =
            copied.iter().filter_map(|id| merged.launch(id)).filter(|launch| launch.mcp_servers.is_empty()).collect();
        if !launches.is_empty() {
            self.trust(project, &launches)?;
        }
        tracing::info!(project = %project.display(), agents = ?copied, "the user's agents copied into the project");
        Ok(copied)
    }

    /// Pins agents of the project's agents.json (the user's without one) to the registry's newer
    /// version: `agent_id`'s, else every agent with an update. One write, in place, key order kept;
    /// refused while the file doesn't parse. A project's launch that was trusted stays trusted
    /// when the pin is all that changed. Returns what it pinned (nothing: up to date).
    pub fn pin_versions(&self, project: Option<&Path>, agent_id: Option<&str>) -> Result<Vec<Pinned>, String> {
        let _editing = self.editing();
        let entries = self.registry.agents();
        let merged = self.merged(project);
        // Only an agent its crate updates (an `npx` one) has an update: the pin and the download.
        let hub = crate::agents::standard();
        let targets: Vec<(AgentSummary, String, agent_api::Update)> = self
            .list(project)
            .agents
            .into_iter()
            .filter(|a| agent_id.is_none_or(|id| a.id == id))
            .filter_map(|a| {
                let to = a.update.as_ref()?.to.clone();
                registry::match_launch(&entries, &a.command, &a.args)?;
                let update = hub.for_launch(&crate::agents::launch_of_parts(&a.command, &a.args)).update(&a.args, &to)?;
                Some((a, to, update))
            })
            .collect();
        if targets.is_empty() {
            return Ok(Vec::new());
        }
        let was_trusted: Vec<Option<LaunchConfig>> = targets
            .iter()
            .map(|(a, _, _)| {
                let launch = merged.launch(&a.id)?;
                let trusted = project.is_some_and(|p| merged.needs_trust(&a.id) && self.is_trusted(p, &launch));
                trusted.then_some(launch)
            })
            .collect();
        edit_file(&self.file_of(project)?, |root| {
            let agents = agents_of(root)?;
            for (agent, to, update) in &targets {
                let args = agents
                    .get_mut(&agent.id)
                    .and_then(|entry| entry.get_mut("args"))
                    .and_then(serde_json::Value::as_array_mut)
                    .ok_or_else(|| format!("agent \"{}\" has no args to pin", agent.id))?;
                let (at, arg) = &update.pin;
                let slot = args.get_mut(*at).ok_or_else(|| format!("agent \"{}\" can't be pinned to {to}", agent.id))?;
                *slot = arg.as_str().into();
            }
            Ok(())
        })?;
        self.reload_file(project);
        let pinned: Vec<Pinned> = targets
            .iter()
            .map(|(a, to, update)| Pinned { agent_id: a.id.clone(), name: a.name.clone(), download: update.download.clone(), version: to.clone() })
            .collect();
        for p in &pinned {
            tracing::info!(agent = %p.agent_id, version = %p.version, "agent pinned to the registry's version");
        }
        if let Some(project) = project {
            let now = self.merged(Some(project));
            let carried: Vec<LaunchConfig> = targets
                .iter()
                .zip(&was_trusted)
                .zip(&pinned)
                .filter_map(|(((_, _, update), before), pin)| {
                    let mut expected = before.clone()?;
                    let (at, arg) = &update.pin;
                    *expected.args.get_mut(*at)? = arg.clone();
                    now.launch(&pin.agent_id).filter(|launch| *launch == expected)
                })
                .collect();
            if !carried.is_empty() {
                self.trust(project, &carried)?;
            }
        }
        Ok(pinned)
    }

    /// Rewrites an agent's name and launch, keeping the rest of its entry; a project's new launch
    /// is trusted. Returns the project whose file changed.
    pub fn update_agent(&self, project: Option<&Path>, agent_id: &str, agent: &NewAgent) -> Result<Option<PathBuf>, String> {
        let _editing = self.editing();
        let resolved = resolve(agent, &self.registry.known())?;
        let file = self.file_of(project)?;
        edit_file(&file, |root| {
            let entry = agents_of(root)?
                .get_mut(agent_id)
                .and_then(serde_json::Value::as_object_mut)
                .ok_or_else(|| format!("unknown agent \"{agent_id}\""))?;
            set_launch(entry, &resolved);
            Ok(())
        })?;
        tracing::info!(agent = %agent_id, "agent edited");
        self.reload_and_trust(project, agent_id, &resolved)?;
        Ok(project.map(Path::to_path_buf))
    }

    /// Makes an agent the default for new sessions: in the project's agents.json, or the user's
    /// without a project. Returns the project whose file changed.
    pub fn set_default(&self, project: Option<&Path>, agent_id: &str) -> Result<Option<PathBuf>, String> {
        let _editing = self.editing();
        let merged = self.merged(project);
        let Some(agent) = merged.agent(agent_id) else { return Err(format!("unknown agent \"{agent_id}\"")) };
        if merged.enabled(agent_id).is_none() {
            return Err(format!("{} is off; turn it on first", agent.name));
        }
        let file = self.file_of(project)?;
        edit_file(&file, |root| {
            match root.get_mut("defaultAgent") {
                Some(value) => *value = agent_id.into(),
                // Beside `version`, where people write it.
                None => {
                    root.shift_insert(1.min(root.len()), "defaultAgent".to_owned(), agent_id.into());
                }
            }
            Ok(())
        })?;
        tracing::info!(agent = %agent_id, "default agent set");
        self.reload_file(project);
        Ok(project.map(Path::to_path_buf))
    }

    /// Removes an agent's entry from the project's agents.json (the user's without a project).
    /// `restore_agent(token)` puts it back.
    pub fn remove_agent(&self, project: Option<&Path>, agent_id: &str) -> Result<Removal, String> {
        let _editing = self.editing();
        let file = self.file_of(project)?;
        let off = self.lock().switches.is_off(project, agent_id);
        let mut before = None;
        edit_file(&file, |root| {
            let agents = agents_of(root)?;
            let position = agents.keys().position(|k| k == agent_id).ok_or_else(|| format!("unknown agent \"{agent_id}\""))?;
            before = agents.shift_remove(agent_id).map(|entry| (entry, position));
            Ok(())
        })?;
        tracing::info!(agent = %agent_id, "agent removed");
        self.reload_file(project);
        let (entry, position) = before.ok_or_else(|| format!("unknown agent \"{agent_id}\""))?;
        let project = project.map(Path::to_path_buf);
        let removed = Removed { file, project: project.clone(), id: agent_id.to_owned(), entry, position, off };
        let mut inner = self.lock();
        inner.next_token += 1;
        let token = inner.next_token;
        inner.removed.insert(token, removed);
        Ok(Removal { token, project })
    }

    /// Undoes a `remove_agent`: its entry back as it was, where it was. Returns the project whose
    /// file changed.
    pub fn restore_agent(&self, token: u64) -> Result<Option<PathBuf>, String> {
        let _editing = self.editing();
        let removed = self.lock().removed.remove(&token).ok_or("nothing to restore")?;
        edit_file(&removed.file, |root| {
            let agents = agents_of(root)?;
            agents.shift_remove(&removed.id);
            agents.shift_insert(removed.position.min(agents.len()), removed.id.clone(), removed.entry.clone());
            Ok(())
        })?;
        tracing::info!(agent = %removed.id, "agent restored");
        if removed.off && self.lock().switches.set(removed.project.as_deref(), &removed.id, false) {
            self.save_switches();
        }
        self.reload_file(removed.project.as_deref());
        Ok(removed.project)
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
            .filter(|a| merged.enabled(&a.id).is_some() && merged.needs_trust(&a.id))
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

    /// Re-reads the user-level file only (`watch::watch_user_file` calls it on every change on disk).
    /// Returns whether it changed.
    pub fn reload_user(&self) -> bool {
        let Some(user_file) = &self.user_file else { return false };
        let mut inner = self.lock();
        let changed = inner.user.reload(user_file);
        if changed {
            if let Some(error) = &inner.user.error {
                tracing::warn!("agents.json: {error}");
            }
            let pruned = inner.prune(None);
            drop(inner);
            if pruned {
                self.save_switches();
            }
        }
        changed
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// One change of an agents.json at a time (`edits`).
    fn editing(&self) -> std::sync::MutexGuard<'_, ()> {
        self.edits.lock().unwrap_or_else(PoisonError::into_inner)
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
            let pruned = inner.prune(None) | inner.prune(Some(project));
            drop(inner);
            if pruned {
                self.save_switches();
            }
        }
        changed
    }

    /// The config of `project` (its file only), read from disk on first use; `None`: no project open, the
    /// user's agents only.
    pub fn merged(&self, project: Option<&Path>) -> Merged {
        match project {
            Some(project) if !self.lock().projects.contains_key(project) => {
                self.reload(project);
            }
            None => {
                self.reload_user();
            }
            Some(_) => {}
        }
        let inner = self.lock();
        // A project's agents are what its agents.json lists, nothing else; the user's file is
        // the agents of no project.
        let (layers, project_state): (Vec<_>, _) = match project {
            Some(project) => (Vec::new(), inner.projects.get(project)),
            None => (inner.user.last_valid.iter().collect(), None),
        };
        let mut merged = merge(&layers, project_state.and_then(|state| state.last_valid.as_ref()));
        let error = match project {
            Some(_) => project_state.and_then(|state| state.error.as_ref()),
            None => inner.user.error.as_ref(),
        };
        merged.errors.splice(0..0, error.cloned());
        merged.turn_off(inner.switches.off(project));
        merged
    }
}

impl Inner {
    /// Drops the switches of agents that left the scope's file (its last valid version). A file
    /// that never parsed, or isn't there (a checkout of a branch without it), says nothing about
    /// its agents.
    fn prune(&mut self, project: Option<&Path>) -> bool {
        let state = match project {
            Some(project) => self.projects.get(project),
            None => Some(&self.user),
        };
        let Some(file) = state.and_then(|s| s.last_valid.as_ref()) else { return false };
        let ids: BTreeSet<String> = file.agents.keys().cloned().collect();
        self.switches.prune(project, |id| ids.contains(id))
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

    /// Agent configs whose registry is `registry::tests::FIXTURE`.
    fn with_fixture(user_file: Option<PathBuf>, trust_file: Option<PathBuf>) -> AgentConfigs {
        AgentConfigs::new(user_file, trust_file).with_registry(registry::Registry::of(registry::tests::FIXTURE))
    }

    fn temp_project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brama-config-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn project_settings_fall_back_to_worktree() {
        let project = temp_project("project-settings");
        assert_eq!(project_settings(&project).default_mode, "worktree", "no file");
        ensure_project_dir(&project).unwrap();
        assert_eq!(project_settings(&project).default_mode, "worktree", "the default file");
        let file = project.join(".brama/workspace.json");
        fs::write(&file, r#"{"version":1,"defaultMode":"local"}"#).unwrap();
        assert_eq!(project_settings(&project).default_mode, "local");
        fs::write(&file, LEGACY_DEFAULT_WORKSPACE).unwrap();
        assert_eq!(project_settings(&project).default_mode, "worktree", "the file older versions wrote");
        for invalid in [r#"{"version":1,"defaultMode":"cloud"}"#, "{ not json", r#"{"version":2,"defaultMode":"local"}"#] {
            fs::write(&file, invalid).unwrap();
            assert_eq!(project_settings(&project).default_mode, "worktree", "{invalid}");
        }
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn local_turns_queue_unless_the_project_says_parallel() {
        let project = temp_project("local-turns");
        assert_eq!(project_settings(&project).local_turns, LocalTurns::Queue, "no file");
        ensure_project_dir(&project).unwrap();
        assert_eq!(project_settings(&project).local_turns, LocalTurns::Queue, "the default file");
        let file = project.join(".brama/workspace.json");
        fs::write(&file, r#"{"version":1,"defaultMode":"local","localTurns":"parallel"}"#).unwrap();
        assert_eq!(project_settings(&project), ProjectSettings { default_mode: "local".into(), local_turns: LocalTurns::Parallel });
        for other in [r#""queue""#, r#""both""#, "3", "null"] {
            fs::write(&file, format!(r#"{{"version":1,"defaultMode":"local","localTurns":{other}}}"#)).unwrap();
            let settings = project_settings(&project);
            assert_eq!(settings.local_turns, LocalTurns::Queue, "{other}");
            assert_eq!(settings.default_mode, "local", "{other} keeps the rest");
        }
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn creates_defaults_once_and_never_overwrites() {
        let project = temp_project("defaults");
        ensure_project_dir(&project).unwrap();
        let agents = project.join(".brama/agents.json");
        assert_eq!(fs::read_to_string(&agents).unwrap(), DEFAULT_AGENTS);
        assert!(fs::read_to_string(project.join(".brama/workspace.json")).unwrap().contains("\"defaultMode\": \"worktree\""));
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
    fn project_overrides_user() {
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
                "codex":{"args":["-y","codex-acp@2"]}
            },"mcpServers":[{"name":"docs","command":"docs-mcp-v2","args":[],"env":[]}]}"#,
        )
        .unwrap();
        let merged = merge(&[&user], Some(&project));
        let ids: Vec<_> = merged.agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["codex", "gemini"]);
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
    fn what_the_project_runs_needs_trust() {
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
        assert!(merged.needs_trust("thief"), "a keychain item only once its launch is trusted");
        assert_eq!(merged.launch("thief").unwrap().env["K"], "${keychain:openai}", "shown to the user as asked");

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
    fn a_cli_entry_is_part_of_what_is_trusted() {
        let base = temp_project("trust-cli");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let file = project.join(".brama/agents.json");
        let user = r#"{"version":1,"agents":{"claude":{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp"]}}}"#;
        let user_file = base.join("user.json");
        fs::write(&user_file, user).unwrap();
        fs::write(&file, user).unwrap();
        let configs = AgentConfigs::new(Some(user_file), Some(base.join("data/trusted-agents.json")));
        let launch = configs.merged(Some(&project)).launch("claude").unwrap();
        assert_eq!(launch.cli, None);
        assert!(!serde_json::to_string(&launch).unwrap().contains("\"cli\""), "a launch trusted before `cli` existed reads the same");
        configs.trust(&project, std::slice::from_ref(&launch)).unwrap();

        fs::write(&file, r#"{"version":1,"agents":{"claude":{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp"],
            "cli":{"command":"./evil","resumeArgs":["{id}"]}}}}"#).unwrap();
        configs.reload(&project);
        let merged = configs.merged(Some(&project));
        let changed = merged.launch("claude").unwrap();
        assert_eq!(changed.cli.as_ref().and_then(|c| c.command.as_deref()), Some("./evil"));
        assert!(!configs.is_trusted(&project, &changed), "a cli the file sets needs trust again");
        assert_eq!(merged.agent("claude").unwrap().cli, changed.cli);

        let user_cli = parse(Path::new("user.json"), r#"{"version":1,"agents":{"x":{"command":"x","cli":{"resumeArgs":["{id}"]}}}}"#).unwrap();
        let project_name = parse(Path::new("project.json"), r#"{"version":1,"agents":{"x":{"name":"X"}}}"#).unwrap();
        let project_cli = parse(Path::new("project.json"), r#"{"version":1,"agents":{"x":{"cli":{"resumeArgs":["{id}"]}}}}"#).unwrap();
        assert!(!merge(&[&user_cli], Some(&project_name)).needs_trust("x"), "the user's cli needs no trust");
        assert!(merge(&[&user_cli], Some(&project_cli)).needs_trust("x"), "the project's does");
        assert!(parse(Path::new("a.json"), r#"{"version":1,"agents":{"x":{"command":"x","cli":{"args":[]}}}}"#).is_err(), "resumeArgs is required");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn the_list_says_which_agents_have_a_terminal_mode() {
        let file = parse(
            Path::new("user.json"),
            r#"{"version":1,"agents":{
                "claude":{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp@0.99.1"]},
                "codex":{"command":"npx","args":["-y","@agentclientprotocol/codex-acp@2.5.0"]},
                "agy":{"command":"agy_acp_server.par"}
            }}"#,
        )
        .unwrap();
        let list = merge(&[&file], None).list();
        let modes: Vec<_> = list.agents.iter().map(|a| (a.id.as_str(), a.terminal)).collect();
        assert_eq!(
            modes,
            [
                ("agy", None),
                ("claude", Some(cli::TerminalMode { resume: true, new: true })),
                ("codex", Some(cli::TerminalMode { resume: true, new: false })),
            ]
        );
        let json = serde_json::to_value(&list.agents[1]).unwrap();
        assert_eq!(json["terminal"], serde_json::json!({ "resume": true, "new": true }));
        assert_eq!(serde_json::to_value(&list.agents[0]).unwrap()["terminal"], serde_json::Value::Null);
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
    fn the_list_shows_every_agent_and_where_it_comes_from_and_disabled_is_only_reported() {
        let user = parse(
            Path::new("user.json"),
            r#"{"version":1,"agents":{"a":{"name":"A","command":"a"},"b":{"command":"b"}}}"#,
        )
        .unwrap();
        let project = parse(Path::new("project.json"), r#"{"version":1,"agents":{"repo":{"name":"Repo","command":"./run"}}}"#).unwrap();
        let list = merge(&[&user], Some(&project)).list();
        let shown: Vec<_> = list.agents.iter().map(|a| (a.id.as_str(), a.scope)).collect();
        assert_eq!(shown, [("a", Scope::User), ("b", Scope::User), ("repo", Scope::Project)]);
        assert_eq!(list.default_agent.as_deref(), Some("a"));

        // Files from when agents could be turned off still load: the agent is listed, the field reported.
        let off = parse(Path::new("agents.json"), r#"{"version":1,"agents":{"a":{"command":"a","disabled":true}}}"#).unwrap();
        let merged = merge(&[&off], None);
        assert_eq!(merged.agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["a"]);
        assert_eq!(merged.errors, [r#"agent "a": "disabled" is no longer supported; remove the agent instead"#]);
    }

    #[test]
    fn add_agent_writes_the_users_file_and_keeps_what_it_had() {
        let base = temp_project("add");
        let user_file = base.join("config/brama/agents.json");
        let configs = with_fixture(Some(user_file.clone()), None);
        let agent = NewAgent { known: Some("codex-acp".into()), ..Default::default() };
        assert_eq!(configs.add_agent(None, &agent).unwrap(), "codex-acp", "creates the file");
        assert_eq!(configs.merged(None).agent("codex-acp").unwrap().args, ["-y", "@agentclientprotocol/codex-acp@0.65.0", "--acp"]);

        fs::write(
            &user_file,
            "{\n  \"version\": 1,\n  \"defaultAgent\": \"codex-acp\",\n  \"agents\": {\n    \"codex-acp\": {\"command\": \"codex-acp\"}\n  },\n  \"mcpServers\": []\n}\n",
        )
        .unwrap();
        assert_eq!(configs.add_agent(None, &agent).unwrap(), "codex-acp-2", "ids stay unique");
        let text = fs::read_to_string(&user_file).unwrap();
        let keys: Vec<_> = ["\"version\"", "\"defaultAgent\"", "\"agents\"", "\"mcpServers\""]
            .iter()
            .map(|k| text.find(k).unwrap())
            .collect();
        assert!(keys.windows(2).all(|w| w[0] < w[1]), "keys keep their order:\n{text}");
        let merged = configs.merged(None);
        assert_eq!(merged.agent("codex-acp-2").unwrap().name, "Codex");
        assert!(merged.agent("codex-acp").is_some());

        fs::write(&user_file, "{ \"version\": 1, oops").unwrap();
        assert!(configs.add_agent(None, &agent).unwrap_err().contains("agents.json"), "an invalid file is never overwritten");
        assert_eq!(fs::read_to_string(&user_file).unwrap(), "{ \"version\": 1, oops");

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn with_a_project_open_an_agent_is_added_to_its_file_and_trusted() {
        let base = temp_project("add-project");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let user_file = base.join("user.json");
        let configs = with_fixture(Some(user_file.clone()), None);
        let pick = NewAgent { known: Some("claude-acp".into()), ..Default::default() };

        assert_eq!(configs.add_agent(Some(&project), &pick).unwrap(), "claude-acp");
        let text = fs::read_to_string(project.join(".brama/agents.json")).unwrap();
        assert!(text.contains("\"claude-acp\"") && text.contains("@agentclientprotocol/claude-agent-acp@0.94.0"), "pinned: {text}");
        assert!(!user_file.exists(), "the user's file is left alone");
        let merged = configs.merged(Some(&project));
        assert!(merged.needs_trust("claude-acp"));
        assert!(configs.untrusted(&project).is_empty(), "the user chose what it runs");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn the_users_own_agents_are_offered_to_a_project_and_copied_into_it() {
        let base = temp_project("import");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let user_file = base.join("user.json");
        fs::write(
            &user_file,
            r#"{"version":1,"agents":{"mine":{"name":"Mine","command":"mine","env":{"K":"${keychain:k}"}},"both":{"command":"user"}}}"#,
        )
        .unwrap();
        let project_file = project.join(".brama/agents.json");
        fs::write(&project_file, r#"{"version":1,"agents":{"both":{"command":"project"}}}"#).unwrap();
        let configs = with_fixture(Some(user_file.clone()), None);
        let offered = |project: Option<&Path>| configs.list(project).user_agents.into_iter().map(|a| a.id).collect::<Vec<_>>();

        assert_eq!(offered(Some(&project)), ["mine"], "only those the project lacks");
        assert!(offered(None).is_empty(), "nothing to offer without a project");

        fs::write(&user_file, r#"{"version":1,"agents":{"mine":{"name":"Mine","command":"mine","env":{"K":"${keychain:k}"}},"both":{"command":"user"},"other":{"command":"other"}}}"#).unwrap();
        assert!(configs.import_user_agents(&project, None).unwrap().is_empty(), "custom commands aren't copied");
        let gemini = r#""gemini":{"name":"Gemini","command":"npx","args":["-y","@agentclientprotocol/codex-acp","--acp"]}"#;
        fs::write(&user_file, format!(r#"{{"version":1,"agents":{{{gemini},"mine":{{"name":"Mine","command":"npx","args":["@github/copilot","--acp"],"env":{{"K":"${{keychain:k}}"}}}},"both":{{"command":"user"}}}}}}"#)).unwrap();
        assert_eq!(configs.import_user_agents(&project, Some(&["gemini".to_owned()])).unwrap(), ["gemini"], "only the one asked for");
        assert_eq!(configs.import_user_agents(&project, None).unwrap(), ["mine"]);
        let merged = configs.merged(Some(&project));
        let mine = merged.agent("mine").unwrap();
        assert_eq!((mine.name.as_str(), mine.env["K"].as_str()), ("Mine", "${keychain:k}"), "the whole entry");
        assert_eq!(merged.agent("both").unwrap().command, "project", "the project's own stays");
        assert!(configs.untrusted(&project).iter().all(|u| u.launch.agent_id != "mine"), "the user's own: trusted");
        assert!(offered(Some(&project)).is_empty());
        assert!(configs.import_user_agents(&project, None).unwrap().is_empty(), "nothing left to copy");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn settings_trusts_only_what_the_user_chose() {
        let base = temp_project("trust-chosen");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let project_file = project.join(".brama/agents.json");
        fs::write(
            &project_file,
            r#"{"version":1,"agents":{"repo":{"command":"./run","env":{"T":"${keychain:github}"}}},
                "mcpServers":[{"name":"evil","command":"curl","args":[],"env":[]}]}"#,
        )
        .unwrap();
        let configs = with_fixture(None, None);
        let waiting = |configs: &AgentConfigs| configs.untrusted(&project).into_iter().map(|u| u.launch.agent_id).collect::<Vec<_>>();

        let pick = NewAgent { known: Some("codex-acp".into()), ..Default::default() };
        configs.add_agent(Some(&project), &pick).unwrap();
        assert!(waiting(&configs).contains(&"codex-acp".to_owned()), "the repo's MCP servers start with it: the dialog asks");

        fs::write(&project_file, r#"{"version":1,"agents":{"repo":{"command":"./run","env":{"T":"${keychain:github}"}}}}"#).unwrap();
        configs.reload(&project);
        let rename = NewAgent { name: "Repo".into(), command: Some("./run".into()), ..Default::default() };
        configs.update_agent(Some(&project), "repo", &rename).unwrap();
        assert!(waiting(&configs).contains(&"repo".to_owned()), "a keychain read the user didn't write isn't trusted");

        let id = configs.add_agent(Some(&project), &pick).unwrap();
        assert!(!waiting(&configs).contains(&id), "only what the user chose: trusted");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_edit_rewrites_the_entry_and_keeps_the_rest() {
        let base = temp_project("edit");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let user_file = base.join("user.json");
        fs::write(&user_file, r#"{"version":1,"agents":{"mine":{"command":"old","args":["-x"],"env":{"K":"${env:K}"}}}}"#).unwrap();
        let project_file = project.join(".brama/agents.json");
        fs::write(&project_file, r#"{"version":1,"agents":{"repo":{"command":"./run","env":{"K":"${env:K}"}}}}"#).unwrap();
        let configs = with_fixture(Some(user_file.clone()), None);

        let repo = NewAgent { name: "Repo".into(), known: Some("codex-acp".into()), ..Default::default() };
        assert_eq!(configs.update_agent(Some(&project), "repo", &repo).unwrap(), Some(project.clone()));
        let merged = configs.merged(Some(&project));
        let edited = merged.agent("repo").unwrap();
        assert_eq!(edited.name, "Repo");
        assert_eq!(edited.args, ["-y", "@agentclientprotocol/codex-acp@0.65.0", "--acp"]);
        assert_eq!(edited.env.get("K").map(String::as_str), Some("${env:K}"), "the rest is kept");
        let waiting: Vec<_> = configs.untrusted(&project).into_iter().map(|u| u.launch.agent_id).collect();
        assert_eq!(waiting, ["repo"], "its env wasn't the user's choice: the trust dialog asks");

        let mine = NewAgent { name: "Mine".into(), command: Some("new".into()), ..Default::default() };
        assert!(configs.update_agent(Some(&project), "mine", &mine).is_err(), "not the project's");
        assert_eq!(configs.update_agent(None, "mine", &mine).unwrap(), None);
        let merged = configs.merged(None);
        let edited = merged.agent("mine").unwrap();
        assert_eq!((edited.name.as_str(), edited.command.as_str()), ("Mine", "new"));
        assert!(edited.args.is_empty(), "args went with the old command");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn the_default_agent_is_set_in_the_open_projects_file() {
        let base = temp_project("default");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        fs::write(project.join(".brama/agents.json"), r#"{"version":1,"agents":{"a":{"command":"a"},"b":{"command":"b"}}}"#).unwrap();
        let user_file = base.join("user.json");
        fs::write(&user_file, r#"{"version":1,"defaultAgent":"a","agents":{"a":{"command":"a"},"b":{"command":"b"}}}"#).unwrap();
        let configs = AgentConfigs::new(Some(user_file.clone()), None);

        assert_eq!(configs.set_default(Some(&project), "b").unwrap(), Some(project.clone()));
        assert_eq!(configs.list(Some(&project)).default_agent.as_deref(), Some("b"));
        assert_eq!(configs.list(None).default_agent.as_deref(), Some("a"), "the user's file keeps its own");
        assert_eq!(configs.set_default(None, "b").unwrap(), None);
        assert_eq!(configs.list(None).default_agent.as_deref(), Some("b"));
        assert!(configs.set_default(None, "nope").is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_removed_agent_leaves_the_file_and_comes_back_where_it_was() {
        let base = temp_project("remove");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let user_file = base.join("user.json");
        fs::write(&user_file, r#"{"version":1,"agents":{"a":{"command":"a"},"b":{"command":"b","env":{"K":"v"}},"c":{"command":"c"}}}"#).unwrap();
        let project_file = project.join(".brama/agents.json");
        fs::write(&project_file, r#"{"version":1,"agents":{"repo":{"command":"./run"},"last":{"command":"./last"}}}"#).unwrap();
        let configs = AgentConfigs::new(Some(user_file.clone()), None);
        let ids = |project: Option<&Path>| configs.list(project).agents.into_iter().map(|a| a.id).collect::<Vec<_>>();

        let removed = configs.remove_agent(Some(&project), "repo").unwrap();
        assert_eq!(removed.project.as_deref(), Some(project.as_path()));
        assert_eq!(ids(Some(&project)), ["last"], "gone");
        assert!(!fs::read_to_string(&project_file).unwrap().contains("repo"));
        configs.restore_agent(removed.token).unwrap();
        let text = fs::read_to_string(&project_file).unwrap();
        assert!(text.find("\"repo\"").unwrap() < text.find("\"last\"").unwrap(), "back in its place:\n{text}");
        assert!(configs.restore_agent(removed.token).is_err(), "once");

        let gone = configs.remove_agent(None, "b").unwrap();
        assert_eq!(gone.project, None);
        assert_eq!(ids(None), ["a", "c"]);
        configs.restore_agent(gone.token).unwrap();
        let merged = configs.merged(None);
        assert_eq!(merged.agent("b").unwrap().env.get("K").map(String::as_str), Some("v"), "all of it");
        let text = fs::read_to_string(&user_file).unwrap();
        assert!(text.find("\"b\"").unwrap() < text.find("\"c\"").unwrap(), "{text}");

        assert!(configs.remove_agent(Some(&project), "a").is_err(), "not the project's");
        assert!(configs.remove_agent(None, "nope").is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_registry_agent_is_added_with_its_pinned_launch_unless_the_command_replaces_it() {
        let base = temp_project("known");
        let user_file = base.join("agents.json");
        let configs = with_fixture(Some(user_file.clone()), None);
        let listed = configs.list(None).known;
        assert_eq!(listed.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(), ["claude-acp", "codex-acp", "github-copilot-cli", "antigravity-acp"], "the supported registry agents");
        let codex = &listed[1];

        let pick = NewAgent { known: Some("codex-acp".into()), ..Default::default() };
        assert_eq!(configs.add_agent(None, &pick).unwrap(), "codex-acp", "its own id, its own name");
        let merged = configs.merged(None);
        let added = merged.agent("codex-acp").unwrap();
        assert_eq!((added.name.as_str(), added.command.as_str()), ("Codex", "npx"));
        assert_eq!(added.args, codex.args);

        let named = NewAgent { name: "Codex Pro".into(), known: Some("codex-acp".into()), ..Default::default() };
        assert_eq!(configs.add_agent(None, &named).unwrap(), "codex-pro", "the id is taken: from the name");

        let custom = NewAgent { known: Some("codex-acp".into()), command: Some("codex-acp".into()), ..Default::default() };
        assert!(configs.add_agent(None, &custom).unwrap_err().contains("registry's launch"), "no custom command");
        let any = NewAgent { name: "X".into(), command: Some("x".into()), ..Default::default() };
        assert!(configs.add_agent(None, &any).unwrap_err().contains("Claude, Codex, Copilot or Antigravity"), "no custom agent");
        let unknown = NewAgent { known: Some("nope".into()), ..Default::default() };
        assert!(configs.add_agent(None, &unknown).unwrap_err().contains("nope"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_projects_agents_are_its_files_and_only_those() {
        let base = temp_project("only-project");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let user_file = base.join("user.json");
        fs::write(&user_file, r#"{"version":1,"defaultAgent":"mine","agents":{"mine":{"command":"mine"},"both":{"command":"user"}}}"#).unwrap();
        let project_file = project.join(".brama/agents.json");
        fs::write(&project_file, r#"{"version":1,"agents":{"both":{"command":"project"},"repo":{"command":"./run"}}}"#).unwrap();
        let configs = AgentConfigs::new(Some(user_file.clone()), None);
        let ids = |project: Option<&Path>| configs.list(project).agents.into_iter().map(|a| a.id).collect::<Vec<_>>();

        assert_eq!(ids(Some(&project)), ["both", "repo"], "nothing from the user's file");
        assert_eq!(configs.merged(Some(&project)).agent("both").unwrap().command, "project");
        assert_ne!(configs.list(Some(&project)).default_agent.as_deref(), Some("mine"), "nor its default");
        assert_eq!(ids(None), ["both", "mine"], "the user's file is the agents of no project");

        fs::write(&project_file, r#"{"version":1,"agents":{}}"#).unwrap();
        configs.reload(&project);
        assert!(ids(Some(&project)).is_empty(), "an empty file, an empty list");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn versions_are_listed_and_kept() {
        let base = temp_project("versions");
        let user_file = base.join("user.json");
        fs::write(&user_file, r#"{"version":1,"agents":{"mine":{"command":"mine"}}}"#).unwrap();
        let trust_file = base.join("data/trusted-agents.json");
        let configs = AgentConfigs::new(Some(user_file.clone()), Some(trust_file.clone()));
        assert_eq!(configs.list(None).agents[0].version, None);
        assert!(configs.note_version("mine", "0.9.2"));
        assert!(!configs.note_version("mine", "0.9.2"), "unchanged");
        assert_eq!(configs.list(None).agents[0].version.as_deref(), Some("0.9.2"));
        let again = AgentConfigs::new(Some(user_file), Some(trust_file));
        assert_eq!(again.list(None).agents[0].version.as_deref(), Some("0.9.2"), "kept on disk");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_agent_turned_off_is_listed_off_and_never_the_default() {
        let base = temp_project("switch");
        let user_file = base.join("user.json");
        fs::write(&user_file, r#"{"version":1,"defaultAgent":"b","agents":{"a":{"command":"a"},"b":{"command":"b"},"c":{"command":"c"}}}"#).unwrap();
        let trust_file = base.join("data/trusted-agents.json");
        let configs = AgentConfigs::new(Some(user_file.clone()), Some(trust_file.clone()));
        let enabled = |configs: &AgentConfigs| configs.list(None).agents.into_iter().map(|a| (a.id, a.enabled)).collect::<Vec<_>>();

        assert_eq!(configs.set_enabled(None, "b", false).unwrap(), None);
        assert_eq!(enabled(&configs), [("a".into(), true), ("b".into(), false), ("c".into(), true)], "listed, off");
        let merged = configs.merged(None);
        assert!(merged.agent("b").is_some() && merged.enabled("b").is_none(), "kept, not to be started");
        assert_eq!(merged.default_agent.as_deref(), Some("a"), "the first agent that's on");
        assert!(fs::read_to_string(&user_file).unwrap().contains("\"defaultAgent\":\"b\""), "agents.json isn't touched");
        assert!(configs.set_default(None, "b").is_err(), "an agent that's off can't be the default");

        let again = AgentConfigs::new(Some(user_file), Some(trust_file));
        assert_eq!(enabled(&again)[1], ("b".into(), false), "kept in app data");
        configs.set_enabled(None, "a", false).unwrap();
        configs.set_enabled(None, "c", false).unwrap();
        assert_eq!(configs.list(None).default_agent, None, "all off: no default");
        configs.set_enabled(None, "b", true).unwrap();
        assert_eq!(configs.list(None).default_agent.as_deref(), Some("b"), "the file's default once it's on");
        assert!(configs.set_enabled(None, "nope", false).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_switch_is_per_project_and_goes_with_its_agent() {
        let base = temp_project("switch-prune");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let project_file = project.join(".brama/agents.json");
        let both = r#"{"version":1,"agents":{"repo":{"command":"./run"},"other":{"command":"./other"}}}"#;
        fs::write(&project_file, both).unwrap();
        let user_file = base.join("user.json");
        fs::write(&user_file, r#"{"version":1,"agents":{"repo":{"command":"./run"}}}"#).unwrap();
        let configs = AgentConfigs::new(Some(user_file), None);
        let is_on = |project: Option<&Path>, id: &str| configs.list(project).agents.into_iter().find(|a| a.id == id).unwrap().enabled;

        assert_eq!(configs.set_enabled(Some(&project), "repo", false).unwrap(), Some(project.clone()));
        assert!(!is_on(Some(&project), "repo"));
        assert!(is_on(None, "repo"), "the user's file is another scope");

        fs::write(&project_file, r#"{"version":1,"agents":{"other":{"command":"./other"}}}"#).unwrap();
        configs.reload(&project);
        fs::write(&project_file, both).unwrap();
        configs.reload(&project);
        assert!(is_on(Some(&project), "repo"), "an id that left the file keeps no switch");

        configs.set_enabled(Some(&project), "repo", false).unwrap();
        let removed = configs.remove_agent(Some(&project), "repo").unwrap();
        configs.restore_agent(removed.token).unwrap();
        assert!(!is_on(Some(&project), "repo"), "Undo brings the switch back with the entry");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_deleted_agents_file_keeps_the_switches() {
        let project = temp_project("switch-deleted");
        ensure_project_dir(&project).unwrap();
        let project_file = project.join(".brama/agents.json");
        let text = r#"{"version":1,"agents":{"repo":{"command":"./run"}}}"#;
        fs::write(&project_file, text).unwrap();
        let configs = AgentConfigs::new(None, None);
        configs.set_enabled(Some(&project), "repo", false).unwrap();

        // A checkout of a branch without the file, and back.
        fs::remove_file(&project_file).unwrap();
        configs.reload(&project);
        fs::write(&project_file, text).unwrap();
        configs.reload(&project);
        assert!(configs.merged(Some(&project)).off.contains("repo"), "still off");
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn agents_added_at_once_are_all_kept() {
        let base = temp_project("add-at-once");
        let configs = with_fixture(Some(base.join("agents.json")), None);
        let pick = NewAgent { known: Some("codex-acp".into()), ..Default::default() };
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (configs, pick) = (configs.clone(), pick.clone());
                std::thread::spawn(move || configs.add_agent(None, &pick).unwrap())
            })
            .collect();
        let mut ids: Vec<String> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 8, "each got its own id: {ids:?}");
        assert_eq!(configs.merged(None).agents.len(), 8, "none lost");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_agent_that_is_off_waits_for_no_trust() {
        let project = temp_project("switch-trust");
        ensure_project_dir(&project).unwrap();
        fs::write(project.join(".brama/agents.json"), r#"{"version":1,"agents":{"repo":{"command":"./run"},"other":{"command":"./other"}}}"#).unwrap();
        let configs = AgentConfigs::new(None, None);
        configs.set_enabled(Some(&project), "repo", false).unwrap();
        let waiting: Vec<_> = configs.untrusted(&project).into_iter().map(|u| u.launch.agent_id).collect();
        assert_eq!(waiting, ["other"]);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn registry_agents_show_the_version_installed_and_the_update_there_is() {
        let base = temp_project("updates");
        let user_file = base.join("user.json");
        fs::write(
            &user_file,
            r#"{"version":1,"agents":{
                "old":{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp@0.90.0"]},
                "current":{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp@0.94.0"]},
                "loose":{"command":"npx","args":["-y","@agentclientprotocol/codex-acp","--acp"]},
                "ran":{"command":"npx","args":["-y","@agentclientprotocol/codex-acp","--acp"]},
                "custom":{"command":"./agent"}
            }}"#,
        )
        .unwrap();
        let configs = with_fixture(Some(user_file), None);
        configs.note_version("ran", "0.65.0");
        configs.note_version("custom", "3.1.0");
        configs.note_version("old", "0.1.0");
        let list = configs.list(None);
        let shown: BTreeMap<_, _> =
            list.agents.iter().map(|a| (a.id.as_str(), (a.registry_id.as_deref(), a.version.as_deref(), a.update.clone()))).collect();
        let update = |to: &str, pin| Some(registry::AgentUpdate { to: to.into(), pin });

        assert_eq!(shown["old"], (Some("claude-acp"), Some("0.90.0"), update("0.94.0", false)), "the pin, not what it reported");
        assert_eq!(shown["current"], (Some("claude-acp"), Some("0.94.0"), None));
        assert_eq!(shown["loose"], (Some("codex-acp"), None, update("0.65.0", true)), "unpinned, never ran: pin the latest");
        assert_eq!(shown["ran"], (Some("codex-acp"), Some("0.65.0"), None), "what it reported");
        assert_eq!(shown["custom"], (None, Some("3.1.0"), None), "not in the registry: no update");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_agent_run_from_path_is_the_users_to_update() {
        let base = temp_project("on-path");
        let user_file = base.join("user.json");
        fs::write(&user_file, r#"{"version":1,"agents":{"agy":{"name":"Antigravity","command":"agy_acp_server.par"}}}"#).unwrap();
        let configs = with_fixture(Some(user_file), None);
        configs.note_version("agy", "1.0.0");
        let agy = configs.list(None).agents.into_iter().find(|a| a.id == "agy").unwrap();
        assert_eq!((agy.registry_id.as_deref(), agy.version.as_deref()), (Some("antigravity-acp"), Some("1.0.0")));
        assert_eq!(agy.update, None, "the user installed it: no update offered");
        assert!(configs.pin_versions(None, Some("agy")).unwrap().is_empty());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_update_pins_the_registrys_version_in_place() {
        let base = temp_project("pin");
        let user_file = base.join("user.json");
        let text = "{\n  \"version\": 1,\n  \"agents\": {\n    \"claude\": {\n      \"name\": \"Claude\",\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"@agentclientprotocol/claude-agent-acp@0.90.0\", \"--debug\"],\n      \"env\": {\"K\": \"v\"}\n    },\n    \"gem\": {\"command\": \"npx\", \"args\": [\"-y\", \"@agentclientprotocol/codex-acp\", \"--acp\"]},\n    \"custom\": {\"command\": \"./agent\"}\n  },\n  \"mcpServers\": []\n}\n";
        fs::write(&user_file, text).unwrap();
        let configs = with_fixture(Some(user_file.clone()), None);

        let pinned = configs.pin_versions(None, Some("claude")).unwrap();
        assert_eq!(
            pinned,
            [Pinned {
                agent_id: "claude".into(),
                name: "Claude".into(),
                download: agent_kit::npm_prefetch("@agentclientprotocol/claude-agent-acp", "0.94.0"),
                version: "0.94.0".into()
            }]
        );
        let after: serde_json::Value = serde_json::from_str(&fs::read_to_string(&user_file).unwrap()).unwrap();
        let mut expected: serde_json::Value = serde_json::from_str(text).unwrap();
        expected["agents"]["claude"]["args"][1] = "@agentclientprotocol/claude-agent-acp@0.94.0".into();
        assert_eq!(after, expected, "only the pin changed");
        let keys: Vec<_> = after.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["version", "agents", "mcpServers"], "key order kept");
        assert_eq!(configs.list(None).agents.iter().find(|a| a.id == "claude").unwrap().update, None, "up to date");
        assert!(configs.pin_versions(None, Some("claude")).unwrap().is_empty(), "nothing left to update");
        assert!(configs.pin_versions(None, Some("custom")).unwrap().is_empty(), "not in the registry");

        let all = configs.pin_versions(None, None).unwrap();
        assert_eq!(
            all.iter().map(|p| p.download.args.last().map(String::as_str)).collect::<Vec<_>>(),
            [Some("@agentclientprotocol/codex-acp@0.65.0")],
            "every update: an unpinned one gets pinned"
        );
        assert_eq!(configs.merged(None).agent("gem").unwrap().args, ["-y", "@agentclientprotocol/codex-acp@0.65.0", "--acp"]);

        fs::write(
            &user_file,
            r#"{"version":1,"agents":{
                "wrapper":{"command":"npx","args":["-y","my-wrapper","--agent","@agentclientprotocol/codex-acp"]},
                "pkg":{"command":"npx","args":["--package=@agentclientprotocol/codex-acp@0.60.0","--","@agentclientprotocol/codex-acp","--acp"]}
            }}"#,
        )
        .unwrap();
        configs.reload_file(None);
        let all = configs.pin_versions(None, None).unwrap();
        assert_eq!(all.iter().map(|p| p.agent_id.as_str()).collect::<Vec<_>>(), ["pkg"], "a custom agent's argument isn't the package npx runs");
        let merged = configs.merged(None);
        assert_eq!(merged.agent("wrapper").unwrap().args, ["-y", "my-wrapper", "--agent", "@agentclientprotocol/codex-acp"], "left alone");
        assert_eq!(merged.agent("pkg").unwrap().args, ["--package=@agentclientprotocol/codex-acp@0.65.0", "--", "@agentclientprotocol/codex-acp", "--acp"], "the package pinned, the command not");

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_update_keeps_the_trust_of_what_it_replaced() {
        let base = temp_project("pin-trust");
        let project = base.join("p");
        ensure_project_dir(&project).unwrap();
        let project_file = project.join(".brama/agents.json");
        fs::write(
            &project_file,
            r#"{"version":1,"agents":{
                "trusted":{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp@0.90.0"]},
                "waiting":{"command":"npx","args":["-y","@agentclientprotocol/codex-acp@0.60.0","--acp"]}
            }}"#,
        )
        .unwrap();
        let configs = with_fixture(None, None);
        let trusted = configs.merged(Some(&project)).launch("trusted").unwrap();
        configs.trust(&project, &[trusted]).unwrap();

        let pinned = configs.pin_versions(Some(&project), None).unwrap();
        assert_eq!(pinned.len(), 2);
        let waiting: Vec<_> = configs.untrusted(&project).into_iter().map(|u| u.launch.agent_id).collect();
        assert_eq!(waiting, ["waiting"], "trusted before, trusted after; the other still waits");

        fs::write(&project_file, r#"{"version":1,"agents":{"trusted":{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp@0.91.0"]}}}"#).unwrap();
        configs.reload(&project);
        fs::write(&project_file, "{ oops").unwrap();
        configs.reload(&project);
        assert!(configs.pin_versions(Some(&project), None).unwrap_err().contains("fix agents.json first"), "an invalid file is refused");
        assert_eq!(fs::read_to_string(&project_file).unwrap(), "{ oops");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_registry_agent_added_twice_gets_its_id_with_a_number() {
        let base = temp_project("add-twice");
        let configs = with_fixture(Some(base.join("user.json")), None);
        let pick: NewAgent = serde_json::from_value(serde_json::json!({ "registry": "codex-acp" })).unwrap();
        assert_eq!(configs.add_agent(None, &pick).unwrap(), "codex-acp");
        assert_eq!(configs.add_agent(None, &pick).unwrap(), "codex-acp-2");
        assert_eq!(configs.merged(None).agent("codex-acp-2").unwrap().args, ["-y", "@agentclientprotocol/codex-acp@0.65.0", "--acp"], "pinned");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn the_agents_view_hides_the_registry_entries_installed_and_knows_who_ran() {
        let base = temp_project("view");
        let user_file = base.join("user.json");
        fs::write(&user_file, r#"{"version":1,"agents":{"mine":{"name":"Mine","command":"npx","args":["-y","@agentclientprotocol/codex-acp","--acp"]},"x":{"command":"x"}}}"#).unwrap();
        let configs = with_fixture(Some(user_file), None);
        configs.note_version("x", "1.0.0");
        configs.set_enabled(None, "mine", false).unwrap();
        let v = configs.view(None, "", view::Filter::All, view::RowState { updating: &|id| id == "mine", sign_in: &|_| None });
        let rows: Vec<_> = v.installed.iter().map(|r| (r.id.as_str(), r.status, r.updating)).collect();
        assert_eq!(rows, [("mine", view::Status::Off, true)], "x runs a custom command: not listed");
        assert_eq!(v.registry.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["claude-acp", "github-copilot-cli", "antigravity-acp"], "Codex is installed as Mine");
        assert_eq!(v.counts, view::Counts { all: 1, updates: 1, off: 1 });
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
