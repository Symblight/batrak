//! The ACP agent registry (`cdn.agentclientprotocol.com`): the agents Settings offers to add and
//! the versions installed agents are checked against. Nothing is bundled: it is fetched at the
//! first launch, the last body kept in app data (`acp-registry.json`) and checked again daily, with
//! its `ETag`; until it first answers the list is empty and a check is tried again every minute.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub use agent_api::{package_arg, split_spec};

/// The only URL this module fetches.
pub const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/// How old the last check may be before the next.
pub const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// How soon a registry that never answered is asked again.
pub const RETRY_EVERY: Duration = Duration::from_secs(60);
const TIMEOUT: Duration = Duration::from_secs(15);

/// One agent of the registry that Brama can run or show.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// Its authors, joined.
    pub vendor: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub launch: Launch,
}

/// How it runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Launch {
    Npx(Npx),
    Program(Program),
}

/// `npx -y <package>@<version> <args>`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Npx {
    pub package: String,
    pub version: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// A program the user installed, run from PATH as `<command> <args>`: the registry ships it as
/// an archive, which Brama doesn't download.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    /// The archive's `cmd` (`./agy_acp_server.par`) without its folder.
    pub command: String,
    pub args: Vec<String>,
    /// This platform's archive, for the user to download.
    pub archive: String,
}

/// The registry agents Brama offers; the registry's others are left out.
pub const SUPPORTED: [&str; 4] = ["claude-acp", "codex-acp", "github-copilot-cli", "antigravity-acp"];

/// This machine's key in the registry's `binary` map (`darwin-aarch64`, `windows-x86_64`…).
fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// A registry agent the Agents tab offers to add, with its pinned launch.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownAgent {
    /// Its registry id, also its id in agents.json when that's free.
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

impl RegistryAgent {
    /// What agents.json runs it with: `npx` with the package pinned to the registry's version, or
    /// the program on PATH.
    pub fn known(&self) -> KnownAgent {
        let (command, args) = match &self.launch {
            Launch::Npx(Npx { package, version, args, .. }) => {
                ("npx".to_owned(), ["-y".to_owned(), format!("{package}@{version}")].into_iter().chain(args.iter().cloned()).collect())
            }
            Launch::Program(program) => (program.command.clone(), program.args.clone()),
        };
        KnownAgent { id: self.id.clone(), name: self.name.clone(), command, args }
    }

    /// The registry's version of an `npx` agent; `None` for a program the user installed and updates.
    pub fn latest(&self) -> Option<&str> {
        match &self.launch {
            Launch::Npx(npx) => Some(&npx.version),
            Launch::Program(_) => None,
        }
    }

