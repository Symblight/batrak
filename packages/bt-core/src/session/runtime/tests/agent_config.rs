use super::*;

const NO_AGENTS: &str = r#"{"version":1,"agents":{}}"#;

/// Replaces the project's agents.json and trusts what it runs, as Settings does for what it adds.
fn set_trusted_agents(f: &Fixture, json: &str) {
    f.set_agents(&f.project, json);
    let configs = &f.sessions.inner.opts.configs;
    let launches: Vec<_> = configs.untrusted(&f.project).into_iter().map(|u| u.launch).collect();
    configs.trust(&f.project, &launches).unwrap();
}

/// A session of `fake`, its agent up.
async fn idle_session(f: &Fixture, id: &str) -> Arc<Recorder> {
    let (_, events) = f.create(id, "fake").unwrap();
    events.wait_status("idle").await;
    events
}

fn launches(f: &Fixture) -> usize {
    f.launcher.launches.load(Ordering::SeqCst)
}

async fn unconfigured(events: &Recorder) -> Envelope {
    events.wait_for("unconfigured", |e| e.kind == "unconfigured").await
}

#[tokio::test]
async fn removing_a_session_stops_its_agent_and_deletes_it_in_the_agent() {
    let options = FakeAgentOptions { delete_session: true, ..listing() };
    let f = fixture("remove", options.clone());
    let events = idle_session(&f, "gone").await;
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
    idle_session(&f, "other").await;
    f.sessions.shutdown();
    let reopened = f.reopen().await;
    let ids: Vec<_> = reopened.list().into_iter().map(|s| s.id).collect();
    assert_eq!(ids, ["other"]);
}

#[tokio::test]
async fn a_session_its_agent_cant_delete_is_hidden_instead() {
    let options = listing();
    let f = fixture("hide", options.clone());
    idle_session(&f, "kept").await;
    f.sessions.remove("kept").await.unwrap();
    assert_eq!(options.stored.lock().unwrap().len(), 1, "still in the agent");
    f.sessions.sync(&f.project, None).await;
    assert!(f.sessions.list().is_empty(), "not listed again");
    f.sessions.shutdown();
    assert!(f.reopen().await.list().is_empty(), "nor after a restart");
}

#[tokio::test]
async fn an_agent_gone_from_agents_json_fails_the_start_and_once_back_starts_and_stays_running_after_its_turn() {
    let f = fixture("unconfigured", FakeAgentOptions::default());
    let events = idle_session(&f, "u").await;
    f.sessions.stop("u").await.unwrap();

    f.set_agents(&f.project, NO_AGENTS);
    events.clear();
    f.sessions.restart("u").await.unwrap();
    let gone = unconfigured(&events).await;
    assert_eq!(gone.payload["agentId"], "fake");
    assert_eq!(gone.payload["message"], "Agent \"fake\" is no longer configured");
    assert_eq!(gone.payload["ran"], "fake-agent ", "what it ran, as its log shows it");
    assert_eq!(launches(&f), 1, "nothing ran");

    // Back without the sync (a change no watcher saw), then a Restart.
    f.give_agents(&f.project);
    events.clear();
    f.sessions.restart("u").await.unwrap();
    events.wait_status("idle").await;
    assert_eq!(launches(&f), 2);
    f.sessions.send_prompt("u", text("hello")).unwrap();
    assert_eq!(events.wait_turn_end().await, "end_turn");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.sessions.list()[0].status, SessionStatus::Idle, "not marked stopped while its agent runs");
}

