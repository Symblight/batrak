//! The remote a branch syncs with: its name, URL and, for github.com, owner and repository.

use std::ffi::OsStr;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::exec::{self, Mode, Options};
use super::lock;
use super::repo::{RepoInfo, RepoState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    /// Credentials of an http(s) URL are dropped before it leaves the backend.
    pub url: String,
    pub github: Option<GithubRepo>,
}

/// What the header needs of the remotes; `remote` is `None` when the repository has none.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Remotes {
    pub remote: Option<RemoteInfo>,
    pub has_remotes: bool,
    /// Unix ms of the last fetch (`FETCH_HEAD`'s mtime).
    pub fetched_at: Option<u64>,
}

/// Reads the remote `branch` syncs with: its upstream's, else the one a push would publish to
/// (`pushRemote`, `pushDefault`), else the only one, else `origin`.
pub fn read(git: &Path, root: &Path, info: &RepoInfo, branch: Option<&str>) -> Result<Remotes, String> {
    let out = exec::run_with(
        git,
        root,
        &exec::args(&[&"config", &"--get-regexp", &r"^remote\..*\.url$"]),
        Mode::Background,
        &Default::default(),
    )?;
    // Exit 1 is "no such key": no remotes.
    let text = if out.success() { out.stdout_str()?.to_owned() } else { String::new() };
    let urls: Vec<(String, String)> = text
        .lines()
        .filter_map(|line| {
            let (key, url) = line.split_once(' ')?;
            let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
            Some((name.to_owned(), url.to_owned()))
        })
        .collect();
    let fetched_at = std::fs::metadata(info.common_dir.join("FETCH_HEAD"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_millis()).ok());
    if urls.is_empty() {
        return Ok(Remotes { remote: None, has_remotes: false, fetched_at });
    }

    let name = match branch {
        Some(branch) => {
            let reference = format!("refs/heads/{branch}");
            let out = exec::run_with(
                git,
                root,
                &exec::args(&[&"for-each-ref", &"--format=%(upstream:remotename)%00%(push:remotename)", &reference]),
                Mode::Background,
                &Default::default(),
            )?;
            let line = out.stdout_str()?.trim_end_matches('\n');
            let (upstream, push) = line.split_once('\0').unwrap_or((line, ""));
            let found = [upstream, push].into_iter().find(|n| urls.iter().any(|(name, _)| name == n)).map(str::to_owned);
            found
        }
        None => None,
    };
    let name = name
        .or_else(|| (urls.len() == 1).then(|| urls[0].0.clone()))
        .or_else(|| urls.iter().find(|(n, _)| n == "origin").map(|(n, _)| n.clone()))
        .unwrap_or_else(|| urls[0].0.clone());
    let url = urls.iter().find(|(n, _)| *n == name).map(|(_, u)| u.as_str()).unwrap_or_default();
    Ok(Remotes {
        remote: Some(RemoteInfo { github: parse_github(url), url: strip_credentials(url), name }),
        has_remotes: true,
        fetched_at,
    })
}


/// What the remote chip can run. A pull only fast-forwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteOp {
    Fetch,
    Pull,
    Push,
    /// First push of a branch: `push -u`.
    Publish,
}

/// Why a remote operation failed, from git's message; the frontend offers what fits each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    Auth,
    /// The remote has commits the branch lacks (push).
    Rejected,
    /// The branches diverged (pull).
    NotFastForward,
    Conflict,
    /// Local changes a pull would overwrite.
    Dirty,
    Network,
    NotFound,
    Timeout,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteError {
    pub kind: FailureKind,
    /// The tail of git's message, without credentials.
    pub message: String,
}

impl RemoteError {
    pub fn other(message: impl Into<String>) -> RemoteError {
        RemoteError { kind: FailureKind::Other, message: message.into() }
    }
}

