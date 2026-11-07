use super::*;

#[tokio::test]
async fn config_options_arrive_at_start_and_follow_a_change() {
    let f = fixture("options", FakeAgentOptions::default());
    let (_, events) = f.create("o", "fake").unwrap();
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
    let mut req = f.request("k", "fake", None);
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
    let events = attach_page(&reopened, "k", "main");
    assert!(reopened.resume("k").await.unwrap());
    events.wait_status("idle").await;
    assert_eq!(*lock(&lock(&f.launcher.agents).last().unwrap().model), "fast");
    reopened.shutdown();
}

#[tokio::test]
async fn an_agent_that_never_answers_a_config_option_neither_holds_up_its_start_nor_stop() {
    let f = fixture("hang-options", FakeAgentOptions { hang_set_config: true, ..listing() });
    let mut req = f.request("h", "fake", None);
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
    let events = attach_page(&reopened, "h", "main");
    assert!(reopened.resume("h").await.unwrap());
    events.wait_status("idle").await;
    let shown = events.wait_for("options", |e| e.kind == "config-options").await;
    assert_eq!(shown.payload["configOptions"][0]["currentValue"], "smart");
    reopened.shutdown();
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
    assert!(f.sessions.probe_options(Some(&f.project), "nope").await.unwrap_err().contains("Unknown agent"));
    let failed = f.sessions.probe_options(Some(&f.project), "locked").await.unwrap_err();
    assert!(failed.contains("no keychain item"), "{failed}");
}
