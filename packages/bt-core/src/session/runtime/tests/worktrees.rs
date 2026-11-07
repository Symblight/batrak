use super::*;

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
async fn worktree_sessions_run_side_by_side_on_their_own_branches() {
    let f = git_fixture("wt");
    let head = run_in(&f.project, &["rev-parse", "HEAD"]).trim().to_owned();
    let (one, events) = f.create_in("w1", "fake", f.new_workspace(None)).unwrap();
    let (two, other) = f.create_in("w2", "fake", f.new_workspace(None)).unwrap();
    let (_, local) = f.create("l", "fake").unwrap();
    for recorder in [&events, &other, &local] {
        recorder.wait_status("idle").await;
    }

    assert_eq!(f.sessions.workspaces().get(one.workspace_id.as_deref().unwrap()).unwrap().base_commit, head);
    let branch = one.branch.clone().unwrap();
    assert!(branch.starts_with("workspace"), "{branch}");
    assert_ne!(two.branch, one.branch);
    let wt = PathBuf::from(one.folder.clone());
    assert!(wt.starts_with(dunce::canonicalize(f.dir.join("data/worktrees")).unwrap()), "{}", wt.display());
    assert_eq!(run_in(&wt, &["branch", "--show-current"]).trim(), branch);
    assert_eq!(run_in(&wt, &["rev-parse", "HEAD"]).trim(), head);

    // The agent works in its own copy; the project and the other session don't see it.
    let file = wt.join("a.txt");
    assert_eq!(f.ask("w1", &events, &format!("write {} mine", file.display())).await, "written");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
    assert_eq!(std::fs::read_to_string(f.project.join("a.txt")).unwrap(), "one\ntwo\nthree\n");
    assert_eq!(run_in(&f.project, &["branch", "--show-current"]).trim(), "main", "the checkout stays");
    let two_file = PathBuf::from(two.folder).join("a.txt");
    assert_eq!(std::fs::read_to_string(two_file).unwrap(), "one\ntwo\nthree\n");
    let reply = f.ask("w1", &events, &format!("read {}", f.path("a.txt"))).await;
    assert!(reply.contains("outside the session"), "{reply}");
}

#[tokio::test]
async fn a_sessions_folder_is_where_its_agent_works_a_terminal_may_start_and_only_a_workspaces_is_readable() {
    let f = git_fixture("wt-folder");
    let (local, events) = f.create("l", "fake").unwrap();
    let (wt, other) = f.create_in("w", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    other.wait_status("idle").await;
    assert_eq!(local.folder, f.project.to_string_lossy());

    assert!(f.sessions.contains_folder(&f.project), "a local session's folder is its project");
    assert!(f.sessions.contains_folder(&f.project.join("src")));
    assert!(f.sessions.contains_folder(Path::new(&wt.folder)));
    assert!(!f.sessions.contains_folder(&f.dir.join("data")));
    assert!(!f.sessions.contains_folder(&f.project.with_file_name("projectx")));

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
async fn a_workspace_gives_its_folder_and_base_only_once_checked_out() {
    let f = git_fixture("ws-checked-out");
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    let placed = f.sessions.workspaces().place(&f.project, Some("Later"), None).unwrap();

    assert_eq!(f.sessions.workspace_checked_out(&ws.id).unwrap(), (ws.folder.clone(), ws.base_commit.clone()));
    assert!(f.sessions.workspace_checked_out("nope").is_err(), "an unknown workspace");
    let err = f.sessions.workspace_checked_out(&placed.id).unwrap_err();
    assert!(err.contains("isn't checked out"), "{err}");
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
    let wt = f.sessions.workspaces().get(session.workspace_id.as_deref().unwrap()).unwrap().worktree_path;
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

    f.sessions.shutdown();
    std::fs::remove_dir_all(&session.folder).unwrap();
    let sessions = f.reopen().await;
    let listed = sessions.list().into_iter().find(|s| s.id == "r").unwrap();
    assert_eq!(listed.branch, session.branch);
    let events = attach_page(&sessions, "r", "main");
    sessions.send_prompt("r", text("hello")).unwrap();
    let failed = events.wait_status("error").await;
    assert!(failed.payload["message"].as_str().unwrap().contains("folder is missing"), "{failed:?}");
}

#[tokio::test]
async fn at_launch_worktrees_no_workspace_owns_are_removed_unless_they_hold_work() {
    let f = git_fixture("wt-tidy");
    let (kept, events) = f.create_in("k", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    let kept = PathBuf::from(kept.folder);
    let chatless = f.sessions.workspaces().create(&f.project, "Empty", None).unwrap();
    let group = kept.parent().unwrap().to_path_buf();
    let git = crate::git::test_repo::git_bin();
    let (orphan, dirty) = (group.join("orphan"), group.join("dirty"));
    for (path, branch) in [(&orphan, "batrak/orphan"), (&dirty, "batrak/dirty")] {
        crate::git::worktree::add(&git, &f.project, path, branch, "main", &std::sync::atomic::AtomicBool::new(false)).unwrap();
    }
    std::fs::write(dirty.join("work.txt"), "w").unwrap();
    std::fs::create_dir_all(f.dir.join("data/worktrees/empty-group")).unwrap();

    f.sessions.tidy_worktrees();
    assert!(kept.join("a.txt").exists(), "a session's own");
    assert!(chatless.folder.join("a.txt").is_file(), "a workspace's own, though no chat runs in it");
    assert!(!orphan.exists());
    assert!(run_in(&f.project, &["branch", "--list", "batrak/orphan"]).contains("batrak/orphan"), "branches stay");
    assert_eq!(std::fs::read_to_string(dirty.join("work.txt")).unwrap(), "w");
    assert!(!f.dir.join("data/worktrees/empty-group").exists());
    assert!(!run_in(&f.project, &["worktree", "list"]).contains("orphan"));
}
