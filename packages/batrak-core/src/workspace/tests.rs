use std::path::PathBuf;

use super::*;
use crate::git::test_repo::temp_dir;

fn record(id: &str) -> WorkspaceRecord {
    WorkspaceRecord {
        id: id.to_owned(),
        project_path: PathBuf::from("/p/app"),
        name: "Fix login".to_owned(),
        name_source: NameSource::User,
        folder: PathBuf::from("/data/worktrees/app-1/fix-login"),
        worktree_path: PathBuf::from("/data/worktrees/app-1/fix-login"),
        branch: "brama/fix-login".to_owned(),
        base_commit: "abc".to_owned(),
        base_branch: Some("main".to_owned()),
        created_at: "2026-11-03T10:00:00.000Z".to_owned(),
        checked_out: true,
    }
}

#[test]
fn records_round_trip_workspaces_json_and_a_missing_or_invalid_file_is_empty() {
    let dir = temp_dir("workspace-store");
    let file = dir.join("workspaces.json");
    assert!(Store::open(file.clone()).list(None).is_empty(), "no file");

    let store = Store::open(file.clone());
    store.insert(record("w1")).unwrap();
    let reopened = Store::open(file.clone());
    assert_eq!(reopened.list(None), vec![record("w1")]);
    assert_eq!(reopened.list(Some(std::path::Path::new("/p/other"))), vec![], "by project");

    std::fs::write(&file, "{oops").unwrap();
    assert!(Store::open(file).list(None).is_empty(), "invalid");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_named_workspace_is_placed_on_its_branch_from_the_base_and_checked_out() {
    use crate::git::test_repo::TestRepo;
    let repo = TestRepo::with_commit("ws-create");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.write("feature.txt", "f");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "feature"]);
    let data = temp_dir("ws-create-data");
    let workspaces = Workspaces::new(&data);

    let ws = workspaces.create(&repo.path, "Fix login", None).unwrap();

    assert_eq!(ws.branch, "brama/fix-login");
    assert_eq!(ws.worktree_path.file_name().unwrap(), "fix-login");
    assert!(ws.folder.join("README.md").is_file(), "checked out");
    assert!(!ws.folder.join("feature.txt").exists(), "from the base branch (main), not HEAD");
    assert_eq!(ws.base_branch.as_deref(), Some("main"));
    assert_eq!(workspaces.list(&repo.path), vec![ws.clone()]);

    let taken = workspaces.create(&repo.path, "Fix login", Some("feature")).unwrap();
    assert_eq!(taken.branch, "brama/fix-login-2", "the branch and folder are taken");
    assert!(taken.folder.join("feature.txt").is_file(), "from the chosen base");
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn an_unnamed_workspace_is_called_after_its_branch_and_named_by_its_agent() {
    use crate::git::test_repo::TestRepo;
    let repo = TestRepo::with_commit("ws-unnamed");
    let data = temp_dir("ws-unnamed-data");
    let workspaces = Workspaces::new(&data);

    let first = workspaces.place(&repo.path, None, None).unwrap();
    let second = workspaces.place(&repo.path, None, None).unwrap();

    assert_eq!((first.name.as_str(), first.branch.as_str()), ("Workspace", "brama/workspace"));
    assert_eq!((second.name.as_str(), second.branch.as_str()), ("Workspace 2", "brama/workspace-2"));
    assert_eq!(first.name_source, NameSource::Agent, "its chat names it");
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn a_workspace_needs_a_real_base_and_never_takes_it_as_an_option() {
    use crate::git::test_repo::TestRepo;
    let repo = TestRepo::with_commit("ws-refuse-base");
    let data = temp_dir("ws-refuse-base-data");
    let workspaces = Workspaces::new(&data);
    assert!(workspaces.place(&repo.path, None, Some("nope")).unwrap_err().contains("nope"));
    assert!(workspaces.place(&repo.path, None, Some("--output=x")).unwrap_err().contains("--output=x"));
    assert!(!repo.path.join("x").exists(), "a base is never an option");
    assert!(workspaces.list(&repo.path).is_empty(), "nothing stored");
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn a_workspace_needs_a_repository_with_a_commit() {
    use crate::git::test_repo::TestRepo;
    let data = temp_dir("ws-refuse-data");
    let workspaces = Workspaces::new(&data);
    let plain = temp_dir("ws-refuse-plain");
    assert!(workspaces.create(&plain, "x", None).unwrap_err().contains("git repository"));
    let unborn = TestRepo::new("ws-refuse-unborn");
    assert!(workspaces.create(&unborn.path, "x", None).unwrap_err().contains("no commit"));
    assert!(workspaces.list(&plain).is_empty() && workspaces.list(&unborn.path).is_empty());
    std::fs::remove_dir_all(data).unwrap();
    std::fs::remove_dir_all(plain).unwrap();
}

#[test]
fn renaming_changes_the_name_only() {
    use crate::git::test_repo::TestRepo;
    let repo = TestRepo::with_commit("ws-rename");
    let data = temp_dir("ws-rename-data");
    let workspaces = Workspaces::new(&data);
    let ws = workspaces.place(&repo.path, None, None).unwrap();

    let renamed = workspaces.rename(&ws.id, "  Second  ").unwrap();

    assert_eq!((renamed.name.as_str(), renamed.name_source), ("Second", NameSource::User));
    assert_eq!((&renamed.folder, &renamed.branch), (&ws.folder, &ws.branch), "folder and branch stay");
    assert!(workspaces.rename(&ws.id, " ").is_err(), "empty is refused");
    assert_eq!(Workspaces::new(&data).get(&ws.id).unwrap().name, "Second", "stored");
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn deleting_saves_uncommitted_work_and_keeps_or_deletes_the_branch() {
    use crate::git::test_repo::{run_in, TestRepo};
    let repo = TestRepo::with_commit("ws-delete");
    let data = temp_dir("ws-delete-data");
    let workspaces = Workspaces::new(&data);
    let branches = || run_in(&repo.path, &["branch", "--format=%(refname:short)"]);

    // Nothing done: the branch goes, whatever Keep branch says.
    let unused = workspaces.create(&repo.path, "Unused", None).unwrap();
    workspaces.discard(&unused.id, true).unwrap();
    assert!(!unused.worktree_path.exists());
    assert!(!branches().contains("brama/unused"));
    assert!(workspaces.get(&unused.id).is_err(), "the record goes");

    // Uncommitted work: a snapshot commit on the branch, which stays.
    let dirty = workspaces.create(&repo.path, "Dirty", None).unwrap();
    std::fs::write(dirty.folder.join("README.md"), "unsaved").unwrap();
    workspaces.discard(&dirty.id, true).unwrap();
    assert!(!dirty.worktree_path.exists());
    assert_eq!(run_in(&repo.path, &["show", "brama/dirty:README.md"]), "unsaved");
    assert!(run_in(&repo.path, &["log", "-1", "--format=%B", "brama/dirty"]).contains("Work in progress from workspace \"Dirty\""));

    // Commits, Keep branch off: the branch goes.
    let done = workspaces.create(&repo.path, "Done", None).unwrap();
    std::fs::write(done.folder.join("x.txt"), "x").unwrap();
    run_in(&done.folder, &["add", "."]);
    run_in(&done.folder, &["commit", "-qm", "work"]);
    workspaces.discard(&done.id, false).unwrap();
    assert!(!branches().contains("brama/done"));
    assert!(run_in(&repo.path, &["status", "--porcelain"]).is_empty(), "the project is untouched");
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn a_detached_worktree_with_uncommitted_work_is_kept_on_delete() {
    use crate::git::test_repo::{run_in, TestRepo};
    let repo = TestRepo::with_commit("ws-delete-detached");
    let data = temp_dir("ws-delete-detached-data");
    let workspaces = Workspaces::new(&data);
    let ws = workspaces.create(&repo.path, "Handed", None).unwrap();
    run_in(&ws.folder, &["switch", "-q", "--detach"]);
    std::fs::write(ws.folder.join("README.md"), "unsaved").unwrap();

    workspaces.discard(&ws.id, true).unwrap();

    assert_eq!(std::fs::read_to_string(ws.folder.join("README.md")).unwrap(), "unsaved", "kept");
    assert!(workspaces.get(&ws.id).is_err(), "the record goes");
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn every_change_is_announced_with_its_project_and_the_page_sees_creating_and_missing() {
    use crate::git::test_repo::TestRepo;
    use std::sync::{Arc, Mutex};
    let repo = TestRepo::with_commit("ws-announce");
    let data = temp_dir("ws-announce-data");
    let workspaces = Workspaces::new(&data);
    let heard = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let sink = Arc::clone(&heard);
    workspaces.notify_with(Arc::new(crate::notify::testing::OnWorkspaces(move |project: &std::path::Path| sink.lock().unwrap().push(project.to_path_buf()))));

    let ws = workspaces.place(&repo.path, Some("Task"), None).unwrap();
    assert!(!workspaces.pages(&repo.path)[0].missing, "placed, not checked out yet: not missing");
    workspaces.check_out(&ws.id).unwrap();
    let page = &workspaces.pages(&repo.path)[0];
    assert!(!page.creating && !page.missing && page.error.is_none());
    workspaces.rename(&ws.id, "Renamed").unwrap();
    std::fs::remove_dir_all(&ws.worktree_path).unwrap();
    assert!(workspaces.pages(&repo.path)[0].missing, "deleted outside Batrak");
    workspaces.discard(&ws.id, true).unwrap();

    let heard = heard.lock().unwrap();
    assert!(heard.len() >= 4, "place, checkout, rename, delete: {heard:?}");
    assert!(heard.iter().all(|p| *p == repo.path));
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn a_chat_start_does_the_first_checkout_after_a_failed_one_or_a_relaunch() {
    use crate::git::test_repo::TestRepo;
    let repo = TestRepo::with_commit("ws-first-checkout");
    let data = temp_dir("ws-first-checkout-data");

    // Placed, then the app quit before any checkout: a new launch still checks it out.
    let placed = Workspaces::new(&data).place(&repo.path, Some("Quit early"), None).unwrap();
    Workspaces::new(&data).ready(&placed.id).unwrap();
    assert!(placed.folder.join("README.md").is_file(), "checked out after a relaunch");

    // A first checkout that failed is tried again.
    let workspaces = Workspaces::new(&data);
    let failed = workspaces.place(&repo.path, Some("Failed once"), None).unwrap();
    std::fs::create_dir_all(failed.worktree_path.parent().unwrap()).unwrap();
    std::fs::write(&failed.worktree_path, "in the way").unwrap();
    assert!(workspaces.check_out(&failed.id).is_err());
    std::fs::remove_file(&failed.worktree_path).unwrap();
    workspaces.ready(&failed.id).unwrap();
    assert!(failed.folder.join("README.md").is_file(), "retried");
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn a_folder_and_branch_deleted_outside_batrak_stay_missing_until_recreate() {
    use crate::git::test_repo::{run_in, TestRepo};
    let repo = TestRepo::with_commit("ws-gone");
    let data = temp_dir("ws-gone-data");
    let ws = Workspaces::new(&data).create(&repo.path, "Gone", None).unwrap();
    std::fs::remove_dir_all(&ws.worktree_path).unwrap();
    run_in(&repo.path, &["worktree", "prune"]);
    run_in(&repo.path, &["branch", "-qD", &ws.branch]);

    // A chat's start after a relaunch.
    let workspaces = Workspaces::new(&data);
    workspaces.ready(&ws.id).unwrap();

    assert!(!ws.worktree_path.exists(), "not checked out again");
    assert!(workspaces.pages(&repo.path)[0].missing);
    workspaces.check_out(&ws.id).unwrap();
    assert!(ws.folder.join("README.md").is_file(), "Recreate checks it out");
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn a_name_placed_but_not_checked_out_yet_is_taken() {
    use crate::git::test_repo::TestRepo;
    let repo = TestRepo::with_commit("ws-reserved");
    let data = temp_dir("ws-reserved-data");
    let workspaces = Workspaces::new(&data);

    let first = workspaces.place(&repo.path, Some("Fix login"), None).unwrap();
    let second = workspaces.place(&repo.path, Some("Fix login"), None).unwrap();

    assert_ne!(first.worktree_path, second.worktree_path);
    assert_eq!((first.branch.as_str(), second.branch.as_str()), ("brama/fix-login", "brama/fix-login-2"));
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn a_workspaces_folder_opens_only_while_checked_out() {
    use crate::git::test_repo::TestRepo;
    let repo = TestRepo::with_commit("ws-open-folder");
    let data = temp_dir("ws-open-folder-data");
    let workspaces = Workspaces::new(&data);
    let ws = workspaces.place(&repo.path, Some("Task"), None).unwrap();
    assert!(workspaces.open_folder(&ws.id).is_err(), "placed, not checked out yet");

    workspaces.check_out(&ws.id).unwrap();
    assert_eq!(workspaces.open_folder(&ws.id), Ok(ws.folder.clone()));

    std::fs::remove_dir_all(&ws.worktree_path).unwrap();
    assert!(workspaces.open_folder(&ws.id).is_err(), "deleted outside Batrak");
    assert!(workspaces.open_folder("nope").is_err());
    workspaces.discard(&ws.id, false).unwrap();
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn a_placed_workspace_lists_as_creating_from_its_first_announcement_until_its_checkout_ends() {
    use crate::git::test_repo::TestRepo;
    use std::sync::{Arc, Mutex};
    let repo = TestRepo::with_commit("ws-creating");
    let data = temp_dir("ws-creating-data");
    let workspaces = Workspaces::new(&data);
    let seen = Arc::new(Mutex::new(Vec::<(bool, bool)>::new()));
    let (sink, observer) = (Arc::clone(&seen), workspaces.clone());
    workspaces.notify_with(Arc::new(crate::notify::testing::OnWorkspaces(move |project: &std::path::Path| {
        let pages = observer.pages(project);
        sink.lock().unwrap().extend(pages.iter().map(|w| (w.creating, w.missing)));
    })));

    let ws = workspaces.place(&repo.path, None, None).unwrap();
    let placed = workspaces.pages(&repo.path)[0].clone();
    workspaces.check_out(&ws.id).unwrap();

    assert!(placed.creating && !placed.missing, "the reply to Create");
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.first(), Some(&(true, false)), "the first announcement: {seen:?}");
    assert_eq!(seen.last(), Some(&(false, false)), "checked out: {seen:?}");
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn a_workspace_never_checked_out_lists_as_missing_after_a_relaunch_or_a_failed_checkout() {
    use crate::git::test_repo::TestRepo;
    let repo = TestRepo::with_commit("ws-never");
    let data = temp_dir("ws-never-data");
    let page = |workspaces: &Workspaces, id: &str| workspaces.pages(&repo.path).into_iter().find(|w| w.record.id == id).unwrap();

    // Placed, then the app quit before its checkout ran.
    let quit = Workspaces::new(&data).place(&repo.path, Some("Quit early"), None).unwrap();
    let workspaces = Workspaces::new(&data);
    let after_relaunch = page(&workspaces, &quit.id);
    // Its checkout failed.
    let failed = workspaces.place(&repo.path, Some("Failed"), None).unwrap();
    std::fs::create_dir_all(failed.worktree_path.parent().unwrap()).unwrap();
    std::fs::write(&failed.worktree_path, "in the way").unwrap();
    assert!(workspaces.check_out(&failed.id).is_err());
    let after_failure = page(&workspaces, &failed.id);
    // Recreate checks it out.
    workspaces.check_out(&quit.id).unwrap();

    assert!(after_relaunch.missing && !after_relaunch.creating, "{after_relaunch:?}");
    assert!(after_failure.missing && after_failure.error.is_some(), "{after_failure:?}");
    assert!(!page(&workspaces, &quit.id).missing, "recreated");
    std::fs::remove_dir_all(data).unwrap();
}

/// A `post-checkout` hook that sleeps keeps `worktree add` running.
#[cfg(unix)]
#[test]
fn deleting_a_workspace_while_its_checkout_runs_stops_it_and_leaves_no_folder_or_branch() {
    use crate::git::test_repo::{run_in, TestRepo};
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};
    let repo = TestRepo::with_commit("ws-delete-creating");
    let hook = repo.path.join(".git/hooks/post-checkout");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\nsleep 10\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let data = temp_dir("ws-delete-creating-data");
    let workspaces = Workspaces::new(&data);
    let ws = workspaces.place(&repo.path, Some("Slow"), None).unwrap();
    let checkout = workspaces.clone();
    let id = ws.id.clone();
    let checking_out = std::thread::spawn(move || checkout.check_out(&id));
    let waiting = Instant::now();
    while !ws.worktree_path.join(".git").exists() && waiting.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(200));

    let deleting = Instant::now();
    workspaces.discard(&ws.id, true).unwrap();

    assert!(deleting.elapsed() < Duration::from_secs(5), "waited {:?} for the checkout", deleting.elapsed());
    assert!(checking_out.join().unwrap().is_err(), "the checkout was stopped");
    assert!(!ws.worktree_path.exists(), "no folder");
    assert!(!run_in(&repo.path, &["branch", "--format=%(refname:short)"]).contains("brama/slow"), "no branch");
    assert!(workspaces.get(&ws.id).is_err());
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn a_base_names_a_branch_before_a_tag_and_a_remote_branch_by_its_remote_name() {
    use crate::git::test_repo::TestRepo;
    let (repo, _origin) = TestRepo::with_remote("ws-base-refs");
    let pushed = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    repo.write("local.txt", "not pushed");
    repo.git(&["add", "local.txt"]);
    repo.git(&["commit", "-qm", "local"]);
    let main = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    // Tags that shadow both names in git's own lookup order.
    repo.git(&["tag", "main", &pushed]);
    repo.git(&["tag", "origin/main", &main]);
    let data = temp_dir("ws-base-refs-data");
    let workspaces = Workspaces::new(&data);

    let on_main = workspaces.place(&repo.path, Some("On main"), Some("main")).unwrap();
    let on_remote = workspaces.create(&repo.path, "On remote", Some("origin/main")).unwrap();

    assert_eq!(on_main.base_commit, main, "the branch, not the tag");
    assert_eq!(on_remote.base_commit, pushed, "the remote branch, not the tag");
    assert_eq!(on_remote.base_branch.as_deref(), Some("origin/main"));
    let upstream = format!("{}@{{upstream}}", on_remote.branch);
    let tracked = crate::git::exec::run(&crate::git::test_repo::git_bin(), &repo.path, &crate::git::exec::args(&[&"rev-parse", &"--abbrev-ref", &upstream]), crate::git::exec::Mode::Background);
    assert!(tracked.is_err(), "its new branch has no upstream: {tracked:?}");
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn the_default_base_is_the_remote_head_when_the_remote_has_one() {
    use crate::git::test_repo::TestRepo;
    let (repo, _origin) = TestRepo::with_remote("ws-default-remote");
    repo.git(&["remote", "set-head", "origin", "main"]);
    let pushed = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    repo.write("local.txt", "not pushed");
    repo.git(&["add", "local.txt"]);
    repo.git(&["commit", "-qm", "local"]);
    let data = temp_dir("ws-default-remote-data");
    let workspaces = Workspaces::new(&data);

    let ws = workspaces.place(&repo.path, None, None).unwrap();

    assert_eq!(ws.base_branch.as_deref(), Some("origin/main"));
    assert_eq!(ws.base_commit, pushed);
    std::fs::remove_dir_all(data).unwrap();
}
