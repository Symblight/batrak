//! Sessions against the in-process fake agent: lifecycle, turns, permissions, cancel, file
//! confinement, crash and restart, persistence.

use std::sync::atomic::AtomicUsize;
use std::time::Instant;

use super::*;
use crate::acp::fake_agent::{self, FakeAgentOptions, FakeAgentState};
use crate::git::apply::ApplyOutcome;
use crate::git::test_repo::run_in;

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
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture(name: &str, options: FakeAgentOptions) -> Fixture {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brama-sessions-{name}-{}-{n}", std::process::id()));
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
    let f = Fixture { dir, project, sessions, launcher };
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

/// A fixture whose project is a real repository: `a.txt` and `.brama/` committed on `main`.
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
        std::fs::write(project.join(".brama/agents.json"), json).unwrap();
        self.sessions.inner.opts.configs.reload(project);
    }

    fn create(&self, id: &str, agent: &str) -> Result<(Session, Arc<Recorder>), String> {
        self.create_in(id, agent, WorkspaceChoice::Main)
    }

    fn create_in(&self, id: &str, agent: &str, workspace: WorkspaceChoice) -> Result<(Session, Arc<Recorder>), String> {
        self.create_from(self.request(id, agent, workspace))
    }

    fn request(&self, id: &str, agent: &str, workspace: WorkspaceChoice) -> CreateSession {
        CreateSession {
            session_id: id.to_owned(),
            project_path: self.project.to_string_lossy().into_owned(),
            agent_id: agent.to_owned(),
            title: format!("Session {id}"),
            config: BTreeMap::new(),
            workspace,
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

#[tokio::test]
async fn a_turn_streams_updates_in_order_between_turn_start_and_turn_end() {
    let f = fixture("turn", FakeAgentOptions::default());
    let (session, events) = f.create("s1", "fake").unwrap();
    assert_eq!(session.status, SessionStatus::Preparing);
    events.wait_status("starting").await;
    events.wait_status("idle").await;
    assert_eq!(listed_version(&f, "fake").as_deref(), Some("1.2.3"), "a start keeps the agent's version");

    f.sessions.send_prompt("s1", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    events.wait_for("idle after the turn", |e| e.kind == "status" && e.payload["status"] == "idle" && e.seq > 4).await;

    let all = lock(&events.events).clone();
    let kinds: Vec<_> = all.iter().map(|e| e.kind).collect();
    let start = kinds.iter().position(|k| *k == "turn-start").unwrap();
    let end = kinds.iter().position(|k| *k == "turn-end").unwrap();
    assert!(start < end);
    assert_eq!(events.texts(), ["Hello", ", world"]);
    assert!(all.windows(2).all(|w| w[0].seq < w[1].seq), "seq is monotonic");
    assert!(all.iter().all(|e| e.session_id == "s1"));

    // The agent got the login env without git redirects, plus its resolved secret.
    let env: HashMap<_, _> = lock(&f.launcher.env).iter().cloned().collect();
    assert_eq!(env.get("TOKEN").map(String::as_str), Some("s3cret-value"));
    assert!(!env.contains_key("GIT_INDEX_FILE"));
    // …and the secret went nowhere else.
    let stored = std::fs::read_to_string(f.dir.join("data/sessions.json")).unwrap();
    let log = std::fs::read_to_string(f.sessions.log_path("s1").unwrap()).unwrap_or_default();
    let sent = serde_json::to_string(&all).unwrap();
    for place in [&stored, &log, &sent] {
        assert!(!place.contains("s3cret-value"));
    }
}

#[tokio::test]
async fn local_sessions_of_one_project_all_run_and_their_turns_queue() {
    let f = fixture("slot", FakeAgentOptions::default());
    let (_, first) = f.create("first", "fake").unwrap();
    first.wait_status("idle").await;
    let (_, second) = f.create("second", "fake").unwrap();
    second.wait_status("idle").await;

    f.sessions.send_prompt("first", text("sleep 300")).unwrap();
    first.wait_for("turn-start", |e| e.kind == "turn-start").await;
    f.sessions.send_prompt("second", text("hello")).unwrap();
    let queued = second.wait_for("queued", |e| e.kind == "queued").await;
    assert_eq!(queued.payload["holder"], json!({ "id": "first", "title": "Session first" }));
    second.wait_status("queued").await;
    assert_eq!(status_of(&f, "second"), SessionStatus::Queued);
    let stored = std::fs::read_to_string(f.dir.join("data/sessions.json")).unwrap();
    assert!(!stored.contains("queued"), "no status is kept: {stored}");
    assert!(f.sessions.send_prompt("second", text("hello")).unwrap_err().contains("still working"), "one prompt at a time");

    assert_eq!(first.wait_turn_end().await, "end_turn");
    assert!(!has(&second, "turn-start") || has(&first, "turn-end"));
    assert_eq!(second.wait_turn_end().await, "end_turn");
    assert_eq!(second.texts(), ["Hello", ", world"]);
}

#[tokio::test]
async fn queued_turns_start_in_the_order_they_were_sent() {
    let f = fixture("slot-order", FakeAgentOptions::default());
    let events = Arc::new(Recorder::default());
    for id in ["a", "b", "c"] {
        f.sessions.create(f.request(id, "fake", WorkspaceChoice::Main), "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    }
    for id in ["a", "b", "c"] {
        events.wait_for("idle", |e| e.session_id == id && e.kind == "status" && e.payload["status"] == "idle").await;
    }
    f.sessions.send_prompt("a", text("sleep 200")).unwrap();
    events.wait_for("a's turn", |e| e.session_id == "a" && e.kind == "turn-start").await;
    for id in ["b", "c"] {
        f.sessions.send_prompt(id, text("sleep 20")).unwrap();
        events.wait_for("queued", |e| e.session_id == id && e.kind == "queued").await;
    }
    events.wait_for("c's turn end", |e| e.session_id == "c" && e.kind == "turn-end").await;
    let all = lock(&events.events).clone();
    let starts: Vec<_> = all.iter().filter(|e| e.kind == "turn-start").map(|e| e.session_id.as_str()).collect();
    assert_eq!(starts, ["a", "b", "c"]);
    let behind: Vec<_> = all.iter().filter(|e| e.session_id == "c" && e.kind == "queued").map(|e| &e.payload["holder"]["id"]).collect();
    assert_eq!(behind, ["a", "b"], "c hears who it waits for");
}

#[tokio::test]
async fn cancelling_a_queued_turn_ends_it_without_reaching_the_agent() {
    let f = fixture("slot-cancel", FakeAgentOptions::default());
    let (_, first) = f.create("first", "fake").unwrap();
    first.wait_status("idle").await;
    let (_, second) = f.create("second", "fake").unwrap();
    second.wait_status("idle").await;
    f.sessions.send_prompt("first", text("sleep 200")).unwrap();
    first.wait_for("turn-start", |e| e.kind == "turn-start").await;
    f.sessions.send_prompt("second", text("hello")).unwrap();
    second.wait_status("queued").await;

    f.sessions.cancel("second").unwrap();
    assert_eq!(second.wait_turn_end().await, "cancelled");
    second.wait_for("idle after it", |e| e.kind == "status" && e.payload["status"] == "idle" && e.seq > 5).await;
    let agent = Arc::clone(&lock(&f.launcher.agents)[1]);
    assert!(lock(&agent.prompts).is_empty());
    assert_eq!(agent.cancel_count.load(Ordering::SeqCst), 0, "nothing to cancel in the agent");
    assert_eq!(first.wait_turn_end().await, "end_turn", "the holder goes on");
    second.clear();
    f.sessions.send_prompt("second", text("hello")).unwrap();
    assert_eq!(second.wait_turn_end().await, "end_turn", "and the slot is free");
}

#[tokio::test]
async fn stopping_or_crashing_the_holder_hands_the_slot_on() {
    let f = fixture("slot-stop", FakeAgentOptions::default());
    let mut events = Vec::new();
    for id in ["a", "b", "c"] {
        let (_, e) = f.create(id, "fake").unwrap();
        e.wait_status("idle").await;
        events.push(e);
    }
    let [a, b, c] = &events[..] else { unreachable!() };
    f.sessions.send_prompt("a", text("slow")).unwrap();
    a.wait_for("first chunk", |e| e.kind == "update").await;
    f.sessions.send_prompt("b", text("crash")).unwrap();
    b.wait_status("queued").await;
    f.sessions.send_prompt("c", text("hello")).unwrap();
    c.wait_status("queued").await;

    f.sessions.stop("a").await.unwrap();
    assert_eq!(a.wait_turn_end().await, "cancelled");
    b.wait_for("b's turn", |e| e.kind == "turn-start").await;
    b.wait_status("error").await;
    assert_eq!(c.wait_turn_end().await, "end_turn", "b's crash freed it too");
}

#[tokio::test]
async fn stopping_or_removing_a_queued_session_drops_its_turn() {
    let f = fixture("slot-leave", FakeAgentOptions::default());
    let mut events = Vec::new();
    for id in ["a", "b", "c", "d"] {
        let (_, e) = f.create(id, "fake").unwrap();
        e.wait_status("idle").await;
        events.push(e);
    }
    let [a, b, c, d] = &events[..] else { unreachable!() };
    f.sessions.send_prompt("a", text("sleep 300")).unwrap();
    a.wait_for("turn-start", |e| e.kind == "turn-start").await;
    for (id, e) in [("b", b), ("c", c), ("d", d)] {
        f.sessions.send_prompt(id, text("hello")).unwrap();
        e.wait_status("queued").await;
    }
    f.sessions.stop("b").await.unwrap();
    assert_eq!(b.wait_turn_end().await, "cancelled");
    b.wait_status("stopped").await;
    f.sessions.remove("c").await.unwrap();
    assert_eq!(a.wait_turn_end().await, "end_turn");
    assert_eq!(d.wait_turn_end().await, "end_turn");
    for agent in [1, 2] {
        assert!(lock(&lock(&f.launcher.agents)[agent].prompts).is_empty(), "agent {agent}");
    }
}

#[tokio::test]
async fn a_queued_turn_whose_agent_leaves_agents_json_leaves_the_queue() {
    let f = fixture("slot-unconfigured", FakeAgentOptions::default());
    let (_, first) = f.create("first", "fake").unwrap();
    first.wait_status("idle").await;
    let (_, second) = f.create("second", "fake").unwrap();
    second.wait_status("idle").await;
    f.sessions.send_prompt("first", text("sleep 300")).unwrap();
    first.wait_for("turn-start", |e| e.kind == "turn-start").await;
    f.sessions.send_prompt("second", text("hello")).unwrap();
    second.wait_status("queued").await;

    f.set_agents(&f.project, r#"{"version":1,"agents":{}}"#);
    f.sessions.sync_agents(&f.project).await;
    assert_eq!(second.wait_turn_end().await, "cancelled");
    second.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    assert!(!has(&first, "turn-end"), "the holder's turn goes on");
    assert_eq!(first.wait_turn_end().await, "end_turn");
    assert!(lock(&lock(&f.launcher.agents)[1].prompts).is_empty());
}

#[tokio::test]
async fn a_worktree_session_never_queues_behind_a_local_one() {
    let f = git_fixture("slot-worktree");
    let (_, local) = f.create("local", "fake").unwrap();
    local.wait_status("idle").await;
    let (_, tree) = f.create_in("tree", "fake", f.new_workspace(None)).unwrap();
    tree.wait_status("idle").await;
    f.sessions.send_prompt("local", text("sleep 500")).unwrap();
    local.wait_for("turn-start", |e| e.kind == "turn-start").await;
    f.sessions.send_prompt("tree", text("hello")).unwrap();
    assert_eq!(tree.wait_turn_end().await, "end_turn");
    assert!(!has(&tree, "queued"));
    assert!(!has(&local, "turn-end"), "while the local turn still runs");
}

#[tokio::test]
async fn with_parallel_local_turns_two_turns_run_at_once() {
    let f = fixture("slot-parallel", FakeAgentOptions::default());
    std::fs::write(f.project.join(".brama/workspace.json"), r#"{"version":1,"localTurns":"parallel"}"#).unwrap();
    let (_, first) = f.create("first", "fake").unwrap();
    first.wait_status("idle").await;
    let (_, second) = f.create("second", "fake").unwrap();
    second.wait_status("idle").await;
    f.sessions.send_prompt("first", text("sleep 500")).unwrap();
    first.wait_for("turn-start", |e| e.kind == "turn-start").await;
    f.sessions.send_prompt("second", text("hello")).unwrap();
    assert_eq!(second.wait_turn_end().await, "end_turn");
    assert!(!has(&second, "queued"));
    assert!(!has(&first, "turn-end"), "both turns ran at once");
}

#[tokio::test]
async fn permission_allow_then_cancel_with_a_pending_one() {
    let f = fixture("permission", FakeAgentOptions::default());
    let (_, events) = f.create("p", "fake").unwrap();
    events.wait_status("idle").await;

    f.sessions.send_prompt("p", text("permission")).unwrap();
    let request = events.wait_for("permission request", |e| e.kind == "permission-request").await;
    events.wait_status("waiting").await;
    assert_eq!(request.payload["options"][1]["optionId"], "deny");
    let id = request.payload["requestId"].as_str().unwrap().to_owned();
    f.sessions.respond_permission("p", &id, Some("allow".to_owned())).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(events.texts(), ["chose allow"]);

    events.clear();
    f.sessions.send_prompt("p", text("permission")).unwrap();
    events.wait_for("permission request", |e| e.kind == "permission-request").await;
    f.sessions.cancel("p").unwrap();
    assert_eq!(events.wait_turn_end().await, "cancelled");
    assert_eq!(lock(&f.launcher.agents)[0].cancel_count.load(Ordering::SeqCst), 1);
    events.clear();
    f.sessions.send_prompt("p", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn", "the next turn runs");
}

/// The `update` events' (subagentId, sessionUpdate), `-` for the session's own.
fn tagged_updates<'a>(updates: impl Iterator<Item = &'a Value>) -> Vec<(String, String)> {
    updates
        .map(|u| (u["subagentId"].as_str().unwrap_or("-").to_owned(), u["sessionUpdate"].as_str().unwrap_or_default().to_owned()))
        .collect()
}

#[tokio::test]
async fn a_subagents_updates_and_permission_request_reach_the_page_tagged_with_it() {
    // Arrange
    let f = fixture("subagent", FakeAgentOptions::default());
    let (_, events) = f.create("p", "fake").unwrap();
    events.wait_status("idle").await;
    // Act
    f.sessions.send_prompt("p", text("subagent")).unwrap();
    let request = events.wait_for("permission request", |e| e.kind == "permission-request").await;
    let page = attach_page(&f.sessions, "p", "reloaded");
    // Assert: live and in a reattaching page's snapshot
    assert_eq!(request.payload["subagentId"], "child-1");
    let expected = [pair("-", "subagent_update"), pair("child-1", "session_info_update"), pair("child-1", "tool_call"), pair("child-1", "agent_message_chunk")];
    let live: Vec<Value> = lock(&events.events).iter().filter(|e| e.kind == "update").map(|e| e.payload.clone()).collect();
    assert_eq!(tagged_updates(live.iter()), expected);
    let snapshot = lock(&page.events).iter().find(|e| e.kind == "snapshot").cloned().unwrap();
    assert_eq!(tagged_updates(snapshot.payload["updates"].as_array().unwrap().iter().filter(|u| u["sessionUpdate"] != "user_message_chunk")), expected);
    assert_ne!(f.sessions.get("p").unwrap().record().title, "child title", "a subagent's title isn't the chat's");
    let id = request.payload["requestId"].as_str().unwrap();
    f.sessions.respond_permission("p", id, Some("allow".to_owned())).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
}

/// The `subagents` events' lists, in order.
fn subagent_lists(events: &Recorder) -> Vec<Value> {
    lock(&events.events).iter().filter(|e| e.kind == "subagents").map(|e| e.payload["subagents"].clone()).collect()
}

#[tokio::test]
async fn a_chats_subagents_reach_the_page_as_one_list_before_the_update_that_changed_it() {
    // Arrange
    let f = fixture("subagent-list", FakeAgentOptions::default());
    let (_, events) = f.create("p", "fake").unwrap();
    events.wait_status("idle").await;
    // Act
    f.sessions.send_prompt("p", text("subagent")).unwrap();
    let request = events.wait_for("permission request", |e| e.kind == "permission-request").await;
    let page = attach_page(&f.sessions, "p", "reloaded");
    f.sessions.respond_permission("p", request.payload["requestId"].as_str().unwrap(), Some("allow".to_owned())).unwrap();
    events.wait_turn_end().await;
    // Assert
    let order: Vec<&str> = lock(&events.events)
        .iter()
        .filter(|e| e.kind == "subagents" || (e.kind == "update" && e.payload["sessionUpdate"] == "subagent_update"))
        .map(|e| e.kind)
        .collect();
    assert_eq!(order, ["subagents", "update", "subagents", "update"], "each list before its update");
    let lists = subagent_lists(&events);
    let mut first = lists[0][0].clone();
    assert!(first["announcedAt"].as_str().is_some_and(|at| !at.is_empty()));
    first["announcedAt"] = json!("");
    assert_eq!(first, json!({ "id": "child-1", "title": "find usages", "description": "Explore", "state": "running", "stopReason": null, "cancellable": true, "announcedAt": "" }));
    assert_eq!((&lists[1][0]["state"], &lists[1][0]["stopReason"], &lists[1][0]["cancellable"]), (&json!("idle"), &json!("end_turn"), &json!(true)), "patched, not replaced");
    assert_eq!(lock(&page.events)[0].kind, "subagents", "an attaching page gets them before the snapshot");
}

#[tokio::test]
async fn a_cli_run_chats_running_subagents_reach_the_page_from_its_agents_records_as_its_cli_shows_them() {
    // Arrange
    let f = fixture("subagent-cli", FakeAgentOptions::default());
    f.give_cli_agents();
    let terminals = terminals();
    let (acp, events) = f.started_then_stopped("s1", "fake").await;
    // Act
    f.sessions.open_cli("s1", None, window(&terminals)).await.unwrap();
    events.wait_for("subagents", |e| e.kind == "subagents").await;
    // Assert
    assert_eq!(
        subagent_lists(&events)[0],
        json!([
            { "id": "running", "title": format!("running of {acp}"), "description": "Explore", "state": "running", "stopReason": null, "cancellable": false, "announcedAt": "2026-11-03T10:00:00Z" },
        ]),
        "done, stopped and stale ones are gone from its CLI too"
    );
}

#[tokio::test]
async fn cancelling_a_subagent_answers_its_request_and_the_turn_goes_on() {
    // Arrange
    let f = fixture("subagent-cancel", FakeAgentOptions::default());
    let (_, events) = f.create("p", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("p", text("subagent")).unwrap();
    events.wait_status("waiting").await;
    // Act
    f.sessions.cancel_subagent("p", "child-1").unwrap();
    // Assert
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(*lock(&lock(&f.launcher.agents)[0].cancelled_sessions), ["child-1"]);
    assert!(events.texts().contains(&"child cancelled".to_owned()));
    assert!(f.sessions.cancel_subagent("p", "child-9").is_err());
}

#[tokio::test]
async fn a_page_attaching_while_a_permission_waits_is_asked_it_again_until_it_is_answered() {
    let f = fixture("permission-attach", FakeAgentOptions::default());
    let (_, events) = f.create("p", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("p", text("permission")).unwrap();
    let asked = events.wait_for("permission request", |e| e.kind == "permission-request").await;

    let page = attach_page(&f.sessions, "p", "reloaded");

    let kinds: Vec<_> = lock(&page.events).iter().map(|e| e.kind).collect();
    assert_eq!(kinds, ["snapshot", "permission-request", "status"]);
    assert_eq!(lock(&page.events)[1].payload, asked.payload);

    let id = asked.payload["requestId"].as_str().unwrap();
    f.sessions.respond_permission("p", id, Some("allow".to_owned())).unwrap();
    events.wait_turn_end().await;
    let later = attach_page(&f.sessions, "p", "later");
    assert!(!has(&later, "permission-request"), "answered: not asked again");
}

#[tokio::test]
async fn a_second_prompt_during_a_turn_is_refused_and_cancel_stops_it() {
    let f = fixture("busy", FakeAgentOptions::default());
    let (_, events) = f.create("b", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("b", text("slow")).unwrap();
    assert!(f.sessions.send_prompt("b", text("hello")).unwrap_err().contains("still working"));
    events.wait_for("first chunk", |e| e.kind == "update").await;
    f.sessions.cancel("b").unwrap();
    assert_eq!(events.wait_turn_end().await, "cancelled");
}

#[tokio::test]
async fn agent_file_access_is_confined_to_the_project() {
    let f = fixture("fs", FakeAgentOptions::default());
    let (_, events) = f.create("fs", "fake").unwrap();
    events.wait_status("idle").await;
    let outside = f.dir.join("outside.txt");
    std::fs::write(&outside, "secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, f.project.join("link.txt")).unwrap();

    let mut replies = Vec::new();
    for prompt in [
        format!("read {}", f.path("a.txt")),
        format!("write {} new text", f.path("dir/new.txt")),
        format!("read {}", f.path("../outside.txt")),
        format!("read {}", f.path("link.txt")),
        format!("write {} x", f.path(".git/config")),
        format!("write {} x", outside.display()),
        format!("read {}", f.path("missing.txt")),
    ] {
        events.clear();
        f.sessions.send_prompt("fs", text(&prompt)).unwrap();
        events.wait_turn_end().await;
        replies.push(events.texts().join(""));
    }
    assert_eq!(replies[0], "read:one\ntwo\nthree\n");
    assert_eq!(replies[1], "written");
    assert_eq!(std::fs::read_to_string(f.project.join("dir/new.txt")).unwrap(), "new text");
    assert!(replies[2].starts_with("error:") && replies[2].contains(".."), "{}", replies[2]);
    if cfg!(unix) {
        assert!(replies[3].contains("outside the session"), "{}", replies[3]);
    }
    assert!(replies[4].contains(".git"), "{}", replies[4]);
    assert!(replies[5].contains("outside the session"), "{}", replies[5]);
    assert!(replies[6].starts_with("error:"), "{}", replies[6]);
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret");
    assert_eq!(std::fs::read_to_string(f.project.join(".git/config")).unwrap(), "[core]\n");
}

#[tokio::test]
async fn a_crash_mid_turn_is_an_error_and_restart_brings_the_agent_back() {
    let f = fixture("crash", FakeAgentOptions::default());
    let (_, events) = f.create("c", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("c", text("crash")).unwrap();
    events.wait_for("turn error", |e| e.kind == "error" && e.payload["turn"] == true).await;
    let status = events.wait_status("error").await;
    assert!(status.payload["message"].as_str().unwrap().starts_with("The agent stopped"));
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Error);
    assert_eq!(events.texts(), ["about to crash"], "the transcript so far was delivered");

    events.clear();
    f.sessions.restart("c").await.unwrap();
    events.wait_status("idle").await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 2);
    f.sessions.send_prompt("c", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
}

#[tokio::test]
async fn resume_starts_a_stopped_agent_once_without_reporting_it_stopped() {
    let options = FakeAgentOptions { load_session: true, ..Default::default() };
    let f = fixture("resume", options);
    let (_, events) = f.create("r", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.stop("r").await.unwrap();
    events.wait_status("stopped").await;

    events.clear();
    assert!(f.sessions.resume("r").await.unwrap());
    assert!(f.sessions.resume("r").await.unwrap(), "a second resume while it starts is a no-op");
    events.wait_status("idle").await;
    assert!(f.sessions.resume("r").await.unwrap(), "a running agent stays as it is");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 2);
    let agent = Arc::clone(&lock(&f.launcher.agents)[1]);
    assert_eq!(agent.loads.load(Ordering::SeqCst), 1, "it continues its ACP session");
    let events = lock(&events.events).clone();
    assert!(!events.iter().any(|e| e.kind == "error" || (e.kind == "status" && e.payload["status"] == "stopped")), "{events:#?}");
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

#[tokio::test]
async fn a_page_attaching_to_a_running_session_gets_its_history_before_its_status() {
    let f = fixture("snapshot", FakeAgentOptions { load_session: true, ..Default::default() });
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.stop("s").await.unwrap();
    f.sessions.resume("s").await.unwrap();
    events.wait_status("idle").await;
    f.ask("s", &events, "hello").await;

    let page = attach_page(&f.sessions, "s", "reloaded");

    let got = lock(&page.events).clone();
    assert_eq!((got[0].kind, got[1].kind), ("snapshot", "status"), "{got:#?}");
    assert_eq!(
        snapshot_messages(&got[0]),
        [
            pair("user_message_chunk", "earlier question"),
            pair("agent_message_chunk", "earlier answer"),
            pair("user_message_chunk", "hello"),
            pair("agent_message_chunk", "Hello, world"),
        ],
        "the agent's replay, then the turn: its prompt and its reply's chunks merged"
    );
    assert!(lock(&events.events).iter().all(|e| e.kind != "snapshot"), "only the attaching page gets it");
}

#[tokio::test]
async fn a_page_attaching_mid_turn_gets_the_reply_so_far_then_the_rest() {
    let f = fixture("snapshot-turn", FakeAgentOptions::default());
    let (_, events) = f.create("t", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("t", text("slow")).unwrap();
    events.wait_for("a few chunks", |e| e.payload["content"]["text"] == "3 ").await;

    let page = attach_page(&f.sessions, "t", "reloaded");
    page.wait_for("more chunks", |e| e.kind == "update").await;
    f.sessions.cancel("t").unwrap();
    page.wait_turn_end().await;

    let snapshot = page.wait_for("snapshot", |e| e.kind == "snapshot").await;
    let messages = snapshot_messages(&snapshot);
    assert_eq!(messages[0], pair("user_message_chunk", "slow"));
    let so_far = &messages[1].1;
    assert_eq!(format!("{so_far}{}", page.texts().join("")), events.texts().join(""), "nothing lost or repeated");
}

#[tokio::test]
async fn a_page_attaching_to_a_stopped_or_crashed_session_gets_no_snapshot() {
    let f = fixture("snapshot-stopped", FakeAgentOptions::default());
    let (_, a) = f.create("a", "fake").unwrap();
    let (_, b) = f.create("b", "fake").unwrap();
    a.wait_status("idle").await;
    b.wait_status("idle").await;
    f.ask("a", &a, "hello").await;
    f.sessions.stop("a").await.unwrap();
    f.sessions.send_prompt("b", text("crash")).unwrap();
    b.wait_status("error").await;

    for id in ["a", "b"] {
        let page = attach_page(&f.sessions, id, "reloaded");
        assert!(!has(&page, "snapshot"), "{id}: its agent's next start replays it");
    }
}

#[tokio::test]
async fn parallel_turns_that_change_the_same_file_each_hear_of_the_other_once() {
    let f = fixture("overlap", FakeAgentOptions::default());
    std::fs::write(f.project.join(".brama/workspace.json"), r#"{"version":1,"localTurns":"parallel"}"#).unwrap();
    std::fs::write(f.project.join("b.txt"), "b\n").unwrap();
    let mut events = Vec::new();
    for id in ["a", "b", "c"] {
        let (_, e) = f.create(id, "fake").unwrap();
        e.wait_status("idle").await;
        events.push(e);
    }
    let [a, b, c] = &events[..] else { unreachable!() };
    f.sessions.send_prompt("a", text(&format!("edit {} 400", f.path("a.txt")))).unwrap();
    f.sessions.send_prompt("b", text(&format!("edit {} 400", f.path("a.txt")))).unwrap();
    f.sessions.send_prompt("c", text(&format!("edit {} 400", f.path("b.txt")))).unwrap();
    for e in [a, b, c] {
        e.kind_seen("tool_call_update").await;
    }

    // As the project's watcher reports them, twice.
    for _ in 0..2 {
        f.sessions.note_changes(&f.project, &["a.txt".to_owned(), "b.txt".to_owned()]);
    }
    let overlaps = |e: &Recorder| -> Vec<Value> {
        lock(&e.events).iter().filter(|e| e.kind == "overlap").map(|e| e.payload.clone()).collect()
    };
    assert_eq!(overlaps(a), [json!({ "path": "a.txt", "other": { "id": "b", "title": "Session b" } })]);
    assert_eq!(overlaps(b), [json!({ "path": "a.txt", "other": { "id": "a", "title": "Session a" } })]);
    assert!(overlaps(c).is_empty(), "only c changed b.txt");
    for e in [a, b, c] {
        assert_eq!(e.wait_turn_end().await, "end_turn");
    }

    // A new turn hears of it again.
    let edit = |id: &str, ms: u32| f.sessions.send_prompt(id, text(&format!("edit {} {ms}", f.path("a.txt")))).unwrap();
    a.clear();
    b.clear();
    edit("a", 300);
    edit("b", 300);
    for e in [a, b] {
        e.kind_seen("tool_call_update").await;
    }
    f.sessions.note_changes(&f.project, &["a.txt".to_owned()]);
    assert_eq!((overlaps(a).len(), overlaps(b).len()), (1, 1));
    for e in [a, b] {
        e.wait_turn_end().await;
    }

    // A batch that comes just after a's turn ended still has a's change in it.
    a.clear();
    b.clear();
    edit("a", 0);
    edit("b", 800);
    a.wait_turn_end().await;
    b.kind_seen("tool_call_update").await;
    f.sessions.note_changes(&f.project, &["a.txt".to_owned()]);
    assert_eq!(overlaps(b), [json!({ "path": "a.txt", "other": { "id": "a", "title": "Session a" } })], "late batch");
    assert!(overlaps(a).is_empty(), "a's turn is over");
    b.wait_turn_end().await;

    // Once a's turn is well over, b's change is its own.
    a.clear();
    b.clear();
    edit("a", 0);
    edit("b", 800);
    a.wait_turn_end().await;
    b.kind_seen("tool_call_update").await;
    tokio::time::sleep(OVERLAP_GRACE * 2).await;
    f.sessions.note_changes(&f.project, &["a.txt".to_owned()]);
    assert!(overlaps(b).is_empty(), "not after a's turn");
}

#[tokio::test]
async fn a_file_named_by_another_way_there_is_the_same_file() {
    let f = fixture("overlap-paths", FakeAgentOptions::default());
    std::fs::write(f.project.join(".brama/workspace.json"), r#"{"version":1,"localTurns":"parallel"}"#).unwrap();
    std::fs::create_dir_all(f.project.join("sub")).unwrap();
    let mut events = Vec::new();
    for id in ["a", "b"] {
        let (_, e) = f.create(id, "fake").unwrap();
        e.wait_status("idle").await;
        events.push(e);
    }
    let [a, b] = &events[..] else { unreachable!() };
    f.sessions.send_prompt("a", text(&format!("edit {} 400", f.path("a.txt")))).unwrap();
    f.sessions.send_prompt("b", text(&format!("edit {} 400", f.path("sub/../a.txt")))).unwrap();
    for e in [a, b] {
        e.kind_seen("tool_call_update").await;
    }
    f.sessions.note_changes(&f.project, &["a.txt".to_owned()]);
    for e in [a, b] {
        assert_eq!(lock(&e.events).iter().filter(|e| e.kind == "overlap").count(), 1);
        e.wait_turn_end().await;
    }
}

#[tokio::test]
async fn a_turn_that_only_read_a_file_did_not_change_it() {
    let f = fixture("overlap-read", FakeAgentOptions::default());
    std::fs::write(f.project.join(".brama/workspace.json"), r#"{"version":1,"localTurns":"parallel"}"#).unwrap();
    std::fs::write(f.project.join("a.txt"), "a\n").unwrap();
    let mut events = Vec::new();
    for id in ["a", "b"] {
        let (_, e) = f.create(id, "fake").unwrap();
        e.wait_status("idle").await;
        events.push(e);
    }
    let [a, b] = &events[..] else { unreachable!() };
    f.sessions.send_prompt("a", text(&format!("look {} 400", f.path("a.txt")))).unwrap();
    f.sessions.send_prompt("b", text(&format!("edit {} 400", f.path("a.txt")))).unwrap();
    for e in [a, b] {
        e.kind_seen("tool_call_update").await;
    }
    f.sessions.note_changes(&f.project, &["a.txt".to_owned()]);
    for e in [a, b] {
        assert!(!lock(&e.events).iter().any(|e| e.kind == "overlap"), "a only read a.txt");
        e.wait_turn_end().await;
    }
}

#[tokio::test]
async fn resume_starts_a_local_session_while_another_runs_in_the_project() {
    let f = fixture("resume-slot", FakeAgentOptions::default());
    let (_, first) = f.create("first", "fake").unwrap();
    first.wait_status("idle").await;
    f.sessions.stop("first").await.unwrap();
    let (_, second) = f.create("second", "fake").unwrap();
    second.wait_status("idle").await;

    first.clear();
    assert!(f.sessions.resume("first").await.unwrap());
    first.wait_status("idle").await;
}

#[tokio::test]
async fn resume_leaves_a_worktree_session_stopped_while_the_project_has_its_branch() {
    let f = git_fixture("resume-wt");
    let (session, events) = f.create_in("c", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    f.sessions.workspace_check_out_branch(session.workspace_id.as_deref().unwrap()).await.unwrap();

    events.clear();
    assert!(!f.sessions.resume("c").await.unwrap());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(lock(&events.events).is_empty(), "quietly: {:#?}", lock(&events.events));
    run_in(&f.project, &["switch", "-q", "main"]);
    assert!(f.sessions.resume("c").await.unwrap());
    events.wait_status("idle").await;
}

#[tokio::test]
async fn stop_ends_a_running_turn_as_cancelled_and_frees_the_slot() {
    let f = fixture("stop", FakeAgentOptions::default());
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("s", text("slow")).unwrap();
    events.wait_for("first chunk", |e| e.kind == "update").await;
    f.sessions.stop("s").await.unwrap();
    assert_eq!(events.wait_turn_end().await, "cancelled");
    events.wait_status("stopped").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!lock(&events.events).iter().any(|e| e.kind == "error"), "a requested stop is no error");
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Stopped);
}

#[tokio::test]
async fn a_missing_secret_fails_the_start_naming_the_variable() {
    let f = fixture("secret", FakeAgentOptions::default());
    let (_, events) = f.create("x", "locked").unwrap();
    let status = events.wait_status("error").await;
    assert_eq!(status.payload["message"], "Locked: env KEY: no keychain item \"missing\"");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 0);
    assert!(f.create("y", "fake").is_ok(), "a failed session holds no slot");
}

#[tokio::test]
async fn unknown_agents_are_refused() {
    let f = fixture("refuse", FakeAgentOptions::default());
    assert!(f.create("u", "nope").unwrap_err().contains("Unknown agent"));
}

#[tokio::test]
async fn worktree_sessions_run_side_by_side_on_their_own_branches() {
    let f = git_fixture("wt");
    let head = run_in(&f.project, &["rev-parse", "HEAD"]).trim().to_owned();
    let (one, events) = f.create_in("w1", "fake", f.new_workspace(None)).unwrap();
    let (two, other) = f.create_in("w2", "fake", f.new_workspace(None)).unwrap();
    let (_, local) = f.create("l", "fake").unwrap();
    for recorder in [&events, &other, &local] {
        recorder.wait_status("idle").await;
    }

    assert_eq!(one.mode, Mode::Worktree);
    assert_eq!(one.base_commit.as_deref(), Some(head.as_str()));
    let branch = one.branch.clone().unwrap();
    assert!(branch.starts_with("brama/workspace"), "{branch}");
    assert_ne!(two.branch, one.branch);
    let wt = PathBuf::from(one.worktree_path.clone().unwrap());
    assert!(wt.starts_with(dunce::canonicalize(f.dir.join("data/worktrees")).unwrap()), "{}", wt.display());
    assert_eq!(run_in(&wt, &["branch", "--show-current"]).trim(), branch);
    assert_eq!(run_in(&wt, &["rev-parse", "HEAD"]).trim(), head);

    // The agent works in its own copy; the project and the other session don't see it.
    let file = wt.join("a.txt");
    assert_eq!(f.ask("w1", &events, &format!("write {} mine", file.display())).await, "written");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
    assert_eq!(std::fs::read_to_string(f.project.join("a.txt")).unwrap(), "one\ntwo\nthree\n");
    let two_file = PathBuf::from(two.worktree_path.unwrap()).join("a.txt");
    assert_eq!(std::fs::read_to_string(two_file).unwrap(), "one\ntwo\nthree\n");
    let reply = f.ask("w1", &events, &format!("read {}", f.path("a.txt"))).await;
    assert!(reply.contains("outside the session"), "{reply}");
    let listed = f.sessions.list().into_iter().find(|s| s.id == "w1").unwrap();
    assert_eq!(listed.worktree_path, one.worktree_path);
}

#[tokio::test]
async fn a_sessions_folder_is_where_its_agent_works_and_its_workspaces_folder_is_readable() {
    let f = git_fixture("wt-folder");
    let (local, events) = f.create("l", "fake").unwrap();
    let (wt, other) = f.create_in("w", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    other.wait_status("idle").await;
    assert_eq!(local.folder, f.project.to_string_lossy());
    assert_eq!(Some(&wt.folder), wt.worktree_path.as_ref());

    let root = PathBuf::from(&wt.folder);
    assert!(f.sessions.contains(&root.join("a.txt")));
    assert!(!f.sessions.contains(&f.project.join("a.txt")), "a local session's folder is the project's");
    assert!(!f.sessions.contains(&root.with_file_name("other").join("a.txt")));
    assert!(!f.sessions.contains(&f.dir.join("data/sessions.json")));
    f.sessions.remove("w").await.unwrap();
    assert!(f.sessions.contains(&root.join("a.txt")), "its workspace stays");
    f.sessions.delete_workspace(wt.workspace_id.as_deref().unwrap(), false).await.unwrap();
    assert!(!f.sessions.contains(&root.join("a.txt")), "gone with its workspace");
}

#[tokio::test]
async fn a_sessions_folder_contains_its_project_or_its_worktree_folder() {
    let f = git_fixture("contains-folder");
    let (_local, events) = f.create("l", "fake").unwrap();
    let (wt, other) = f.create_in("w", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    other.wait_status("idle").await;
    assert!(f.sessions.contains_folder(&f.project), "a local session's folder is its project");
    assert!(f.sessions.contains_folder(&f.project.join("src")));
    assert!(f.sessions.contains_folder(Path::new(&wt.folder)));
    assert!(!f.sessions.contains_folder(&f.dir.join("data")));
    assert!(!f.sessions.contains_folder(&f.project.with_file_name("projectx")));
}

#[tokio::test]
async fn a_worktree_prompt_quotes_project_files_by_path_and_names_files_it_lacks() {
    let f = git_fixture("wt-prompt");
    std::fs::write(f.project.join(".env"), "SECRET=1\n").unwrap();
    std::fs::write(f.project.join("a.txt"), "user one\nuser two\n").unwrap();
    let (session, events) = f.create_in("p", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    let env = lock(&f.sessions.get("p").unwrap().env).clone().unwrap();
    let wt = PathBuf::from(session.folder);
    let selection = |path: String| PromptInput::Selection { path, from_line: 1, to_line: 1 };

    // Relative: the session's own copy.
    let blocks = prompt_blocks(&*env, vec![selection("a.txt".to_owned())]).unwrap();
    assert_eq!(blocks, [PromptBlock::Selection { uri: format!("{}#L1-1", file_uri(&wt.join("a.txt"))), text: "one\n".to_owned() }]);
    // Absolute in the project: what the user selected there.
    let blocks = prompt_blocks(&*env, vec![selection(f.path("a.txt")), PromptInput::Mention { path: f.path("a.txt") }]).unwrap();
    assert_eq!(
        blocks,
        [
            PromptBlock::Selection { uri: format!("{}#L1-1", file_uri(&f.project.join("a.txt"))), text: "user one\n".to_owned() },
            PromptBlock::Mention { name: "a.txt".to_owned(), uri: file_uri(&f.project.join("a.txt")) },
        ]
    );
    let err = prompt_blocks(&*env, vec![PromptInput::Mention { path: ".env".to_owned() }]).unwrap_err();
    assert!(err.contains(".env") && err.contains("not in this session's worktree"), "{err}");
    let outside = f.dir.join("data/sessions.json").to_string_lossy().into_owned();
    assert!(prompt_blocks(&*env, vec![PromptInput::Mention { path: outside }]).unwrap_err().contains("outside"));
}

#[tokio::test]
async fn a_workspaces_changes_are_listed_against_its_base() {
    let f = git_fixture("wt-changes");
    let (session, events) = f.create_in("c", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    let ws = session.workspace_id.clone().unwrap();
    let wt = PathBuf::from(&session.folder);
    assert!(f.sessions.workspace_changes(&ws).unwrap().is_empty(), "nothing done yet");

    assert_eq!(f.ask("c", &events, &format!("write {} one\nmore", wt.join("a.txt").display())).await, "written");
    assert_eq!(f.ask("c", &events, &format!("write {} new", wt.join("dir/new.txt").display())).await, "written");
    let changed: Vec<_> = f.sessions.workspace_changes(&ws).unwrap().into_iter().map(|file| file.path).collect();
    assert_eq!(changed, ["a.txt", "dir/new.txt"]);
    assert_eq!(f.sessions.workspace_file_at_base(&ws, "a.txt").unwrap().as_deref(), Some("one\ntwo\nthree\n"));
    assert_eq!(f.sessions.workspace_file_at_base(&ws, "dir/new.txt").unwrap(), None);
    assert!(f.sessions.workspace_file_at_base(&ws, "../x").is_err());
    assert!(f.sessions.workspace_changes("nope").is_err(), "an unknown workspace");
}

#[tokio::test]
async fn checking_out_a_workspaces_branch_stops_its_chat_and_hands_the_branch_over() {
    let f = git_fixture("wt-checkout");
    let (session, events) = f.create_in("c", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    let ws = session.workspace_id.clone().unwrap();
    let wt = PathBuf::from(&session.folder);
    let branch = session.branch.clone().unwrap();
    std::fs::write(wt.join("work.txt"), "w\n").unwrap();
    let err = f.sessions.workspace_check_out_branch(&ws).await.unwrap_err();
    assert!(err.contains("uncommitted") && err.contains("Apply to Main"), "{err}");
    run_in(&wt, &["add", "."]);
    run_in(&wt, &["commit", "-qm", "agent"]);

    f.sessions.workspace_check_out_branch(&ws).await.unwrap();
    assert_eq!(run_in(&f.project, &["branch", "--show-current"]).trim(), branch);
    assert_eq!(std::fs::read_to_string(f.project.join("work.txt")).unwrap(), "w\n");
    let listed = f.sessions.list().into_iter().find(|s| s.id == "c").unwrap();
    assert_eq!(listed.status, SessionStatus::Stopped);

    // While the project has its branch, the session can't go on (its commits would land nowhere).
    events.clear();
    f.sessions.restart("c").await.unwrap();
    let failed = events.wait_for("start error", |e| e.kind == "error").await;
    assert!(failed.payload["message"].as_str().unwrap().contains("checked out in the project"), "{:?}", failed.payload);
    run_in(&f.project, &["switch", "-q", "main"]);
    events.clear();
    f.sessions.restart("c").await.unwrap();
    events.wait_status("idle").await;
    assert_eq!(run_in(&wt, &["branch", "--show-current"]).trim(), branch, "back on its branch");
}

#[tokio::test]
async fn a_worktree_session_starts_from_the_chosen_branch() {
    let f = git_fixture("wt-base");
    run_in(&f.project, &["switch", "-qc", "feature"]);
    std::fs::write(f.project.join("a.txt"), "feature\n").unwrap();
    run_in(&f.project, &["commit", "-qam", "feature"]);
    let feature = run_in(&f.project, &["rev-parse", "HEAD"]).trim().to_owned();
    run_in(&f.project, &["switch", "-q", "main"]);

    let (session, events) = f.create_in("b", "fake", f.new_workspace(Some("feature"))).unwrap();
    events.wait_status("idle").await;
    assert_eq!(session.base_commit.as_deref(), Some(feature.as_str()));
    let wt = PathBuf::from(session.worktree_path.unwrap());
    assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "feature\n");
    assert_eq!(run_in(&f.project, &["branch", "--show-current"]).trim(), "main", "the checkout stays");
}

#[tokio::test]
async fn a_project_inside_a_repository_runs_in_the_same_folder_of_its_worktree() {
    let mut f = git_fixture("wt-sub");
    let app = f.project.join("app");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::write(app.join("main.rs"), "fn main() {}\n").unwrap();
    run_in(&f.project, &["add", "."]);
    run_in(&f.project, &["commit", "-qm", "app"]);
    f.project = app;
    f.give_agents(&f.project);

    let (session, events) = f.create_in("s", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    let wt = PathBuf::from(session.worktree_path.unwrap());
    assert_eq!(session.project_id, f.project.to_string_lossy());
    let reply = f.ask("s", &events, &format!("read {}", wt.join("app/main.rs").display())).await;
    assert_eq!(reply, "read:fn main() {}\n");
    let reply = f.ask("s", &events, &format!("read {}", wt.join("a.txt").display())).await;
    assert!(reply.contains("outside the session"), "only the project's folder: {reply}");
}

#[tokio::test]
async fn a_worktree_session_comes_back_after_a_restart_and_waits_for_its_folder() {
    let f = git_fixture("wt-restart");
    let (session, events) = f.create_in("r", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    let wt = PathBuf::from(session.worktree_path.clone().unwrap());
    std::fs::write(wt.join("work.txt"), "agent work\n").unwrap();
    run_in(&wt, &["add", "."]);
    run_in(&wt, &["commit", "-qm", "agent"]);

    f.sessions.shutdown();
    std::fs::remove_dir_all(&wt).unwrap();
    let sessions = f.reopen().await;
    let listed = sessions.list().into_iter().find(|s| s.id == "r").unwrap();
    assert_eq!(listed.branch, session.branch);
    assert_eq!(listed.base_commit, session.base_commit);
    let events = Arc::new(Recorder::default());
    sessions.attach("r", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    sessions.send_prompt("r", text("hello")).unwrap();
    let failed = events.wait_status("error").await;
    assert!(failed.payload["message"].as_str().unwrap().contains("folder is missing"), "{failed:?}");
}

#[tokio::test]
async fn at_launch_worktrees_no_session_owns_are_removed_unless_they_hold_work() {
    let f = git_fixture("wt-tidy");
    let (kept, events) = f.create_in("k", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    let kept = PathBuf::from(kept.worktree_path.unwrap());
    let group = kept.parent().unwrap().to_path_buf();
    let git = crate::git::test_repo::git_bin();
    let (orphan, dirty) = (group.join("orphan"), group.join("dirty"));
    crate::git::worktree::add(&git, &f.project, &orphan, "brama/orphan", "main", &std::sync::atomic::AtomicBool::new(false)).unwrap();
    crate::git::worktree::add(&git, &f.project, &dirty, "brama/dirty", "main", &std::sync::atomic::AtomicBool::new(false)).unwrap();
    std::fs::write(dirty.join("work.txt"), "w").unwrap();
    std::fs::create_dir_all(f.dir.join("data/worktrees/empty-group")).unwrap();

    f.sessions.tidy_worktrees();
    assert!(kept.join("a.txt").exists(), "a session's own");
    assert!(!orphan.exists());
    assert!(run_in(&f.project, &["branch", "--list", "brama/orphan"]).contains("brama/orphan"), "branches stay");
    assert_eq!(std::fs::read_to_string(dirty.join("work.txt")).unwrap(), "w");
    assert!(!f.dir.join("data/worktrees/empty-group").exists());
    assert!(!run_in(&f.project, &["worktree", "list"]).contains("orphan"));
}

#[tokio::test]
async fn sessions_come_back_after_a_restart_and_load_their_acp_session() {
    let options = FakeAgentOptions { load_session: true, ..listing() };
    let f = fixture("reload", options);
    let (_, events) = f.create("r", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.shutdown();

    let reopened = f.reopen().await;
    let listed = reopened.list();
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0].id.as_str(), listed[0].status), ("r", SessionStatus::Stopped));
    let events = Arc::new(Recorder::default());
    reopened.attach("r", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    reopened.send_prompt("r", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    let agent = Arc::clone(lock(&f.launcher.agents).last().unwrap());
    assert_eq!(agent.loads.load(Ordering::SeqCst), 1, "session/load was used");
    assert_eq!(events.texts(), ["earlier question", "earlier answer", "Hello", ", world"]);
    let idle = events.wait_status("idle").await;
    assert!(idle.payload["message"].is_null(), "history restored: no banner");
    reopened.shutdown();
}

#[tokio::test]
async fn without_load_support_a_reopened_session_says_history_was_not_restored() {
    let f = fixture("noload", listing());
    let (_, events) = f.create("n", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.shutdown();

    let reopened = f.reopen().await;
    let events = Arc::new(Recorder::default());
    reopened.attach("n", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    reopened.send_prompt("n", text("hello")).unwrap();
    let idle = events.wait_status("idle").await;
    assert_eq!(idle.payload["message"], "Agent history not restored");
    assert_eq!(events.wait_turn_end().await, "end_turn");
    reopened.shutdown();
}

#[tokio::test]
async fn resuming_without_load_continues_the_agents_session() {
    let f = fixture("resume-only", FakeAgentOptions { resume_session: true, ..listing() });
    let (_, events) = f.create("r", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.shutdown();

    let reopened = f.reopen().await;
    let events = Arc::new(Recorder::default());
    reopened.attach("r", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    assert!(reopened.resume("r").await.unwrap());
    let idle = events.wait_status("idle").await;
    assert_eq!(idle.payload["message"], "The agent continues this session but doesn't give its history");
    let agent = Arc::clone(lock(&f.launcher.agents).last().unwrap());
    assert_eq!((agent.resumes.load(Ordering::SeqCst), agent.new_sessions.load(Ordering::SeqCst)), (1, 0));
    reopened.shutdown();
}

#[tokio::test]
async fn config_options_arrive_at_start_and_follow_a_change() {
    let f = fixture("options", FakeAgentOptions::default());
    assert!(f.create("o", "fake").is_ok());
    let events = {
        let recorder = Arc::new(Recorder::default());
        f.sessions.attach("o", "main", Arc::clone(&recorder) as Arc<dyn EventSink>).unwrap();
        recorder
    };
    let first = events.wait_for("options", |e| e.kind == "config-options").await;
    let ids = |e: &Envelope| -> Vec<String> {
        e.payload["configOptions"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap().to_owned()).collect()
    };
    assert_eq!(ids(&first), ["model", "effort", "mode"]);
    assert_eq!(first.payload["configOptions"][0]["category"], "model");
    assert_eq!(first.payload["configOptions"][1]["category"], "thought_level");
    let risks = |e: &Envelope| -> Vec<Value> {
        let mode = e.payload["configOptions"].as_array().unwrap().iter().find(|o| o["id"] == "mode").unwrap();
        mode["options"].as_array().unwrap().iter().map(|v| v["risk"].clone()).collect()
    };
    assert_eq!(risks(&first), [json!("neutral"), json!("full")], "its modes tagged by its crate");
    assert!(first.payload["configOptions"][0]["options"][0].get("risk").is_none(), "only modes");

    events.clear();
    f.sessions.set_config_option("o", "model", "fast").await.unwrap();
    let after = events.wait_for("options after set", |e| e.kind == "config-options").await;
    assert_eq!(after.payload["configOptions"][0]["currentValue"], "fast");
    assert_eq!(ids(&after), ["model", "mode"], "the fast model has no effort option");
    assert_eq!(risks(&after), [json!("neutral"), json!("full")], "tagged after a change too");
    assert_eq!(*lock(&lock(&f.launcher.agents)[0].model), "fast");

    assert!(f.sessions.set_config_option("o", "model", "huge").await.is_err(), "the agent's refusal comes back");
    f.sessions.stop("o").await.unwrap();
    assert!(f.sessions.set_config_option("o", "model", "smart").await.unwrap_err().contains("isn't running"));
}

#[tokio::test]
async fn a_sessions_config_options_come_back_when_its_agent_starts_again() {
    let f = fixture("keep-options", FakeAgentOptions { load_session: true, ..listing() });
    let mut req = f.request("k", "fake", WorkspaceChoice::Main);
    // Picked in the draft; the fake refuses any effort, which doesn't stop the start.
    req.config = BTreeMap::from([("model".to_owned(), "fast".to_owned()), ("effort".to_owned(), "low".to_owned())]);
    let (_, events) = f.create_from(req).unwrap();
    events.wait_status("idle").await;
    let model = |e: &Envelope| e.payload["configOptions"][0]["currentValue"].clone();
    let options = events.wait_for("options", |e| e.kind == "config-options").await;
    assert_eq!(model(&options), "fast", "the first options shown are the picked ones");
    assert_eq!(*lock(&lock(&f.launcher.agents)[0].model), "fast", "set before the first prompt can run");
    assert_eq!(f.sessions.list()[0].config["model"], "fast");

    // A stopped agent starts with the session's choice, not its default.
    f.sessions.set_config_option("k", "model", "smart").await.unwrap();
    f.sessions.set_config_option("k", "model", "fast").await.unwrap();
    f.sessions.stop("k").await.unwrap();
    events.clear();
    assert!(f.sessions.resume("k").await.unwrap());
    events.wait_status("idle").await;
    let options = events.wait_for("options", |e| e.kind == "config-options").await;
    assert_eq!(model(&options), "fast");
    assert_eq!(*lock(&lock(&f.launcher.agents)[1].model), "fast");

    // And after the app restarts.
    f.sessions.shutdown();
    let reopened = f.reopen().await;
    assert_eq!(reopened.list()[0].config["model"], "fast");
    let events = Arc::new(Recorder::default());
    reopened.attach("k", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    assert!(reopened.resume("k").await.unwrap());
    events.wait_status("idle").await;
    assert_eq!(*lock(&lock(&f.launcher.agents).last().unwrap().model), "fast");
    reopened.shutdown();
}

#[tokio::test]
async fn an_agent_that_never_answers_a_config_option_neither_holds_up_its_start_nor_stop() {
    let f = fixture("hang-options", FakeAgentOptions { hang_set_config: true, ..listing() });
    let mut req = f.request("h", "fake", WorkspaceChoice::Main);
    req.config = BTreeMap::from([("model".to_owned(), "fast".to_owned())]);
    let (_, events) = f.create_from(req).unwrap();
    events.wait_for("the agent asked", |_| f.launcher.launches.load(Ordering::SeqCst) == 1).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    tokio::time::timeout(Duration::from_secs(2), f.sessions.stop("h")).await.expect("Stop waits for the agent's answer").unwrap();
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Stopped);

    // Given up on after the timeout: the agent runs, with its own value.
    let mut options = options_for(&f.dir, &f.launcher);
    options.initialize_timeout = Duration::from_millis(100);
    f.sessions.shutdown();
    let reopened = f.reopen_with(options).await;
    let events = Arc::new(Recorder::default());
    reopened.attach("h", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    assert!(reopened.resume("h").await.unwrap());
    events.wait_status("idle").await;
    let shown = events.wait_for("options", |e| e.kind == "config-options").await;
    assert_eq!(shown.payload["configOptions"][0]["currentValue"], "smart");
    reopened.shutdown();
}

#[tokio::test]
async fn a_renamed_session_keeps_its_title_after_a_restart() {
    let f = fixture("rename", listing());
    let (_, events) = f.create("n", "fake").unwrap();
    events.wait_status("idle").await;

    let renamed = f.sessions.rename("n", "  Fix the parser \n").unwrap();
    assert_eq!(renamed.title, "Fix the parser", "trimmed");
    assert_eq!(f.sessions.list()[0].title, "Fix the parser");
    assert!(f.sessions.rename("n", "   ").is_err(), "an empty title is refused");
    assert!(f.sessions.rename("missing", "x").is_err());

    f.sessions.shutdown();
    let reopened = f.reopen().await;
    assert_eq!(reopened.list()[0].title, "Fix the parser");
}

#[tokio::test]
async fn removing_a_session_stops_its_agent_and_deletes_it_in_the_agent() {
    let options = FakeAgentOptions { delete_session: true, ..listing() };
    let f = fixture("remove", options.clone());
    let (_, events) = f.create("gone", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("gone", text("slow")).unwrap();
    events.wait_for("first chunk", |e| e.kind == "update").await;
    let session_dir = f.dir.join("data/sessions/gone");
    assert!(session_dir.join("agent.log").exists());

    f.sessions.remove("gone").await.unwrap();
    assert!(f.sessions.list().is_empty());
    assert!(!session_dir.exists(), "its log is deleted");
    assert!(options.stored.lock().unwrap().is_empty(), "deleted in the agent");
    assert_eq!(events.wait_turn_end().await, "cancelled", "the running turn ends");
    assert!(f.project.join("a.txt").exists(), "the project is untouched");
    assert!(f.sessions.remove("gone").await.is_err());

    // Its slot in the project is free, and it doesn't come back after a restart.
    let (_, other) = f.create("other", "fake").unwrap();
    other.wait_status("idle").await;
    f.sessions.shutdown();
    let reopened = f.reopen().await;
    let ids: Vec<_> = reopened.list().into_iter().map(|s| s.id).collect();
    assert_eq!(ids, ["other"]);
}

#[tokio::test]
async fn a_session_its_agent_cant_delete_is_hidden_instead() {
    let options = listing();
    let f = fixture("hide", options.clone());
    let (_, events) = f.create("kept", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.remove("kept").await.unwrap();
    assert_eq!(options.stored.lock().unwrap().len(), 1, "still in the agent");
    f.sessions.sync(&f.project, None).await;
    assert!(f.sessions.list().is_empty(), "not listed again");
    f.sessions.shutdown();
    assert!(f.reopen().await.list().is_empty(), "nor after a restart");
}

#[tokio::test]
async fn probing_an_agent_returns_its_options_and_leaves_nothing_behind() {
    let f = fixture("probe", FakeAgentOptions::default());
    let options = options_of(f.sessions.probe_options(Some(&f.project), "fake").await.unwrap());
    let ids: Vec<_> = options.iter().map(|o| o["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["model", "effort", "mode"]);
    assert_eq!(options[2]["options"][1]["risk"], "full", "a probe's modes are tagged too");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1);
    assert_eq!(listed_version(&f, "fake").as_deref(), Some("1.2.3"), "the agent's version is kept");
    assert!(f.sessions.list().is_empty(), "no session is listed");
    assert!(f.create("s", "fake").is_ok(), "no local slot is taken");
    assert!(f.sessions.probe_options(Some(&f.project), "nope").await.unwrap_err().contains("Unknown agent"));
    let failed = f.sessions.probe_options(Some(&f.project), "locked").await.unwrap_err();
    assert!(failed.contains("no keychain item"), "{failed}");
}

#[tokio::test]
async fn an_agent_gone_from_agents_json_fails_the_start_and_starts_once_it_is_back() {
    let f = fixture("unconfigured", FakeAgentOptions::default());
    let (_, events) = f.create("u", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.stop("u").await.unwrap();

    f.set_agents(&f.project, r#"{"version":1,"agents":{}}"#);
    events.clear();
    f.sessions.restart("u").await.unwrap();
    let gone = events.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    assert_eq!(gone.payload["agentId"], "fake");
    assert_eq!(gone.payload["message"], "Agent \"fake\" is no longer configured");
    assert_eq!(gone.payload["ran"], "fake-agent ", "what it ran, as its log shows it");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1, "nothing ran");

    f.give_agents(&f.project);
    events.clear();
    f.sessions.restart("u").await.unwrap();
    events.wait_status("idle").await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_session_follows_its_agent_to_another_id_that_runs_the_same() {
    let f = fixture("rebind", FakeAgentOptions::default());
    let (_, events) = f.create("r", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.stop("r").await.unwrap();

    // Removed, then added again (Settings gives it a new id).
    f.set_agents(&f.project, &AGENTS.replace("\"fake\":", "\"fake-2\":"));
    let configs = &f.sessions.inner.opts.configs;
    let launches: Vec<_> = configs.untrusted(&f.project).into_iter().map(|u| u.launch).collect();
    configs.trust(&f.project, &launches).unwrap();
    events.clear();
    f.sessions.restart("r").await.unwrap();
    let moved = events.wait_for("session", |e| e.kind == "session").await;
    assert_eq!(moved.payload["agentId"], "fake-2");
    events.wait_status("idle").await;
    assert_eq!(f.sessions.list()[0].agent_id, "fake-2", "kept");

    // A session from before launches were kept: its log says what it ran.
    f.sessions.stop("r").await.unwrap();
    f.sessions.get("r").unwrap().record.lock().unwrap().launch = None;
    f.set_agents(&f.project, &AGENTS.replace("\"fake\":", "\"fake-3\":"));
    let launches: Vec<_> = configs.untrusted(&f.project).into_iter().map(|u| u.launch).collect();
    configs.trust(&f.project, &launches).unwrap();
    events.clear();
    f.sessions.restart("r").await.unwrap();
    events.wait_status("idle").await;
    assert_eq!(f.sessions.list()[0].agent_id, "fake-3");

    // Something else under its id is not its agent.
    f.sessions.stop("r").await.unwrap();
    f.set_agents(&f.project, r#"{"version":1,"agents":{"other":{"command":"other-agent"}}}"#);
    events.clear();
    f.sessions.restart("r").await.unwrap();
    events.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
}

#[tokio::test]
async fn agents_json_losing_a_sessions_agent_stops_it_and_getting_it_back_restores_it() {
    let f = git_fixture("sync");
    let (_, running) = f.create("s", "fake").unwrap();
    running.wait_status("idle").await;
    let (_, stopped) = f.create_in("t", "fake", f.new_workspace(None)).unwrap();
    stopped.wait_status("idle").await;
    f.sessions.stop("t").await.unwrap();
    let launched = f.launcher.launches.load(Ordering::SeqCst);

    f.set_agents(&f.project, r#"{"version":1,"agents":{}}"#);
    running.clear();
    stopped.clear();
    f.sessions.sync_agents(&f.project).await;
    for events in [&running, &stopped] {
        let gone = events.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
        assert_eq!(gone.payload["message"], "Agent \"fake\" is no longer configured");
        events.wait_status("error").await;
    }
    assert!(f.sessions.list().iter().all(|s| s.status == SessionStatus::Error), "at once, shown or not");
    f.sessions.sync_agents(&f.project).await;
    let reported = lock(&running.events).iter().filter(|e| e.kind == "unconfigured").count();
    assert_eq!(reported, 1, "said once");

    f.give_agents(&f.project);
    running.clear();
    stopped.clear();
    f.sessions.sync_agents(&f.project).await;
    running.wait_status("idle").await;
    stopped.wait_status("stopped").await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), launched + 1, "only the one that ran starts again");
}

#[tokio::test]
async fn a_turn_running_when_its_agent_leaves_agents_json_finishes_first() {
    let f = fixture("sync-turn", FakeAgentOptions::default());
    let (_, events) = f.create("w", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("w", text("slow")).unwrap();
    events.wait_for("first chunk", |e| e.kind == "update").await;

    f.set_agents(&f.project, r#"{"version":1,"agents":{}}"#);
    f.sessions.sync_agents(&f.project).await;
    assert!(!lock(&events.events).iter().any(|e| e.kind == "unconfigured"), "not mid-turn");
    assert_eq!(events.wait_turn_end().await, "end_turn");
    events.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    events.wait_status("error").await;
}

#[tokio::test]
async fn turning_an_agent_off_stops_its_sessions_and_turning_it_on_puts_them_back() {
    let f = fixture("switch-off", FakeAgentOptions::default());
    let configs = &f.sessions.inner.opts.configs;
    let (_, running) = f.create("s", "fake").unwrap();
    running.wait_status("idle").await;
    f.sessions.send_prompt("s", text("slow")).unwrap();
    running.wait_for("first chunk", |e| e.kind == "update").await;
    let launched = f.launcher.launches.load(Ordering::SeqCst);
    assert_eq!(f.sessions.active_of(&f.project, "fake"), 1, "what turning it off stops");
    assert_eq!(f.sessions.active_of(&f.project, "locked"), 0);

    configs.set_enabled(Some(&f.project), "fake", false).unwrap();
    f.sessions.sync_agents(&f.project).await;
    assert!(!lock(&running.events).iter().any(|e| e.kind == "unconfigured"), "not mid-turn");
    assert_eq!(running.wait_turn_end().await, "end_turn");
    let off = running.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    assert_eq!(off.payload["reason"], "off");
    assert_eq!(off.payload["message"], "Fake is off");
    running.wait_status("error").await;

    assert!(f.create("t", "fake").unwrap_err().contains("Fake is off"), "no new session of it");
    running.clear();
    f.sessions.restart("s").await.unwrap();
    let refused = running.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    assert_eq!(refused.payload["reason"], "off", "a start is refused");
    let probe = f.sessions.probe_options(Some(&f.project), "fake").await.unwrap_err();
    assert!(probe.contains("off"), "{probe}");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), launched, "nothing ran");

    configs.set_enabled(Some(&f.project), "fake", true).unwrap();
    running.clear();
    f.sessions.sync_agents(&f.project).await;
    running.wait_status("idle").await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), launched + 1, "back as it was: running");
}

#[tokio::test]
async fn an_agent_turned_off_stops_its_sessions_even_when_another_runs_the_same() {
    let f = fixture("switch-twin", FakeAgentOptions::default());
    // Added twice from the registry: `fake-2` runs exactly what `fake` does.
    f.set_agents(&f.project, &AGENTS.replace("\"locked\":", "\"fake-2\":{\"name\":\"Fake\",\"command\":\"fake-agent\",\"env\":{\"TOKEN\":\"${keychain:token}\"}},\"locked\":"));
    let configs = &f.sessions.inner.opts.configs;
    let launches: Vec<_> = configs.untrusted(&f.project).into_iter().map(|u| u.launch).collect();
    configs.trust(&f.project, &launches).unwrap();
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("idle").await;

    configs.set_enabled(Some(&f.project), "fake", false).unwrap();
    f.sessions.sync_agents(&f.project).await;
    let off = events.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    assert_eq!(off.payload["reason"], "off");
    events.wait_status("error").await;
    assert_eq!(f.sessions.list()[0].agent_id, "fake", "not moved to its twin");

    events.clear();
    f.sessions.restart("s").await.unwrap();
    events.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    assert_eq!(f.sessions.list()[0].agent_id, "fake", "a start doesn't move it either");
}

#[tokio::test]
async fn a_removed_agent_is_reported_as_removed() {
    let f = fixture("switch-removed", FakeAgentOptions::default());
    let (_, events) = f.create("r", "fake").unwrap();
    events.wait_status("idle").await;
    f.set_agents(&f.project, r#"{"version":1,"agents":{}}"#);
    f.sessions.sync_agents(&f.project).await;
    let gone = events.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    assert_eq!(gone.payload["reason"], "removed");
}

#[tokio::test]
async fn a_running_session_hears_when_agents_json_changes_what_its_agent_runs() {
    let f = fixture("outdated", FakeAgentOptions::default());
    let (session, events) = f.create("o", "fake").unwrap();
    assert_eq!(session.agent_name.as_deref(), Some("Fake"), "its agent's name, for when the agent is gone");
    events.wait_status("idle").await;

    f.set_agents(&f.project, &AGENTS.replace("\"command\":\"fake-agent\"", "\"command\":\"fake-agent\",\"args\":[\"--v2\"]"));
    events.clear();
    f.sessions.sync_agents(&f.project).await;
    let outdated = events.wait_for("agent-outdated", |e| e.kind == "agent-outdated").await;
    assert_eq!(outdated.payload["message"], "agents.json changed what Fake runs. Restart to use it.");
    f.sessions.sync_agents(&f.project).await;
    assert_eq!(lock(&events.events).iter().filter(|e| e.kind == "agent-outdated").count(), 1, "said once");
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Idle, "it keeps running");

    f.set_agents(&f.project, AGENTS);
    events.clear();
    f.sessions.sync_agents(&f.project).await;
    let current = events.wait_for("agent-outdated", |e| e.kind == "agent-outdated").await;
    assert!(current.payload["message"].is_null(), "changed back: nothing to say");

    f.set_agents(&f.project, &AGENTS.replace("\"name\":\"Fake\"", "\"name\":\"Faker\""));
    events.clear();
    f.sessions.sync_agents(&f.project).await;
    assert!(!lock(&events.events).iter().any(|e| e.kind == "agent-outdated"), "a new name runs nothing new");
}

#[tokio::test]
async fn an_update_tells_a_running_session_and_its_restart_runs_the_new_version_trusted() {
    let f = fixture("update", FakeAgentOptions::default());
    let configs = &f.sessions.inner.opts.configs;
    f.set_agents(&f.project, r#"{"version":1,"agents":{"claude":{"name":"Claude","command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp@0.90.0"]}}}"#);
    let launches: Vec<_> = configs.untrusted(&f.project).into_iter().map(|u| u.launch).collect();
    configs.trust(&f.project, &launches).unwrap();
    let (_, events) = f.create("u", "claude").unwrap();
    events.wait_status("idle").await;

    assert_eq!(configs.pin_versions(Some(&f.project), Some("claude")).unwrap().len(), 1);
    f.sessions.sync_agents(&f.project).await;
    let outdated = events.wait_for("agent-outdated", |e| e.kind == "agent-outdated").await;
    assert_eq!(outdated.payload["message"], "agents.json changed what Claude runs. Restart to use it.");
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Idle, "nothing restarts on its own");

    events.clear();
    f.sessions.restart("u").await.unwrap();
    events.wait_status("idle").await;
    assert!(!lock(&events.events).iter().any(|e| e.kind == "untrusted"), "the trust went with the pin");
    let ran = f.sessions.get("u").unwrap().record.lock().unwrap().launch.clone().unwrap();
    assert_eq!(ran.args, ["-y", "@agentclientprotocol/claude-agent-acp@0.94.0"]);
}

#[tokio::test]
async fn a_session_started_again_without_a_sync_stays_running_after_its_turn() {
    let f = fixture("stale-flag", FakeAgentOptions::default());
    let (_, events) = f.create("f", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.stop("f").await.unwrap();
    f.set_agents(&f.project, r#"{"version":1,"agents":{}}"#);
    events.clear();
    f.sessions.restart("f").await.unwrap();
    events.wait_for("unconfigured", |e| e.kind == "unconfigured").await;

    // Back without the sync (a change no watcher saw), then a Restart.
    f.give_agents(&f.project);
    events.clear();
    f.sessions.restart("f").await.unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("f", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Idle, "not marked stopped while its agent runs");
}

#[tokio::test]
async fn an_agent_the_project_defines_runs_only_once_trusted() {
    let f = fixture("trust", FakeAgentOptions::default());
    f.set_agents(&f.project, r#"{"version":1,"agents":{"repo":{"name":"Repo","command":"./agent","args":["--acp"]}}}"#);
    let (_, events) = f.create("t", "repo").unwrap();
    let untrusted = events.wait_for("untrusted", |e| e.kind == "untrusted").await;
    assert_eq!(untrusted.payload["launch"]["command"], "./agent");
    let message = untrusted.payload["message"].as_str().unwrap();
    assert!(message.contains("./agent --acp"), "{message}");
    events.wait_status("error").await;
    let probe = f.sessions.probe_options(Some(&f.project), "repo").await.unwrap_err();
    assert!(probe.contains("trust"), "{probe}");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 0, "nothing ran");

    let launch: crate::config::LaunchConfig = serde_json::from_value(untrusted.payload["launch"].clone()).unwrap();
    f.sessions.inner.opts.configs.trust(&f.project, &[launch]).unwrap();
    events.clear();
    f.sessions.restart("t").await.unwrap();
    events.wait_status("idle").await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn the_agent_cannot_rewrite_the_projects_agents_json() {
    let f = fixture("agents-json", FakeAgentOptions::default());
    let (_, events) = f.create("c", "fake").unwrap();
    events.wait_status("idle").await;
    let file = f.project.join(".brama/agents.json");
    let before = std::fs::read_to_string(&file).unwrap();
    f.sessions.send_prompt("c", text(&format!("write {} x", f.path(".brama/agents.json")))).unwrap();
    events.wait_turn_end().await;
    let reply = events.texts().join("");
    assert!(reply.starts_with("error:") && reply.contains("agents.json"), "{reply}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
}

#[tokio::test]
async fn a_message_sent_while_the_first_start_fails_does_not_start_the_agent_again() {
    let f = fixture("once", FakeAgentOptions { fail_new_session: true, ..Default::default() });
    let (_, events) = f.create("o", "fake").unwrap();
    f.sessions.send_prompt("o", text("hello")).unwrap();
    let failed = events.wait_for("turn error", |e| e.kind == "error" && e.payload["turn"] == true).await;
    assert!(failed.payload["message"].as_str().unwrap().contains("no session today"), "{failed:?}");
    events.wait_for("start error", |e| e.kind == "error" && e.payload["turn"].is_null()).await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1);

    // The user's next message tries again.
    events.clear();
    f.sessions.send_prompt("o", text("again")).unwrap();
    events.wait_for("turn error", |e| e.kind == "error" && e.payload["turn"] == true).await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn session_ids_are_names_not_paths() {
    let f = fixture("ids", FakeAgentOptions::default());
    for bad in ["../x", "/tmp/x", "", "a/b", "..", "a\\b", &"x".repeat(65)] {
        let err = f.create(bad, "fake").unwrap_err();
        assert!(err.contains("invalid session id"), "{bad:?}: {err}");
    }
    assert!(f.sessions.list().is_empty());
}

#[test]
fn reads_lines_without_loading_more_than_the_limit() {
    let dir = std::env::temp_dir().join(format!("brama-read-lines-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let small = dir.join("small.txt");
    std::fs::write(&small, "a\nb\nc").unwrap();
    assert_eq!(read_lines(&small, Some(2), Some(1), 100).unwrap(), "b\n");
    assert_eq!(read_lines(&small, Some(2), None, 100).unwrap(), "b\nc");
    assert_eq!(read_lines(&small, None, Some(1), 100).unwrap(), "a\n");
    assert_eq!(read_lines(&small, None, None, 100).unwrap(), "a\nb\nc");
    assert!(read_lines(&small, None, None, 3).unwrap_err().contains("too large"), "a whole file over the limit");
    assert_eq!(read_lines(&small, Some(3), Some(1), 3).unwrap(), "c", "a part of it is fine");

    let long = dir.join("long.txt");
    std::fs::write(&long, format!("{}\nshort\n", "x".repeat(50))).unwrap();
    assert_eq!(read_lines(&long, Some(2), None, 10).unwrap(), "short\n", "a long line skipped is never loaded");
    assert!(read_lines(&long, Some(1), Some(1), 10).unwrap_err().contains("too large"), "nor is a part over the limit");
    std::fs::write(&long, [0xff, 0xfe, b'\n']).unwrap();
    assert!(read_lines(&long, Some(1), Some(1), 10).is_err(), "not UTF-8");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn prompt_blocks_map_mentions_and_selections_and_refuse_escapes() {
    let dir = std::env::temp_dir().join(format!("brama-blocks-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/my file.rs"), "l1\nl2\nl3\nl4\n").unwrap();
    let root = dunce::canonicalize(&dir).unwrap();
    let env = env::LocalEnv::new(root.clone());
    let blocks = prompt_blocks(
        &env,
        vec![
            PromptInput::Text { text: "look".to_owned() },
            PromptInput::Mention { path: "src/my file.rs".to_owned() },
            PromptInput::Selection { path: "src/my file.rs".to_owned(), from_line: 2, to_line: 3 },
        ],
    )
    .unwrap();
    let uri = format!("file://{}/src/my%20file.rs", root.display());
    assert_eq!(
        blocks,
        vec![
            PromptBlock::Text("look".to_owned()),
            PromptBlock::Mention { name: "my file.rs".to_owned(), uri: uri.clone() },
            PromptBlock::Selection { uri: format!("{uri}#L2-3"), text: "l2\nl3\n".to_owned() },
        ]
    );
    for bad in ["../x", "/etc/passwd", ".git/config", "missing.rs"] {
        assert!(prompt_blocks(&env, vec![PromptInput::Mention { path: bad.to_owned() }]).is_err(), "{bad}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn prompt_input_from_the_page() {
    let parsed: Vec<PromptInput> = serde_json::from_str(
        r#"[{"type":"text","text":"hi"},{"type":"mention","path":"a.rs"},{"type":"selection","path":"a.rs","fromLine":1,"toLine":2}]"#,
    )
    .unwrap();
    assert_eq!(parsed[2], PromptInput::Selection { path: "a.rs".to_owned(), from_line: 1, to_line: 2 });
}

/// Sessions with the real Claude Code agent (`claude`) in a fresh project under a temp `name`.
fn real_claude(name: &str) -> (Sessions, PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("brama-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let project = dir.join("project");
    std::fs::create_dir_all(&project).unwrap();
    crate::config::ensure_project_dir(&project).unwrap();
    let project = dunce::canonicalize(project).unwrap();
    std::fs::write(
        project.join(".brama/agents.json"),
        r#"{"version":1,"agents":{"claude":{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp"]}}}"#,
    )
    .unwrap();
    let configs = AgentConfigs::new(None, None);
    let launches: Vec<_> = configs.untrusted(&project).into_iter().map(|u| u.launch).collect();
    configs.trust(&project, &launches).unwrap();
    let mut opts = SessionsOptions::for_app(dir.join("data"), configs);
    opts.initialize_timeout = Duration::from_secs(180);
    let sessions = Sessions::new(opts);
    (sessions, project, dir)
}

/// End to end with the real Claude Code agent (`npx @agentclientprotocol/claude-agent-acp`, from a
/// project's agents.json, trusted): needs network, Node and a signed-in Claude Code. Run with
/// `cargo test --lib real_claude -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_claude_agent_end_to_end() {
    let (sessions, project, dir) = real_claude("real-claude");
    let probed = options_of(sessions.probe_options(Some(&project), "claude").await.unwrap());
    let categories: Vec<_> = probed.iter().map(|o| o["category"].as_str().unwrap_or("-")).collect();
    eprintln!("probed categories: {categories:?}");
    assert!(categories.contains(&"model") && categories.contains(&"thought_level"));
    let events = Arc::new(Recorder::default());
    let req = CreateSession {
        session_id: "real".to_owned(),
        project_path: project.to_string_lossy().into_owned(),
        agent_id: "claude".to_owned(),
        title: "real".to_owned(),
        config: BTreeMap::new(),
        workspace: WorkspaceChoice::Main,
    };
    sessions.create(req, "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    let wait = |what: &'static str, secs: u64, pred: Box<dyn Fn(&Envelope) -> bool + Send>| {
        let events = Arc::clone(&events);
        async move {
            let started = Instant::now();
            loop {
                if let Some(found) = lock(&events.events).iter().find(|e| pred(e)) {
                    return found.clone();
                }
                if let Some(err) = lock(&events.events).iter().find(|e| e.kind == "error") {
                    panic!("{what}: {:?}", err.payload);
                }
                assert!(started.elapsed() < Duration::from_secs(secs), "no {what}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    };
    wait("idle", 240, Box::new(|e| e.kind == "status" && e.payload["status"] == "idle")).await;
    let pid = {
        let state = sessions.get("real").unwrap();
        let live = state.live.lock().await;
        live.as_ref().and_then(|l| l.process.as_ref()).and_then(AgentProcess::pid).unwrap()
    };
    eprintln!("agent ready, pid {pid}");
    let options = wait("config-options", 10, Box::new(|e| e.kind == "config-options")).await;
    eprintln!("config options: {}", serde_json::to_string_pretty(&options.payload).unwrap());
    // Pick another value of the model option and see the agent take it.
    let model = options.payload["configOptions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["category"] == "model")
        .cloned();
    if let Some(model) = model {
        let current = model["currentValue"].clone();
        let other = model["options"].as_array().unwrap().iter().map(|v| v["value"].clone()).find(|v| *v != current).unwrap();
        events.clear();
        sessions.set_config_option("real", model["id"].as_str().unwrap(), other.as_str().unwrap()).await.unwrap();
        let after = wait("config-options after set", 30, Box::new(|e| e.kind == "config-options")).await;
        let now = after.payload["configOptions"].as_array().unwrap().iter().find(|o| o["id"] == model["id"]).unwrap()["currentValue"].clone();
        eprintln!("model {current} -> {now}");
        assert_eq!(now, other);
    }

    // 1. A plain turn streams text and ends with end_turn.
    sessions.send_prompt("real", text("Reply with exactly the single word: pong")).unwrap();
    let end = wait("turn-end 1", 120, Box::new(|e| e.kind == "turn-end")).await;
    eprintln!("turn 1: {:?} text {:?}", end.payload, events.texts().join(""));
    assert_eq!(end.payload["stopReason"], "end_turn");
    assert!(events.texts().join("").to_lowercase().contains("pong"));

    // 2. A write asks for permission; allowing it writes through fs/write_text_file (or the agent's own tool).
    events.clear();
    sessions
        .send_prompt("real", text("Create a file named hello.txt in the current directory containing exactly: hi"))
        .unwrap();
    let ask = wait(
        "permission or turn-end",
        180,
        Box::new(|e| e.kind == "permission-request" || e.kind == "turn-end"),
    )
    .await;
    if ask.kind == "permission-request" {
        eprintln!("permission: {}", ask.payload);
        let allow = ask.payload["options"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["kind"] == "allow_once" || o["kind"] == "allow_always")
            .unwrap()["optionId"]
            .as_str()
            .unwrap()
            .to_owned();
        sessions.respond_permission("real", ask.payload["requestId"].as_str().unwrap(), Some(allow)).unwrap();
    }
    let end = wait("turn-end 2", 180, Box::new(|e| e.kind == "turn-end")).await;
    eprintln!("turn 2: {:?}", end.payload);
    let kinds: Vec<String> = lock(&events.events)
        .iter()
        .filter(|e| e.kind == "update")
        .map(|e| e.payload["sessionUpdate"].as_str().unwrap_or_default().to_owned())
        .collect();
    eprintln!("update kinds: {kinds:?}");
    assert_eq!(std::fs::read_to_string(project.join("hello.txt")).unwrap().trim(), "hi");

    // 3. Cancel stops a turn.
    events.clear();
    sessions
        .send_prompt("real", text("Count slowly from 1 to 300, one number per line, with a short comment on each."))
        .unwrap();
    wait("first chunk", 120, Box::new(|e| e.kind == "update")).await;
    sessions.cancel("real").unwrap();
    let end = wait("turn-end 3", 60, Box::new(|e| e.kind == "turn-end")).await;
    eprintln!("turn 3: {:?}", end.payload);
    assert_eq!(end.payload["stopReason"], "cancelled");

    // 4. Stop leaves no process of the agent's group behind.
    sessions.stop("real").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    // SAFETY: signal 0 only checks whether any process of the group exists.
    #[cfg(unix)]
    assert_ne!(unsafe { libc::kill(-(pid as i32), 0) }, 0, "the agent's process group is gone");
    let log = std::fs::read_to_string(sessions.log_path("real").unwrap()).unwrap_or_default();
    eprintln!("log tail: {}", log.lines().rev().take(5).collect::<Vec<_>>().join(" | "));
    let _ = std::fs::remove_dir_all(dir);
}

/// What the real Claude Code sends for a subagent (ACP subagent sessions, which Brama declares):
/// prints the `subagent_update`s, `session_message`s and the subagent's own updates, and whether
/// `session/list` gains a session. Needs what `real_claude_agent_end_to_end` does.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_claude_subagents() {
    let (sessions, project, dir) = real_claude("real-claude-subagents");
    std::fs::write(project.join("notes.md"), "The secret word is pelican.\n").unwrap();
    let events = Arc::new(Recorder::default());
    let req = CreateSession {
        session_id: "real".to_owned(),
        project_path: project.to_string_lossy().into_owned(),
        agent_id: "claude".to_owned(),
        title: "real".to_owned(),
        config: BTreeMap::new(),
        workspace: WorkspaceChoice::Main,
    };
    sessions.create(req, "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    events.wait_status("idle").await;
    sessions
        .send_prompt("real", text("Use the Agent tool with subagent_type Explore to find the secret word in notes.md, then tell me the word."))
        .unwrap();
    let started = Instant::now();
    let end = loop {
        let pending: Vec<_> = lock(&events.events).iter().filter(|e| e.kind == "permission-request").cloned().collect();
        for request in pending {
            let id = request.payload["requestId"].as_str().unwrap_or_default().to_owned();
            let allow = request.payload["options"].as_array().and_then(|o| o.iter().find(|o| o["kind"] == "allow_once")).map(|o| o["optionId"].as_str().unwrap_or_default().to_owned());
            eprintln!("permission (subagent {:?}): allowing", request.payload["subagentId"]);
            let _ = sessions.respond_permission("real", &id, allow);
        }
        lock(&events.events).retain(|e| e.kind != "permission-request");
        if let Some(end) = lock(&events.events).iter().find(|e| e.kind == "turn-end").cloned() {
            break end;
        }
        assert!(started.elapsed() < Duration::from_secs(300), "no turn-end");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let updates: Vec<Value> = lock(&events.events).iter().filter(|e| e.kind == "update").map(|e| e.payload.clone()).collect();
    for u in updates.iter().filter(|u| matches!(u["sessionUpdate"].as_str(), Some("subagent_update" | "session_message"))) {
        eprintln!("{}", serde_json::to_string(u).unwrap());
    }
    let mut by_subagent: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for u in updates.iter().filter(|u| u.get("subagentId").is_some()) {
        by_subagent.entry(u["subagentId"].as_str().unwrap_or_default().to_owned()).or_default().push(u["sessionUpdate"].as_str().unwrap_or_default().to_owned());
    }
    eprintln!("subagents' own updates: {by_subagent:#?}");
    eprintln!("turn: {:?}, reply {:?}", end.payload, events.texts().join(""));
    sessions.sync(&project, None).await;
    let listed: Vec<_> = sessions.list().into_iter().map(|s| s.title).collect();
    eprintln!("listed after the turn: {listed:?}");
    let _ = std::fs::remove_dir_all(dir);
    assert!(updates.iter().any(|u| u["sessionUpdate"] == "subagent_update"), "no subagent_update");
    assert!(!by_subagent.is_empty(), "no update came under a subagent's id");
}

#[tokio::test]
async fn sessions_are_listed_by_last_activity_which_a_prompt_and_its_turn_end_set() {
    let f = fixture("activity", FakeAgentOptions { resume_session: true, ..listing() });
    let (first, events) = f.create("a", "fake").unwrap();
    events.wait_status("idle").await;
    assert_eq!(first.last_activity_at, first.created_at, "no activity yet: its creation");
    f.sessions.stop("a").await.unwrap();
    let (second, second_events) = f.create("b", "fake").unwrap();
    second_events.wait_status("idle").await;
    f.sessions.stop("b").await.unwrap();
    assert_eq!(f.sessions.list().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["b", "a"]);

    // Timestamps have milliseconds: the prompt comes strictly after `b` was created.
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(f.ask("a", &events, "hello").await, "Hello, world");
    let listed = f.sessions.list();
    assert_eq!(listed.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert!(listed[0].last_activity_at > second.created_at);
    f.sessions.shutdown();

    // After a restart the order is the agent's: its last activity in each.
    let reopened = f.reopen().await;
    let listed = reopened.list();
    assert_eq!(listed.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert!(listed[0].last_activity_at > second.created_at);
}

fn stamp_ms(stamp: &Value) -> i64 {
    parse_iso_millis(stamp.as_str().expect("a stamp")).expect("an ISO stamp")
}

fn listed_activity(f: &Fixture, id: &str) -> String {
    f.sessions.list().into_iter().find(|s| s.id == id).unwrap().last_activity_at
}

#[tokio::test]
async fn a_prompt_and_a_turns_end_carry_the_stamp_touch_wrote_and_so_does_a_failed_turn() {
    let f = fixture("stamps", FakeAgentOptions::default());
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("idle").await;

    let sent = f.sessions.send_prompt("s", text("sleep 100")).unwrap();
    assert_eq!(listed_activity(&f, "s"), sent, "the prompt's stamp is the session's activity");
    let end = events.wait_for("turn-end", |e| e.kind == "turn-end").await;
    assert_eq!(end.payload["at"], listed_activity(&f, "s"), "the end's stamp is the session's activity");
    assert!(stamp_ms(&end.payload["at"]) > parse_iso_millis(&sent).unwrap());

    let failing = fixture("stamps-failed", FakeAgentOptions { fail_new_session: true, ..Default::default() });
    let (_, events) = failing.create("o", "fake").unwrap();
    let sent = failing.sessions.send_prompt("o", text("hello")).unwrap();
    let failed = events.wait_for("turn error", |e| e.kind == "error" && e.payload["turn"] == true).await;
    assert_eq!(failed.payload["at"], listed_activity(&failing, "o"), "a failed turn touches too");
    assert!(stamp_ms(&failed.payload["at"]) >= parse_iso_millis(&sent).unwrap());
}

#[tokio::test]
async fn output_emits_activity_with_a_stamp_at_most_once_per_output_stamp() {
    let mut f = fixture("output-stamp", FakeAgentOptions::default());
    let interval = Duration::from_millis(150);
    f.sessions = Sessions::new(SessionsOptions { output_stamp: interval, ..options_for(&f.dir, &f.launcher) });
    f.give_agents(&f.project);
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("idle").await;

    f.sessions.send_prompt("s", text("slow")).unwrap();
    let activity = |events: &Recorder| -> Vec<Envelope> { lock(&events.events).iter().filter(|e| e.kind == "activity").cloned().collect() };
    let started = Instant::now();
    while activity(&events).len() < 3 {
        assert!(started.elapsed() < Duration::from_secs(5), "no third activity in {:#?}", lock(&events.events));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    f.sessions.cancel("s").unwrap();
    events.wait_turn_end().await;

    let stamps: Vec<i64> = activity(&events).iter().map(|e| stamp_ms(&e.payload["at"])).collect();
    let first_chunk = lock(&events.events).iter().position(|e| e.kind == "update").unwrap();
    let first_activity = lock(&events.events).iter().position(|e| e.kind == "activity").unwrap();
    assert!(first_activity.abs_diff(first_chunk) <= 1, "the first output stamps at once");
    let chunks = lock(&events.events).iter().filter(|e| e.kind == "update").count();
    assert!(stamps.len() < chunks, "{} stamps for {chunks} chunks", stamps.len());
    for pair in stamps.windows(2) {
        assert!(pair[1] - pair[0] >= interval.as_millis() as i64 - 1, "stamps {pair:?} are closer than {interval:?}");
    }
}

#[tokio::test]
async fn the_agents_title_replaces_the_prompts_and_comes_from_its_list_after_a_restart() {
    let f = fixture("agent-title", listing());
    let (created, events) = f.create("t", "fake").unwrap();
    assert_eq!((created.title.as_str(), created.title_source), ("Session t", TitleSource::Prompt));
    assert_eq!(f.ask("t", &events, "title Tree view gaps").await, "titled");

    let changed = events.wait_for("session", |e| e.kind == "session").await;
    assert_eq!(changed.payload["title"], "Tree view gaps");
    assert_eq!(changed.payload["titleSource"], "agent");
    f.sessions.shutdown();

    let listed = f.reopen().await.list();
    assert_eq!((listed[0].title.as_str(), listed[0].title_source), ("Tree view gaps", TitleSource::Agent));
}

#[tokio::test]
async fn after_a_rename_the_agent_no_longer_changes_the_title_until_it_is_reset() {
    let f = fixture("user-title", FakeAgentOptions::default());
    let (_, events) = f.create("t", "fake").unwrap();
    let renamed = f.sessions.rename("t", "Mine").unwrap();
    assert_eq!(renamed.title_source, TitleSource::User);
    assert!(f.sessions.reset_title("t").is_err(), "no agent title to go back to yet");

    f.ask("t", &events, "title Tree view gaps").await;
    let listed = &f.sessions.list()[0];
    assert_eq!((listed.title.as_str(), listed.agent_title.as_deref()), ("Mine", Some("Tree view gaps")));

    let reset = f.sessions.reset_title("t").unwrap();
    assert_eq!((reset.title.as_str(), reset.title_source), ("Tree view gaps", TitleSource::Agent));
}

fn options_of(probed: Probed) -> Vec<Value> {
    match probed {
        Probed::Options(options) => options,
        Probed::SignIn { .. } => panic!("the probe asks to sign in"),
    }
}

/// An agent that needs a sign-in: one `agent` method, `browser`.
fn needing_sign_in() -> FakeAgentOptions {
    FakeAgentOptions {
        require_auth: true,
        auth_methods: vec![json!({ "id": "browser", "name": "Log in", "description": "In your browser" })],
        ..Default::default()
    }
}

fn event_count(events: &Recorder, kind: &str) -> usize {
    lock(&events.events).iter().filter(|e| e.kind == kind).count()
}

#[tokio::test]
async fn a_prompt_to_an_agent_that_asks_to_sign_in_is_held_not_lost() {
    let f = fixture("sign-in-held", needing_sign_in());
    let (_, events) = f.create("s", "fake").unwrap();
    let asked = events.wait_for("sign-in", |e| e.kind == "sign-in").await;
    assert_eq!(asked.payload["agentId"], "fake");
    assert_eq!(asked.payload["agentName"], "Fake");
    assert_eq!(asked.payload["methods"][0]["id"], "browser");
    assert_eq!(asked.payload["methods"][0]["kind"], "agent");
    let status = events.wait_status("error").await;
    assert_eq!(status.payload["message"], "Sign in to Fake");
    assert_eq!(event_count(&events, "error"), 0, "no error notice: the sign-in card says it");

    f.sessions.send_prompt("s", text("hello")).unwrap();
    let held = events.wait_for("held", |e| e.kind == "held").await;
    assert_eq!(held.payload["prompt"][0]["text"], "hello");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(event_count(&events, "turn-end"), 0, "the turn waits");
    assert_eq!(f.sessions.sign_in_state(Some(&f.project), "fake").unwrap().methods.len(), 1);

    events.clear();
    let sign_in = f.sessions.sign_in(Some(&f.project), "fake", Some("browser")).await.unwrap();
    assert_eq!(sign_in.end().await, SignInEnd::Done);
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(events.texts().join(""), "Hello, world", "the held prompt was answered");
    events.wait_for("sign-in cleared", |e| e.kind == "sign-in" && e.payload.is_null()).await;
    let agents = lock(&f.launcher.agents).clone();
    assert_eq!(*agents.last().unwrap().prompts.lock().unwrap(), ["hello"]);
    assert!(agents.iter().any(|a| *a.authenticated.lock().unwrap() == ["browser"]));
    assert!(f.sessions.sign_in_state(Some(&f.project), "fake").is_none(), "it no longer needs one");
}

#[tokio::test]
async fn signing_in_brings_back_every_waiting_session_of_the_agent() {
    let f = fixture("sign-in-two", needing_sign_in());
    let (_, first) = f.create("a", "fake").unwrap();
    let (_, second) = f.create("b", "fake").unwrap();
    first.wait_status("error").await;
    second.wait_status("error").await;
    f.sessions.send_prompt("a", text("hello")).unwrap();
    first.wait_for("held", |e| e.kind == "held").await;

    first.clear();
    second.clear();
    let sign_in = f.sessions.sign_in(Some(&f.project), "fake", Some("browser")).await.unwrap();
    let joined = f.sessions.sign_in(Some(&f.project), "fake", Some("browser")).await.unwrap();
    assert_eq!(sign_in.end().await, SignInEnd::Done);
    assert_eq!(joined.end().await, SignInEnd::Done, "a second call joins the first");
    assert_eq!(first.wait_turn_end().await, "end_turn");
    second.wait_status("idle").await;
    assert_eq!(event_count(&second, "turn-end"), 0, "nothing was held there");
    let authenticated: usize = lock(&f.launcher.agents).iter().map(|a| a.authenticated.lock().unwrap().len()).sum();
    assert_eq!(authenticated, 1, "one sign-in");
}

#[tokio::test]
async fn cancel_stop_or_the_agent_leaving_gives_a_held_prompt_back() {
    let f = fixture("sign-in-drop", needing_sign_in());
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("error").await;

    f.sessions.send_prompt("s", text("hello")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;
    f.sessions.cancel("s").unwrap();
    let back = events.wait_for("prompt-returned", |e| e.kind == "prompt-returned").await;
    assert_eq!(back.payload["prompt"][0]["text"], "hello");
    assert_eq!(events.wait_turn_end().await, "cancelled");

    events.clear();
    f.sessions.send_prompt("s", text("again")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;
    f.sessions.stop("s").await.unwrap();
    events.wait_for("prompt-returned", |e| e.kind == "prompt-returned").await;
    events.wait_for("sign-in cleared", |e| e.kind == "sign-in" && e.payload.is_null()).await;
    events.wait_turn_end().await;

    f.sessions.restart("s").await.unwrap();
    events.clear();
    events.wait_status("error").await;
    f.sessions.send_prompt("s", text("third")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;
    f.set_agents(&f.project, r#"{"version":1,"agents":{}}"#);
    f.sessions.sync_agents(&f.project).await;
    events.wait_for("prompt-returned", |e| e.kind == "prompt-returned").await;
    events.wait_for("unconfigured", |e| e.kind == "unconfigured").await;
    let prompts: Vec<String> = lock(&f.launcher.agents).iter().flat_map(|a| a.prompts.lock().unwrap().clone()).collect();
    assert!(prompts.is_empty(), "none reached the agent: {prompts:?}");
}

#[tokio::test]
async fn a_failed_sign_in_keeps_the_prompt_waiting() {
    let f = fixture("sign-in-fail", FakeAgentOptions { fail_authenticate: Some((-32603, "login failed")), ..needing_sign_in() });
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("error").await;
    f.sessions.send_prompt("s", text("hello")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;
    let SignInEnd::Failed(message) = f.sessions.sign_in(Some(&f.project), "fake", Some("browser")).await.unwrap().end().await else {
        panic!("signed in")
    };
    assert!(message.contains("login failed"), "{message}");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(event_count(&events, "prompt-returned") + event_count(&events, "turn-end"), 0, "still held");
    assert!(f.sessions.sign_in_state(Some(&f.project), "fake").is_some_and(|s| !s.pending));
}

#[tokio::test]
async fn a_sign_in_runs_only_a_trusted_launch_and_can_be_cancelled() {
    let f = fixture("sign-in-trust", needing_sign_in());
    f.set_agents(&f.project, r#"{"version":1,"agents":{"repo":{"name":"Repo","command":"./agent"}}}"#);
    let refused = f.sessions.sign_in(Some(&f.project), "repo", Some("browser")).await.err().unwrap();
    assert!(refused.contains("trust"), "{refused}");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 0, "nothing ran");
    assert!(f.sessions.cancel_sign_in(Some(&f.project), "repo").is_none(), "none runs");
}

#[tokio::test]
async fn a_login_that_ran_out_mid_session_holds_the_prompt_until_signed_in_again() {
    let options = FakeAgentOptions { signed_in: Arc::new(true.into()), ..needing_sign_in() };
    let signed_in = Arc::clone(&options.signed_in);
    let f = fixture("sign-in-expired", options);
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("idle").await;
    signed_in.store(false, Ordering::SeqCst);
    events.clear();
    f.sessions.send_prompt("s", text("hello")).unwrap();
    events.wait_for("sign-in", |e| e.kind == "sign-in" && !e.payload.is_null()).await;
    events.wait_for("held", |e| e.kind == "held").await;
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Error);

    assert_eq!(f.sessions.sign_in(Some(&f.project), "fake", Some("browser")).await.unwrap().end().await, SignInEnd::Done);
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(events.texts().join(""), "Hello, world");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 3, "the session's, the sign-in's, the session's again");
}

#[tokio::test]
async fn a_probe_that_asks_to_sign_in_says_so_and_the_tab_shows_it() {
    let f = fixture("sign-in-probe", needing_sign_in());
    let Probed::SignIn { sign_in } = f.sessions.probe_options(Some(&f.project), "fake").await.unwrap() else {
        panic!("options without a sign-in")
    };
    assert_eq!(sign_in.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["browser"]);
    let state = f.sessions.sign_in_state(Some(&f.project), "fake").unwrap();
    assert!(!state.pending && state.methods == sign_in);
    assert!(f.sessions.sign_in_state(Some(&f.project), "locked").is_none());
    let list = f.sessions.agent_list(Some(&f.project));
    let needs = |id: &str| list.agents.iter().find(|a| a.id == id).unwrap().sign_in;
    assert!(needs("fake") && !needs("locked"), "the picker says which one needs a sign-in");
    let json = serde_json::to_value(Probed::SignIn { sign_in }).unwrap();
    assert_eq!(json["signIn"][0]["name"], "Log in");
}

#[tokio::test]
async fn an_agent_waiting_for_a_sign_in_isnt_started_again_by_a_probe() {
    // An agent may open the browser whenever it's started signed out: a page reload's probe
    // mustn't start it again until the user signs in or presses Retry.
    let options = needing_sign_in();
    let signed_in = Arc::clone(&options.signed_in);
    let f = fixture("sign-in-probe-again", options);
    assert!(matches!(f.sessions.probe_options(Some(&f.project), "fake").await.unwrap(), Probed::SignIn { .. }));
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1);

    let Probed::SignIn { sign_in } = f.sessions.probe_options(Some(&f.project), "fake").await.unwrap() else {
        panic!("options without a sign-in")
    };
    assert_eq!(sign_in.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["browser"], "the noted methods");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1, "not started again");

    signed_in.store(true, Ordering::SeqCst);
    assert_eq!(f.sessions.sign_in(Some(&f.project), "fake", None).await.unwrap().end().await, SignInEnd::Done);
    assert!(matches!(f.sessions.probe_options(Some(&f.project), "fake").await.unwrap(), Probed::Options(_)), "probed once signed in");
}

#[tokio::test]
async fn an_agent_that_signs_in_on_its_own_starts_only_when_the_user_acts() {
    use super::sync::SyncOutcome;
    let f = fixture("interactive", FakeAgentOptions { load_session: true, ..listing() });
    f.set_agents(&f.project, r#"{"version":1,"agents":{"agy":{"name":"Agy","command":"interactive-agent"}}}"#);
    let configs = &f.sessions.inner.opts.configs;
    configs.trust(&f.project, &configs.untrusted(&f.project).into_iter().map(|u| u.launch).collect::<Vec<_>>()).unwrap();
    let launches = || f.launcher.launches.load(Ordering::SeqCst);

    // Probe and sync: no user asked.
    assert!(f.sessions.probe_options(Some(&f.project), "agy").await.is_err(), "not probed");
    let agy = Some(&["agy".to_owned()][..]);
    assert_eq!(outcomes(&f.sessions.sync(&f.project, agy).await), [("agy", SyncOutcome::Unsupported, None)]);
    assert_eq!(launches(), 0, "neither started it");

    // A session the user made, stopped: showing it doesn't start it, a message does.
    let (_, events) = f.create("s", "agy").unwrap();
    events.wait_status("idle").await;
    f.sessions.stop("s").await.unwrap();
    events.wait_status("stopped").await;
    assert!(!f.sessions.resume("s").await.unwrap(), "stays stopped when shown");
    assert_eq!(launches(), 1);
    f.sessions.send_prompt("s", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(launches(), 2);
}

#[tokio::test]
async fn retry_after_a_login_elsewhere_sends_the_held_prompt() {
    let options = needing_sign_in();
    let signed_in = Arc::clone(&options.signed_in);
    let f = fixture("sign-in-retry", options);
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("error").await;
    f.sessions.send_prompt("s", text("hello")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;

    let SignInEnd::Failed(message) = f.sessions.sign_in(Some(&f.project), "fake", None).await.unwrap().end().await else {
        panic!("signed in")
    };
    assert!(message.contains("still asks to sign in"), "{message}");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(event_count(&events, "turn-end"), 0, "still held");

    // A login in a terminal, which the app doesn't see.
    signed_in.store(true, Ordering::SeqCst);
    assert_eq!(f.sessions.sign_in(Some(&f.project), "fake", None).await.unwrap().end().await, SignInEnd::Done);
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(events.texts().join(""), "Hello, world");
    let authenticated: usize = lock(&f.launcher.agents).iter().map(|a| a.authenticated.lock().unwrap().len()).sum();
    assert_eq!(authenticated, 0, "Retry only checks");
}

#[tokio::test]
async fn a_cancelled_sign_in_ends_cancelled_and_keeps_the_prompt_held() {
    let f = fixture("sign-in-cancel", FakeAgentOptions { hang_authenticate: true, ..needing_sign_in() });
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("error").await;
    f.sessions.send_prompt("s", text("hello")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;

    let sign_in = f.sessions.sign_in(Some(&f.project), "fake", Some("browser")).await.unwrap();
    while lock(&f.launcher.agents).iter().all(|a| a.authenticated.lock().unwrap().is_empty()) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(f.sessions.sign_in_state(Some(&f.project), "fake").unwrap().pending);
    assert!(f.sessions.cancel_sign_in(Some(&f.project), "fake").is_some());
    assert_eq!(sign_in.end().await, SignInEnd::Cancelled);
    let state = f.sessions.sign_in_state(Some(&f.project), "fake").unwrap();
    assert!(!state.pending && state.methods.len() == 1, "it still needs one");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(event_count(&events, "prompt-returned") + event_count(&events, "turn-end"), 0, "still held");
}

#[tokio::test]
async fn a_session_waiting_under_an_earlier_launch_comes_back_after_signing_in_to_the_new_one() {
    let f = fixture("sign-in-moved", needing_sign_in());
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("error").await;
    f.set_agents(&f.project, &AGENTS.replace(r#""command":"fake-agent""#, r#""command":"fake-agent","args":["--acp"]"#));
    let configs = &f.sessions.inner.opts.configs;
    let launches: Vec<_> = configs.untrusted(&f.project).into_iter().map(|u| u.launch).collect();
    configs.trust(&f.project, &launches).unwrap();
    f.sessions.sync_agents(&f.project).await;

    events.clear();
    assert_eq!(f.sessions.sign_in(Some(&f.project), "fake", Some("browser")).await.unwrap().end().await, SignInEnd::Done);
    events.wait_status("idle").await;
}

/// An agent whose only way in is a login in a terminal: Claude's `terminal` type, or Copilot's
/// `terminal-auth` command.
fn needing_a_terminal_login() -> FakeAgentOptions {
    FakeAgentOptions {
        require_auth: true,
        auth_methods: vec![
            json!({ "type": "terminal", "id": "tui", "name": "Subscription", "args": ["auth", "login"], "env": { "MODE": "login" } }),
            json!({ "id": "cli", "name": "CLI", "_meta": { "terminal-auth": { "command": "/opt/cli", "args": ["login"], "label": "CLI Login" } } }),
        ],
        ..Default::default()
    }
}

#[tokio::test]
async fn a_terminal_method_gives_a_login_to_run_and_its_exit_signs_in() {
    let options = needing_a_terminal_login();
    let signed_in = Arc::clone(&options.signed_in);
    let f = fixture("sign-in-terminal", options);
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("error").await;
    f.sessions.send_prompt("s", text("hello")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;
    let launches = f.launcher.launches.load(Ordering::SeqCst);

    let mut sign_in = f.sessions.sign_in(Some(&f.project), "fake", Some("tui")).await.unwrap();
    let tab = sign_in.tab.clone().unwrap();
    assert_eq!(tab.title, "Subscription");
    assert_eq!(tab.command_line, "fake-agent auth login");
    let login = sign_in.login.take().unwrap();
    assert_eq!(login.command.program, "fake-agent");
    assert!(login.command.env.contains(&("MODE".to_owned(), "login".to_owned())), "the method's env");
    assert!(login.command.env.contains(&("TOKEN".to_owned(), "s3cret-value".to_owned())), "the launch's, resolved");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), launches, "nothing ran yet");
    assert!(f.sessions.sign_in_state(Some(&f.project), "fake").unwrap().pending);
    let joined = f.sessions.sign_in(Some(&f.project), "fake", Some("tui")).await.unwrap();
    assert_eq!(joined.tab.as_ref(), Some(&tab), "a second call shows the same tab");
    assert!(joined.login.is_none(), "and runs nothing");

    // The login wrote its credentials, then exited 0.
    signed_in.store(true, Ordering::SeqCst);
    f.sessions.login_ended(&tab.terminal_id, LoginExit::Code(0));
    assert_eq!(sign_in.end().await, SignInEnd::Done);
    assert_eq!(joined.end().await, SignInEnd::Done);
    assert_eq!(events.wait_turn_end().await, "end_turn");
    assert_eq!(events.texts().join(""), "Hello, world", "the held prompt was answered");
}

#[tokio::test]
async fn a_failed_or_closed_login_keeps_the_prompt_held() {
    let f = fixture("sign-in-terminal-fail", needing_a_terminal_login());
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("error").await;
    f.sessions.send_prompt("s", text("hello")).unwrap();
    events.wait_for("held", |e| e.kind == "held").await;

    let sign_in = f.sessions.sign_in(Some(&f.project), "fake", Some("cli")).await.unwrap();
    let tab = sign_in.tab.clone().unwrap();
    assert_eq!(tab.title, "CLI Login");
    assert_eq!(sign_in.login.as_ref().unwrap().command.program, "/opt/cli");
    f.sessions.login_ended(&tab.terminal_id, LoginExit::Code(1));
    assert_eq!(sign_in.end().await, SignInEnd::Failed("CLI Login exited with 1".to_owned()));

    let again = f.sessions.sign_in(Some(&f.project), "fake", Some("cli")).await.unwrap();
    let tab = again.tab.clone().unwrap();
    f.sessions.login_ended(&tab.terminal_id, LoginExit::Closed);
    assert_eq!(again.end().await, SignInEnd::Cancelled);

    let third = f.sessions.sign_in(Some(&f.project), "fake", Some("cli")).await.unwrap();
    let cancelled = f.sessions.cancel_sign_in(Some(&f.project), "fake").unwrap();
    assert_eq!(cancelled.terminal_id, third.tab.as_ref().map(|t| t.terminal_id.clone()), "its terminal is the caller's to close");
    assert_eq!(third.end().await, SignInEnd::Cancelled);

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(event_count(&events, "prompt-returned") + event_count(&events, "turn-end"), 0, "still held");
}

fn outcomes(report: &super::SyncReport) -> Vec<(&str, super::sync::SyncOutcome, Option<usize>)> {
    report.agents.iter().map(|a| (a.agent_id.as_str(), a.outcome, a.count)).collect()
}

/// The fake agent's store, with sessions in `cwd`s.
fn stored_in(options: &FakeAgentOptions, sessions: &[(&str, &Path, Option<&str>, Option<&str>)]) {
    let mut stored = options.stored.lock().unwrap();
    for (id, cwd, title, updated_at) in sessions {
        stored.push(fake_agent::FakeSession::new(id, cwd, *title, *updated_at));
    }
}

#[tokio::test]
async fn a_sync_lists_the_agents_sessions_of_the_project_and_says_how_each_agent_did() {
    use super::sync::SyncOutcome;
    let options = listing();
    let f = fixture("sync", options.clone());
    let elsewhere = f.dir.join("elsewhere");
    stored_in(&options, &[
        ("t1", &f.project, Some("From a terminal"), Some("2026-10-20T10:00:00Z")),
        ("t2", &f.project, None, Some("2026-10-21T10:00:00Z")),
        ("x", &elsewhere, Some("Another project"), None),
    ]);
    let report = f.sessions.sync(&f.project, None).await;
    assert_eq!(outcomes(&report), [("fake", SyncOutcome::Listed, Some(2)), ("locked", SyncOutcome::Failed, None)]);
    assert!(report.agents[1].error.as_deref().unwrap().contains("missing"), "{:?}", report.agents[1].error);

    let listed = f.sessions.list();
    let rows: Vec<_> = listed.iter().map(|s| (s.id.as_str(), s.title.as_str(), s.status, s.last_activity_at.as_str())).collect();
    assert_eq!(rows, [
        ("fake~t2", "Untitled session", SessionStatus::Stopped, "2026-10-21T10:00:00.000Z"),
        ("fake~t1", "From a terminal", SessionStatus::Stopped, "2026-10-20T10:00:00.000Z"),
    ]);
    assert_eq!(listed[0].acp_session_id.as_deref(), Some("t2"));
    assert_eq!((listed[0].mode, listed[0].folder.as_str()), (Mode::Local, f.project.to_str().unwrap()));
}

#[tokio::test]
async fn the_stored_list_shows_at_once_after_a_relaunch_and_a_sync_brings_it_up_to_date() {
    let options = listing();
    let f = fixture("sync-stored", options.clone());
    stored_in(&options, &[("t1", &f.project, Some("First"), None), ("t2", &f.project, Some("Second"), None)]);
    f.sessions.sync(&f.project, None).await;
    f.sessions.shutdown();

    let relaunched = Sessions::new(options_for(&f.dir, &f.launcher));
    let mut ids: Vec<_> = relaunched.list().into_iter().map(|s| (s.id, s.title, s.status == SessionStatus::Stopped)).collect();
    ids.sort();
    assert_eq!(ids, [
        ("fake~t1".to_owned(), "First".to_owned(), true),
        ("fake~t2".to_owned(), "Second".to_owned(), true),
    ], "before any sync");
    let stored = std::fs::read_to_string(f.dir.join("data/sessions.json")).unwrap();
    assert!(!stored.contains("earlier answer") && !f.dir.join("data/sessions/fake~t1/transcript.jsonl").exists(), "no messages");

    // Deleted in a terminal, renamed by the agent.
    options.stored.lock().unwrap().retain(|s| s.id != "t2");
    options.stored.lock().unwrap()[0].title = Some("First, renamed".to_owned());
    relaunched.sync(&f.project, None).await;
    let ids: Vec<_> = relaunched.list().into_iter().map(|s| (s.id, s.title)).collect();
    assert_eq!(ids, [("fake~t1".to_owned(), "First, renamed".to_owned())]);
}

#[tokio::test]
async fn an_agent_that_cant_list_keeps_its_sessions() {
    use super::sync::SyncOutcome;
    let f = fixture("sync-unsupported", FakeAgentOptions::default());
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("idle").await;
    let report = f.sessions.sync(&f.project, Some(&["fake".to_owned()])).await;
    assert_eq!(outcomes(&report), [("fake", SyncOutcome::Unsupported, None)]);
    assert_eq!(f.sessions.list().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["s"]);
}

#[tokio::test]
async fn a_running_session_its_agent_doesnt_list_yet_stays() {
    let options = listing();
    let f = fixture("sync-running", options.clone());
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("idle").await;
    options.stored.lock().unwrap().clear();
    f.sessions.sync(&f.project, Some(&["fake".to_owned()])).await;
    assert_eq!(f.sessions.list().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["s"]);
    f.sessions.stop("s").await.unwrap();
    f.sessions.sync(&f.project, Some(&["fake".to_owned()])).await;
    assert!(f.sessions.list().is_empty(), "stopped, and gone from its agent");
}

#[tokio::test]
async fn agents_that_are_off_or_wait_for_a_sign_in_are_skipped() {
    use super::sync::SyncOutcome;
    let options = FakeAgentOptions { require_auth: true, ..listing() };
    let f = fixture("sync-skip", options);
    let fake = Some(&["fake".to_owned()][..]);
    assert_eq!(outcomes(&f.sessions.sync(&f.project, fake).await), [("fake", SyncOutcome::SignIn, None)]);
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1);
    assert!(f.sessions.sign_in_state(Some(&f.project), "fake").is_some(), "noted as a sign-in need");
    assert_eq!(outcomes(&f.sessions.sync(&f.project, fake).await), [("fake", SyncOutcome::SignIn, None)]);
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1, "not started again while it waits");

    f.sessions.inner.opts.configs.set_enabled(Some(&f.project), "fake", false).unwrap();
    assert_eq!(outcomes(&f.sessions.sync(&f.project, fake).await), [("fake", SyncOutcome::Off, None)]);
}

#[tokio::test]
async fn an_agent_that_doesnt_answer_in_time_fails_and_two_syncs_of_a_project_join() {
    use super::sync::SyncOutcome;
    let f = fixture("sync-slow", FakeAgentOptions { hang_list: true, ..listing() });
    let mut options = options_for(&f.dir, &f.launcher);
    options.sync_timeout = Duration::from_millis(300);
    let sessions = Sessions::new(options);
    let fake = Some(&["fake".to_owned()][..]);
    let (first, second) = tokio::join!(sessions.sync(&f.project, fake), sessions.sync(&f.project, fake));
    assert_eq!(first, second);
    assert_eq!(outcomes(&first), [("fake", SyncOutcome::Failed, None)]);
    assert!(first.agents[0].error.as_deref().unwrap().contains("didn't answer"));
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1, "one agent for both");
}

/// Two listing agents, `fake` and `other`, both trusted; `fake` answers only once the returned
/// sender opens it. The project has one stored session, so each agent lists one.
fn two_listing_agents(name: &str) -> (Fixture, tokio::sync::watch::Sender<bool>) {
    let options = listing();
    let f = fixture(name, options.clone());
    f.set_agents(&f.project, r#"{"version":1,"agents":{"fake":{"name":"Fake","command":"fake-agent"},
        "other":{"name":"Other","command":"other-agent"}}}"#);
    let configs = &f.sessions.inner.opts.configs;
    let launches: Vec<_> = configs.untrusted(&f.project).into_iter().map(|u| u.launch).collect();
    configs.trust(&f.project, &launches).unwrap();
    stored_in(&options, &[("t1", &f.project, Some("Stored"), None)]);
    let open = f.launcher.hold("fake-agent");
    (f, open)
}

/// Runs `second` once `first` has started `fake`, then lets `fake` answer.
async fn sync_during(f: &Fixture, open: &tokio::sync::watch::Sender<bool>, first: Option<&[String]>, second: Option<&[String]>)
    -> (super::SyncReport, super::SyncReport) {
    tokio::join!(f.sessions.sync(&f.project, first), async {
        while f.launcher.launches_of("fake-agent") == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let (report, ()) = tokio::join!(f.sessions.sync(&f.project, second), async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            open.send_replace(true);
        });
        report
    })
}

#[tokio::test]
async fn a_sync_for_another_agent_waits_for_the_running_one_and_lists_its_own() {
    use super::sync::SyncOutcome;
    let (f, open) = two_listing_agents("sync-other");
    let (fake, other) = (["fake".to_owned()], ["other".to_owned()]);
    let (first, second) = sync_during(&f, &open, Some(&fake), Some(&other)).await;
    assert_eq!(outcomes(&first), [("fake", SyncOutcome::Listed, Some(1))]);
    assert_eq!(outcomes(&second), [("other", SyncOutcome::Listed, Some(1))]);
    assert_eq!(f.launcher.launches_of("other-agent"), 1, "other was asked");
    assert_eq!(f.sessions.list().len(), 1, "the agents share one store: t1, listed once");
}

#[tokio::test]
async fn a_full_sync_during_a_one_agent_sync_reports_every_agent() {
    use super::sync::SyncOutcome;
    let (f, open) = two_listing_agents("sync-full-after-one");
    let fake = ["fake".to_owned()];
    let (_, second) = sync_during(&f, &open, Some(&fake), None).await;
    assert_eq!(outcomes(&second), [("fake", SyncOutcome::Listed, Some(1)), ("other", SyncOutcome::Listed, Some(1))]);
}

#[tokio::test]
async fn a_sync_for_some_agents_joins_a_running_full_sync() {
    use super::sync::SyncOutcome;
    let (f, open) = two_listing_agents("sync-join-full");
    let fake = ["fake".to_owned()];
    let (first, second) = sync_during(&f, &open, None, Some(&fake)).await;
    assert_eq!(first, second);
    assert_eq!(outcomes(&first), [("fake", SyncOutcome::Listed, Some(1)), ("other", SyncOutcome::Listed, Some(1))]);
    assert_eq!(f.launcher.launches_of("fake-agent"), 1, "fake is asked once");
    let lists: usize = lock(&f.launcher.agents).iter().map(|a| a.lists.load(Ordering::SeqCst)).sum();
    assert_eq!(lists, 2, "each agent listed once");
}

#[tokio::test]
async fn a_session_its_agent_saw_active_just_now_is_active_elsewhere_for_a_while_unless_it_was_here() {
    let options = listing();
    let f = fixture("sync-elsewhere", options.clone());
    let now = crate::session::iso_now();
    stored_in(&options, &[("busy", &f.project, None, Some(now.as_str())), ("old", &f.project, None, Some("2026-01-01T00:00:00Z"))]);
    f.sessions.sync(&f.project, None).await;
    let until = |sessions: &Sessions, id: &str| sessions.list().into_iter().find(|s| s.id == id).unwrap().active_elsewhere_until;
    let now_ms = crate::session::parse_iso_millis(&now).unwrap();
    assert_eq!(until(&f.sessions, "fake~busy"), Some(crate::session::iso_from_millis(now_ms + 2 * 60_000)), "its activity and two minutes");
    let old = until(&f.sessions, "fake~old").unwrap();
    assert!(old.as_str() < now.as_str(), "long over: {old}");

    let (_, events) = f.create("here", "fake").unwrap();
    assert_eq!(f.ask("here", &events, "hello").await, "Hello, world");
    f.sessions.stop("here").await.unwrap();
    f.sessions.sync(&f.project, None).await;
    assert_eq!(until(&f.sessions, "here"), None, "its last activity was Brama's");
}

#[tokio::test]
async fn an_agent_stays_up_between_syncs_to_list_again() {
    let options = listing();
    let f = fixture("sync-kept", options.clone());
    let fake = Some(&["fake".to_owned()][..]);
    f.sessions.sync(&f.project, fake).await;
    stored_in(&options, &[("later", &f.project, Some("Started later"), None)]);
    f.sessions.sync(&f.project, fake).await;
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 1, "listed again by the same agent");
    assert_eq!(f.sessions.list().iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), ["Started later"]);
    let agent = Arc::clone(lock(&f.launcher.agents).last().unwrap());
    assert_eq!(agent.lists.load(Ordering::SeqCst), 2);

    // One that went away is started again.
    agent.crash.notify_one();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let report = f.sessions.sync(&f.project, fake).await;
    assert_eq!(report.agents[0].outcome, super::sync::SyncOutcome::Listed);
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 2);
}

/// The fake agent with a CLI of its own: a shell that prints what it got and waits, or exits
/// with 3 when its first argument is `--exit`.
const CLI_AGENTS: &str = r#"{"version":1,"agents":{
    "fake":{"name":"Fake","command":"fake-agent","env":{"TOKEN":"${keychain:token}"},
        "cli":{"command":"/bin/sh","args":["-c","echo \"ARGS:$*\" \"PWD:$(pwd)\" \"TOKEN:$TOKEN\"; [ \"$1\" = --exit ] && exit 3; sleep 30","cli"],
            "resumeArgs":["--resume","{id}"],"newArgs":["--session-id","{id}"]}},
    "reader":{"name":"Reader","command":"fake-agent",
        "cli":{"command":"/bin/sh","args":["-c","stty -icanon -echo; printf 'ARGS:%s READY\\033[?2004h' \"$*\"; dd bs=1 count=16 2>/dev/null | tr '\\033' '^'; echo END","cli"],
            "resumeArgs":["--resume","{id}"],"newArgs":["--session-id","{id}"]}},
    "quitter":{"name":"Quitter","command":"fake-agent","cli":{"command":"/bin/sh","args":["-c","exit 3","cli"],"resumeArgs":["{id}"]}},
    "plain":{"name":"Plain","command":"fake-agent"},
    "missing":{"name":"Missing","command":"fake-agent","cli":{"command":"/nonexistent/brama-cli","resumeArgs":["{id}"],"newArgs":["{id}"]}}}}"#;

/// What a CLI's terminal shows, and how it ended.
#[derive(Default)]
struct Screen {
    output: Mutex<Vec<u8>>,
    events: Mutex<Vec<crate::terminal::TerminalEvent>>,
}

impl crate::terminal::TerminalSink for Screen {
    fn output(&self, bytes: &[u8]) -> bool {
        lock(&self.output).extend_from_slice(bytes);
        true
    }

    fn event(&self, event: &crate::terminal::TerminalEvent) -> bool {
        lock(&self.events).push(event.clone());
        true
    }
}

impl Screen {
    async fn wait_for(&self, text: &str) -> String {
        let started = Instant::now();
        loop {
            let shown = String::from_utf8_lossy(&lock(&self.output)).into_owned();
            if shown.contains(text) {
                return shown;
            }
            assert!(started.elapsed() < Duration::from_secs(5), "no {text:?} in {shown:?}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

fn terminals() -> crate::terminal::Terminals {
    crate::terminal::Terminals::new(crate::terminal::TerminalsOptions { shell: None, version: "test".into() })
}

fn window(terminals: &crate::terminal::Terminals) -> CliWindow<'_> {
    CliWindow { terminals, group: "main", cols: 200, rows: 24 }
}

fn attach(terminals: &crate::terminal::Terminals, terminal_id: &str) -> Arc<Screen> {
    let screen = Arc::new(Screen::default());
    terminals.attach(terminal_id, Arc::clone(&screen) as Arc<dyn crate::terminal::TerminalSink>).unwrap();
    screen
}

fn listed(f: &Fixture, id: &str) -> Session {
    f.sessions.list().into_iter().find(|s| s.id == id).unwrap()
}

impl Fixture {
    /// The project's agents with CLIs, trusted.
    fn give_cli_agents(&self) {
        self.set_agents(&self.project, CLI_AGENTS);
        let configs = &self.sessions.inner.opts.configs;
        let launches: Vec<_> = configs.untrusted(&self.project).into_iter().map(|u| u.launch).collect();
        configs.trust(&self.project, &launches).unwrap();
    }

    /// A session of `agent` that started once (so its agent has it) and is stopped.
    async fn started_then_stopped(&self, id: &str, agent: &str) -> (String, Arc<Recorder>) {
        let (_, events) = self.create(id, agent).unwrap();
        events.wait_status("idle").await;
        self.sessions.stop(id).await.unwrap();
        (listed(self, id).acp_session_id.unwrap(), events)
    }

    fn draft(&self, agent: &str, workspace: WorkspaceChoice) -> CliDraft {
        CliDraft {
            project_path: self.project.to_string_lossy().into_owned(),
            agent_id: agent.to_owned(),
            title: "New session".to_owned(),
            config: BTreeMap::new(),
            workspace,
            prompt: None,
        }
    }
}

#[tokio::test]
async fn a_session_continues_in_its_agents_cli_in_its_folder_with_its_env() {
    let f = fixture("cli", FakeAgentOptions::default());
    f.give_cli_agents();
    let terminals = terminals();
    let (_, events) = f.create("s1", "fake").unwrap();
    events.wait_status("idle").await;
    let refused = f.sessions.open_cli("s1", None, window(&terminals)).await.unwrap_err();
    assert!(refused.contains("running"), "{refused}");

    f.sessions.stop("s1").await.unwrap();
    let acp = listed(&f, "s1").acp_session_id.unwrap();
    let opened = f.sessions.open_cli("s1", None, window(&terminals)).await.unwrap();
    assert_eq!(opened.terminal_id, "cli-s1");
    let shown = attach(&terminals, &opened.terminal_id).wait_for("TOKEN:").await;
    assert!(shown.contains(&format!("ARGS:--resume {acp}")), "{shown}");
    assert!(shown.contains(&format!("PWD:{}", f.project.display())), "{shown}");
    assert!(shown.contains("TOKEN:s3cret-value"), "the agent's env: {shown}");
    assert!(listed(&f, "s1").in_terminal);
    let again = f.sessions.open_cli("s1", None, window(&terminals)).await.unwrap();
    assert_eq!(again, opened, "one CLI per session");
    let other = CliWindow { terminals: &terminals, group: "other", cols: 80, rows: 24 };
    let refused = f.sessions.open_cli("s1", None, other).await.unwrap_err();
    assert_eq!(refused, "Shown in the terminal of another window");

    // Every session the page gets says so.
    assert!(f.sessions.rename("s1", "Renamed").unwrap().in_terminal, "rename");
    let sink: Arc<dyn EventSink> = Arc::new(Recorder::default());
    assert!(f.sessions.attach("s1", "other", sink).unwrap().in_terminal, "attach");

    // The agent isn't started meanwhile.
    let launches = f.launcher.launches.load(Ordering::SeqCst);
    assert!(!f.sessions.resume("s1").await.unwrap());
    let refused = f.sessions.send_prompt("s1", text("hi")).unwrap_err();
    assert!(refused.contains("open in the terminal"), "{refused}");
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), launches);

    f.sessions.close_cli("s1").await.unwrap();
    assert!(!listed(&f, "s1").in_terminal);
    assert!(!terminals.owns("main", "cli-s1"), "its terminal is closed");
    assert!(f.sessions.resume("s1").await.unwrap(), "the chat can start it again");
}

#[tokio::test]
async fn a_draft_starts_in_the_cli_under_its_own_id() {
    let f = fixture("cli-draft", FakeAgentOptions::default());
    f.give_cli_agents();
    let terminals = terminals();
    let id = "0cb916db-26aa-40f2-86b5-1ba81b225fd2";
    let opened = f.sessions.open_cli(id, Some(f.draft("fake", WorkspaceChoice::Main)), window(&terminals)).await.unwrap();
    let shown = attach(&terminals, &opened.terminal_id).wait_for("TOKEN:").await;
    assert!(shown.contains(&format!("ARGS:--session-id {id} PWD:")), "no prompt, nothing after the id: {shown}");
    let session = listed(&f, id);
    assert_eq!(session.acp_session_id.as_deref(), Some(id), "the CLI's id is its ACP id");
    assert_eq!((session.status, session.in_terminal), (SessionStatus::Stopped, true));
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 0, "no ACP agent");

    let other = "1cb916db-26aa-40f2-86b5-1ba81b225fd2";
    let refused = f.sessions.open_cli(other, Some(f.draft("quitter", WorkspaceChoice::Main)), window(&terminals)).await.unwrap_err();
    assert!(refused.contains("can't start a session"), "{refused}");
    let refused = f.sessions.open_cli(other, Some(f.draft("plain", WorkspaceChoice::Main)), window(&terminals)).await.unwrap_err();
    assert!(refused.contains("no terminal mode"), "{refused}");
    let refused = f.sessions.open_cli("not-a-uuid", Some(f.draft("fake", WorkspaceChoice::Main)), window(&terminals)).await.unwrap_err();
    assert!(refused.contains("UUID"), "{refused}");
    assert!(f.sessions.list().iter().all(|s| s.id == id), "nothing created for a refusal");
    terminals.close(&[opened.terminal_id]);
}

#[tokio::test]
async fn a_draft_sent_to_the_cli_starts_it_with_its_first_prompt() {
    let f = fixture("cli-draft-prompt", FakeAgentOptions::default());
    f.give_cli_agents();
    let terminals = terminals();
    let id = "3cb916db-26aa-40f2-86b5-1ba81b225fd2";
    let draft = CliDraft { prompt: Some("fix the build".into()), ..f.draft("fake", WorkspaceChoice::Main) };
    let opened = f.sessions.open_cli(id, Some(draft), window(&terminals)).await.unwrap();
    let shown = attach(&terminals, &opened.terminal_id).wait_for("TOKEN:").await;
    assert!(shown.contains(&format!("ARGS:--session-id {id} fix the build")), "{shown}");
    terminals.close(&[opened.terminal_id]);
}

#[tokio::test]
async fn a_first_prompt_too_long_for_the_command_line_is_pasted_once_the_cli_reads() {
    let f = fixture("cli-draft-long", FakeAgentOptions::default());
    f.give_cli_agents();
    let terminals = terminals();
    let id = "4cb916db-26aa-40f2-86b5-1ba81b225fd2";
    let prompt = format!("fix {}", "x".repeat(agent_api::MAX_ARG_PROMPT));
    let draft = CliDraft { prompt: Some(prompt), ..f.draft("reader", WorkspaceChoice::Main) };
    let opened = f.sessions.open_cli(id, Some(draft), window(&terminals)).await.unwrap();
    let shown = attach(&terminals, &opened.terminal_id).wait_for("END").await;
    assert!(shown.contains(&format!("ARGS:--session-id {id} READY")), "not on the command line: {shown}");
    assert!(shown.contains("^[200~fix xxxx"), "pasted, bracketed: {shown}");
    terminals.close(&[opened.terminal_id]);
}

#[tokio::test]
async fn a_cli_starts_with_the_model_picked_in_the_composer() {
    let f = fixture("cli-draft-picks", FakeAgentOptions::default());
    f.give_cli_agents();
    let terminals = terminals();
    let id = "5cb916db-26aa-40f2-86b5-1ba81b225fd2";
    let config = BTreeMap::from([("model".to_owned(), "opus".to_owned())]);
    let draft = CliDraft { prompt: Some("fix it".into()), config, ..f.draft("fake", WorkspaceChoice::Main) };
    let opened = f.sessions.open_cli(id, Some(draft), window(&terminals)).await.unwrap();
    let shown = attach(&terminals, &opened.terminal_id).wait_for("TOKEN:").await;
    assert!(shown.contains(&format!("ARGS:--session-id {id} --model opus fix it")), "{shown}");
    terminals.close(std::slice::from_ref(&opened.terminal_id));
    f.sessions.close_cli(id).await.unwrap();

    // Continued in the terminal later: the session's own picks again.
    let opened = f.sessions.open_cli(id, None, window(&terminals)).await.unwrap();
    let shown = attach(&terminals, &opened.terminal_id).wait_for("TOKEN:").await;
    assert!(shown.contains(&format!("ARGS:--resume {id} --model opus")), "{shown}");
    terminals.close(&[opened.terminal_id]);
}

#[tokio::test]
async fn a_worktree_sessions_cli_runs_in_its_checked_out_folder() {
    let f = git_fixture("cli-worktree");
    f.give_cli_agents();
    let terminals = terminals();
    let id = "2cb916db-26aa-40f2-86b5-1ba81b225fd2";
    let opened = f.sessions.open_cli(id, Some(f.draft("fake", f.new_workspace(None))), window(&terminals)).await.unwrap();
    let folder = listed(&f, id).folder;
    assert_ne!(folder, f.project.to_string_lossy());
    assert!(Path::new(&folder).join("a.txt").is_file(), "checked out before the CLI starts");
    let shown = attach(&terminals, &opened.terminal_id).wait_for("TOKEN:").await;
    assert!(shown.contains(&format!("PWD:{folder}")), "{shown}");
    terminals.close(&[opened.terminal_id]);
}

#[tokio::test]
async fn the_clis_exit_is_reported_and_frees_the_session() {
    let f = fixture("cli-exit", FakeAgentOptions::default());
    f.give_cli_agents();
    let terminals = terminals();
    let (_, events) = f.started_then_stopped("q", "quitter").await;
    events.clear();
    f.sessions.open_cli("q", None, window(&terminals)).await.unwrap();
    let exited = events.wait_for("cli-exited", |e| e.kind == "cli-exited").await;
    assert_eq!(exited.payload, json!({ "code": 3, "signal": null }));
    assert!(!listed(&f, "q").in_terminal);
    let session = events.wait_for("the session after", |e| e.kind == "session" && e.payload["inTerminal"] == false).await;
    assert_eq!(session.payload["id"], "q");
    let started = Instant::now();
    while terminals.owns("main", "cli-q") {
        assert!(started.elapsed() < Duration::from_secs(5), "its terminal is closed once it exited");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!f.sessions.cli_busy("q").unwrap(), "nothing runs");
}

#[tokio::test]
async fn removing_the_session_or_turning_its_agent_off_closes_its_cli() {
    let f = fixture("cli-close", FakeAgentOptions::default());
    f.give_cli_agents();
    let terminals = terminals();
    f.started_then_stopped("a", "fake").await;
    f.started_then_stopped("b", "fake").await;
    for id in ["a", "b"] {
        let opened = f.sessions.open_cli(id, None, window(&terminals)).await.unwrap();
        attach(&terminals, &opened.terminal_id).wait_for("TOKEN:").await;
    }
    assert!(f.sessions.cli_busy("a").is_ok());

    f.sessions.remove("a").await.unwrap();
    assert!(!terminals.owns("main", "cli-a"));

    f.sessions.inner.opts.configs.set_enabled(Some(&f.project), "fake", false).unwrap();
    f.sessions.sync_agents(&f.project).await;
    assert!(!terminals.owns("main", "cli-b"));
    assert!(!listed(&f, "b").in_terminal);
}

impl Fixture {
    /// A chat created in a workspace.
    /// A new workspace of the project, unnamed (its first chat names it), from `base` (`None`:
    /// the project's base branch); checked out at its first chat's start.
    fn new_workspace(&self, base: Option<&str>) -> WorkspaceChoice {
        let ws = self.sessions.workspaces().place(&self.project, None, base).unwrap();
        WorkspaceChoice::Existing { id: ws.id }
    }

    fn create_in_workspace(&self, id: &str, workspace: &str) -> Result<(Session, Arc<Recorder>), String> {
        self.create_in(id, "fake", WorkspaceChoice::Existing { id: workspace.to_owned() })
    }
}

#[tokio::test]
async fn the_first_chat_of_an_unnamed_workspace_names_it_after_its_first_message() {
    let f = git_fixture("ws-unnamed-chat");
    let ws = f.sessions.workspaces().place(&f.project, None, None).unwrap();

    f.create_in_workspace("first", &ws.id).unwrap();
    let named = f.sessions.workspaces().get(&ws.id).unwrap().name;
    f.create_in_workspace("second", &ws.id).unwrap();

    assert_eq!(named, "Session first");
    assert_eq!(f.sessions.workspaces().get(&ws.id).unwrap().name, "Session first", "a later chat doesn't rename it");
}

#[tokio::test]
async fn a_chat_is_created_in_an_unnamed_workspace_even_when_renaming_it_fails() {
    let f = git_fixture("ws-rename-fails");
    let ws = f.sessions.workspaces().place(&f.project, None, None).unwrap();
    // `workspaces.json` can't be written: its temp file's name is taken by a folder.
    std::fs::create_dir_all(f.dir.join("data/workspaces.json.tmp/x")).unwrap();

    let created = f.create_in_workspace("first", &ws.id);

    assert!(created.is_ok(), "{:?}", created.err());
}

#[tokio::test]
async fn a_chat_in_a_workspace_runs_in_its_folder_and_removing_it_leaves_the_folder() {
    let f = git_fixture("ws-chat");
    let ws = f.sessions.workspaces().create(&f.project, "Fix login", None).unwrap();

    let (chat, events) = f.create_in_workspace("c", &ws.id).unwrap();
    events.wait_status("idle").await;

    assert_eq!(chat.workspace_id.as_deref(), Some(ws.id.as_str()));
    assert_eq!(PathBuf::from(&chat.folder), ws.folder, "its agent works in the workspace's folder");
    assert_eq!(chat.branch.as_deref(), Some(ws.branch.as_str()));
    f.sessions.remove("c").await.unwrap();
    assert!(ws.folder.join("a.txt").is_file(), "the folder stays");
    assert!(run_in(&f.project, &["branch", "--list", &ws.branch]).contains(&ws.branch), "the branch stays");
}

#[tokio::test]
async fn deleting_a_workspace_removes_its_chats_and_its_folder() {
    let options = FakeAgentOptions { delete_session: true, ..listing() };
    let f = git_fixture_with("ws-delete-chats", options.clone());
    let ws = f.sessions.workspaces().create(&f.project, "Fix login", None).unwrap();
    let (_, events) = f.create_in_workspace("c", &ws.id).unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("c", text("slow")).unwrap();
    events.wait_for("first chunk", |e| e.kind == "update").await;

    f.sessions.delete_workspace(&ws.id, true).await.unwrap();

    assert_eq!(events.wait_turn_end().await, "cancelled", "the running turn ends");
    assert!(f.sessions.list().is_empty(), "its chats are gone");
    assert!(options.stored.lock().unwrap().is_empty(), "deleted in the agent");
    assert!(!ws.worktree_path.exists());
    assert!(f.sessions.workspaces().list(&f.project).is_empty());
}

#[tokio::test]
async fn a_delete_preview_counts_uncommitted_files_and_commits_and_names_working_chats() {
    let f = git_fixture("ws-preview");
    let ws = f.sessions.workspaces().create(&f.project, "Fix login", None).unwrap();
    let (_, events) = f.create_in_workspace("busy", &ws.id).unwrap();
    let (_, idle) = f.create_in_workspace("idle", &ws.id).unwrap();
    events.wait_status("idle").await;
    idle.wait_status("idle").await;
    std::fs::write(ws.folder.join("x.txt"), "x").unwrap();
    run_in(&ws.folder, &["add", "."]);
    run_in(&ws.folder, &["commit", "-qm", "work"]);
    std::fs::write(ws.folder.join("a.txt"), "changed").unwrap();
    std::fs::write(ws.folder.join("new.txt"), "new").unwrap();
    f.sessions.send_prompt("busy", text("slow")).unwrap();
    events.wait_for("first chunk", |e| e.kind == "update").await;

    let preview = f.sessions.workspace_delete_preview(&ws.id).await.unwrap();

    assert_eq!((preview.uncommitted, preview.commits), (2, 1));
    assert_eq!(preview.working, vec!["Session busy".to_owned()]);
    f.sessions.cancel("busy").ok();
}

#[tokio::test]
async fn worktree_sessions_become_workspaces_at_load_and_local_ones_stay_in_main() {
    let f = git_fixture("ws-migrate");
    let (tree, events) = f.create_in("t", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    let (_, local) = f.create("l", "fake").unwrap();
    local.wait_status("idle").await;
    f.sessions.shutdown();
    // As an older version stored them: no workspaces, no workspace ids.
    let _ = std::fs::remove_file(f.dir.join("data/workspaces.json"));
    let path = f.dir.join("data/sessions.json");
    let mut stored: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    for record in &mut stored {
        record.as_object_mut().unwrap().remove("workspaceId");
    }
    std::fs::write(&path, serde_json::to_string(&stored).unwrap()).unwrap();

    let reopened = Sessions::new(options_for(&f.dir, &f.launcher));

    let workspaces = reopened.workspaces().list(&f.project);
    assert_eq!(workspaces.len(), 1);
    let ws = &workspaces[0];
    assert_eq!(ws.name, "Session t");
    assert_eq!(Some(ws.folder.to_string_lossy().into_owned()), Some(tree.folder.clone()), "folder unchanged");
    assert_eq!(Some(ws.branch.clone()), tree.branch, "branch unchanged");
    assert_eq!(Some(ws.base_commit.clone()), tree.base_commit);
    let listed = reopened.list();
    let workspace_of = |id: &str| listed.iter().find(|s| s.id == id).unwrap().workspace_id.clone();
    assert_eq!(workspace_of("t").as_deref(), Some(ws.id.as_str()));
    assert_eq!(workspace_of("l"), None, "local sessions are Main's");

    reopened.shutdown();
    let again = Sessions::new(options_for(&f.dir, &f.launcher));
    assert_eq!(again.workspaces().list(&f.project), workspaces, "loading twice adds nothing");
}

#[tokio::test]
async fn a_corrupt_workspaces_file_loses_no_chats_workspace_or_worktree() {
    let f = git_fixture("ws-corrupt");
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    let (_, events) = f.create_in_workspace("a", &ws.id).unwrap();
    events.wait_status("idle").await;
    std::fs::write(ws.folder.join("a.txt"), "edited").unwrap();
    f.sessions.shutdown();
    std::fs::write(f.dir.join("data/workspaces.json"), "{ not json").unwrap();

    let reopened = Sessions::new(options_for(&f.dir, &f.launcher));
    reopened.tidy_worktrees();

    let workspaces = reopened.workspaces().list(&f.project);
    assert_eq!(workspaces.iter().map(|w| &w.folder).collect::<Vec<_>>(), [&ws.folder], "its workspace is back");
    let chat = reopened.list().into_iter().find(|s| s.id == "a").unwrap();
    assert_eq!(chat.workspace_id.as_deref(), Some(workspaces[0].id.as_str()));
    assert_eq!(std::fs::read_to_string(ws.folder.join("a.txt")).unwrap(), "edited", "the worktree stays");
}

#[tokio::test]
async fn a_workspace_being_deleted_gets_no_new_or_listed_chat() {
    let options = listing();
    let f = git_fixture_with("ws-deleting", options.clone());
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    options.stored.lock().unwrap().push(fake_agent::FakeSession::new("in-ws", &ws.folder, Some("Listed"), None));
    let deleting = f.sessions.workspaces().deleting(&ws.id);

    let err = f.create_in_workspace("late", &ws.id).unwrap_err();
    f.sessions.sync(&f.project, None).await;

    assert!(err.contains("being deleted"), "{err}");
    assert!(f.sessions.list().is_empty(), "neither the new nor the listed chat");
    drop(deleting);
    assert!(f.create_in_workspace("after", &ws.id).is_ok(), "a delete that stopped leaves it usable");
}

#[tokio::test]
async fn a_workspace_outlives_its_only_chat() {
    let f = git_fixture("ws-new");

    let (chat, events) = f.create_in("b", "fake", f.new_workspace(Some("main"))).unwrap();
    events.wait_status("idle").await;

    let workspaces = f.sessions.workspaces().list(&f.project);
    assert_eq!(workspaces.len(), 1);
    let ws = &workspaces[0];
    assert_eq!((ws.name.as_str(), ws.branch.as_str(), ws.base_branch.as_deref()), ("Session b", "brama/workspace", Some("main")));
    assert_eq!(chat.workspace_id.as_deref(), Some(ws.id.as_str()));
    assert_eq!(PathBuf::from(&chat.folder), ws.folder, "its agent works in the workspace's folder");
    assert!(ws.folder.join("a.txt").is_file(), "checked out at the chat's start");

    f.sessions.remove("b").await.unwrap();
    assert_eq!(f.sessions.workspaces().list(&f.project), workspaces, "only Delete workspace removes it");
    assert!(ws.folder.join("a.txt").is_file(), "the folder stays");
    assert!(run_in(&f.project, &["branch", "--list", &ws.branch]).contains(&ws.branch), "the branch stays");
}

#[tokio::test]
async fn main_runs_in_the_project_folder_without_git_and_another_projects_workspace_is_refused() {
    let plain = fixture("ws-main-plain", FakeAgentOptions::default());
    std::fs::remove_dir_all(plain.project.join(".git")).unwrap();
    let (chat, events) = plain.create("m", "fake").unwrap();
    events.wait_status("idle").await;
    assert_eq!((chat.mode, chat.workspace_id, chat.folder), (Mode::Local, None, plain.project.to_string_lossy().into_owned()));

    let f = git_fixture("ws-existing-refused");
    let other = f.dir.join("other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("b.txt"), "b\n").unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["add", "."], &["commit", "-qm", "init"]] {
        run_in(&other, args);
    }
    let theirs = f.sessions.workspaces().create(&dunce::canonicalize(&other).unwrap(), "Theirs", None).unwrap();
    let err = f.create_in_workspace("x", &theirs.id).unwrap_err();
    assert!(err.contains("another project"), "{err}");
    assert!(f.sessions.list().is_empty());
}

#[tokio::test]
async fn turns_in_one_workspace_queue_on_its_folder_and_main_doesnt_wait_for_them() {
    let f = git_fixture("slot-workspace");
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    let (_, first) = f.create_in_workspace("first", &ws.id).unwrap();
    let (_, second) = f.create_in_workspace("second", &ws.id).unwrap();
    let (_, main) = f.create("main", "fake").unwrap();
    for events in [&first, &second, &main] {
        events.wait_status("idle").await;
    }
    f.sessions.send_prompt("first", text("sleep 500")).unwrap();
    first.wait_for("turn-start", |e| e.kind == "turn-start").await;

    f.sessions.send_prompt("second", text("hello")).unwrap();
    f.sessions.send_prompt("main", text("hello")).unwrap();

    assert_eq!(main.wait_turn_end().await, "end_turn", "Main has a slot of its own");
    assert!(!has(&main, "queued"));
    let queued = second.wait_for("queued", |e| e.kind == "queued").await;
    assert_eq!(queued.payload["holder"]["id"], "first", "behind the workspace's other chat");
    assert_eq!(second.wait_turn_end().await, "end_turn");
}

#[tokio::test]
async fn parallel_turns_in_one_workspace_hear_of_each_others_changes_in_its_folder() {
    let f = git_fixture("overlap-workspace");
    std::fs::write(f.project.join(".brama/workspace.json"), r#"{"version":1,"localTurns":"parallel"}"#).unwrap();
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    let file = ws.folder.join("a.txt").to_string_lossy().into_owned();
    let (_, a) = f.create_in_workspace("a", &ws.id).unwrap();
    let (_, b) = f.create_in_workspace("b", &ws.id).unwrap();
    for e in [&a, &b] {
        e.wait_status("idle").await;
    }
    for id in ["a", "b"] {
        f.sessions.send_prompt(id, text(&format!("edit {file} 400"))).unwrap();
    }
    for e in [&a, &b] {
        e.kind_seen("tool_call_update").await;
    }

    f.sessions.note_changes(&f.project, &["a.txt".to_owned()]);
    assert!(!has(&a, "overlap"), "Main's folder isn't the workspace's");
    f.sessions.note_changes(&ws.folder, &["a.txt".to_owned()]);

    a.wait_for("overlap", |e| e.kind == "overlap" && e.payload["other"]["id"] == "b").await;
    b.wait_for("overlap", |e| e.kind == "overlap" && e.payload["other"]["id"] == "a").await;
}

#[tokio::test]
async fn a_session_listed_in_a_workspaces_folder_lands_in_that_workspace() {
    let options = listing();
    let f = git_fixture_with("sync-workspace", options.clone());
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    options.stored.lock().unwrap().extend([
        fake_agent::FakeSession::new("in-ws", &ws.folder, Some("In the workspace"), None),
        fake_agent::FakeSession::new("in-main", &f.project, Some("In Main"), None),
    ]);

    f.sessions.sync(&f.project, None).await;

    let listed = f.sessions.list();
    let by_title = |t: &str| listed.iter().find(|s| s.title == t).unwrap().clone();
    let in_ws = by_title("In the workspace");
    assert_eq!(in_ws.workspace_id.as_deref(), Some(ws.id.as_str()));
    assert_eq!(PathBuf::from(&in_ws.folder), ws.folder, "its folder is its cwd");
    assert_eq!((in_ws.mode, in_ws.branch.as_deref()), (Mode::Worktree, Some(ws.branch.as_str())));
    assert_eq!(by_title("In Main").workspace_id, None);
}

#[tokio::test]
async fn at_launch_a_workspaces_worktree_stays_though_no_chat_runs_in_it() {
    let f = git_fixture("tidy-workspace");
    let ws = f.sessions.workspaces().create(&f.project, "Empty", None).unwrap();

    f.sessions.tidy_worktrees();

    assert!(ws.folder.join("a.txt").is_file(), "kept");
}

#[tokio::test]
async fn a_workspaces_git_actions_wait_for_none_of_its_chats_and_hold_them_all() {
    let f = git_fixture("ws-actions");
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    let (_, busy) = f.create_in_workspace("busy", &ws.id).unwrap();
    let (_, idle) = f.create_in_workspace("idle", &ws.id).unwrap();
    busy.wait_status("idle").await;
    idle.wait_status("idle").await;
    std::fs::write(ws.folder.join("committed.txt"), "c\n").unwrap();
    run_in(&ws.folder, &["add", "."]);
    run_in(&ws.folder, &["commit", "-qm", "agent"]);
    std::fs::write(ws.folder.join("a.txt"), "edited").unwrap();
    let names = |files: Vec<crate::git::repo::FileStatus>| files.into_iter().map(|f| f.path).collect::<Vec<_>>();
    assert_eq!(names(f.sessions.workspace_changes(&ws.id).unwrap()), ["a.txt", "committed.txt"]);
    assert_eq!(f.sessions.workspace_file_at_base(&ws.id, "a.txt").unwrap().as_deref(), Some("one\ntwo\nthree\n"));

    // Refused while one chat works, naming it; the other chat's slot is left alone.
    f.sessions.send_prompt("busy", text("slow")).unwrap();
    busy.wait_for("first chunk", |e| e.kind == "update").await;
    let err = f.sessions.workspace_apply_locally(&ws.id).await.unwrap_err();
    assert!(err.contains("Session busy") && err.contains("working in this workspace"), "{err}");
    assert_eq!(f.ask("idle", &idle, "hello").await, "Hello, world", "a refused claim holds no chat");
    f.sessions.cancel("busy").unwrap();
    busy.wait_turn_end().await;

    // While it runs, every chat refuses a prompt.
    let held = f.sessions.hold_workspace(&ws.id).unwrap();
    assert!(f.sessions.send_prompt("idle", text("hello")).is_err());
    drop(held);
    assert_eq!(f.sessions.workspace_apply_locally(&ws.id).await.unwrap(), ApplyOutcome::Clean);
    assert_eq!(std::fs::read_to_string(f.project.join("a.txt")).unwrap(), "edited");
    assert_eq!(std::fs::read_to_string(f.project.join("committed.txt")).unwrap(), "c\n");

    // Check out branch stops every chat and hands the branch to Main.
    run_in(&f.project, &["stash", "-uq"]);
    run_in(&ws.folder, &["checkout", "-q", "--", "a.txt"]);
    f.sessions.workspace_check_out_branch(&ws.id).await.unwrap();
    assert_eq!(run_in(&f.project, &["branch", "--show-current"]).trim(), ws.branch);
    assert!(f.sessions.list().iter().all(|s| s.status == SessionStatus::Stopped));
}

#[tokio::test]
async fn recreating_a_workspaces_deleted_folder_checks_it_out_from_its_branch() {
    let f = git_fixture("ws-recreate");
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    let (_, events) = f.create_in_workspace("c", &ws.id).unwrap();
    events.wait_status("idle").await;
    std::fs::write(ws.folder.join("work.txt"), "agent work\n").unwrap();
    run_in(&ws.folder, &["add", "."]);
    run_in(&ws.folder, &["commit", "-qm", "agent"]);
    f.sessions.stop("c").await.unwrap();
    std::fs::remove_dir_all(&ws.worktree_path).unwrap();
    events.clear();
    f.sessions.restart("c").await.unwrap();
    let failed = events.wait_status("error").await;
    assert!(failed.payload["message"].as_str().unwrap().contains("folder is missing"), "{failed:?}");

    f.sessions.recreate_workspace(&ws.id).await.unwrap();

    assert_eq!(std::fs::read_to_string(ws.folder.join("work.txt")).unwrap(), "agent work\n", "from its branch");
    events.clear();
    f.sessions.restart("c").await.unwrap();
    events.wait_status("idle").await;
}

#[tokio::test]
async fn a_new_workspace_follows_its_first_chats_agent_title_until_renamed() {
    let f = git_fixture("ws-follow-title");
    let told = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let sink = Arc::clone(&told);
    f.sessions.workspaces().on_change(Arc::new(move |project: &Path| lock(&sink).push(project.to_path_buf())));
    let (first, events) = f.create_in("a", "fake", f.new_workspace(None)).unwrap();
    let ws = first.workspace_id.unwrap();
    let (_, second) = f.create_in_workspace("b", &ws).unwrap();
    events.wait_status("idle").await;
    second.wait_status("idle").await;
    let name = || f.sessions.workspaces().get(&ws).unwrap().name;

    f.ask("a", &events, "title Tree view gaps").await;
    assert_eq!(name(), "Tree view gaps");
    assert!(lock(&told).contains(&f.project), "the page hears of it");

    f.ask("b", &second, "title Something else").await;
    assert_eq!(name(), "Tree view gaps", "only its first chat names it");

    f.sessions.workspaces().rename(&ws, "Mine").unwrap();
    f.ask("a", &events, "title Later").await;
    assert_eq!(name(), "Mine", "a user's name stays");
}