/// Runs `op` for the branch `state` describes. Pull and publish change local state, so they hold
/// the repository's mutation lock; fetch and push can take minutes and must not hold up a commit.
pub fn run(git: &Path, root: &Path, op: RemoteOp, state: &RepoState) -> Result<(), RemoteError> {
    let Some(branch) = state.branch.as_deref() else { return Err(RemoteError::other("HEAD is detached: there is no branch to sync")) };
    let Some(remote) = state.remote.as_ref().map(|r| r.name.as_str()) else {
        return Err(RemoteError::other("This repository has no remote"));
    };
    if matches!(op, RemoteOp::Pull | RemoteOp::Push) && state.upstream.is_none() {
        return Err(RemoteError::other(format!("Branch {branch} has no upstream: publish it first")));
    }
    let publish_ref = format!("HEAD:refs/heads/{branch}");
    let (args, mode): (Vec<&str>, Mode) = match op {
        RemoteOp::Fetch => (vec!["fetch", "--prune", remote], Mode::Remote),
        RemoteOp::Pull => (vec!["pull", "--ff-only"], Mode::Hooks),
        RemoteOp::Push => (vec!["push"], Mode::Remote),
        RemoteOp::Publish => (vec!["push", "-u", remote, &publish_ref], Mode::Remote),
    };
    let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
    let go = || {
        let opts = Options { env: &[("GCM_INTERACTIVE", OsStr::new("never"))], ..Default::default() };
        Ok(match exec::run_with(git, root, &args, mode, &opts) {
            Ok(out) if out.success() => Ok(()),
            Ok(out) => Err(RemoteError { kind: classify(&out.stderr), message: tail(&out.stderr) }),
            Err(e) if e.contains("timed out") => Err(RemoteError { kind: FailureKind::Timeout, message: e }),
            Err(e) => Err(RemoteError::other(e)),
        })
    };
    let result = if matches!(op, RemoteOp::Pull | RemoteOp::Publish) { lock::with_mutation(git, root, go) } else { go() };
    result.map_err(RemoteError::other)?
}

/// The kind of failure git's English message (`LC_ALL=C`) tells of.
pub fn classify(stderr: &str) -> FailureKind {
    let text = stderr.to_ascii_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
    // Order matters: "unable to access" comes with 401, 403 and 404 as well as with a dead network.
    if any(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "permission denied (publickey",
        "invalid username or password",
        "returned error: 401",
        "returned error: 403",
    ]) {
        FailureKind::Auth
    } else if any(&["repository not found", "does not appear to be a git repository", "returned error: 404"]) {
        FailureKind::NotFound
    } else if any(&["! [rejected]", "fetch first", "non-fast-forward", "stale info"]) {
        FailureKind::Rejected
    } else if any(&["not possible to fast-forward", "can't be fast-forwarded", "diverging branches"]) {
        FailureKind::NotFastForward
    } else if any(&["conflict", "could not apply", "automatic merge failed"]) {
        FailureKind::Conflict
    } else if any(&["would be overwritten", "please commit your changes or stash"]) {
        FailureKind::Dirty
    } else if any(&[
        "could not resolve host",
        "connection refused",
        "connection timed out",
        "network is unreachable",
        "could not connect",
        "failed to connect",
        "unable to access",
    ]) {
        FailureKind::Network
    } else {
        FailureKind::Other
    }
}

/// The last 20 lines of git's message, with the credentials of any URL in it dropped.
fn tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().collect();
    let kept = lines[lines.len().saturating_sub(20)..].join("\n");
    scrub_urls(&kept)
}

/// `https://user:secret@host/x` → `https://host/x` anywhere in `text`.
fn scrub_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"').unwrap_or(tail.len());
        let authority = &tail[..end];
        out.push_str(authority.rsplit_once('@').map_or(authority, |(_, host)| host));
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// `https://user:token@host/…` → `https://host/…`; other URLs (`git@host:…`, paths) are kept.
fn strip_credentials(url: &str) -> String {
    for scheme in ["https://", "http://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            let (authority, path) = rest.split_once('/').map_or((rest, None), |(a, p)| (a, Some(p)));
            let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
            return match path {
                Some(path) => format!("{scheme}{host}/{path}"),
                None => format!("{scheme}{host}"),
            };
        }
    }
    url.to_owned()
}

