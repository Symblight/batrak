use super::*;

/// Sessions with the real Claude Code agent (`claude`) in a fresh project under a temp `name`.
fn real_claude(name: &str) -> (Sessions, PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("batrak-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let project = dir.join("project");
    std::fs::create_dir_all(&project).unwrap();
    crate::config::ensure_project_dir(&project).unwrap();
    let project = dunce::canonicalize(project).unwrap();
    std::fs::write(
        project.join(".bt/agents.json"),
        r#"{"version":1,"agents":{"claude":{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp"]}}}"#,
    )
    .unwrap();
    let configs = AgentConfigs::new(None, None);
    let launches: Vec<_> = configs.untrusted(&project).into_iter().map(|u| u.launch).collect();
    configs.trust(&project, &launches).unwrap();
    let mut opts = SessionsOptions::for_app(dir.join("data"), configs, tokio::runtime::Handle::current());
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
        workspace_id: None,
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

/// What the real Claude Code sends for a subagent (ACP subagent sessions, which Batrak declares):
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
        workspace_id: None,
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
