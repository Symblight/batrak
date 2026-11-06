//! The branches a session or a workspace can start from, and fetching the remotes' ones.

use std::path::Path;

use serde::Serialize;

use super::exec::{self, Mode};
use super::repo::info;

/// Local branches a session can start from, most recently committed first; the sessions' own
/// (`batrak/…`) are left out. Empty outside a repository or before the first commit.
pub fn branches(git: &Path, root: &Path) -> Result<Vec<String>, String> {
    if info(git, root)?.is_none() {
        return Ok(Vec::new());
    }
    local_branches(git, root)
}

/// [`branches`] for a `root` known to be in a repository.
fn local_branches(git: &Path, root: &Path) -> Result<Vec<String>, String> {
    let args = exec::args(&[&"for-each-ref", &"--sort=-committerdate", &"--format=%(refname:short)", &"refs/heads/"]);
    let out = exec::run(git, root, &args, Mode::Background)?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter(|name| !name.is_empty() && !name.starts_with(BRANCH_PREFIX))
        .map(str::to_owned)
        .collect())
}

/// Starts the name of every branch a workspace creates.
pub const BRANCH_PREFIX: &str = "batrak/";

/// Branches a workspace can be based on: local ones and each remote's remote-tracking ones, most
/// recently committed first, Batrak's own (`batrak/…`) left out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub local: Vec<String>,
    pub remotes: Vec<RemoteBranches>,
    /// What `origin/HEAD` points at (`origin/main`): the remote's default branch, as of the last fetch.
    pub default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranches {
    pub remote: String,
    /// Full short names (`origin/main`), as `git` takes them.
    pub branches: Vec<String>,
}

/// The [`BranchList`] of the repository `root` is in; empty outside one or before its first commit.
pub fn branch_list(git: &Path, root: &Path) -> Result<BranchList, String> {
    if info(git, root)?.is_none() {
        return Ok(BranchList::default());
    }
    let run = |args: &[&dyn AsRef<std::ffi::OsStr>]| exec::run(git, root, &exec::args(args), Mode::Background);
    let lines = |out: Vec<u8>| String::from_utf8_lossy(&out).lines().filter(|l| !l.is_empty()).map(str::to_owned).collect::<Vec<_>>();
    let mut names = lines(run(&[&"remote"])?);
    // The longest name first: `team/b/main` is `team/b`'s, not `team`'s.
    names.sort_by_key(|n| std::cmp::Reverse(n.len()));
    let mut remotes: Vec<RemoteBranches> = Vec::new();
    for refname in lines(run(&[&"for-each-ref", &"--sort=-committerdate", &"--format=%(refname)", &"refs/remotes/"])?) {
        let Some(short) = refname.strip_prefix("refs/remotes/") else { continue };
        let Some(remote) = names.iter().find(|n| short.strip_prefix(n.as_str()).is_some_and(|rest| rest.starts_with('/'))) else { continue };
        let branch = &short[remote.len() + 1..];
        if branch == "HEAD" || branch.starts_with(BRANCH_PREFIX) {
            continue;
        }
        match remotes.iter_mut().find(|r| &r.remote == remote) {
            Some(r) => r.branches.push(short.to_owned()),
            None => remotes.push(RemoteBranches { remote: remote.clone(), branches: vec![short.to_owned()] }),
        }
    }
    remotes.sort_by(|a, b| a.remote.cmp(&b.remote));
    let default = run(&[&"symbolic-ref", &"-q", &"--short", &"refs/remotes/origin/HEAD"]).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned());
    Ok(BranchList { local: local_branches(git, root)?, remotes, default: default.filter(|d| !d.is_empty()) })
}

