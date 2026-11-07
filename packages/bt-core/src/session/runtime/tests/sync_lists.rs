use super::sync::SyncOutcome;
use super::*;

#[tokio::test]
async fn a_sync_lists_the_agents_sessions_of_the_project_and_says_how_each_agent_did() {
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
    assert_eq!((listed[0].workspace_id.as_deref(), listed[0].folder.as_str()), (None, f.project.to_str().unwrap()));
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

    // Deleted in a terminal, renamed by the agent.
    options.stored.lock().unwrap().retain(|s| s.id != "t2");
    options.stored.lock().unwrap()[0].title = Some("First, renamed".to_owned());
    relaunched.sync(&f.project, None).await;
    let ids: Vec<_> = relaunched.list().into_iter().map(|s| (s.id, s.title)).collect();
    assert_eq!(ids, [("fake~t1".to_owned(), "First, renamed".to_owned())]);
}

#[tokio::test]
async fn an_agent_that_cant_list_keeps_its_sessions() {
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
    let fake = Some(&["fake".to_owned()][..]);
    let (_, events) = f.create("s", "fake").unwrap();
    events.wait_status("idle").await;
    options.stored.lock().unwrap().clear();
    f.sessions.sync(&f.project, fake).await;
    assert_eq!(f.sessions.list().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["s"]);
    f.sessions.stop("s").await.unwrap();
    f.sessions.sync(&f.project, fake).await;
    assert!(f.sessions.list().is_empty(), "stopped, and gone from its agent");
}

#[tokio::test]
async fn agents_that_are_off_or_wait_for_a_sign_in_are_skipped() {
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
async fn a_sync_during_another_joins_it_when_it_covers_its_agents_else_waits_and_lists_its_own() {
    let (fake, other) = (["fake".to_owned()], ["other".to_owned()]);
    let listed = |id: &'static str| (id, SyncOutcome::Listed, Some(1));
    let only_fake = vec![listed("fake")];
    let both = vec![listed("fake"), listed("other")];
    // The running sync's agents, the second's, what each reports, whether they share a report, and
    // how many lists the agents answered.
    let cases = [
        (Some(&fake[..]), Some(&other[..]), only_fake.clone(), vec![listed("other")], false, 2),
        (Some(&fake[..]), None, only_fake, both.clone(), false, 3),
        (None, Some(&fake[..]), both.clone(), both, true, 2),
    ];
    for (running, asked, running_report, asked_report, joined, lists) in cases {
        let (f, open) = two_listing_agents("sync-during");
        let (first, second) = sync_during(&f, &open, running, asked).await;
        let case = format!("{running:?} then {asked:?}");
        assert_eq!(outcomes(&first), running_report, "{case}");
        assert_eq!(outcomes(&second), asked_report, "{case}");
        assert_eq!(first == second, joined, "{case}");
        assert_eq!(f.launcher.launches_of("fake-agent"), 1, "{case}: fake is started once");
        let answered: usize = lock(&f.launcher.agents).iter().map(|a| a.lists.load(Ordering::SeqCst)).sum();
        assert_eq!(answered, lists, "{case}");
        assert_eq!(f.sessions.list().len(), 1, "{case}: the agents share one store: t1, listed once");
    }
}

#[tokio::test]
async fn a_session_its_agent_saw_active_just_now_is_active_elsewhere_for_a_while_unless_it_was_here() {
    let options = listing();
    let f = fixture("sync-elsewhere", options.clone());
    let now = crate::util::iso_now();
    stored_in(&options, &[("busy", &f.project, None, Some(now.as_str())), ("old", &f.project, None, Some("2026-01-01T00:00:00Z"))]);
    f.sessions.sync(&f.project, None).await;
    let until = |sessions: &Sessions, id: &str| sessions.list().into_iter().find(|s| s.id == id).unwrap().active_elsewhere_until;
    let now_ms = crate::util::parse_iso_millis(&now).unwrap();
    assert_eq!(until(&f.sessions, "fake~busy"), Some(crate::util::iso_from_millis(now_ms + 2 * 60_000)), "its activity and two minutes");
    let old = until(&f.sessions, "fake~old").unwrap();
    assert!(old.as_str() < now.as_str(), "long over: {old}");

    let (_, events) = f.create("here", "fake").unwrap();
    assert_eq!(f.ask("here", &events, "hello").await, "Hello, world");
    f.sessions.stop("here").await.unwrap();
    f.sessions.sync(&f.project, None).await;
    assert_eq!(until(&f.sessions, "here"), None, "its last activity was Batrak's");
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

    // One that went away is started again.
    let agent = Arc::clone(lock(&f.launcher.agents).last().unwrap());
    agent.crash.notify_one();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let report = f.sessions.sync(&f.project, fake).await;
    assert_eq!(report.agents[0].outcome, SyncOutcome::Listed);
    assert_eq!(f.launcher.launches.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn the_front_hears_a_projects_sessions_after_each_sync() {
    struct OnSynced(Arc<Mutex<Vec<(PathBuf, usize, String)>>>);
    impl crate::notify::Notifier for OnSynced {
        fn sessions_synced(&self, project: &Path, sessions: &[Session], report: &SyncReport) {
            lock(&self.0).push((project.to_path_buf(), sessions.len(), report.project_path.clone()));
        }
    }
    let heard = Arc::new(Mutex::new(Vec::new()));
    let f = fixture("sync-synced", FakeAgentOptions::default());
    let mut options = options_for(&f.dir, &f.launcher);
    options.configs = options.configs.with_notifier(Arc::new(OnSynced(Arc::clone(&heard))));

    f.reopen_with(options).await;

    assert_eq!(*lock(&heard), [(f.project.clone(), 0, f.project.to_string_lossy().into_owned())]);
}
