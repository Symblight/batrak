use super::*;

/// A new session's id: its CLI takes only a UUID.
const NEW_ID: &str = "2cb916db-26aa-40f2-86b5-1ba81b225fd2";

fn cli_fixture(name: &str) -> Fixture {
    let f = fixture(name, FakeAgentOptions::default());
    f.give_cli_agents();
    f
}

async fn open(f: &Fixture, id: &str) -> Result<CliOpened, String> {
    f.sessions.open_cli(id, None, f.programs.client("main"), None).await
}

async fn open_draft(f: &Fixture, id: &str, draft: CliDraft) -> Result<CliOpened, String> {
    f.sessions.open_cli(id, Some(draft), f.programs.client("main"), None).await
}

#[tokio::test]
async fn a_session_continues_in_its_agents_cli_in_its_folder_with_its_env() {
    let f = cli_fixture("cli");
    let (_, events) = f.create("s1", "fake").unwrap();
    events.wait_status("idle").await;
    let refused = open(&f, "s1").await.unwrap_err();
    assert!(refused.contains("running"), "{refused}");
    assert!(f.sessions.cli_terminals().is_empty(), "no CLI yet");

    f.sessions.stop("s1").await.unwrap();
    let acp = listed(&f, "s1").acp_session_id.unwrap();
    let opened = open(&f, "s1").await.unwrap();
    assert_eq!(opened.terminal_id, "cli-s1");
    assert_eq!(f.sessions.cli_terminals(), std::slice::from_ref(&opened.terminal_id));
    let shown = f.programs.shown(&opened.terminal_id);
    assert!(shown.contains(&format!("ARGS:--resume {acp}")), "{shown}");
    assert!(shown.contains(&format!("PWD:{}", f.project.display())), "{shown}");
    assert!(shown.contains("TOKEN:s3cret-value"), "the agent's env: {shown}");
    assert!(listed(&f, "s1").in_terminal);
    assert_eq!(open(&f, "s1").await.unwrap(), opened, "one CLI per session");
    let refused = f.sessions.open_cli("s1", None, f.programs.client("other"), None).await.unwrap_err();
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
    assert!(!f.programs.owns("main", "cli-s1"), "its terminal is closed");
    assert!(f.sessions.cli_terminals().is_empty(), "its terminal is gone");
    assert!(f.sessions.resume("s1").await.unwrap(), "the chat can start it again");
}

#[tokio::test]
async fn a_running_cli_chat_stays_listed_though_its_agent_doesnt_list_it_yet() {
    let f = git_fixture("cli-unlisted");
    f.give_cli_agents();
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    open_draft(&f, NEW_ID, f.draft("fake", Some(ws.id.clone()))).await.unwrap();

    f.sessions.sync(&f.project, None).await;

    let chat = f.sessions.list().into_iter().find(|s| s.id == NEW_ID);
    assert_eq!(chat.and_then(|c| c.workspace_id), Some(ws.id.clone()), "still its workspace's chat");
    f.sessions.close_cli(NEW_ID).await.unwrap();
    f.sessions.sync(&f.project, None).await;
    assert!(f.sessions.list().iter().all(|s| s.id != NEW_ID), "once its CLI is gone the agent's list decides");
}

#[tokio::test]
async fn a_cli_run_chat_shows_what_its_agent_says_and_counts_as_working_unless_at_its_prompt() {
    use agent_api::SessionActivity::{Idle, Running, WaitingForUser};
    // `RECORDED_ACTIVITY` is shared by the tests, and every fixture's ids start at `fake-session-1`.
    let f = fixture("cli-activity", FakeAgentOptions { created: Arc::new(AtomicUsize::new(1000)), ..FakeAgentOptions::default() });
    f.give_cli_agents();
    let (acp, events) = f.started_then_stopped("s1", "fake").await;
    open(&f, "s1").await.unwrap();
    assert_eq!(f.sessions.working(), 1, "its agent hasn't told, so it may be in a turn");

    for (activity, told, busy) in [(Running, "running", true), (WaitingForUser, "waitingForUser", true), (Idle, "idle", false)] {
        record_activity(&acp, activity);
        events.wait_for(told, |e| e.kind == "session" && e.payload["activity"] == told).await;
        assert_eq!(listed(&f, "s1").status, SessionStatus::Stopped, "no ACP status");
        assert_eq!(f.sessions.cli_busy("s1").unwrap(), busy, "closing it would stop a turn: {told}");
        assert_eq!(f.sessions.working(), usize::from(busy), "{told}");
    }

    f.sessions.close_cli("s1").await.unwrap();
    assert_eq!(listed(&f, "s1").activity, None, "no CLI, nothing to tell");
}

