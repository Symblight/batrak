use super::*;

/// A chat of the workspace, its agent ready.
async fn idle_chat(f: &Fixture, id: &str, workspace: &str) -> Arc<Recorder> {
    let (_, events) = f.create_in_workspace(id, workspace).unwrap();
    events.wait_status("idle").await;
    events
}

/// An agent's commit in `folder`.
fn commit_file(folder: &Path, name: &str, contents: &str) {
    std::fs::write(folder.join(name), contents).unwrap();
    run_in(folder, &["add", "."]);
    run_in(folder, &["commit", "-qm", "agent"]);
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
async fn deleting_a_workspace_deletes_its_chats_two_at_a_time() {
    let options = FakeAgentOptions { delete_session: true, ..listing() };
    let f = git_fixture_with("ws-delete-parallel", options.clone());
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    for id in ["a", "b", "c"] {
        idle_chat(&f, id, &ws.id).await;
    }

    f.sessions.delete_workspace(&ws.id, false).await.unwrap();

    assert_eq!(options.deletes_peak.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn deleting_a_workspace_removes_its_chats_and_its_folder() {
    let options = FakeAgentOptions { delete_session: true, ..listing() };
    let f = git_fixture_with("ws-delete-chats", options.clone());
    let ws = f.sessions.workspaces().create(&f.project, "Fix login", None).unwrap();
    let events = idle_chat(&f, "c", &ws.id).await;
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
    let events = idle_chat(&f, "busy", &ws.id).await;
    idle_chat(&f, "idle", &ws.id).await;
    commit_file(&ws.folder, "x.txt", "x");
    std::fs::write(ws.folder.join("a.txt"), "changed").unwrap();
    std::fs::write(ws.folder.join("new.txt"), "new").unwrap();
    f.sessions.send_prompt("busy", text("slow")).unwrap();
    events.wait_for("first chunk", |e| e.kind == "update").await;

    let preview = f.sessions.workspace_delete_preview(&ws.id).await.unwrap();

    assert_eq!((preview.uncommitted, preview.commits), (2, 1));
    assert_eq!(preview.working, vec!["Session busy".to_owned()]);
}

#[tokio::test]
async fn worktree_sessions_become_workspaces_at_load_and_local_ones_stay_in_main() {
    let f = git_fixture("ws-migrate");
    let (tree, events) = f.create_in("t", "fake", f.new_workspace(None)).unwrap();
    events.wait_status("idle").await;
    let stored_base = f.sessions.workspaces().list(&f.project)[0].base_commit.clone();
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
    assert_eq!(ws.folder.to_string_lossy(), tree.folder, "folder unchanged");
    assert_eq!(Some(ws.branch.clone()), tree.branch, "branch unchanged");
    assert_eq!(ws.base_commit, stored_base);
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
    idle_chat(&f, "a", &ws.id).await;
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
async fn a_chat_in_a_workspace_runs_in_its_folder_on_its_branch_and_the_workspace_outlives_it() {
    let f = git_fixture("ws-new");

    let (chat, events) = f.create_in("b", "fake", f.new_workspace(Some("main"))).unwrap();
    events.wait_status("idle").await;

    let workspaces = f.sessions.workspaces().list(&f.project);
    assert_eq!(workspaces.len(), 1);
    let ws = &workspaces[0];
    assert_eq!((ws.name.as_str(), ws.branch.as_str(), ws.base_branch.as_deref()), ("Session b", "workspace", Some("main")));
    assert_eq!(chat.workspace_id.as_deref(), Some(ws.id.as_str()));
    assert_eq!(PathBuf::from(&chat.folder), ws.folder, "its agent works in the workspace's folder");
    assert_eq!(chat.branch.as_deref(), Some(ws.branch.as_str()));
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
    assert_eq!((chat.workspace_id, chat.folder), (None, plain.project.to_string_lossy().into_owned()));

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
    let first = idle_chat(&f, "first", &ws.id).await;
    let second = idle_chat(&f, "second", &ws.id).await;
    let (_, main) = f.create("main", "fake").unwrap();
    main.wait_status("idle").await;
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
    std::fs::write(f.project.join(".bt/workspace.json"), r#"{"version":1,"localTurns":"parallel"}"#).unwrap();
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    let file = ws.folder.join("a.txt").to_string_lossy().into_owned();
    let a = idle_chat(&f, "a", &ws.id).await;
    let b = idle_chat(&f, "b", &ws.id).await;
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
    assert_eq!(in_ws.branch.as_deref(), Some(ws.branch.as_str()));
    assert_eq!(by_title("In Main").workspace_id, None);
}

#[tokio::test]
async fn a_workspaces_git_actions_wait_for_none_of_its_chats_and_hold_them_all() {
    let f = git_fixture("ws-actions");
    let ws = f.sessions.workspaces().create(&f.project, "Task", None).unwrap();
    let busy = idle_chat(&f, "busy", &ws.id).await;
    let idle = idle_chat(&f, "idle", &ws.id).await;
    commit_file(&ws.folder, "committed.txt", "c\n");
    std::fs::write(ws.folder.join("a.txt"), "edited").unwrap();

    // Refused while one chat works, naming it; the other chat's slot is left alone.
    f.sessions.send_prompt("busy", text("slow")).unwrap();
    busy.wait_for("first chunk", |e| e.kind == "update").await;
    let err = f.sessions.workspace_apply_locally(&ws.id).await.unwrap_err();
    assert!(err.contains("Session busy") && err.contains("working in this workspace"), "{err}");
    f.sessions.cancel("busy").unwrap();
    busy.wait_turn_end().await;
    assert_eq!(f.ask("idle", &idle, "hello").await, "Hello, world", "a refused claim holds no chat");

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
    let events = idle_chat(&f, "c", &ws.id).await;
    commit_file(&ws.folder, "work.txt", "agent work\n");
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
    f.sessions.workspaces().notify_with(Arc::new(crate::notify::testing::OnWorkspaces(move |project: &Path| lock(&sink).push(project.to_path_buf()))));
    let (first, events) = f.create_in("a", "fake", f.new_workspace(None)).unwrap();
    let ws = first.workspace_id.unwrap();
    let (_, second) = f.create_in_workspace("b", &ws).unwrap();
    events.wait_status("idle").await;
    second.wait_status("idle").await;
    let name = || f.sessions.workspaces().get(&ws).unwrap().name;

    // Saved in the background: off the ACP dispatch loop.
    let settle = || tokio::time::sleep(Duration::from_millis(100));
    f.ask("a", &events, "title Tree view gaps").await;
    settle().await;
    assert_eq!(name(), "Tree view gaps");
    assert!(lock(&told).contains(&f.project), "the page hears of it");

    f.ask("b", &second, "title Something else").await;
    settle().await;
    assert_eq!(name(), "Tree view gaps", "only its first chat names it");

    f.sessions.workspaces().rename(&ws, "Mine").unwrap();
    f.ask("a", &events, "title Later").await;
    settle().await;
    assert_eq!(name(), "Mine", "a user's name stays");
}

#[tokio::test]
async fn working_counts_chats_in_a_turn_not_idle_ones() {
    let f = fixture("working-acp", FakeAgentOptions::default());
    let (session, first) = f.create("first", "fake").unwrap();
    assert_eq!(session.status, SessionStatus::Preparing);
    assert_eq!(f.sessions.working(), 1, "preparing");
    first.wait_status("idle").await;
    assert_eq!(f.sessions.working(), 0, "idle");
    let (_, second) = f.create("second", "fake").unwrap();
    second.wait_status("idle").await;

    f.sessions.send_prompt("first", text("permission")).unwrap();
    let request = first.wait_for("permission request", |e| e.kind == "permission-request").await;
    first.wait_status("waiting").await;
    assert_eq!(f.sessions.working(), 1, "waiting");
    f.sessions.send_prompt("second", text("hello")).unwrap();
    second.wait_status("queued").await;
    assert_eq!(f.sessions.working(), 2, "queued behind the waiting one");

    let id = request.payload["requestId"].as_str().unwrap().to_owned();
    f.sessions.respond_permission("first", &id, Some("allow".to_owned())).unwrap();
    first.wait_turn_end().await;
    second.wait_turn_end().await;
    f.sessions.send_prompt("first", text("sleep 5000")).unwrap();
    first.wait_for("the turn", |e| e.kind == "status" && e.payload["status"] == "working" && status_of(&f, "first") == SessionStatus::Working).await;
    assert_eq!(f.sessions.working(), 1, "working, the other idle again");
    f.sessions.stop("first").await.unwrap();
    assert_eq!(f.sessions.working(), 0, "stopped");
}