    /// What Add writes, for people.
    pub fn command_line(&self) -> String {
        let known = self.known();
        std::iter::once(known.command.as_str()).chain(known.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ")
    }
}

/// The registry's agents Brama offers (`SUPPORTED`), each with its `npx` launch or this
/// platform's archive; the others, and one that doesn't read, are left out.
pub fn parse(text: &str) -> Result<Vec<RegistryAgent>, String> {
    #[derive(Deserialize)]
    struct File {
        version: String,
        agents: Vec<serde_json::Value>,
    }
    #[derive(Deserialize)]
    struct Agent {
        id: String,
        name: String,
        version: String,
        #[serde(default)]
        description: String,
        #[serde(default)]
        authors: Vec<String>,
        repository: Option<String>,
        website: Option<String>,
        distribution: Dist,
    }
    #[derive(Deserialize)]
    struct Dist {
        npx: Option<NpxDist>,
        binary: Option<BTreeMap<String, BinaryDist>>,
    }
    #[derive(Deserialize)]
    struct BinaryDist {
        archive: String,
        cmd: String,
        #[serde(default)]
        args: Vec<String>,
    }
    #[derive(Deserialize)]
    struct NpxDist {
        package: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    }
    let file: File = serde_json::from_str(text).map_err(|e| format!("registry.json:{}:{}: {e}", e.line(), e.column()))?;
    if !file.version.starts_with("1.") {
        return Err(format!("registry.json: unsupported version {}", file.version));
    }
    let platform = platform();
    let mut agents = Vec::new();
    for value in file.agents {
        if !value.get("id").and_then(serde_json::Value::as_str).is_some_and(|id| SUPPORTED.contains(&id)) {
            continue;
        }
        let agent: Agent = match serde_json::from_value(value) {
            Ok(agent) => agent,
            Err(e) => {
                tracing::debug!("registry agent skipped: {e}");
                continue;
            }
        };
        let launch = match agent.distribution {
            Dist { npx: Some(npx), .. } => {
                let (package, version) = split_spec(&npx.package);
                Launch::Npx(Npx {
                    package: package.to_owned(),
                    version: version.unwrap_or(&agent.version).to_owned(),
                    args: npx.args,
                    env: npx.env,
                })
            }
            Dist { binary: Some(mut builds), .. } => match builds.remove(&platform) {
                Some(build) => {
                    let Some(command) = Path::new(&build.cmd).file_name().and_then(|n| n.to_str()) else { continue };
                    Launch::Program(Program { command: command.to_owned(), args: build.args, archive: build.archive })
                }
                None => {
                    tracing::debug!(agent = %agent.id, platform, "registry agent skipped: no build for this platform");
                    continue;
                }
            },
            _ => continue,
        };
        agents.push(RegistryAgent {
            id: agent.id,
            name: agent.name,
            version: agent.version,
            description: agent.description,
            vendor: agent.authors.join(", "),
            repository: agent.repository,
            website: agent.website,
            launch,
        });
    }
    Ok(agents)
}

/// An installed agent's registry entry, found by what it runs.
#[derive(Debug, Clone, PartialEq)]
pub struct Matched<'a> {
    pub agent: &'a RegistryAgent,
    /// The version its args pin, when that's a version (`@latest` isn't).
    pub pinned: Option<String>,
}

/// The registry agent a launch runs: its program on PATH (by name), or `npx` whose package
/// (`package_arg`) is the entry's, with or without `@version`. agents.json's ids aren't compared:
/// it names its agents as it likes.
pub fn match_launch<'a>(agents: &'a [RegistryAgent], command: &str, args: &[String]) -> Option<Matched<'a>> {
    if let Some(agent) = program_of(agents, command) {
        return Some(Matched { agent, pinned: None });
    }
    let launch = agent_api::Launch { command: command.to_owned(), args: args.to_vec() };
    let (_, package, version) = launch.npx_package()?;
    let agent = agents.iter().find(|a| matches!(&a.launch, Launch::Npx(npx) if npx.package == package))?;
    let pinned = version.filter(|v| parse_version(v).is_some()).map(str::to_owned);
    Some(Matched { agent, pinned })
}

/// The registry agent whose program on PATH `command` is (by file name).
fn program_of<'a>(agents: &'a [RegistryAgent], command: &str) -> Option<&'a RegistryAgent> {
    let name = Path::new(command).file_name()?;
    agents.iter().find(|a| matches!(&a.launch, Launch::Program(p) if name == p.command.as_str()))
}

/// What to tell the user when `command`, a registry agent's program on PATH, didn't start: it
/// isn't installed, and where to get it. `None` for anything else.
pub fn not_installed(agents: &[RegistryAgent], command: &str) -> Option<String> {
    let agent = program_of(agents, command)?;
    let Launch::Program(program) = &agent.launch else { return None };
    Some(format!(
        "{} isn't installed: download {}, unpack it and put {} on PATH, then restart Brama",
        agent.name, program.archive, program.command
    ))
}

fn parse_version(version: &str) -> Option<semver::Version> {
    semver::Version::parse(version.strip_prefix('v').unwrap_or(version)).ok()
}

/// A newer version the registry has for an installed agent.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdate {
    pub to: String,
    /// The installed version isn't known (an unpinned launch that never reported one): the update
    /// pins the registry's, offered as "Pin latest".
    pub pin: bool,
}

/// Whether the registry's version of `matched` is newer than the one installed: the version its
/// args pin, else `reported` (`agentInfo.version` from its last `initialize`).
pub fn update_of(matched: &Matched<'_>, reported: Option<&str>) -> Option<AgentUpdate> {
    let latest = matched.agent.latest()?.to_owned();
    let newest = parse_version(&latest)?;
    match matched.pinned.as_deref().or(reported) {
        Some(installed) => {
            let installed = parse_version(installed)?;
            (newest > installed).then(|| AgentUpdate { to: latest.clone(), pin: false })
        }
        None => Some(AgentUpdate { to: latest.clone(), pin: true }),
    }
}

