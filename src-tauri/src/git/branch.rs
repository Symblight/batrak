//! The branches of a repository for the header's branch popover, and switching between them.

use std::path::Path;

use serde::Serialize;

use super::exec::{self, Mode};
use super::lock::with_mutation;
use super::repo;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub name: String,
    pub current: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Unix ms of the branch's last commit.
    pub committed_at: u64,
}

/// A branch on a remote that has no local branch of the same name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    pub remote: String,
    /// Without the remote's name: what `git switch` takes to create the tracking branch.
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    /// Most recently committed first.
    pub local: Vec<LocalBranch>,
    pub remote: Vec<RemoteBranch>,
}

/// Every local branch (the sessions' own `brama/…` too) with its counts against its upstream, and the
/// remote branches nobody has checked out yet. Empty outside a repository or before the first commit.
pub fn list(git: &Path, root: &Path) -> Result<BranchList, String> {
    let mut list = BranchList { local: Vec::new(), remote: Vec::new() };
    if repo::info(git, root)?.is_none() {
        return Ok(list);
    }
    let refs = |format: &str, namespace: &str, sort: &str| {
        let format = format!("--format={format}");
        let out = exec::run(git, root, &exec::args(&[&"for-each-ref", &sort, &format, &namespace]), Mode::Background)?;
        Ok::<_, String>(String::from_utf8_lossy(&out).into_owned())
    };
    let local = refs("%(refname:short)%00%(HEAD)%00%(upstream:track,nobracket)%00%(committerdate:unix)", "refs/heads/", "--sort=-committerdate")?;
    list.local = local.lines().filter_map(parse_local).collect();
    // The full name: the short one of `origin/HEAD` is just `origin`.
    let remote = refs("%(refname)", "refs/remotes/", "--sort=refname")?;
    list.remote = remote
        .lines()
        .filter_map(|line| line.strip_prefix("refs/remotes/")?.split_once('/'))
        .filter(|(_, name)| *name != "HEAD" && !list.local.iter().any(|b| b.name == *name))
        .map(|(remote, name)| RemoteBranch { remote: remote.to_owned(), name: name.to_owned() })
        .collect();
    Ok(list)
}

/// `name\0*\0ahead 1, behind 2\0unix seconds`; `*` marks the checked-out branch.
fn parse_local(line: &str) -> Option<LocalBranch> {
    let mut fields = line.split('\0');
    let (name, head, track, date) = (fields.next()?, fields.next()?, fields.next()?, fields.next()?);
    let (ahead, behind) = repo::parse_track(track);
    Some(LocalBranch {
        name: name.to_owned(),
        current: head == "*",
        ahead,
        behind,
        committed_at: date.parse::<u64>().unwrap_or(0) * 1000,
    })
}