/// Owner and repository of a github.com URL (https, `git@github.com:`, `ssh://`, `git://`);
/// `None` for any other host.
pub fn parse_github(url: &str) -> Option<GithubRepo> {
    let url = url.trim();
    let path = if let Some(rest) = url.strip_prefix("git@github.com:") {
        rest
    } else {
        let (_, rest) = url.split_once("://")?;
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = host.split(':').next()?.to_ascii_lowercase();
        if host != "github.com" && host != "ssh.github.com" && host != "www.github.com" {
            return None;
        }
        path
    };
    let mut parts = path.trim_end_matches('/').splitn(3, '/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    (!owner.is_empty() && !repo.is_empty()).then(|| GithubRepo { owner: owner.to_owned(), repo: repo.to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use crate::git::repo;
    use crate::git::test_repo::{git_bin, TestRepo};

    fn remotes_of(repo: &TestRepo) -> Remotes {
        let git = git_bin();
        let info = repo::info(&git, &repo.path).unwrap().unwrap();
        let branch = repo.git(&["symbolic-ref", "-q", "--short", "HEAD"]);
        read(&git, &repo.path, &info, Some(branch.trim())).unwrap()
    }

    #[test]
    fn github_urls_in_every_form() {
        let gh = |o: &str, r: &str| Some(GithubRepo { owner: o.into(), repo: r.into() });
        let cases = [
            ("https://github.com/acme/app.git", gh("acme", "app")),
            ("https://github.com/acme/app", gh("acme", "app")),
            ("https://user:tok@github.com/acme/app.git", gh("acme", "app")),
            ("git@github.com:acme/app.git", gh("acme", "app")),
            ("ssh://git@github.com/acme/app.git", gh("acme", "app")),
            ("ssh://git@ssh.github.com:443/acme/app.git", gh("acme", "app")),
            ("git://github.com/acme/app.git", gh("acme", "app")),
            ("HTTPS://GitHub.com/acme/app/", gh("acme", "app")),
            ("https://gitlab.com/acme/app.git", None),
            ("https://github.com.evil.test/acme/app.git", None),
            ("https://github.com/acme", None),
            ("/srv/git/app.git", None),
        ];
        for (url, expected) in cases {
            assert_eq!(parse_github(url), expected, "{url}");
        }
    }

    #[test]
    fn credentials_leave_http_urls_only_when_stripped() {
        assert_eq!(strip_credentials("https://u:t@github.com/a/b.git"), "https://github.com/a/b.git");
        assert_eq!(strip_credentials("https://tok@github.com"), "https://github.com");
        assert_eq!(strip_credentials("git@github.com:a/b.git"), "git@github.com:a/b.git");
    }

    #[test]
    fn a_branch_reports_the_remote_it_syncs_with() {
        // No remote at all.
        let bare_repo = TestRepo::with_commit("remote-none");
        assert_eq!(remotes_of(&bare_repo), Remotes::default());

        // A tracking branch: its upstream's remote; FETCH_HEAD is absent until the first fetch.
        let (repo, origin) = TestRepo::with_remote("remote-tracking");
        let state = remotes_of(&repo);
        let remote = state.remote.expect("a remote");
        assert_eq!((remote.name.as_str(), state.has_remotes), ("origin", true));
        assert_eq!(remote.url, origin.to_str().unwrap());
        assert_eq!((remote.github, state.fetched_at), (None, None));
        repo.git(&["fetch", "-q"]);
        assert!(remotes_of(&repo).fetched_at.is_some(), "a fetch is dated");

        // Not tracking: the remote a push would use, here the only one.
        repo.git(&["switch", "-q", "-c", "topic"]);
        assert_eq!(remotes_of(&repo).remote.map(|r| r.name), Some("origin".to_owned()));

        // Several remotes and no upstream: `pushRemote` wins over the `origin` fallback.
        repo.git(&["remote", "add", "fork", "https://tok@github.com/me/app.git"]);
        assert_eq!(remotes_of(&repo).remote.map(|r| r.name), Some("origin".to_owned()));
        repo.git(&["config", "branch.topic.pushRemote", "fork"]);
        let fork = remotes_of(&repo).remote.expect("a remote");
        assert_eq!(fork.name, "fork");
        assert_eq!(fork.url, "https://github.com/me/app.git", "token dropped");
        assert_eq!(fork.github, Some(GithubRepo { owner: "me".into(), repo: "app".into() }));
    }

    /// A second clone of `origin`, to move the remote from outside the repository under test.
    fn clone_of(origin: &Path, name: &str) -> PathBuf {
        let parent = crate::git::test_repo::temp_dir(name);
        crate::git::test_repo::run_in(&parent, &["clone", "-q", origin.to_str().unwrap(), "other"]);
        parent.join("other")
    }

    fn state_of(repo: &TestRepo) -> RepoState {
        let git = git_bin();
        let info = repo::info(&git, &repo.path).unwrap().unwrap();
        repo::head_in(&git, &repo.path, &info).unwrap()
    }

    fn run_op(repo: &TestRepo, op: RemoteOp) -> Result<(), RemoteError> {
        run(&git_bin(), &repo.path, op, &state_of(repo))
    }

    #[test]
    fn push_fetch_and_pull_move_commits_between_a_branch_and_its_remote() {
        let (repo, origin) = TestRepo::with_remote("ops");

        // Ahead: a push empties the counter, and the remote has the commit.
        repo.write("a.txt", "a");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "local"]);
        assert_eq!(state_of(&repo).ahead, 1);
        run_op(&repo, RemoteOp::Push).unwrap();
        assert_eq!(state_of(&repo).ahead, 0);
        assert!(crate::git::test_repo::run_in(&origin, &["log", "--format=%s", "main"]).contains("local"));

        // Behind: only a fetch tells; a fast-forward pull brings the commit in.
        let other = clone_of(&origin, "ops-other");
        std::fs::write(other.join("b.txt"), "b").unwrap();
        crate::git::test_repo::run_in(&other, &["add", "."]);
        crate::git::test_repo::run_in(&other, &["commit", "-qm", "remote"]);
        crate::git::test_repo::run_in(&other, &["push", "-q"]);
        assert_eq!(state_of(&repo).behind, 0, "unseen until fetched");
        run_op(&repo, RemoteOp::Fetch).unwrap();
        assert_eq!(state_of(&repo).behind, 1);
        run_op(&repo, RemoteOp::Pull).unwrap();
        assert_eq!((state_of(&repo).behind, repo.path.join("b.txt").exists()), (0, true));
    }

    #[test]
    fn publish_sets_the_upstream_of_a_new_branch() {
        let (repo, _origin) = TestRepo::with_remote("publish");
        repo.git(&["switch", "-q", "-c", "topic"]);
        assert_eq!(state_of(&repo).upstream, None);
        run_op(&repo, RemoteOp::Publish).unwrap();
        assert_eq!(state_of(&repo).upstream.as_deref(), Some("origin/topic"));
    }

    #[test]
    fn a_diverged_branch_is_neither_pushed_nor_fast_forwarded() {
        let (repo, origin) = TestRepo::with_remote("diverged");
        let other = clone_of(&origin, "diverged-other");
        std::fs::write(other.join("b.txt"), "b").unwrap();
        crate::git::test_repo::run_in(&other, &["add", "."]);
        crate::git::test_repo::run_in(&other, &["commit", "-qm", "remote"]);
        crate::git::test_repo::run_in(&other, &["push", "-q"]);
        repo.write("a.txt", "a");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "local"]);

        let rejected = run_op(&repo, RemoteOp::Push).unwrap_err();
        assert_eq!(rejected.kind, FailureKind::Rejected, "{}", rejected.message);
        run_op(&repo, RemoteOp::Fetch).unwrap();
        let diverged = run_op(&repo, RemoteOp::Pull).unwrap_err();
        assert_eq!(diverged.kind, FailureKind::NotFastForward, "{}", diverged.message);
        assert!(!repo.path.join("b.txt").exists(), "nothing was merged");
    }

    #[test]
    fn what_cannot_run_says_why_and_a_dead_remote_leaks_no_credentials() {
        let (repo, _origin) = TestRepo::with_remote("failures");
        repo.git(&["switch", "-q", "-c", "topic"]);
        let no_upstream = run_op(&repo, RemoteOp::Push).unwrap_err();
        assert_eq!(no_upstream.kind, FailureKind::Other);
        assert!(no_upstream.message.contains("no upstream"), "{}", no_upstream.message);

        let no_remote = TestRepo::with_commit("failures-none");
        assert_eq!(run_op(&no_remote, RemoteOp::Fetch).unwrap_err().message, "This repository has no remote");
        repo.git(&["switch", "-q", "--detach"]);
        assert!(run_op(&repo, RemoteOp::Fetch).unwrap_err().message.contains("detached"));

        repo.git(&["switch", "-q", "main"]);
        repo.git(&["remote", "set-url", "origin", "http://user:secret@127.0.0.1:1/x.git"]);
        let dead = run_op(&repo, RemoteOp::Fetch).unwrap_err();
        assert_eq!(dead.kind, FailureKind::Network, "{}", dead.message);
        assert!(!dead.message.contains("secret"), "{}", dead.message);

        repo.git(&["remote", "set-url", "origin", "/nonexistent/repo.git"]);
        assert_eq!(run_op(&repo, RemoteOp::Fetch).unwrap_err().kind, FailureKind::NotFound);
    }

    #[test]
    fn failures_are_told_apart_by_git_s_message() {
        let cases = [
            ("fatal: Authentication failed for 'https://github.com/a/b.git/'", FailureKind::Auth),
            ("fatal: could not read Username for 'https://github.com': terminal prompts disabled", FailureKind::Auth),
            ("git@github.com: Permission denied (publickey).", FailureKind::Auth),
            ("fatal: unable to access 'https://h/x.git/': The requested URL returned error: 403", FailureKind::Auth),
            ("fatal: unable to access 'https://h/x.git/': The requested URL returned error: 404", FailureKind::NotFound),
            ("ERROR: Repository not found.", FailureKind::NotFound),
            (" ! [rejected]        main -> main (fetch first)", FailureKind::Rejected),
            (" ! [rejected]        main -> main (non-fast-forward)", FailureKind::Rejected),
            (" ! [remote rejected] main -> main (pre-receive hook declined)", FailureKind::Other),
            ("fatal: Not possible to fast-forward, aborting.", FailureKind::NotFastForward),
            ("CONFLICT (content): Merge conflict in a.txt", FailureKind::Conflict),
            ("error: Your local changes to the following files would be overwritten by merge:", FailureKind::Dirty),
            ("fatal: unable to access 'https://h/x.git/': Could not resolve host: h", FailureKind::Network),
            ("ssh: connect to host h port 22: Connection timed out", FailureKind::Network),
            ("something unexpected", FailureKind::Other),
        ];
        for (stderr, kind) in cases {
            assert_eq!(classify(stderr), kind, "{stderr}");
        }
        assert_eq!(scrub_urls("fatal: unable to access 'https://u:p@h.test/x.git/': no"), "fatal: unable to access 'https://h.test/x.git/': no");
    }
}
