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
}

impl Launcher for FakeLauncher {
    fn launch(&self, _env: &dyn SessionEnv, _agent: &AgentConfig, process_env: &[(String, String)], _stderr: File)
        -> Result<Launched, String> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        *lock(&self.env) = process_env.to_vec();
        let (writer, reader, state) = fake_agent::start(self.options.clone());
        lock(&self.agents).push(state);
        Ok(Launched { process: None, writer: Box::new(writer), reader: Box::new(reader) })
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
    let f = fixture(name, FakeAgentOptions::default());
    std::fs::remove_dir_all(f.project.join(".git")).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["add", "."], &["commit", "-qm", "init"]] {
        run_in(&f.project, args);
    }
    f
}

fn options_for(dir: &Path, launcher: &Arc<FakeLauncher>) -> SessionsOptions {
    SessionsOptions {
        data_dir: dir.join("data"),
        configs: AgentConfigs::new(Some(dir.join("config/agents.json")), Some(dir.join("data/trusted-agents.json"))),
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
    }
}

/// How long the fixture's ended turns still count for an overlap.
const OVERLAP_GRACE: Duration = Duration::from_millis(200);

impl Fixture {
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
        self.create_in(id, agent, Mode::Local, None)
    }

    fn create_in(&self, id: &str, agent: &str, mode: Mode, base: Option<&str>) -> Result<(Session, Arc<Recorder>), String> {
        self.create_from(self.request(id, agent, mode, base))
    }

    fn request(&self, id: &str, agent: &str, mode: Mode, base: Option<&str>) -> CreateSession {
        CreateSession {
            session_id: id.to_owned(),
            project_path: self.project.to_string_lossy().into_owned(),
            agent_id: agent.to_owned(),
            mode,
            title: format!("Session {id}"),
            config: BTreeMap::new(),
            base_branch: base.map(str::to_owned),
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
    assert!(!stored.contains("queued"), "saved as idle: {stored}");
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
        f.sessions.create(f.request(id, "fake", Mode::Local, None), "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
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
    let (_, tree) = f.create_in("tree", "fake", Mode::Worktree, None).unwrap();
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
    let (_, events) = f.create_in("c", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    f.sessions.check_out_branch("c").await.unwrap();

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
async fn unknown_agents_and_unsupported_modes_are_refused() {
    let f = fixture("refuse", FakeAgentOptions::default());
    assert!(f.create("u", "nope").unwrap_err().contains("Unknown agent"));
    assert!(f.create_in("d", "fake", Mode::Docker, None).unwrap_err().contains("not available yet"));
}

#[tokio::test]
async fn worktree_sessions_run_side_by_side_on_their_own_branches() {
    let f = git_fixture("wt");
    let head = run_in(&f.project, &["rev-parse", "HEAD"]).trim().to_owned();
    let (one, events) = f.create_in("w1", "fake", Mode::Worktree, None).unwrap();
    let (two, other) = f.create_in("w2", "fake", Mode::Worktree, None).unwrap();
    let (_, local) = f.create("l", "fake").unwrap();
    for recorder in [&events, &other, &local] {
        recorder.wait_status("idle").await;
    }

    assert_eq!(one.mode, Mode::Worktree);
    assert_eq!(one.base_commit.as_deref(), Some(head.as_str()));
    let branch = one.branch.clone().unwrap();
    assert!(branch.starts_with("brama/session-w1"), "{branch}");
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
async fn a_sessions_folder_is_where_its_agent_works_and_a_worktree_is_readable() {
    let f = git_fixture("wt-folder");
    let (local, events) = f.create("l", "fake").unwrap();
    let (wt, other) = f.create_in("w", "fake", Mode::Worktree, None).unwrap();
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
    assert!(!f.sessions.contains(&root.join("a.txt")), "gone with its session");
}

#[tokio::test]
async fn a_sessions_folder_contains_its_project_or_its_worktree_folder() {
    let f = git_fixture("contains-folder");
    let (_local, events) = f.create("l", "fake").unwrap();
    let (wt, other) = f.create_in("w", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    other.wait_status("idle").await;
    assert!(f.sessions.contains_folder(&f.project), "a local session's folder is its project");
    assert!(f.sessions.contains_folder(&f.project.join("src")));
    assert!(f.sessions.contains_folder(Path::new(&wt.folder)));
    assert!(!f.sessions.contains_folder(&f.dir.join("data")));
    assert!(!f.sessions.contains_folder(&f.project.with_file_name("projectx")));
}

#[tokio::test]
async fn a_worktree_sessions_folder_is_given_only_once_checked_out() {
    let f = git_fixture("wt-tree-folder");
    let (local, events) = f.create("l", "fake").unwrap();
    let (wt, other) = f.create_in("w", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    other.wait_status("idle").await;
    assert_eq!(f.sessions.worktree_folder(&wt.id).unwrap(), PathBuf::from(&wt.folder));
    assert!(f.sessions.worktree_folder(&local.id).is_err(), "a local session's folder is the project");
    assert!(f.sessions.worktree_folder("nope").is_err());

    std::fs::remove_dir_all(wt.worktree_path.as_ref().unwrap()).unwrap();
    assert!(f.sessions.worktree_folder(&wt.id).is_err(), "deleted from disk");
}

#[tokio::test]
async fn a_worktree_prompt_quotes_project_files_by_path_and_names_files_it_lacks() {
    let f = git_fixture("wt-prompt");
    std::fs::write(f.project.join(".env"), "SECRET=1\n").unwrap();
    std::fs::write(f.project.join("a.txt"), "user one\nuser two\n").unwrap();
    let (session, events) = f.create_in("p", "fake", Mode::Worktree, None).unwrap();
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
async fn a_worktree_sessions_changes_are_listed_against_its_base() {
    let f = git_fixture("wt-changes");
    let (session, events) = f.create_in("c", "fake", Mode::Worktree, None).unwrap();
    let (_, local) = f.create("l", "fake").unwrap();
    events.wait_status("idle").await;
    local.wait_status("idle").await;
    let wt = PathBuf::from(&session.folder);
    assert!(f.sessions.changes("c").unwrap().is_empty(), "nothing done yet");

    assert_eq!(f.ask("c", &events, &format!("write {} one\nmore", wt.join("a.txt").display())).await, "written");
    assert_eq!(f.ask("c", &events, &format!("write {} new", wt.join("dir/new.txt").display())).await, "written");
    let changed: Vec<_> = f.sessions.changes("c").unwrap().into_iter().map(|file| file.path).collect();
    assert_eq!(changed, ["a.txt", "dir/new.txt"]);
    assert_eq!(f.sessions.file_at_base("c", "a.txt").unwrap().as_deref(), Some("one\ntwo\nthree\n"));
    assert_eq!(f.sessions.file_at_base("c", "dir/new.txt").unwrap(), None);
    assert!(f.sessions.file_at_base("c", "../x").is_err());
    assert!(f.sessions.changes("l").unwrap_err().contains("worktree"));
}

#[tokio::test]
async fn applying_a_worktree_sessions_work_brings_it_to_the_project_unstaged() {
    let f = git_fixture("wt-apply");
    let (session, events) = f.create_in("a", "fake", Mode::Worktree, None).unwrap();
    let (_, local) = f.create("l", "fake").unwrap();
    events.wait_status("idle").await;
    local.wait_status("idle").await;
    assert_eq!(f.sessions.apply_locally("a").await.unwrap(), ApplyOutcome::Empty);
    assert!(f.sessions.apply_locally("l").await.unwrap_err().contains("worktree"));

    let wt = PathBuf::from(&session.folder);
    std::fs::write(wt.join("committed.txt"), "c\n").unwrap();
    run_in(&wt, &["add", "."]);
    run_in(&wt, &["commit", "-qm", "agent"]);
    assert_eq!(f.ask("a", &events, &format!("write {} edited", wt.join("a.txt").display())).await, "written");

    // Not while the agent works on it.
    events.clear();
    f.sessions.send_prompt("a", text("slow")).unwrap();
    events.wait_for("first chunk", |e| e.kind == "update").await;
    assert!(f.sessions.apply_locally("a").await.unwrap_err().contains("working"));
    f.sessions.cancel("a").unwrap();
    events.wait_turn_end().await;

    assert_eq!(f.sessions.apply_locally("a").await.unwrap(), ApplyOutcome::Clean);
    assert_eq!(std::fs::read_to_string(f.project.join("a.txt")).unwrap(), "edited");
    assert_eq!(std::fs::read_to_string(f.project.join("committed.txt")).unwrap(), "c\n");
    assert!(run_in(&f.project, &["diff", "--cached", "--name-only"]).is_empty(), "unstaged");
    assert_eq!(run_in(&f.project, &["branch", "--show-current"]).trim(), "main");
}

#[tokio::test]
async fn apply_and_check_out_hold_the_turn_slot_only_while_they_run() {
    let f = git_fixture("wt-slot");
    let (session, events) = f.create_in("s", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    let state = f.sessions.get("s").unwrap();
    assert_eq!(f.sessions.apply_locally("s").await.unwrap(), ApplyOutcome::Empty);
    assert!(!state.turn_running.load(Ordering::SeqCst), "released after an apply");
    std::fs::write(PathBuf::from(&session.folder).join("dirty.txt"), "d").unwrap();
    assert!(f.sessions.check_out_branch("s").await.is_err());
    assert!(!state.turn_running.load(Ordering::SeqCst), "released after a refusal");
    assert_eq!(f.ask("s", &events, "hello").await, "Hello, world");

    // A turn holds it: the git work waits for none.
    let held = state.turn_running.swap(true, Ordering::SeqCst);
    assert!(!held);
    assert!(f.sessions.apply_locally("s").await.unwrap_err().contains("working"));
    assert!(state.turn_running.load(Ordering::SeqCst), "a refused claim leaves the turn's slot alone");
    state.turn_running.store(false, Ordering::SeqCst);
}

#[tokio::test]
async fn checking_out_a_worktree_sessions_branch_stops_it_and_hands_the_branch_over() {
    let f = git_fixture("wt-checkout");
    let (session, events) = f.create_in("c", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    let wt = PathBuf::from(&session.folder);
    let branch = session.branch.clone().unwrap();
    std::fs::write(wt.join("work.txt"), "w\n").unwrap();
    let err = f.sessions.check_out_branch("c").await.unwrap_err();
    assert!(err.contains("uncommitted") && err.contains("Apply Locally"), "{err}");
    run_in(&wt, &["add", "."]);
    run_in(&wt, &["commit", "-qm", "agent"]);

    f.sessions.check_out_branch("c").await.unwrap();
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

    let (session, events) = f.create_in("b", "fake", Mode::Worktree, Some("feature")).unwrap();
    events.wait_status("idle").await;
    assert_eq!(session.base_commit.as_deref(), Some(feature.as_str()));
    let wt = PathBuf::from(session.worktree_path.unwrap());
    assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "feature\n");
    assert_eq!(run_in(&f.project, &["branch", "--show-current"]).trim(), "main", "the checkout stays");
}

#[tokio::test]
async fn worktree_sessions_need_a_repository_with_a_commit_and_a_real_base() {
    let plain = fixture("wt-plain", FakeAgentOptions::default());
    std::fs::remove_dir_all(plain.project.join(".git")).unwrap();
    let err = plain.create_in("p", "fake", Mode::Worktree, None).unwrap_err();
    assert!(err.contains("git repository"), "{err}");

    let unborn = fixture("wt-unborn", FakeAgentOptions::default());
    std::fs::remove_dir_all(unborn.project.join(".git")).unwrap();
    run_in(&unborn.project, &["init", "-q", "-b", "main"]);
    let err = unborn.create_in("u", "fake", Mode::Worktree, None).unwrap_err();
    assert!(err.contains("no commit"), "{err}");

    let f = git_fixture("wt-nobase");
    let err = f.create_in("n", "fake", Mode::Worktree, Some("nope")).unwrap_err();
    assert!(err.contains("nope"), "{err}");
    let err = f.create_in("o", "fake", Mode::Worktree, Some("--output=x")).unwrap_err();
    assert!(err.contains("--output=x"), "{err}");
    assert!(!f.project.join("x").exists(), "a base is never an option");
    for sessions in [&plain.sessions, &unborn.sessions, &f.sessions] {
        assert!(sessions.list().is_empty(), "nothing listed");
    }
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

    let (session, events) = f.create_in("s", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    let wt = PathBuf::from(session.worktree_path.unwrap());
    assert_eq!(session.project_id, f.project.to_string_lossy());
    let reply = f.ask("s", &events, &format!("read {}", wt.join("app/main.rs").display())).await;
    assert_eq!(reply, "read:fn main() {}\n");
    let reply = f.ask("s", &events, &format!("read {}", wt.join("a.txt").display())).await;
    assert!(reply.contains("outside the session"), "only the project's folder: {reply}");
}

#[tokio::test]
async fn a_worktree_session_comes_back_after_a_restart_even_without_its_folder() {
    let f = git_fixture("wt-restart");
    let (session, events) = f.create_in("r", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    let wt = PathBuf::from(session.worktree_path.clone().unwrap());
    std::fs::write(wt.join("work.txt"), "agent work\n").unwrap();
    run_in(&wt, &["add", "."]);
    run_in(&wt, &["commit", "-qm", "agent"]);

    f.sessions.shutdown();
    std::fs::remove_dir_all(&wt).unwrap();
    let sessions = Sessions::new(options_for(&f.dir, &f.launcher));
    let listed = sessions.list().into_iter().find(|s| s.id == "r").unwrap();
    assert_eq!(listed.branch, session.branch);
    assert_eq!(listed.base_commit, session.base_commit);
    let events = Arc::new(Recorder::default());
    sessions.attach("r", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    sessions.send_prompt("r", text(&format!("read {}", wt.join("work.txt").display()))).unwrap();
    events.wait_turn_end().await;
    assert_eq!(events.texts().join(""), "read:agent work\n", "checked out again from its branch");
    assert_eq!(run_in(&wt, &["branch", "--show-current"]).trim(), session.branch.unwrap());
}

#[tokio::test]
async fn removing_a_worktree_session_deletes_a_clean_worktree_and_keeps_work() {
    let f = git_fixture("wt-remove");
    let branches = || run_in(&f.project, &["branch", "--format=%(refname:short)"]);

    // Nothing done: the folder and the branch go.
    let (unused, events) = f.create_in("u", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    f.sessions.remove("u").await.unwrap();
    assert!(!Path::new(&unused.worktree_path.unwrap()).exists());
    assert!(!branches().contains(&unused.branch.unwrap()));

    // Committed work: the folder goes, the branch with the commits stays.
    let (committed, events) = f.create_in("c", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    let wt = PathBuf::from(committed.worktree_path.unwrap());
    std::fs::write(wt.join("x.txt"), "x").unwrap();
    run_in(&wt, &["add", "."]);
    run_in(&wt, &["commit", "-qm", "agent"]);
    f.sessions.remove("c").await.unwrap();
    assert!(!wt.exists());
    assert!(branches().contains(&committed.branch.unwrap()));

    // Uncommitted work is committed onto the branch first, then the folder goes.
    let (dirty, events) = f.create_in("d", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    let wt = PathBuf::from(dirty.worktree_path.unwrap());
    let branch = dirty.branch.unwrap();
    std::fs::write(wt.join("a.txt"), "unsaved").unwrap();
    std::fs::write(wt.join("new.txt"), "untracked").unwrap();
    f.sessions.remove("d").await.unwrap();
    assert!(f.sessions.list().is_empty());
    assert!(!wt.exists());
    assert_eq!(run_in(&f.project, &["show", &format!("{branch}:a.txt")]), "unsaved");
    assert_eq!(run_in(&f.project, &["show", &format!("{branch}:new.txt")]), "untracked");
    assert!(run_in(&f.project, &["log", "-1", "--format=%s", &branch]).contains("Session d"));
    assert!(run_in(&f.project, &["status", "--porcelain"]).is_empty(), "the project is untouched");
}

#[tokio::test]
async fn a_detached_worktree_with_uncommitted_work_is_kept_on_remove() {
    let f = git_fixture("wt-remove-detached");
    let (session, events) = f.create_in("x", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    let wt = PathBuf::from(session.worktree_path.unwrap());
    run_in(&wt, &["switch", "-q", "--detach"]);
    std::fs::write(wt.join("a.txt"), "unsaved").unwrap();
    f.sessions.remove("x").await.unwrap();
    assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "unsaved");
}

#[tokio::test]
async fn at_launch_worktrees_no_session_owns_are_removed_unless_they_hold_work() {
    let f = git_fixture("wt-tidy");
    let (kept, events) = f.create_in("k", "fake", Mode::Worktree, None).unwrap();
    events.wait_status("idle").await;
    let kept = PathBuf::from(kept.worktree_path.unwrap());
    let group = kept.parent().unwrap().to_path_buf();
    let git = crate::git::test_repo::git_bin();
    let (orphan, dirty) = (group.join("orphan"), group.join("dirty"));
    crate::git::worktree::add(&git, &f.project, &orphan, "brama/orphan", "main").unwrap();
    crate::git::worktree::add(&git, &f.project, &dirty, "brama/dirty", "main").unwrap();
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
    let options = FakeAgentOptions { load_session: true, ..Default::default() };
    let f = fixture("reload", options);
    let (_, events) = f.create("r", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.shutdown();

    let reopened = Sessions::new(options_for(&f.dir, &f.launcher));
    let listed = reopened.list();
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0].id.as_str(), listed[0].status), ("r", SessionStatus::Stopped));
    let events = Arc::new(Recorder::default());
    reopened.attach("r", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    reopened.send_prompt("r", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    let agent = Arc::clone(&lock(&f.launcher.agents)[1]);
    assert_eq!(agent.loads.load(Ordering::SeqCst), 1, "session/load was used");
    assert_eq!(events.texts(), ["earlier question", "earlier answer", "Hello", ", world"]);
    let idle = events.wait_status("idle").await;
    assert!(idle.payload["message"].is_null(), "history restored: no banner");
    reopened.shutdown();
}

#[tokio::test]
async fn without_load_support_a_reopened_session_says_history_was_not_restored() {
    let f = fixture("noload", FakeAgentOptions::default());
    let (_, events) = f.create("n", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.shutdown();

    let reopened = Sessions::new(options_for(&f.dir, &f.launcher));
    let events = Arc::new(Recorder::default());
    reopened.attach("n", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    reopened.send_prompt("n", text("hello")).unwrap();
    let idle = events.wait_status("idle").await;
    assert_eq!(idle.payload["message"], "Agent history not restored");
    assert_eq!(events.wait_turn_end().await, "end_turn");
    reopened.shutdown();
}

#[tokio::test]
async fn the_conversation_is_recorded_and_survives_a_restart() {
    let options = FakeAgentOptions { load_session: true, ..Default::default() };
    let f = fixture("history", options);
    let (_, events) = f.create("h", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("h", text("hello")).unwrap();
    events.wait_turn_end().await;
    f.sessions.shutdown();

    let reopened = Sessions::new(options_for(&f.dir, &f.launcher));
    let summary = |sessions: &Sessions| -> Vec<String> {
        sessions
            .history("h")
            .unwrap()
            .iter()
            .map(|e| match e["kind"].as_str().unwrap() {
                "prompt" => format!("prompt:{}", e["prompt"][0]["text"].as_str().unwrap()),
                "update" => format!("update:{}", e["update"]["content"]["text"].as_str().unwrap_or("")),
                kind => format!("{kind}:{}", e["stopReason"].as_str().unwrap()),
            })
            .collect()
    };
    let first_turn = ["prompt:hello", "update:Hello", "update:, world", "turn-end:end_turn"];
    assert_eq!(summary(&reopened), first_turn);

    // The agent replays its history while starting (`session/load`): not recorded twice.
    let events = Arc::new(Recorder::default());
    reopened.attach("h", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    reopened.send_prompt("h", text("hello")).unwrap();
    events.wait_turn_end().await;
    assert!(events.texts().contains(&"earlier question".to_owned()), "the replay did happen");
    assert_eq!(summary(&reopened), [&first_turn[..], &first_turn[..]].concat());
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
    assert_eq!(ids(&first), ["model", "effort"]);
    assert_eq!(first.payload["configOptions"][0]["category"], "model");
    assert_eq!(first.payload["configOptions"][1]["category"], "thought_level");

    events.clear();
    f.sessions.set_config_option("o", "model", "fast").await.unwrap();
    let after = events.wait_for("options after set", |e| e.kind == "config-options").await;
    assert_eq!(after.payload["configOptions"][0]["currentValue"], "fast");
    assert_eq!(ids(&after), ["model"], "the fast model has no effort option");
    assert_eq!(*lock(&lock(&f.launcher.agents)[0].model), "fast");

    assert!(f.sessions.set_config_option("o", "model", "huge").await.is_err(), "the agent's refusal comes back");
    f.sessions.stop("o").await.unwrap();
    assert!(f.sessions.set_config_option("o", "model", "smart").await.unwrap_err().contains("isn't running"));
}

#[tokio::test]
async fn a_sessions_config_options_come_back_when_its_agent_starts_again() {
    let f = fixture("keep-options", FakeAgentOptions { load_session: true, ..Default::default() });
    let mut req = f.request("k", "fake", Mode::Local, None);
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
    let reopened = Sessions::new(options_for(&f.dir, &f.launcher));
    assert_eq!(reopened.list()[0].config["model"], "fast");
    let events = Arc::new(Recorder::default());
    reopened.attach("k", "main", Arc::clone(&events) as Arc<dyn EventSink>).unwrap();
    assert!(reopened.resume("k").await.unwrap());
    events.wait_status("idle").await;
    assert_eq!(*lock(&lock(&f.launcher.agents)[2].model), "fast");
    reopened.shutdown();
}

#[tokio::test]
async fn an_agent_that_never_answers_a_config_option_neither_holds_up_its_start_nor_stop() {
    let f = fixture("hang-options", FakeAgentOptions { hang_set_config: true, ..Default::default() });
    let mut req = f.request("h", "fake", Mode::Local, None);
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
    let reopened = Sessions::new(options);
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
    let f = fixture("rename", FakeAgentOptions::default());
    let (_, events) = f.create("n", "fake").unwrap();
    events.wait_status("idle").await;

    let renamed = f.sessions.rename("n", "  Fix the parser \n").unwrap();
    assert_eq!(renamed.title, "Fix the parser", "trimmed");
    assert_eq!(f.sessions.list()[0].title, "Fix the parser");
    assert!(f.sessions.rename("n", "   ").is_err(), "an empty title is refused");
    assert!(f.sessions.rename("missing", "x").is_err());

    f.sessions.shutdown();
    let reopened = Sessions::new(options_for(&f.dir, &f.launcher));
    assert_eq!(reopened.list()[0].title, "Fix the parser");
}

#[tokio::test]
async fn removing_a_session_stops_its_agent_and_forgets_it() {
    let f = fixture("remove", FakeAgentOptions::default());
    let (_, events) = f.create("gone", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("gone", text("slow")).unwrap();
    events.wait_for("first chunk", |e| e.kind == "update").await;
    let session_dir = f.dir.join("data/sessions/gone");
    assert!(session_dir.join("transcript.jsonl").exists());

    f.sessions.remove("gone").await.unwrap();
    assert!(f.sessions.list().is_empty());
    assert!(f.sessions.history("gone").is_err(), "unknown now");
    assert!(!session_dir.exists(), "its transcript and log are deleted");
    assert_eq!(events.wait_turn_end().await, "cancelled", "the running turn ends");
    assert!(f.project.join("a.txt").exists(), "the project is untouched");
    assert!(f.sessions.remove("gone").await.is_err());

    // Its slot in the project is free, and it doesn't come back after a restart.
    let (_, other) = f.create("other", "fake").unwrap();
    other.wait_status("idle").await;
    f.sessions.shutdown();
    let reopened = Sessions::new(options_for(&f.dir, &f.launcher));
    let ids: Vec<_> = reopened.list().into_iter().map(|s| s.id).collect();
    assert_eq!(ids, ["other"]);
}

#[tokio::test]
async fn probing_an_agent_returns_its_options_and_leaves_nothing_behind() {
    let f = fixture("probe", FakeAgentOptions::default());
    let options = f.sessions.probe_options(Some(&f.project), "fake").await.unwrap();
    let ids: Vec<_> = options.iter().map(|o| o["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["model", "effort"]);
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
    let (_, stopped) = f.create_in("t", "fake", Mode::Worktree, None).unwrap();
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
    let f = fixture("once", FakeAgentOptions { require_auth: true, ..Default::default() });
    let (_, events) = f.create("o", "fake").unwrap();
    f.sessions.send_prompt("o", text("hello")).unwrap();
    let failed = events.wait_for("turn error", |e| e.kind == "error" && e.payload["turn"] == true).await;
    assert!(failed.payload["message"].as_str().unwrap().contains("Sign in"), "{failed:?}");
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

/// End to end with the real Claude Code agent (`npx @agentclientprotocol/claude-agent-acp`, from a
/// project's agents.json, trusted): needs network, Node and a signed-in Claude Code. Run with
/// `cargo test --lib real_claude -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_claude_agent_end_to_end() {
    let dir = std::env::temp_dir().join(format!("brama-real-claude-{}", std::process::id()));
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
    let probed = sessions.probe_options(Some(&project), "claude").await.unwrap();
    let categories: Vec<_> = probed.iter().map(|o| o["category"].as_str().unwrap_or("-")).collect();
    eprintln!("probed categories: {categories:?}");
    assert!(categories.contains(&"model") && categories.contains(&"thought_level"));
    let events = Arc::new(Recorder::default());
    let req = CreateSession {
        session_id: "real".to_owned(),
        project_path: project.to_string_lossy().into_owned(),
        agent_id: "claude".to_owned(),
        mode: Mode::Local,
        title: "real".to_owned(),
        config: BTreeMap::new(),
        base_branch: None,
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

#[tokio::test]
async fn sessions_are_listed_by_last_activity_which_a_prompt_and_its_turn_end_set() {
    let f = fixture("activity", FakeAgentOptions::default());
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
    let active = listed[0].last_activity_at.clone();
    f.sessions.shutdown();

    let reopened = Sessions::new(options_for(&f.dir, &f.launcher));
    let listed = reopened.list();
    assert_eq!(listed.iter().map(|s| (s.id.as_str(), s.last_activity_at.as_str())).next(), Some(("a", active.as_str())));
}

#[tokio::test]
async fn the_agents_title_replaces_the_prompts_and_is_kept_across_a_restart() {
    let f = fixture("agent-title", FakeAgentOptions::default());
    let (created, events) = f.create("t", "fake").unwrap();
    assert_eq!((created.title.as_str(), created.title_source), ("Session t", TitleSource::Prompt));
    assert_eq!(f.ask("t", &events, "title Tree view gaps").await, "titled");

    let changed = events.wait_for("session", |e| e.kind == "session").await;
    assert_eq!(changed.payload["title"], "Tree view gaps");
    assert_eq!(changed.payload["titleSource"], "agent");
    f.sessions.shutdown();

    let listed = Sessions::new(options_for(&f.dir, &f.launcher)).list();
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