/// Switches the checkout to `branch`, or with `create` makes it from HEAD first. With `remote`, makes
/// `branch` a local branch tracking `<remote>/<branch>`; without it, a name that exists only on one
/// remote becomes a local branch tracking it. Git's refusal (local changes a switch would overwrite,
/// a branch checked out in a worktree) is the error.
pub fn switch(git: &Path, root: &Path, branch: &str, create: bool, remote: Option<&str>) -> Result<(), String> {
    for name in std::iter::once(branch).chain(remote) {
        if name.is_empty() || name.starts_with('-') {
            return Err(format!("Not a branch name: {name:?}"));
        }
    }
    let tracked = remote.map(|remote| format!("{remote}/{branch}"));
    let words: Vec<&str> = match (&tracked, create) {
        (Some(tracked), _) => vec!["switch", "-c", branch, "--track", tracked],
        (None, true) => vec!["switch", "-c", branch],
        (None, false) => vec!["switch", branch],
    };
    let args: Vec<&std::ffi::OsStr> = words.iter().map(std::ffi::OsStr::new).collect();
    // Checking out runs `post-checkout` and LFS filters, like a pull.
    with_mutation(git, root, || {
        let out = exec::run_with(git, root, &args, Mode::Hooks, &Default::default())?;
        if out.success() { Ok(()) } else { Err(exec::failure_message(&out)) }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::{git_bin, temp_dir, TestRepo};

    fn names(list: &BranchList) -> Vec<&str> {
        list.local.iter().map(|b| b.name.as_str()).collect()
    }

    fn current(root: &Path) -> String {
        crate::git::repo::head(&git_bin(), root).unwrap().unwrap().branch.unwrap()
    }

    #[test]
    fn lists_local_branches_newest_first_with_the_current_one_and_its_counts() {
        // Arrange: main is ahead of its upstream by one commit; two more branches, the newest last.
        let (repo, _origin) = TestRepo::with_remote("branch-list");
        repo.write("a.txt", "a");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "ahead"]);
        repo.git(&["switch", "-qc", "feature/x"]);
        repo.git(&["switch", "-qc", "brama/session-1"]);
        repo.git(&["switch", "-q", "main"]);

        // Act
        let list = list(&git_bin(), &repo.path).unwrap();

        // Assert: session branches are kept; the current branch is marked and has its counts.
        let mut sorted = names(&list);
        sorted.sort();
        assert_eq!(sorted, ["brama/session-1", "feature/x", "main"]);
        let main = list.local.iter().find(|b| b.name == "main").unwrap();
        assert_eq!((main.current, main.ahead, main.behind), (true, 1, 0));
        assert!(list.local.iter().filter(|b| b.current).count() == 1);
        assert!(list.local.windows(2).all(|w| w[0].committed_at >= w[1].committed_at), "newest first");
        assert!(main.committed_at > 0);
    }

    #[test]
    fn remote_branches_are_listed_only_until_a_local_branch_has_their_name() {
        // Arrange: a second clone pushes two branches; one of them gets a local branch here.
        let (repo, origin) = TestRepo::with_remote("branch-remote");
        let other = temp_dir("branch-remote-clone");
        crate::git::test_repo::run_in(&other, &["clone", "-q", origin.to_str().unwrap(), "."]);
        for branch in ["feature/a", "feature/b"] {
            crate::git::test_repo::run_in(&other, &["push", "-q", "origin", &format!("HEAD:refs/heads/{branch}")]);
        }
        repo.git(&["fetch", "-q"]);
        repo.git(&["branch", "feature/a", "origin/feature/a"]);

        // Act
        let list = list(&git_bin(), &repo.path).unwrap();

        // Assert: no origin/HEAD, no origin/main (main is local), no origin/feature/a.
        assert_eq!(list.remote, [RemoteBranch { remote: "origin".into(), name: "feature/b".into() }]);
    }

    #[test]
    fn no_branches_before_the_first_commit_or_outside_a_repository() {
        let empty = TestRepo::new("branch-empty");
        assert_eq!(list(&git_bin(), &empty.path).unwrap(), BranchList { local: vec![], remote: vec![] });
        let plain = temp_dir("branch-plain");
        assert_eq!(list(&git_bin(), &plain).unwrap(), BranchList { local: vec![], remote: vec![] });
    }

    #[test]
    fn switching_moves_to_a_branch_makes_a_new_one_and_tracks_a_remote_one() {
        // Arrange
        let (repo, origin) = TestRepo::with_remote("branch-switch");
        let other = temp_dir("branch-switch-clone");
        crate::git::test_repo::run_in(&other, &["clone", "-q", origin.to_str().unwrap(), "."]);
        crate::git::test_repo::run_in(&other, &["push", "-q", "origin", "HEAD:refs/heads/remote-only"]);
        repo.git(&["fetch", "-q"]);
        repo.git(&["branch", "existing"]);
        let (git, root) = (git_bin(), repo.path.as_path());

        // Act + Assert
        switch(&git, root, "existing", false, None).unwrap();
        assert_eq!(current(root), "existing");
        switch(&git, root, "fresh", true, None).unwrap();
        assert_eq!(current(root), "fresh");
        switch(&git, root, "remote-only", false, None).unwrap();
        assert_eq!(current(root), "remote-only");
        let tracking = crate::git::repo::head(&git, root).unwrap().unwrap();
        assert_eq!(tracking.upstream.as_deref(), Some("origin/remote-only"));
    }

    #[test]
    fn a_remote_branch_two_remotes_have_is_tracked_from_the_one_picked() {
        // Arrange: `origin` and `fork` both have `shared`, from different commits
        let (repo, origin) = TestRepo::with_remote("branch-two-remotes");
        let fork = temp_dir("branch-two-remotes-fork");
        crate::git::test_repo::run_in(&fork, &["clone", "-q", "--bare", origin.to_str().unwrap(), "."]);
        repo.git(&["push", "-q", "origin", "HEAD:refs/heads/shared"]);
        repo.write("f.txt", "fork");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "fork only"]);
        repo.git(&["remote", "add", "fork", fork.to_str().unwrap()]);
        repo.git(&["push", "-q", "fork", "HEAD:refs/heads/shared"]);
        repo.git(&["reset", "-q", "--hard", "HEAD~1"]);
        repo.git(&["fetch", "-q", "--all"]);
        let (git, root) = (git_bin(), repo.path.as_path());

        // Act
        switch(&git, root, "shared", false, Some("fork")).unwrap();

        // Assert: the fork's branch, tracked
        let state = crate::git::repo::head(&git, root).unwrap().unwrap();
        assert_eq!((state.branch.as_deref(), state.upstream.as_deref()), (Some("shared"), Some("fork/shared")));
        assert!(root.join("f.txt").exists(), "the fork's commit is checked out");
        assert!(switch(&git, root, "shared", false, Some("-x")).is_err(), "no option for a remote");
        let _ = std::fs::remove_dir_all(&fork);
    }

    #[test]
    fn a_switch_git_refuses_says_why_and_stays_put() {
        // Arrange: a local change to a file that differs on the other branch.
        let repo = TestRepo::with_commit("branch-refused");
        repo.git(&["switch", "-qc", "other"]);
        repo.write("README.md", "other\n");
        repo.git(&["commit", "-qam", "other"]);
        repo.git(&["switch", "-q", "main"]);
        repo.write("README.md", "local edit\n");

        // Act
        let err = switch(&git_bin(), &repo.path, "other", false, None).unwrap_err();

        // Assert
        assert!(err.contains("README.md"), "{err}");
        assert_eq!(current(&repo.path), "main");
        assert!(switch(&git_bin(), &repo.path, "nope", false, None).is_err());
    }
}
