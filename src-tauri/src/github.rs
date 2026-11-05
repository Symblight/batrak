//! GitHub through the user's GitHub CLI (`gh`): who is signed in, and signing in. The app keeps no
//! token and has no OAuth app: `gh` logs in through the browser and holds the credentials.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;


const HOST: &str = "github.com";
/// How long `gh auth status` may take: it checks the token with GitHub.
const STATUS_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Account {
    /// `gh` is not installed.
    NoCli,
    SignedOut,
    SignedIn { login: String },
}

/// The `gh` executable, looked for each time so that installing it needs no restart. A GUI app on
/// macOS starts with a minimal `PATH`, so the usual install locations are tried after it.
pub fn gh() -> Option<PathBuf> {
    let name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let fallbacks: &[&str] = if cfg!(windows) {
        &["C:\\Program Files\\GitHub CLI\\gh.exe"]
    } else {
        &["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
    };
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).map(|dir| dir.join(name)).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain(fallbacks.iter().map(PathBuf::from))
        .find(|candidate| candidate.is_file())
}

/// `gh` with no questions, no colour, and no token from the environment: what the user is signed
/// in as is a question for their `gh` login, not for a variable this app happened to inherit.
fn command(gh: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(gh);
    command
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_REPO"] {
        command.env_remove(key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// What a `gh` call printed and how it ended.
struct Ran {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Runs `gh` to the end, or stops it after `timeout`.
fn run(gh: &Path, args: &[&str], timeout: Duration) -> Result<Ran, String> {
    let mut child = command(gh, args).spawn().map_err(|e| format!("failed to run gh: {e}"))?;
    // Drained on threads: a full pipe would stop gh before it exits.
    let drain = |pipe: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = std::io::Read::read_to_string(&mut pipe, &mut text);
            }
            text
        })
    };
    let (stdout, stderr) = (drain(child.stdout.take().map(boxed)), drain(child.stderr.take().map(boxed)));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("gh timed out".to_owned());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("failed to wait for gh: {e}")),
        }
    };
    Ok(Ran { success: status.success(), stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default().trim().to_owned() })
}

fn boxed(pipe: impl std::io::Read + Send + 'static) -> Box<dyn std::io::Read + Send> {
    Box::new(pipe)
}

/// Who `gh` is signed in as on github.com.
pub fn account(gh: Option<&Path>) -> Result<Account, String> {
    let Some(gh) = gh else { return Ok(Account::NoCli) };
    let ran = run(gh, &["auth", "status", "--hostname", HOST, "--json", "hosts"], STATUS_TIMEOUT)?;
    if !ran.success {
        return Err(format!("gh failed: {}", ran.stderr));
    }
    parse_account(&ran.stdout)
}

/// `{"hosts":{"github.com":[{"state":"success","active":true,"login":"x"}]}}` → the active, working
/// login. Only no account or a rejected token is "signed out"; GitHub out of reach is an error.
fn parse_account(json: &str) -> Result<Account, String> {
    let v = serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("gh answered something unexpected: {e}"))?;
    let Some(active) = v["hosts"][HOST].as_array().and_then(|accounts| accounts.iter().find(|a| a["active"] == true)) else {
        return Ok(Account::SignedOut);
    };
    let error = active["error"].as_str().unwrap_or_default();
    match (active["state"].as_str(), active["login"].as_str()) {
        (Some("success"), Some(login)) => Ok(Account::SignedIn { login: login.to_owned() }),
        (Some("error"), _) if error.is_empty() || error.contains("401") || error.to_ascii_lowercase().contains("bad credentials") => {
            Ok(Account::SignedOut)
        }
        _ => Err(format!("Couldn't reach GitHub: {}", if error.is_empty() { "no answer" } else { error })),
    }
}