/// What the last check of the registry found.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryState {
    /// When it last answered (ISO 8601), `None`: never.
    pub checked_at: Option<String>,
    /// The last check failed.
    pub offline: bool,
    pub checking: bool,
}

/// What a fetch of `REGISTRY_URL` got.
pub enum Fetched {
    NotModified,
    Body { text: String, etag: Option<String> },
}

/// Fetches the registry; blocking. Tests replace it, so they never reach the network.
pub trait Fetch: Send + Sync {
    fn fetch(&self, etag: Option<&str>) -> Result<Fetched, String>;
}

/// The registry over HTTPS (`ureq`, rustls).
pub struct Http;

impl Fetch for Http {
    fn fetch(&self, etag: Option<&str>) -> Result<Fetched, String> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .max_redirects(0)
            .build()
            .into();
        let mut request = agent.get(REGISTRY_URL);
        if let Some(etag) = etag {
            request = request.header("If-None-Match", etag);
        }
        let mut response = request.call().map_err(|e| e.to_string())?;
        match response.status().as_u16() {
            304 => Ok(Fetched::NotModified),
            200 => {
                let etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_owned);
                let text = response.body_mut().read_to_string().map_err(|e| e.to_string())?;
                Ok(Fetched::Body { text, etag })
            }
            status => Err(format!("HTTP {status}")),
        }
    }
}

/// No network: nothing is fetched.
struct Offline;

impl Fetch for Offline {
    fn fetch(&self, _etag: Option<&str>) -> Result<Fetched, String> {
        Err("no registry fetch configured".to_owned())
    }
}

/// `acp-registry.json` in app data.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    body: String,
    etag: Option<String>,
    /// Unix milliseconds.
    checked_at: Option<i64>,
}

struct State {
    agents: Arc<Vec<RegistryAgent>>,
    body: String,
    etag: Option<String>,
    checked_at: Option<i64>,
    /// When the last check ended, answered or not (Unix milliseconds).
    tried_at: Option<i64>,
    offline: bool,
    checking: bool,
}

struct Inner {
    cache: Option<crate::storage::JsonFile>,
    fetch: Arc<dyn Fetch>,
    state: Mutex<State>,
    /// Held by the check running; a second caller waits for it and takes its answer.
    check: tokio::sync::Mutex<()>,
    /// Checks finished.
    checks: AtomicU64,
}

/// The registry's agents and their last check. Cheap to clone.
#[derive(Clone)]
pub struct Registry {
    inner: Arc<Inner>,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

impl Registry {
    /// A registry of `text`, never fetched.
    #[cfg(test)]
    pub fn of(text: &str) -> Registry {
        let registry = Registry::empty();
        registry.lock().agents = Arc::new(parse(text).unwrap());
        registry
    }

    /// No agents, never fetched.
    pub fn empty() -> Registry {
        Registry::new(None, Arc::new(Offline))
    }