/// Fetches every remote, pruning remote-tracking branches deleted there. Not under
/// `lock::with_mutation`: it touches only `refs/remotes/*` and `FETCH_HEAD`, under git's own ref
/// locks, and holding the lock over the network would stall every commit and `worktree add` meanwhile.
pub fn fetch(git: &Path, root: &Path) -> Result<(), String> {
    let args = exec::args(&[&"fetch", &"--all", &"--prune", &"--quiet"]);
    exec::run(git, root, &args, Mode::Network).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::{git_bin, temp_dir, TestRepo};

    #[test]
    fn branch_list_has_local_branches_and_each_remotes_with_the_remote_default() {
        let git = git_bin();
        let dir = temp_dir("branch-list-none");
        assert_eq!(branch_list(&git, &dir).unwrap(), BranchList::default(), "outside a repository");
        let (repo, _bare) = TestRepo::with_remote("branch-list");
        repo.git(&["branch", "feature/x"]);
        repo.git(&["branch", "batrak/task"]);
        repo.git(&["push", "-q", "origin", "feature/x", "batrak/task"]);
        // A remote whose name has a slash: its branches are its own, not `team`'s.
        repo.git(&["remote", "add", "team/b", _bare.to_str().unwrap()]);
        repo.git(&["fetch", "-q", "team/b"]);
        repo.git(&["remote", "set-head", "origin", "main"]);

        let mut list = branch_list(&git, &repo.path).unwrap();
        list.local.sort();
        for remote in &mut list.remotes {
            remote.branches.sort();
        }

        assert_eq!(list.local, ["feature/x", "main"]);
        assert_eq!(
            list.remotes,
            [
                RemoteBranches { remote: "origin".into(), branches: vec!["origin/feature/x".into(), "origin/main".into()] },
                RemoteBranches { remote: "team/b".into(), branches: vec!["team/b/feature/x".into(), "team/b/main".into()] },
            ]
        );
        assert_eq!(list.default.as_deref(), Some("origin/main"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_remote_named_like_the_ref_prefix_keeps_its_whole_name() {
        let (repo, bare) = TestRepo::with_remote("branch-list-odd-remote");
        repo.git(&["remote", "add", "refs/remotes/x", bare.to_str().unwrap()]);
        repo.git(&["fetch", "-q", "refs/remotes/x"]);

        let list = branch_list(&git_bin(), &repo.path).unwrap();

        assert!(
            list.remotes.contains(&RemoteBranches { remote: "refs/remotes/x".into(), branches: vec!["refs/remotes/x/main".into()] }),
            "{:?}",
            list.remotes
        );
    }

    #[test]
    fn fetch_brings_new_remote_branches_and_prunes_deleted_ones() {
        let git = git_bin();
        let (repo, bare) = TestRepo::with_remote("fetch");
        repo.git(&["push", "-q", "origin", "main:gone"]);
        let other = temp_dir("fetch-other");
        crate::git::test_repo::run_in(&other, &["clone", "-q", bare.to_str().unwrap(), "."]);
        crate::git::test_repo::run_in(&other, &["push", "-q", "origin", "main:fresh", ":gone"]);

        fetch(&git, &repo.path).unwrap();

        let list = branch_list(&git, &repo.path).unwrap();
        let mut remote = list.remotes[0].branches.clone();
        remote.sort();
        assert_eq!(remote, ["origin/fresh", "origin/main"]);
        std::fs::remove_dir_all(other).unwrap();
    }

    #[test]
    fn branches_to_start_a_session_from_leave_out_session_branches() {
        let git = git_bin();
        let dir = temp_dir("branches-none");
        assert!(branches(&git, &dir).unwrap().is_empty(), "outside a repository");
        assert!(branches(&git, &TestRepo::new("branches-empty").path).unwrap().is_empty(), "before the first commit");
        let repo = TestRepo::with_commit("branches");
        for branch in ["feature/x", "batrak/session-1234"] {
            repo.git(&["branch", branch]);
        }
        let mut names = branches(&git, &repo.path).unwrap();
        names.sort();
        assert_eq!(names, ["feature/x", "main"]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