/// A pull request of a branch, as the header shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `OPEN`, `MERGED` or `CLOSED`.
    pub state: String,
    pub is_draft: bool,
    /// `APPROVED`, `CHANGES_REQUESTED` or `REVIEW_REQUIRED` once reviews are asked for.
    pub review_decision: Option<String>,
    /// The latest commit's checks: `SUCCESS`, `FAILURE`, `ERROR`, `PENDING` or `EXPECTED`; `None` without any.
    pub checks: Option<String>,
    /// Names of the latest commit's checks that failed (a check run or a commit status).
    pub failed_checks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PrStatus {
    Ok,
    /// The signed-in account can't see the repository.
    NoAccess,
    /// `gh` has no working login.
    SignedOut,
    /// GitHub couldn't be reached, or answered something else.
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReply {
    pub status: PrStatus,
    pub pr: Option<PullRequest>,
    /// The repository's default branch, the base of a new pull request.
    pub default_branch: Option<String>,
    pub message: Option<String>,
}

impl PrReply {
    fn failed(status: PrStatus, message: impl Into<String>) -> PrReply {
        PrReply { status, pr: None, default_branch: None, message: Some(message.into()) }
    }
}

/// The branch's own ref, so that forks' branches with the same name (`patch-1`) don't crowd it out.
const PR_QUERY: &str = "query($owner:String!,$name:String!,$qualified:String!){repository(owner:$owner,name:$name){defaultBranchRef{name} \
    ref(qualifiedName:$qualified){associatedPullRequests(first:1,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url state isDraft \
    reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename \
    ... on CheckRun{name conclusion} ... on StatusContext{context state}}}}}}}}}}}}";

/// The newest pull request whose head is `branch` of `owner/repo`, through `gh api graphql`. The
/// variables are `gh` string arguments, never part of the query text.
pub fn pull_request(gh: &Path, owner: &str, repo: &str, branch: &str) -> Result<PrReply, String> {
    let owner_arg = format!("owner={owner}");
    let name_arg = format!("name={repo}");
    let qualified_arg = format!("qualified=refs/heads/{branch}");
    let query_arg = format!("query={PR_QUERY}");
    let args = ["api", "graphql", "-f", &owner_arg, "-f", &name_arg, "-f", &qualified_arg, "-f", &query_arg];
    let ran = run(gh, &args, STATUS_TIMEOUT)?;
    if !ran.success {
        let text = format!("{} {}", ran.stderr, ran.stdout);
        let lower = text.to_ascii_lowercase();
        let first_line = ran.stderr.lines().next().unwrap_or("gh failed").to_owned();
        return Ok(if lower.contains("not_found") || lower.contains("could not resolve to a repository") {
            PrReply::failed(PrStatus::NoAccess, first_line)
        } else if lower.contains("gh auth login") || lower.contains("http 401") || lower.contains("bad credentials") {
            PrReply::failed(PrStatus::SignedOut, first_line)
        } else {
            PrReply::failed(PrStatus::Error, first_line)
        });
    }
    Ok(parse_pull_request(&ran.stdout))
}

/// The names of the failed ones among a rollup's check runs and commit statuses.
fn failed_checks(nodes: &serde_json::Value) -> Vec<String> {
    const FAILED: &[&str] = &["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
    let nodes = nodes.as_array().map(Vec::as_slice).unwrap_or_default();
    nodes
        .iter()
        .filter_map(|n| match n["__typename"].as_str() {
            Some("CheckRun") => Some((n["name"].as_str()?, n["conclusion"].as_str()?)),
            Some("StatusContext") => Some((n["context"].as_str()?, n["state"].as_str()?)),
            _ => None,
        })
        .filter(|(_, result)| FAILED.contains(result))
        .map(|(name, _)| name.to_owned())
        .collect()
}

fn parse_pull_request(json: &str) -> PrReply {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return PrReply::failed(PrStatus::Error, "GitHub answered something unexpected");
    };
    let repo = &v["data"]["repository"];
    let text = |value: &serde_json::Value| value.as_str().map(str::to_owned);
    // No ref: the branch isn't on the remote, so it has no pull request.
    let pr = repo["ref"]["associatedPullRequests"]["nodes"].get(0).filter(|n| n.is_object());
    PrReply {
        status: PrStatus::Ok,
        default_branch: text(&repo["defaultBranchRef"]["name"]),
        message: None,
        pr: pr.map(|n| PullRequest {
            number: n["number"].as_u64().unwrap_or(0),
            title: text(&n["title"]).unwrap_or_default(),
            url: text(&n["url"]).unwrap_or_default(),
            state: text(&n["state"]).unwrap_or_default(),
            is_draft: n["isDraft"].as_bool().unwrap_or(false),
            review_decision: text(&n["reviewDecision"]),
            checks: text(&n["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"]),
            failed_checks: failed_checks(&n["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"]),
        }),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    /// A `gh` that runs `script` (shell).
    fn fake_gh(name: &str, script: &str) -> PathBuf {
        let dir = crate::git::test_repo::temp_dir(name);
        let path = dir.join("gh");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn who_is_signed_in_comes_from_gh_and_a_missing_gh_is_its_own_state() {
        let cases = [
            (r#"echo '{"hosts":{"github.com":[{"state":"success","active":true,"login":"octo"}]}}'"#, Account::SignedIn { login: "octo".into() }),
            (r#"echo '{"hosts":{"github.com":[{"state":"error","active":true,"login":"octo"}]}}'"#, Account::SignedOut),
            (r#"echo '{"hosts":{"github.com":[{"state":"success","active":false,"login":"old"},{"state":"success","active":true,"login":"new"}]}}'"#, Account::SignedIn { login: "new".into() }),
            (r#"echo '{"hosts":{}}'"#, Account::SignedOut),
            (r#"echo '{"hosts":{"github.com":[{"state":"error","error":"HTTP 401: Bad credentials (https://api.github.com/graphql)","active":true,"login":"octo"}]}}'"#, Account::SignedOut),
        ];
        for (script, expected) in cases {
            assert_eq!(account(Some(&fake_gh("account", script))).unwrap(), expected, "{script}");
        }
        // GitHub out of reach says nothing about the login: not "signed out".
        for unreachable in [
            r#"echo '{"hosts":{"github.com":[{"state":"timeout","error":"context deadline exceeded","active":true,"login":"octo"}]}}'"#,
            r#"echo '{"hosts":{"github.com":[{"state":"error","error":"dial tcp: lookup api.github.com: no such host","active":true,"login":"octo"}]}}'"#,
        ] {
            let err = account(Some(&fake_gh("account-offline", unreachable))).unwrap_err();
            assert!(err.starts_with("Couldn't reach GitHub"), "{err}");
        }
        assert_eq!(account(None).unwrap(), Account::NoCli);
        assert!(account(Some(&fake_gh("account-broken", "exit 3"))).is_err(), "gh itself failing is not 'signed out'");
    }

    #[test]
    fn a_branch_s_pull_request_is_read_from_gh_and_what_went_wrong_is_told_apart() {
        let node = |owner: &str, number: u64, state: &str, draft: bool, checks: &str| {
            format!(
                r#"{{"number":{number},"title":"T{number}","url":"https://github.com/o/r/pull/{number}","state":"{state}","isDraft":{draft},"reviewDecision":null,"headRepositoryOwner":{{"login":"{owner}"}},"commits":{{"nodes":[{{"commit":{{"statusCheckRollup":{checks}}}}}]}}}}"#
            )
        };
        let reply = |nodes: &[String]| {
            format!(r#"{{"data":{{"repository":{{"defaultBranchRef":{{"name":"main"}},"ref":{{"associatedPullRequests":{{"nodes":[{}]}}}}}}}}}}"#, nodes.join(","))
        };
        let ask = |script: String| pull_request(&fake_gh("pr", &script), "o", "r", "feature/x").unwrap();

        // None, then the newest one of the branch's ref (GitHub leaves out forks' same-named branches).
        let none = ask(format!("echo '{}'", reply(&[])));
        assert_eq!((none.status, none.pr, none.default_branch.as_deref()), (PrStatus::Ok, None, Some("main")));
        let open = ask(format!("echo '{}'", reply(&[node("o", 8, "OPEN", true, r#"{"state":"PENDING"}"#)])));
        let pr = open.pr.expect("a pull request");
        assert_eq!((pr.number, pr.is_draft, pr.checks.as_deref(), pr.state.as_str()), (8, true, Some("PENDING"), "OPEN"));
        // A branch that isn't on the remote has no ref there, so no pull request.
        let unpushed = ask(r#"echo '{"data":{"repository":{"defaultBranchRef":{"name":"main"},"ref":null}}}'"#.into());
        assert_eq!((unpushed.status, unpushed.pr, unpushed.default_branch.as_deref()), (PrStatus::Ok, None, Some("main")));

        // The variables reach gh as string arguments, the branch as its full ref name; the query asks for that ref.
        let echoing = fake_gh("pr-args", r#"for a in "$@"; do case "$a" in qualified=*|owner=*|name=*) echo "$a" >> "$0.args";; query=*ref\(qualifiedName:\$qualified\)*) echo ref-query >> "$0.args";; esac; done; echo '{"data":{"repository":{"ref":null}}}'"#);
        pull_request(&echoing, "o", "r", "feature/x y").unwrap();
        let args = std::fs::read_to_string(format!("{}.args", echoing.display())).unwrap();
        assert_eq!(args, "owner=o\nname=r\nqualified=refs/heads/feature/x y\nref-query\n");

        // Failures.
        let not_found = ask("echo \"gh: Could not resolve to a Repository with the name 'o/r'.\" >&2; exit 1".into());
        let signed_out = ask("echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4".into());
        let offline = ask("echo 'error connecting to api.github.com' >&2; exit 1".into());
        assert_eq!((not_found.status, signed_out.status, offline.status), (PrStatus::NoAccess, PrStatus::SignedOut, PrStatus::Error));
        assert_eq!(offline.message.as_deref(), Some("error connecting to api.github.com"));
    }

    #[test]
    fn a_pull_request_names_its_failed_checks() {
        let json = r#"{"data":{"repository":{"defaultBranchRef":{"name":"main"},"ref":{"associatedPullRequests":{"nodes":[{"number":9,"title":"T","url":"u","state":"OPEN","isDraft":false,"reviewDecision":null,"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE","contexts":{"nodes":[
            {"__typename":"CheckRun","name":"backend","conclusion":"FAILURE"},
            {"__typename":"CheckRun","name":"frontend","conclusion":"SUCCESS"},
            {"__typename":"CheckRun","name":"e2e","conclusion":null},
            {"__typename":"StatusContext","context":"ci/lint","state":"ERROR"},
            {"__typename":"StatusContext","context":"ci/docs","state":"SUCCESS"}
        ]}}}}]}}]}}}}}"#;
        let pr = parse_pull_request(json).pr.expect("a pull request");
        assert_eq!(pr.checks.as_deref(), Some("FAILURE"));
        assert_eq!(pr.failed_checks, ["backend", "ci/lint"]);
        assert!(PR_QUERY.contains("contexts("), "the query asks for each check");
    }

    #[test]
    fn gh_never_sees_a_token_from_the_environment() {
        let c = command(Path::new("gh"), &["auth", "status"]);
        let removed: Vec<_> = c.get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        assert!(removed.contains(&"GH_TOKEN".to_owned()) && removed.contains(&"GITHUB_TOKEN".to_owned()), "{removed:?}");
    }
}