#[tokio::test]
async fn its_agents_list_never_reads_as_activity_of_a_chat_its_cli_runs_nor_right_after() {
    // The agent's list says the session changed just now, as an idle CLI's writes do.
    let options = listing();
    let f = fixture("cli-working", options.clone());
    f.give_cli_agents();
    open_draft(&f, NEW_ID, f.draft("fake", None)).await.unwrap();
    let now = crate::util::iso_now();
    stored_in(&options, &[(NEW_ID, &f.project, None, Some(now.as_str()))]);

    f.sessions.sync(&f.project, None).await;

    let session = listed(&f, NEW_ID);
    assert_eq!((session.active_elsewhere_until, session.activity), (None, None), "the agent keeps no records of it");
    assert!(f.sessions.cli_busy(NEW_ID).unwrap(), "it can't tell, so closing it asks first");

    // The CLI's own writes aren't another app's once it's gone.
    f.sessions.close_cli(NEW_ID).await.unwrap();

    assert_eq!(listed(&f, NEW_ID).active_elsewhere_until, None);
}

#[tokio::test]
async fn continuing_a_failed_chat_in_its_cli_leaves_the_failure_behind() {
    let f = cli_fixture("cli-after-crash");
    let (_, events) = f.create("c", "fake").unwrap();
    events.wait_status("idle").await;
    f.sessions.send_prompt("c", text("crash")).unwrap();
    events.wait_status("error").await;

    open(&f, "c").await.unwrap();

    assert_eq!(listed(&f, "c").status, SessionStatus::Stopped, "an error would hide what its CLI is doing");
}

#[tokio::test]
async fn a_cli_that_didnt_start_doesnt_hide_another_apps_activity() {
    let options = listing();
    let f = fixture("cli-refused", options.clone());
    let now = crate::util::iso_now();
    stored_in(&options, &[("busy", &f.project, None, Some(now.as_str()))]);
    f.sessions.sync(&f.project, None).await;
    let until = listed(&f, "fake~busy").active_elsewhere_until;
    assert!(until.is_some());

    open(&f, "fake~busy").await.unwrap_err();

    assert_eq!(listed(&f, "fake~busy").active_elsewhere_until, until);
}

#[tokio::test]
async fn a_draft_starts_in_the_cli_under_its_own_id() {
    let f = cli_fixture("cli-draft");
    let opened = open_draft(&f, NEW_ID, f.draft("fake", None)).await.unwrap();
    let shown = f.programs.shown(&opened.terminal_id);
    assert!(shown.contains(&format!("ARGS:--session-id {NEW_ID} PWD:")), "no prompt, nothing after the id: {shown}");
    let session = listed(&f, NEW_ID);
    assert_eq!(session.acp_session_id.as_deref(), Some(NEW_ID), "the CLI's id is its ACP id");
    assert_eq!((session.status, session.in_terminal), (SessionStatus::Stopped, true));
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 0, "no ACP agent");

    let other = "1cb916db-26aa-40f2-86b5-1ba81b225fd2";
    for (id, agent, why) in [(other, "quitter", "can't start a session"), (other, "plain", "no terminal mode"), ("not-a-uuid", "fake", "UUID")] {
        let refused = open_draft(&f, id, f.draft(agent, None)).await.unwrap_err();
        assert!(refused.contains(why), "{refused}");
    }
    assert!(f.sessions.list().iter().all(|s| s.id == NEW_ID), "nothing created for a refusal");
}

#[tokio::test]
async fn a_first_prompt_too_long_for_the_command_line_is_pasted_once_the_cli_reads() {
    let f = cli_fixture("cli-draft-long");
    let prompt = format!("fix {}", "x".repeat(agent_api::MAX_ARG_PROMPT));
    let draft = CliDraft { prompt: Some(prompt.clone()), ..f.draft("fake", None) };
    let opened = open_draft(&f, NEW_ID, draft).await.unwrap();
    let program = f.programs.program(&opened.terminal_id);
    assert_eq!(program.args, ["--session-id", NEW_ID], "not on the command line");
    assert_eq!(program.paste.map(|(text, _)| text), Some(prompt), "pasted once it reads");
}

