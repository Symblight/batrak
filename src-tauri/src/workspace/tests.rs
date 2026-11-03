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