    /// The registry kept in `cache` (empty until a check answers), fetched with `fetch`.
    pub fn new(cache: Option<PathBuf>, fetch: Arc<dyn Fetch>) -> Registry {
        let cache = cache.map(crate::storage::JsonFile::new);
        let stored: CacheFile = cache.as_ref().map(|file| file.load()).unwrap_or_default();
        let state = match parse(&stored.body) {
            Ok(agents) => State {
                agents: Arc::new(agents),
                body: stored.body,
                etag: stored.etag,
                checked_at: stored.checked_at,
                tried_at: None,
                offline: false,
                checking: false,
            },
            Err(_) => State {
                agents: Arc::default(),
                body: String::new(),
                etag: None,
                checked_at: None,
                tried_at: None,
                offline: false,
                checking: false,
            },
        };
        let inner = Inner {
            cache,
            fetch,
            state: Mutex::new(state),
            check: tokio::sync::Mutex::new(()),
            checks: AtomicU64::new(0),
        };
        Registry { inner: Arc::new(inner) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn agents(&self) -> Arc<Vec<RegistryAgent>> {
        Arc::clone(&self.lock().agents)
    }

    /// The registry agents the add form offers, with their pinned launches.
    pub fn known(&self) -> Vec<KnownAgent> {
        self.agents().iter().map(RegistryAgent::known).collect()
    }

    pub fn state(&self) -> RegistryState {
        let state = self.lock();
        RegistryState {
            checked_at: state.checked_at.map(crate::session::iso_from_millis),
            offline: state.offline,
            checking: state.checking,
        }
    }

    /// Whether the last answer is older than `CHECK_EVERY`, or, with none yet, the last try is
    /// older than `RETRY_EVERY`.
    pub fn due(&self) -> bool {
        self.due_at(now_millis())
    }

    fn due_at(&self, now: i64) -> bool {
        let state = self.lock();
        match (state.checked_at, state.tried_at) {
            (Some(at), _) => now - at >= CHECK_EVERY.as_millis() as i64,
            (None, Some(at)) => now - at >= RETRY_EVERY.as_millis() as i64,
            (None, None) => true,
        }
    }

    /// Asks the registry whether it changed since the last answer. Returns whether the list did;
    /// a caller that came while another check ran gets `false` once that one ends (it has said so).
    /// A failure keeps what's there and marks the registry offline.
    pub async fn check(&self) -> bool {
        let seen = self.inner.checks.load(Ordering::SeqCst);
        let _running = self.inner.check.lock().await;
        if self.inner.checks.load(Ordering::SeqCst) != seen {
            return false;
        }
        let etag = {
            let mut state = self.lock();
            state.checking = true;
            state.etag.clone()
        };
        let fetch = Arc::clone(&self.inner.fetch);
        let fetched = tokio::task::spawn_blocking(move || fetch.fetch(etag.as_deref()))
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
        let changed = self.take(fetched);
        self.inner.checks.fetch_add(1, Ordering::SeqCst);
        changed
    }

    fn take(&self, fetched: Result<Fetched, String>) -> bool {
        let mut state = self.lock();
        state.checking = false;
        state.tried_at = Some(now_millis());
        let (agents, body, etag) = match fetched.and_then(|f| match f {
            Fetched::NotModified => Ok(None),
            Fetched::Body { text, etag } => parse(&text).map(|agents| Some((agents, text, etag))),
        }) {
            Ok(None) => {
                tracing::debug!("ACP registry unchanged");
                (None, None, state.etag.clone())
            }
            Ok(Some((agents, text, etag))) => (Some(agents), Some(text), etag),
            Err(e) => {
                // A laptop offline isn't a failure to show.
                tracing::info!("ACP registry not checked: {e}");
                state.offline = true;
                return false;
            }
        };
        state.offline = false;
        state.checked_at = Some(now_millis());
        state.etag = etag;
        let changed = agents.as_ref().is_some_and(|agents| **agents != *state.agents);
        if let Some(agents) = agents {
            state.agents = Arc::new(agents);
        }
        if let Some(body) = body {
            state.body = body;
        }
        if changed {
            tracing::info!(agents = state.agents.len(), "ACP registry changed");
        }
        let stored = CacheFile { body: state.body.clone(), etag: state.etag.clone(), checked_at: state.checked_at };
        drop(state);
        if let Some(file) = &self.inner.cache {
            if let Err(e) = file.save(&stored) {
                tracing::info!("ACP registry not kept: {e}");
            }
        }
        changed
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// A registry of the supported agents (Antigravity's archive for every platform the tests run
    /// on), and others Brama leaves out: one it doesn't offer, a `binary`, a `uvx` and a broken one.
    pub(crate) const FIXTURE: &str = r#"{"version":"1.0.0","agents":[
        {"id":"claude-acp","name":"Claude Agent","version":"0.94.0","description":"ACP wrapper for Anthropic's Claude",
         "authors":["Anthropic","Zed Industries"],"distribution":{"npx":{"package":"@agentclientprotocol/claude-agent-acp@0.94.0"}}},
        {"id":"codex-acp","name":"Codex","version":"0.65.0","authors":["OpenAI"],
         "distribution":{"npx":{"package":"@agentclientprotocol/codex-acp@0.65.0","args":["--acp"]}}},
        {"id":"github-copilot-cli","name":"Copilot","version":"1.0.101","authors":["GitHub"],
         "distribution":{"npx":{"package":"@github/copilot@1.0.101","args":["--acp"]}}},
        {"id":"cline","name":"Cline","version":"3.0.73","authors":["Cline Bot Inc."],
         "distribution":{"npx":{"package":"cline@3.0.73","args":["--acp"]}}},
        {"id":"goose","name":"goose","version":"1.55.0","authors":["Block"],
         "distribution":{"binary":{"darwin-aarch64":{"archive":"https://x/goose.tar.gz","cmd":"./goose"}}}},
        {"id":"fast-agent","name":"fast-agent","version":"0.10.1","distribution":{"uvx":{"package":"fast-agent-acp"}}},
        {"id":"broken","distribution":{}},
        {"id":"antigravity-acp","name":"Google Antigravity","version":"1.4.1","authors":["Google LLC"],
         "distribution":{"binary":{
            "darwin-aarch64":{"archive":"https://dl.example.com/agy-darwin-arm64.zip","cmd":"./agy_acp_server.par"},
            "darwin-x86_64":{"archive":"https://dl.example.com/agy-darwin-x86_64.zip","cmd":"./agy_acp_server.par"},
            "linux-x86_64":{"archive":"https://dl.example.com/agy-linux-x86_64.zip","cmd":"./agy_acp_server.par","args":["--uid="]},
            "linux-aarch64":{"archive":"https://dl.example.com/agy-linux-arm64.zip","cmd":"./agy_acp_server.par","args":["--uid="]},
            "windows-x86_64":{"archive":"https://dl.example.com/agy-windows-x86_64.zip","cmd":"./agy_acp_server.par"}}}}
    ],"extensions":[]}"#;

    /// A registry that answers with `answers`, one per check, recording the `ETag`s it was sent.
    #[derive(Default)]
    pub(crate) struct Script {
        answers: Mutex<VecDeque<Result<Fetched, String>>>,
        pub(crate) etags: Mutex<Vec<Option<String>>>,
        delay: Duration,
    }

    impl Script {
        pub(crate) fn new(answers: Vec<Result<Fetched, String>>) -> Arc<Script> {
            Arc::new(Script { answers: Mutex::new(answers.into()), ..Script::default() })
        }
    }

    impl Fetch for Script {
        fn fetch(&self, etag: Option<&str>) -> Result<Fetched, String> {
            std::thread::sleep(self.delay);
            self.etags.lock().unwrap().push(etag.map(str::to_owned));
            self.answers.lock().unwrap().pop_front().unwrap_or_else(|| Err("no answer scripted".to_owned()))
        }
    }

    pub(crate) fn body(text: &str, etag: &str) -> Result<Fetched, String> {
        Ok(Fetched::Body { text: text.to_owned(), etag: Some(etag.to_owned()) })
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brama-registry-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn ids(registry: &Registry) -> Vec<String> {
        registry.agents().iter().map(|a| a.id.clone()).collect()
    }

    #[test]
    fn parses_only_the_supported_agents() {
        let agents = parse(FIXTURE).unwrap();
        assert_eq!(agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["claude-acp", "codex-acp", "github-copilot-cli", "antigravity-acp"]);
        assert_eq!(
            agents[0].launch,
            Launch::Npx(Npx {
                package: "@agentclientprotocol/claude-agent-acp".into(),
                version: "0.94.0".into(),
                args: vec![],
                env: BTreeMap::new()
            })
        );
        assert_eq!(agents[0].vendor, "Anthropic, Zed Industries");
        let Launch::Program(antigravity) = &agents[3].launch else { panic!("{:?}", agents[3].launch) };
        assert_eq!(antigravity.command, "agy_acp_server.par", "the archive's program, which the user puts on PATH");
        assert!(antigravity.archive.starts_with("https://dl.example.com/agy-"), "where to get it");
        assert_eq!(agents[3].latest(), None, "the user updates it");
        assert!(parse(r#"{"version":"2.0.0","agents":[]}"#).unwrap_err().contains("unsupported version"));
    }

    #[test]
    fn known_agents_are_pinned_to_the_registrys_version() {
        let agents = parse(FIXTURE).unwrap();
        let known: Vec<_> = agents.iter().map(RegistryAgent::known).collect();
        assert_eq!(known.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(), ["claude-acp", "codex-acp", "github-copilot-cli", "antigravity-acp"]);
        assert_eq!(known[1].args, ["-y", "@agentclientprotocol/codex-acp@0.65.0", "--acp"]);
        assert_eq!(known[3].command, "agy_acp_server.par", "on PATH, never downloaded");
        assert!(agents[3].command_line().starts_with("agy_acp_server.par"), "{}", agents[3].command_line());
    }

    #[test]
    fn an_installed_agent_is_matched_by_what_it_runs() {
        let agents = parse(FIXTURE).unwrap();
        let args = |a: &[&str]| a.iter().map(|&s| s.to_owned()).collect::<Vec<_>>();
        let matched = |command: &str, a: &[&str]| match_launch(&agents, command, &args(a)).map(|m| (m.agent.id.clone(), m.pinned));

        assert_eq!(matched("npx", &["-y", "@agentclientprotocol/claude-agent-acp@0.90.0"]), Some(("claude-acp".into(), Some("0.90.0".into()))));
        assert_eq!(matched("npx", &["-y", "@agentclientprotocol/claude-agent-acp"]), Some(("claude-acp".into(), None)), "unpinned");
        assert_eq!(matched("/usr/local/bin/npx", &["@agentclientprotocol/codex-acp", "--acp"]), Some(("codex-acp".into(), None)));
        assert_eq!(matched("npx", &["-y", "@agentclientprotocol/codex-acp@latest"]), Some(("codex-acp".into(), None)), "a tag pins nothing");
        assert_eq!(matched("npx", &["-y", "@agentclientprotocol/claude-agent-acp-extra"]), None, "another package");
        assert_eq!(matched("codex-acp", &["--acp"]), None, "custom");
        assert_eq!(matched("npx", &["-y", "cline"]), None, "not a supported agent");
        assert_eq!(matched("npx", &["-y", "my-wrapper", "--agent", "@agentclientprotocol/codex-acp"]), None, "only the package npx runs");
        assert_eq!(matched("npx", &["--yes", "--", "@agentclientprotocol/codex-acp@0.60.0"]), Some(("codex-acp".into(), Some("0.60.0".into()))));
        assert_eq!(matched("npx", &["-p", "@agentclientprotocol/codex-acp@0.60.0", "codex-acp", "--acp"]), Some(("codex-acp".into(), Some("0.60.0".into()))));
        assert_eq!(matched("npx", &["--package=@agentclientprotocol/codex-acp", "codex-acp"]), Some(("codex-acp".into(), None)));
        assert_eq!(matched("agy_acp_server.par", &[]), Some(("antigravity-acp".into(), None)), "a program on PATH");
        assert_eq!(matched("/opt/agy/agy_acp_server.par", &["--uid="]), Some(("antigravity-acp".into(), None)));
    }

    #[test]
    fn a_program_that_isnt_installed_says_where_to_get_it() {
        let agents = parse(FIXTURE).unwrap();
        let hint = not_installed(&agents, "agy_acp_server.par").unwrap();
        assert!(hint.contains("Google Antigravity isn't installed") && hint.contains("https://dl.example.com/agy-"), "{hint}");
        assert!(hint.contains("agy_acp_server.par") && hint.contains("PATH"), "{hint}");
        assert_eq!(not_installed(&agents, "npx"), None, "npx installs its own");
    }

    #[test]
    fn an_update_is_a_newer_version_than_the_one_installed() {
        let agents = parse(FIXTURE).unwrap();
        let claude = |pinned: Option<&str>| Matched { agent: &agents[0], pinned: pinned.map(str::to_owned) };
        let to = |pin| Some(AgentUpdate { to: "0.94.0".into(), pin });

        assert_eq!(update_of(&claude(Some("0.90.0")), None), to(false));
        assert_eq!(update_of(&claude(Some("0.94.0")), None), None, "current");
        assert_eq!(update_of(&claude(Some("1.0.0")), Some("0.1.0")), None, "newer than the registry; the pin wins over the report");
        assert_eq!(update_of(&claude(None), Some("0.93.1")), to(false), "unpinned: what it reported");
        assert_eq!(update_of(&claude(None), Some("0.94.0")), None);
        assert_eq!(update_of(&claude(None), None), to(true), "nothing known: pin the latest");
        assert_eq!(update_of(&claude(None), Some("nightly")), None, "a version that doesn't parse");
    }

    #[tokio::test]
    async fn a_check_takes_a_changed_registry_and_keeps_it() {
        let dir = temp("change");
        let cache = dir.join("acp-registry.json");
        let script = Script::new(vec![body(FIXTURE, "\"a\""), Ok(Fetched::NotModified)]);
        let registry = Registry::new(Some(cache.clone()), script.clone());
        assert!(registry.due(), "never checked");
        assert_eq!(registry.state().checked_at, None);
        assert!(ids(&registry).is_empty(), "nothing until the registry answers");

        assert!(registry.check().await, "changed");
        assert_eq!(ids(&registry), ["claude-acp", "codex-acp", "github-copilot-cli", "antigravity-acp"]);
        assert!(!registry.due());
        assert!(registry.state().checked_at.is_some());

        assert!(!registry.check().await, "unchanged");
        assert_eq!(*script.etags.lock().unwrap(), [None, Some("\"a\"".to_owned())], "asked with the ETag it got");

        let again = Registry::new(Some(cache), Script::new(vec![]));
        assert_eq!(ids(&again), ["claude-acp", "codex-acp", "github-copilot-cli", "antigravity-acp"], "kept in app data");
        assert!(!again.due());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn offline_keeps_what_is_there() {
        let script = Script::new(vec![body(FIXTURE, "\"a\""), Err("dns error".into()), body("{oops", "\"b\""), Ok(Fetched::NotModified)]);
        let registry = Registry::new(None, script);
        registry.check().await;
        assert!(!registry.check().await);
        assert!(registry.state().offline);
        assert_eq!(ids(&registry), ["claude-acp", "codex-acp", "github-copilot-cli", "antigravity-acp"], "the last answer stays");
        assert!(!registry.check().await, "a body that doesn't parse is kept out");
        assert_eq!(ids(&registry).len(), 4);
        registry.check().await;
        assert!(!registry.state().offline, "back");
    }

    #[tokio::test]
    async fn a_registry_that_never_answered_is_tried_again_soon() {
        let script = Script::new(vec![Err("dns error".into()), body(FIXTURE, "\"a\""), Err("dns error".into())]);
        let registry = Registry::new(None, script);
        let now = now_millis();
        assert!(registry.due_at(now), "first launch");
        assert!(!registry.check().await);
        assert!(registry.state().offline);
        assert!(!registry.due_at(now), "not at once");
        assert!(registry.due_at(now + RETRY_EVERY.as_millis() as i64 + 1), "but well before a day");

        assert!(registry.check().await);
        assert!(!registry.check().await);
        assert!(!registry.due_at(now + RETRY_EVERY.as_millis() as i64 + 1), "once it answered, a failure waits a day");
        assert_eq!(ids(&registry).len(), 4, "the last answer stays");
    }

    /// Network: `cargo test --lib real_registry -- --ignored`.
    #[test]
    #[ignore]
    fn real_registry_answers_and_honours_its_etag() {
        let Fetched::Body { text, etag } = Http.fetch(None).unwrap() else { panic!("no body") };
        assert!(parse(&text).unwrap().iter().any(|a| a.id == "claude-acp"));
        let etag = etag.expect("an ETag");
        assert!(matches!(Http.fetch(Some(&etag)).unwrap(), Fetched::NotModified));
    }

    #[tokio::test]
    async fn a_second_check_waits_for_the_first() {
        let script = Arc::new(Script {
            answers: Mutex::new(vec![body(FIXTURE, "\"a\"")].into()),
            delay: Duration::from_millis(100),
            ..Script::default()
        });
        let registry = Registry::new(None, script.clone());
        let (first, second) = tokio::join!(registry.check(), registry.check());
        assert!(first && !second, "one says it changed");
        assert_eq!(script.etags.lock().unwrap().len(), 1, "one fetch");
        assert!(!registry.state().checking);
    }
}
