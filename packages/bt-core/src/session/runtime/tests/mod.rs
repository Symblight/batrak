//! Sessions against the in-process fake agent: lifecycle, turns, permissions, cancel, file
//! confinement, crash and restart, persistence.

use std::sync::atomic::AtomicUsize;
use std::time::Instant;

use super::*;
use crate::session::program::{OnExit, Program, ProgramExit, ProgramRunner};
use crate::acp::fake_agent::{self, FakeAgentOptions, FakeAgentState};
use crate::git::apply::ApplyOutcome;
use crate::git::test_repo::run_in;

mod activity_and_titles;
mod agent_config;
mod cli_runs;
mod config_options;
mod overlaps;
mod permissions;
mod programs;
mod prompts_and_files;
mod queue;
mod real_agent;
mod restarts;
mod shutdowns;
mod sign_ins;
mod sync_lists;
mod tool_calls;
mod turns;
mod workspace_chats;
mod worktrees;

use self::programs::*;

struct FakeLauncher {
    options: FakeAgentOptions,
    launches: AtomicUsize,
    agents: Mutex<Vec<Arc<FakeAgentState>>>,
    /// The environment the last launch got.
    env: Mutex<Vec<(String, String)>>,
    /// The command of each launch, as spawned.
    commands: Mutex<Vec<String>>,
    /// Agents launched with this command say nothing until it turns true.
    held: Mutex<Option<(String, tokio::sync::watch::Receiver<bool>)>>,
}

impl Launcher for FakeLauncher {
    fn launch(&self, _env: &dyn SessionEnv, agent: &AgentConfig, process_env: &[(String, String)], _stderr: File)
        -> Result<Launched, String> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        lock(&self.commands).push(agent.command.clone());
        *lock(&self.env) = process_env.to_vec();
        let (writer, reader, state) = fake_agent::start(self.options.clone());
        lock(&self.agents).push(state);
        let gate = lock(&self.held).as_ref().filter(|(command, _)| *command == agent.command).map(|(_, open)| open.clone());
        let reader: Box<dyn tokio::io::AsyncRead + Send + Unpin> = match gate {
            Some(mut open) => Box::new(Held { gate: Some(Box::pin(async move { let _ = open.wait_for(|o| *o).await; })), inner: reader }),
            None => Box::new(reader),
        };
        Ok(Launched { process: None, writer: Box::new(writer), reader })
    }
}

impl FakeLauncher {
    /// Holds the answers of the agents launched with `command` until the returned sender sends true.
    fn hold(&self, command: &str) -> tokio::sync::watch::Sender<bool> {
        let (open, opened) = tokio::sync::watch::channel(false);
        *lock(&self.held) = Some((command.to_owned(), opened));
        open
    }

    fn launches_of(&self, command: &str) -> usize {
        lock(&self.commands).iter().filter(|c| *c == command).count()
    }
}

/// An agent's output, read only once its gate opens.
struct Held<R> {
    gate: Option<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>>,
    inner: R,
}