#[tokio::test]
async fn a_session_follows_its_agent_to_another_id_that_runs_the_same() {
    let f = fixture("rebind", FakeAgentOptions::default());
    let events = idle_session(&f, "r").await;
    f.sessions.stop("r").await.unwrap();

    // Removed, then added again (Settings gives it a new id).
    set_trusted_agents(&f, &AGENTS.replace("\"fake\":", "\"fake-2\":"));
    events.clear();
    f.sessions.restart("r").await.unwrap();
    let moved = events.wait_for("session", |e| e.kind == "session").await;
    assert_eq!(moved.payload["agentId"], "fake-2");
    events.wait_status("idle").await;
    assert_eq!(f.sessions.list()[0].agent_id, "fake-2", "kept");

    // A session from before launches were kept: its log says what it ran.
    f.sessions.stop("r").await.unwrap();
    f.sessions.get("r").unwrap().record.lock().unwrap().launch = None;
    set_trusted_agents(&f, &AGENTS.replace("\"fake\":", "\"fake-3\":"));
    events.clear();
    f.sessions.restart("r").await.unwrap();
    events.wait_status("idle").await;
    assert_eq!(f.sessions.list()[0].agent_id, "fake-3");

    // Something else under its id is not its agent.
    f.sessions.stop("r").await.unwrap();
    f.set_agents(&f.project, r#"{"version":1,"agents":{"other":{"command":"other-agent"}}}"#);
    events.clear();
    f.sessions.restart("r").await.unwrap();
    unconfigured(&events).await;
}

#[tokio::test]
async fn agents_json_losing_a_sessions_agent_stops_it_and_getting_it_back_restores_it() {
    let f = git_fixture("sync");
    let running = idle_session(&f, "s").await;
    let (_, stopped) = f.create_in("t", "fake", f.new_workspace(None)).unwrap();
    stopped.wait_status("idle").await;
    f.sessions.stop("t").await.unwrap();
    let launched = launches(&f);

    f.set_agents(&f.project, NO_AGENTS);
    running.clear();
    stopped.clear();
    f.sessions.sync_agents(&f.project).await;
    for events in [&running, &stopped] {
        let gone = unconfigured(events).await;
        assert_eq!(gone.payload["message"], "Agent \"fake\" is no longer configured");
        assert_eq!(gone.payload["reason"], "removed");
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
    assert_eq!(launches(&f), launched + 1, "only the one that ran starts again");
}

#[tokio::test]
async fn turning_an_agent_off_stops_its_sessions_and_turning_it_on_puts_them_back() {
    let f = fixture("switch-off", FakeAgentOptions::default());
    let configs = &f.sessions.inner.opts.configs;
    let running = idle_session(&f, "s").await;
    // Turning the agent off lets this turn finish, and `wait_turn_end` gives it 5 s: a full
    // `slow` (200 chunks, 4 s at best) failed it on a loaded machine. 100 chunks (2 s) leave
    // room on both sides: for the sync to return while the turn still runs, and for the turn to end.
    f.sessions.send_prompt("s", text("slow 100")).unwrap();
    running.wait_for("first chunk", |e| e.kind == "update").await;
    let launched = launches(&f);
    assert_eq!(f.sessions.active_of(&f.project, "fake"), 1, "what turning it off stops");
    assert_eq!(f.sessions.active_of(&f.project, "locked"), 0);

    configs.set_enabled(Some(&f.project), "fake", false).unwrap();
    f.sessions.sync_agents(&f.project).await;
    assert!(!has(&running, "unconfigured"), "not mid-turn");
    assert_eq!(running.wait_turn_end().await, "end_turn");
    let off = unconfigured(&running).await;
    assert_eq!(off.payload["reason"], "off");
    assert_eq!(off.payload["message"], "Fake is off");
    running.wait_status("error").await;

    assert!(f.create("t", "fake").unwrap_err().contains("Fake is off"), "no new session of it");
    running.clear();
    f.sessions.restart("s").await.unwrap();
    let refused = unconfigured(&running).await;
    assert_eq!(refused.payload["reason"], "off", "a start is refused");
    let probe = f.sessions.probe_options(Some(&f.project), "fake").await.unwrap_err();
    assert!(probe.contains("off"), "{probe}");
    assert_eq!(launches(&f), launched, "nothing ran");

    configs.set_enabled(Some(&f.project), "fake", true).unwrap();
    running.clear();
    f.sessions.sync_agents(&f.project).await;
    running.wait_status("idle").await;
    assert_eq!(launches(&f), launched + 1, "back as it was: running");
}

#[tokio::test]
async fn an_agent_turned_off_stops_its_sessions_even_when_another_runs_the_same() {
    let f = fixture("switch-twin", FakeAgentOptions::default());
    // Added twice from the registry: `fake-2` runs exactly what `fake` does.
    set_trusted_agents(&f, &AGENTS.replace("\"locked\":", "\"fake-2\":{\"name\":\"Fake\",\"command\":\"fake-agent\",\"env\":{\"TOKEN\":\"${keychain:token}\"}},\"locked\":"));
    let events = idle_session(&f, "s").await;

    f.sessions.inner.opts.configs.set_enabled(Some(&f.project), "fake", false).unwrap();
    f.sessions.sync_agents(&f.project).await;
    let off = unconfigured(&events).await;
    assert_eq!(off.payload["reason"], "off");
    events.wait_status("error").await;
    assert_eq!(f.sessions.list()[0].agent_id, "fake", "not moved to its twin");

    events.clear();
    f.sessions.restart("s").await.unwrap();
    unconfigured(&events).await;
    assert_eq!(f.sessions.list()[0].agent_id, "fake", "a start doesn't move it either");
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
    assert!(!has(&events, "agent-outdated"), "a new name runs nothing new");
}

#[tokio::test]
async fn an_update_tells_a_running_session_and_its_restart_runs_the_new_version_trusted() {
    let f = fixture("update", FakeAgentOptions::default());
    let configs = &f.sessions.inner.opts.configs;
    set_trusted_agents(&f, r#"{"version":1,"agents":{"claude":{"name":"Claude","command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp@0.90.0"]}}}"#);
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
    assert!(!has(&events, "untrusted"), "the trust went with the pin");
    let ran = f.sessions.get("u").unwrap().record.lock().unwrap().launch.clone().unwrap();
    assert_eq!(ran.args, ["-y", "@agentclientprotocol/claude-agent-acp@0.94.0"]);
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
    assert_eq!(launches(&f), 0, "nothing ran");

    let launch: crate::config::LaunchConfig = serde_json::from_value(untrusted.payload["launch"].clone()).unwrap();
    f.sessions.inner.opts.configs.trust(&f.project, &[launch]).unwrap();
    events.clear();
    f.sessions.restart("t").await.unwrap();
    events.wait_status("idle").await;
    assert_eq!(launches(&f), 1);
}

#[tokio::test]
async fn a_message_sent_while_the_first_start_fails_does_not_start_the_agent_again() {
    let f = fixture("once", FakeAgentOptions { fail_new_session: true, ..Default::default() });
    let (_, events) = f.create("o", "fake").unwrap();
    f.sessions.send_prompt("o", text("hello")).unwrap();
    let failed = events.wait_for("turn error", |e| e.kind == "error" && e.payload["turn"] == true).await;
    assert!(failed.payload["message"].as_str().unwrap().contains("no session today"), "{failed:?}");
    events.wait_for("start error", |e| e.kind == "error" && e.payload["turn"].is_null()).await;
    assert_eq!(launches(&f), 1);

    // The user's next message tries again.
    events.clear();
    f.sessions.send_prompt("o", text("again")).unwrap();
    events.wait_for("turn error", |e| e.kind == "error" && e.payload["turn"] == true).await;
    assert_eq!(launches(&f), 2);
}

/// A change of a project's agents reaches its running sessions with no front asking.
#[tokio::test]
async fn a_session_hears_its_agent_was_turned_off_with_nobody_asking_it_to() {
    let f = fixture("follow-agents", FakeAgentOptions::default());
    let events = idle_session(&f, "a").await;

    f.sessions.inner.opts.configs.set_enabled(Some(&f.project), "fake", false).unwrap();

    let off = unconfigured(&events).await;
    assert_eq!(off.payload["agentId"], "fake");
}
