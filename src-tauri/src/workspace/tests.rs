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