impl<R: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for Held<R> {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>)
        -> std::task::Poll<std::io::Result<()>> {
        if let Some(gate) = self.gate.as_mut() {
            std::task::ready!(gate.as_mut().poll(cx));
            self.gate = None;
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

struct Secrets;

impl SecretStore for Secrets {
    fn get(&self, name: &str) -> Result<String, String> {
        match name {
            "token" => Ok("s3cret-value".to_owned()),
            _ => Err(format!("no keychain item \"{name}\"")),
        }
    }
}

#[derive(Default, Debug)]
struct Recorder {
    events: Mutex<Vec<Envelope>>,
}

impl EventSink for Recorder {
    fn send(&self, envelope: &Envelope) -> bool {
        lock(&self.events).push(envelope.clone());
        true
    }
}

impl Recorder {
    /// Waits until an event matches, returning it; fails after 5s.
    async fn wait_for(&self, what: &str, pred: impl Fn(&Envelope) -> bool) -> Envelope {
        let started = Instant::now();
        loop {
            if let Some(found) = lock(&self.events).iter().find(|e| pred(e)) {
                return found.clone();
            }
            assert!(started.elapsed() < Duration::from_secs(5), "no {what} in {:#?}", lock(&self.events));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn wait_status(&self, status: &str) -> Envelope {
        self.wait_for(status, |e| e.kind == "status" && e.payload["status"] == status).await
    }

    async fn wait_turn_end(&self) -> String {
        let end = self.wait_for("turn-end", |e| e.kind == "turn-end").await;
        end.payload["stopReason"].as_str().unwrap_or_default().to_owned()
    }

    fn clear(&self) {
        lock(&self.events).clear();
    }

    /// Waits for an update of this `sessionUpdate` kind.
    async fn kind_seen(&self, kind: &str) -> Envelope {
        self.wait_for(kind, |e| e.kind == "update" && e.payload["sessionUpdate"] == kind).await
    }

    fn texts(&self) -> Vec<String> {
        lock(&self.events)
            .iter()
            .filter(|e| e.kind == "update")
            .filter_map(|e| e.payload["content"]["text"].as_str().map(str::to_owned))
            .collect()
    }
}

struct Fixture {
    dir: PathBuf,
    project: PathBuf,
    sessions: Sessions,
    launcher: Arc<FakeLauncher>,
    programs: Programs,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture(name: &str, options: FakeAgentOptions) -> Fixture {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("batrak-sessions-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let project = dir.join("project");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    std::fs::write(project.join(".git/config"), "[core]\n").unwrap();
    std::fs::write(project.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    crate::config::ensure_project_dir(&project).unwrap();
    let project = dunce::canonicalize(project).unwrap();
    let launcher = Arc::new(FakeLauncher {
        options,
        launches: AtomicUsize::new(0),
        agents: Mutex::default(),
        env: Mutex::default(),
        commands: Mutex::default(),
        held: Mutex::default(),
    });
    let sessions = Sessions::new(options_for(&dir, &launcher));
    let f = Fixture { dir, project, sessions, launcher, programs: Programs::default() };
    f.give_agents(&f.project);
    f
}

/// The fixture's agents: the project's own, trusted as Settings does for the agents it adds.
const AGENTS: &str = r#"{"version":1,"agents":{"fake":{"name":"Fake","command":"fake-agent","env":{"TOKEN":"${keychain:token}"}},
    "locked":{"name":"Locked","command":"x","env":{"KEY":"${keychain:missing}"}}}}"#;

/// An agent's version as the agent list shows it, read back from app data.
fn listed_version(f: &Fixture, agent: &str) -> Option<String> {
    let configs = AgentConfigs::new(Some(f.dir.join("config/agents.json")), Some(f.dir.join("data/trusted-agents.json")));
    configs.list(Some(&f.project)).agents.into_iter().find(|a| a.id == agent)?.version
}

/// A fixture whose project is a real repository: `a.txt` and `.bt/` committed on `main`.
fn git_fixture(name: &str) -> Fixture {
    git_fixture_with(name, listing())
}

fn git_fixture_with(name: &str, options: FakeAgentOptions) -> Fixture {
    let f = fixture(name, options);
    std::fs::remove_dir_all(f.project.join(".git")).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["add", "."], &["commit", "-qm", "init"]] {
        run_in(&f.project, args);
    }
    f
}

/// What the fake agent's records say of a session, by its ACP id.
static RECORDED_ACTIVITY: Mutex<BTreeMap<String, agent_api::SessionActivity>> = Mutex::new(BTreeMap::new());

fn record_activity(acp_id: &str, activity: agent_api::SessionActivity) {
    lock(&RECORDED_ACTIVITY).insert(acp_id.to_owned(), activity);
}

/// The fake agent's kind: its CLI is agents.json's `cli`; it maps `model` to `--model`, as a real
/// agent crate maps the composer's picks to its CLI's flags.
struct FakeKind;

impl agent_api::Agent for FakeKind {
    fn kind(&self) -> &'static str {
        "fake"
    }

    fn matches(&self, launch: &agent_api::Launch) -> bool {
        launch.command == "fake-agent"
    }

    fn cli_args(&self, config: &BTreeMap<String, String>) -> Vec<String> {
        config.get("model").map(|m| vec!["--model".to_owned(), m.clone()]).unwrap_or_default()
    }

    /// Subagents of every session in each state, named after its ACP id.
    fn subagents(&self, session_id: &str) -> Vec<agent_api::SubagentRecord> {
        let record = |id: &str, state| agent_api::SubagentRecord {
            id: id.to_owned(),
            kind: Some("Explore".to_owned()),
            title: Some(format!("{id} of {session_id}")),
            state,
            started_at: Some("2026-11-03T10:00:00Z".to_owned()),
        };
        vec![
            record("done", agent_api::SubagentState::Done),
            record("running", agent_api::SubagentState::Running),
            record("stopped", agent_api::SubagentState::Stopped),
            record("stale", agent_api::SubagentState::Unknown),
        ]
    }

    fn session_activity(&self, session_id: &str) -> Option<agent_api::SessionActivity> {
        lock(&RECORDED_ACTIVITY).get(session_id).copied()
    }

    /// As the fake agent's `tools` script asks in each call's `rawInput`; `advance` completes the
    /// plan's first open entry.
    fn shown_tool_call(&self, tool_call: &Value, plan: &[agent_api::PlanEntry]) -> agent_api::ShownToolCall {
        use agent_api::{PlanEntry, ShownToolCall};
        let input = &tool_call["rawInput"];
        if input["hide"] == true {
            return ShownToolCall::Hide;
        }
        if input["planning"] == true {
            return ShownToolCall::Plan(None);
        }
        if let Some(items) = input["plan"].as_array() {
            let entry = |c: &Value| PlanEntry { content: c.as_str().unwrap_or_default().to_owned(), priority: "medium".to_owned(), status: "pending".to_owned() };
            return ShownToolCall::Plan(Some(items.iter().map(entry).collect()));
        }
        if input["advance"] == true {
            let mut plan = plan.to_vec();
            if let Some(open) = plan.iter_mut().find(|e| e.status != "completed") {
                open.status = "completed".to_owned();
            }
            return ShownToolCall::Plan(Some(plan));
        }
        ShownToolCall::Keep { label: input["label"].as_str().map(str::to_owned), command: input["command"].as_str().map(str::to_owned) }
    }
}

/// An agent that, started signed out, signs in in the browser on its own (as Antigravity does):
/// started only when the user acts on it.
struct InteractiveKind;

impl agent_api::Agent for InteractiveKind {
    fn kind(&self) -> &'static str {
        "interactive"
    }

    fn matches(&self, launch: &agent_api::Launch) -> bool {
        launch.command == "interactive-agent"
    }

    fn starts_in_background(&self) -> bool {
        false
    }
}

fn options_for(dir: &Path, launcher: &Arc<FakeLauncher>) -> SessionsOptions {
    SessionsOptions {
        agents: Arc::new(crate::agents::AgentHub::of(vec![Arc::new(FakeKind), Arc::new(InteractiveKind)])),
        data_dir: dir.join("data"),
        configs: AgentConfigs::new(Some(dir.join("config/agents.json")), Some(dir.join("data/trusted-agents.json")))
            .with_registry(crate::config::registry::Registry::of(crate::config::registry::tests::FIXTURE)),
        secrets: Arc::new(Secrets),
        base_env: Arc::new(|| {
            HashMap::from([
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("GIT_INDEX_FILE".to_owned(), "/x/index".to_owned()),
            ])
        }),
        launcher: Arc::clone(launcher) as Arc<dyn Launcher>,
        runtime: tokio::runtime::Handle::current(),
        initialize_timeout: Duration::from_secs(5),
        overlap_grace: OVERLAP_GRACE,
        output_stamp: api::OUTPUT_STAMP,
        sync_timeout: Duration::from_secs(5),
    }
}

/// Lists the sessions the agents keep: the fake agent's store.
fn listing() -> FakeAgentOptions {
    FakeAgentOptions { list_sessions: true, ..Default::default() }
}

/// How long the fixture's ended turns still count for an overlap.
const OVERLAP_GRACE: Duration = Duration::from_millis(200);

impl Fixture {
    /// The app launched again (after `shutdown`) and synced: its sessions are what the agents list.
    async fn reopen(&self) -> Sessions {
        self.reopen_with(options_for(&self.dir, &self.launcher)).await
    }

    async fn reopen_with(&self, options: SessionsOptions) -> Sessions {
        let sessions = Sessions::new(options);
        sessions.sync(&self.project, None).await;
        sessions
    }

    /// Writes `project`'s agents.json with the fixture's agents and trusts them.
    fn give_agents(&self, project: &Path) {
        self.set_agents(project, AGENTS);
        let configs = &self.sessions.inner.opts.configs;
        let launches: Vec<_> = configs.untrusted(project).into_iter().map(|u| u.launch).collect();
        configs.trust(project, &launches).unwrap();
    }

    /// Replaces `project`'s agents.json, as the watcher would report it.
    fn set_agents(&self, project: &Path, json: &str) {
        crate::config::ensure_project_dir(project).unwrap();
        std::fs::write(project.join(".bt/agents.json"), json).unwrap();
        self.sessions.inner.opts.configs.reload(project);
    }

    fn create(&self, id: &str, agent: &str) -> Result<(Session, Arc<Recorder>), String> {
        self.create_in(id, agent, None)
    }

    fn create_in(&self, id: &str, agent: &str, workspace_id: Option<String>) -> Result<(Session, Arc<Recorder>), String> {
        self.create_from(self.request(id, agent, workspace_id))
    }

    fn request(&self, id: &str, agent: &str, workspace_id: Option<String>) -> CreateSession {
        CreateSession {
            session_id: id.to_owned(),
            project_path: self.project.to_string_lossy().into_owned(),
            agent_id: agent.to_owned(),
            title: format!("Session {id}"),
            config: BTreeMap::new(),
            workspace_id,
        }
    }

    fn create_from(&self, req: CreateSession) -> Result<(Session, Arc<Recorder>), String> {
        let recorder = Arc::new(Recorder::default());
        let session = self.sessions.create(req, "main", Arc::clone(&recorder) as Arc<dyn EventSink>)?;
        Ok((session, recorder))
    }

    /// The fake agent's answer to one prompt.
    async fn ask(&self, id: &str, events: &Recorder, prompt: &str) -> String {
        events.clear();
        self.sessions.send_prompt(id, text(prompt)).unwrap();
        events.wait_turn_end().await;
        events.texts().join("")
    }

    fn path(&self, rel: &str) -> String {
        self.project.join(rel).to_string_lossy().into_owned()
    }
}

fn text(s: &str) -> Vec<PromptInput> {
    vec![PromptInput::Text { text: s.to_owned() }]
}

fn has(events: &Recorder, kind: &str) -> bool {
    lock(&events.events).iter().any(|e| e.kind == kind)
}

fn status_of(f: &Fixture, id: &str) -> SessionStatus {
    f.sessions.list().into_iter().find(|s| s.id == id).map(|s| s.status).unwrap()
}

impl Fixture {
    /// A new workspace of the project, unnamed (its first chat names it), from `base` (`None`:
    /// the project's base branch); checked out at its first chat's start.
    fn new_workspace(&self, base: Option<&str>) -> Option<String> {
        let ws = self.sessions.workspaces().place(&self.project, None, base).unwrap();
        Some(ws.id)
    }

    fn create_in_workspace(&self, id: &str, workspace: &str) -> Result<(Session, Arc<Recorder>), String> {
        self.create_in(id, "fake", Some(workspace.to_owned()))
    }
}

/// Another page (a reload, a second window) opens the session's channel.
fn attach_page(sessions: &Sessions, id: &str, page: &str) -> Arc<Recorder> {
    let events = Arc::new(Recorder::default());
    sessions.attach(id, page, Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    events
}

/// A snapshot's updates as (kind, text) pairs.
fn snapshot_messages(snapshot: &Envelope) -> Vec<(String, String)> {
    snapshot.payload["updates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| (u["sessionUpdate"].as_str().unwrap().to_owned(), u["content"]["text"].as_str().unwrap_or_default().to_owned()))
        .collect()
}

fn pair(kind: &str, text: &str) -> (String, String) {
    (kind.to_owned(), text.to_owned())
}

fn options_of(probed: Probed) -> Vec<Value> {
    match probed {
        Probed::Options(options) => options,
        Probed::SignIn { .. } => panic!("the probe asks to sign in"),
    }
}

fn outcomes(report: &SyncReport) -> Vec<(&str, sync::SyncOutcome, Option<usize>)> {
    report.agents.iter().map(|a| (a.agent_id.as_str(), a.outcome, a.count)).collect()
}

/// The fake agent's store, with sessions in `cwd`s.
fn stored_in(options: &FakeAgentOptions, sessions: &[(&str, &Path, Option<&str>, Option<&str>)]) {
    let mut stored = options.stored.lock().unwrap();
    for (id, cwd, title, updated_at) in sessions {
        stored.push(fake_agent::FakeSession::new(id, cwd, *title, *updated_at));
    }
}
