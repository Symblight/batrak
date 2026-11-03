//! The remote a branch syncs with: its name, URL and, for github.com, owner and repository.

use std::path::Path;

use serde::Serialize;

use super::exec::{self, Mode};

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

/// Reads the remote `branch` syncs with: its upstream's, else the one a push would publish to
/// (`pushRemote`, `pushDefault`), else the only one, else `origin`; `None` without remotes.
pub fn read(git: &Path, root: &Path, branch: Option<&str>) -> Result<Option<RemoteInfo>, String> {
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
    if urls.is_empty() {
        return Ok(None);
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
    Ok(Some(RemoteInfo { github: parse_github(url), url: strip_credentials(url), name }))
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

    use crate::git::test_repo::{git_bin, TestRepo};

    fn remote_of(repo: &TestRepo) -> Option<RemoteInfo> {
        let branch = repo.git(&["symbolic-ref", "-q", "--short", "HEAD"]);
        read(&git_bin(), &repo.path, Some(branch.trim())).unwrap()
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
        assert_eq!(remote_of(&bare_repo), None);

        // A tracking branch: its upstream's remote.
        let (repo, origin) = TestRepo::with_remote("remote-tracking");
        let remote = remote_of(&repo).expect("a remote");
        assert_eq!(remote.name, "origin");
        assert_eq!(remote.url, origin.to_str().unwrap());
        assert_eq!(remote.github, None);

        // Not tracking: the remote a push would use, here the only one.
        repo.git(&["switch", "-q", "-c", "topic"]);
        assert_eq!(remote_of(&repo).map(|r| r.name), Some("origin".to_owned()));

        // Several remotes and no upstream: `pushRemote` wins over the `origin` fallback.
        repo.git(&["remote", "add", "fork", "https://tok@github.com/me/app.git"]);
        assert_eq!(remote_of(&repo).map(|r| r.name), Some("origin".to_owned()));
        repo.git(&["config", "branch.topic.pushRemote", "fork"]);
        let fork = remote_of(&repo).expect("a remote");
        assert_eq!(fork.name, "fork");
        assert_eq!(fork.url, "https://github.com/me/app.git", "token dropped");
        assert_eq!(fork.github, Some(GithubRepo { owner: "me".into(), repo: "app".into() }));
    }
}