#[tokio::test]
async fn a_draft_starts_its_cli_with_the_composers_model_and_its_first_prompt() {
    let f = cli_fixture("cli-draft-picks");
    let config = BTreeMap::from([("model".to_owned(), "opus".to_owned())]);
    let draft = CliDraft { prompt: Some("fix it".into()), config, ..f.draft("fake", None) };
    let opened = open_draft(&f, NEW_ID, draft).await.unwrap();
    let shown = f.programs.shown(&opened.terminal_id);
    assert!(shown.contains(&format!("ARGS:--session-id {NEW_ID} --model opus fix it")), "{shown}");
    f.sessions.close_cli(NEW_ID).await.unwrap();

    // Continued in the terminal later: the session's own picks again.
    let opened = open(&f, NEW_ID).await.unwrap();
    let shown = f.programs.shown(&opened.terminal_id);
    assert!(shown.contains(&format!("ARGS:--resume {NEW_ID} --model opus")), "{shown}");
}

#[tokio::test]
async fn a_worktree_sessions_cli_runs_in_its_checked_out_folder() {
    let f = git_fixture("cli-worktree");
    f.give_cli_agents();
    let opened = open_draft(&f, NEW_ID, f.draft("fake", f.new_workspace(None))).await.unwrap();
    let folder = listed(&f, NEW_ID).folder;
    assert_ne!(folder, f.project.to_string_lossy());
    assert!(Path::new(&folder).join("a.txt").is_file(), "checked out before the CLI starts");
    let shown = f.programs.shown(&opened.terminal_id);
    assert!(shown.contains(&format!("PWD:{folder}")), "{shown}");
}

#[tokio::test]
async fn a_workspace_chats_cli_is_refused_while_its_folder_is_missing() {
    let f = git_fixture("cli-missing");
    f.give_cli_agents();
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    open_draft(&f, NEW_ID, f.draft("fake", Some(ws.id.clone()))).await.unwrap();
    f.sessions.close_cli(NEW_ID).await.unwrap();
    std::fs::remove_dir_all(&ws.worktree_path).unwrap();

    let refused = open(&f, NEW_ID).await.unwrap_err();

    assert!(refused.contains("folder is missing"), "{refused}");
    assert_eq!(listed(&f, NEW_ID).status, SessionStatus::Stopped);
    assert!(!ws.worktree_path.exists(), "not checked out again");
}

#[tokio::test]
async fn the_clis_exit_is_reported_and_frees_the_session() {
    let f = cli_fixture("cli-exit");
    let (_, events) = f.started_then_stopped("q", "quitter").await;
    events.clear();
    open(&f, "q").await.unwrap();
    f.programs.exit("cli-q", Some(3), None);
    let exited = events.wait_for("cli-exited", |e| e.kind == "cli-exited").await;
    assert_eq!(exited.payload, json!({ "code": 3, "signal": null }));
    assert!(!listed(&f, "q").in_terminal);
    let session = events.wait_for("the session after", |e| e.kind == "session" && e.payload["inTerminal"] == false).await;
    assert_eq!(session.payload["id"], "q");
    let started = Instant::now();
    while f.programs.owns("main", "cli-q") {
        assert!(started.elapsed() < Duration::from_secs(5), "its terminal is closed once it exited");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!f.sessions.cli_busy("q").unwrap(), "nothing runs");
}

#[tokio::test]
async fn removing_the_session_or_turning_its_agent_off_closes_its_cli() {
    let f = cli_fixture("cli-close");
    f.started_then_stopped("a", "fake").await;
    f.started_then_stopped("b", "fake").await;
    for id in ["a", "b"] {
        let opened = open(&f, id).await.unwrap();
        assert!(f.programs.owns("main", &opened.terminal_id));
    }

    f.sessions.remove("a").await.unwrap();
    assert!(!f.programs.owns("main", "cli-a"));

    f.sessions.inner.opts.configs.set_enabled(Some(&f.project), "fake", false).unwrap();
    f.sessions.sync_agents(&f.project).await;
    assert!(!f.programs.owns("main", "cli-b"));
    assert!(!listed(&f, "b").in_terminal);
}
