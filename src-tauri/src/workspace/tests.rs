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
        last_active_at: None,
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
    let ws = workspaces.place(&repo.path, "First", NameSource::Agent, None).unwrap();

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
