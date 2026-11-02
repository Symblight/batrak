//! GitHub through the user's GitHub CLI (`gh`): who is signed in, and signing in. The app keeps no
//! token and has no OAuth app: `gh` logs in through the browser and holds the credentials.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;

const HOST: &str = "github.com";
/// How long `gh auth status` may take: it checks the token with GitHub.
const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
/// How long `gh auth login` may print nothing before it is given up on (it changed, or wants a terminal).
const CODE_TIMEOUT: Duration = Duration::from_secs(10);
/// GitHub's one-time code lives 15 minutes.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

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

/// Who `gh` is signed in as on github.com.
pub fn account(gh: Option<&Path>) -> Result<Account, String> {
    let Some(gh) = gh else { return Ok(Account::NoCli) };
    let ran = run(gh, &["auth", "status", "--hostname", HOST, "--json", "hosts"], STATUS_TIMEOUT)?;
    if !ran.success {
        return Err(format!("gh failed: {}", ran.stderr));
    }
    Ok(parse_account(&ran.stdout))
}

/// `{"hosts":{"github.com":[{"state":"success","active":true,"login":"x"}]}}` → the active, working login.
fn parse_account(json: &str) -> Account {
    let login = serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| {
            v["hosts"][HOST]
                .as_array()?
                .iter()
                .find(|a| a["active"] == true && a["state"] == "success")
                .and_then(|a| a["login"].as_str().map(str::to_owned))
        });
    login.map_or(Account::SignedOut, |login| Account::SignedIn { login })
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

const PR_QUERY: &str = "query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){defaultBranchRef{name} \
    pullRequests(headRefName:$branch,first:5,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url state isDraft reviewDecision \
    headRepositoryOwner{login} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}";

/// The newest pull request whose head is `branch` of `owner/repo`, through `gh api graphql`. The
/// variables are `gh` arguments, never part of the query text.
pub fn pull_request(gh: &Path, owner: &str, repo: &str, branch: &str) -> Result<PrReply, String> {
    let owner_arg = format!("owner={owner}");
    let name_arg = format!("name={repo}");
    let branch_arg = format!("branch={branch}");
    let query_arg = format!("query={PR_QUERY}");
    let args = ["api", "graphql", "-F", &owner_arg, "-F", &name_arg, "-F", &branch_arg, "-f", &query_arg];
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
    Ok(parse_pull_request(&ran.stdout, owner))
}

fn parse_pull_request(json: &str, owner: &str) -> PrReply {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return PrReply::failed(PrStatus::Error, "GitHub answered something unexpected");
    };
    let repo = &v["data"]["repository"];
    let text = |value: &serde_json::Value| value.as_str().map(str::to_owned);
    // A pull request from a fork that happens to use the same branch name isn't this branch's.
    let pr = repo["pullRequests"]["nodes"].as_array().and_then(|nodes| {
        nodes.iter().find(|n| n["headRepositoryOwner"]["login"].as_str().is_some_and(|l| l.eq_ignore_ascii_case(owner)))
    });
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
        }),
    }
}

static SIGNING_IN: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// Stops the sign-in that is running, if any.
pub fn cancel_sign_in() {
    CANCELLED.store(true, Ordering::SeqCst);
}

/// Runs `gh auth login --web` and calls `on_code` with the one-time code it prints, then waits for
/// the user to finish in the browser. One at a time.
pub fn sign_in(gh: &Path, on_code: impl Fn(&str)) -> Result<(), String> {
    sign_in_within(gh, on_code, CODE_TIMEOUT, LOGIN_TIMEOUT)
}

fn sign_in_within(gh: &Path, on_code: impl Fn(&str), code_timeout: Duration, login_timeout: Duration) -> Result<(), String> {
    if SIGNING_IN.swap(true, Ordering::SeqCst) {
        return Err("A sign-in is already running".to_owned());
    }
    CANCELLED.store(false, Ordering::SeqCst);
    let result = run_login(gh, on_code, code_timeout, login_timeout);
    SIGNING_IN.store(false, Ordering::SeqCst);
    result
}

fn run_login(gh: &Path, on_code: impl Fn(&str), code_timeout: Duration, login_timeout: Duration) -> Result<(), String> {
    let mut child = command(gh, &["auth", "login", "--hostname", HOST, "--web", "--git-protocol", "https", "--skip-ssh-key"])
        .spawn()
        .map_err(|e| format!("failed to run gh: {e}"))?;
    // gh prints its code and URL on either stream, depending on its version.
    let (lines, output) = mpsc::channel::<String>();
    for pipe in [child.stdout.take().map(boxed), child.stderr.take().map(boxed)].into_iter().flatten() {
        let lines = lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if lines.send(line).is_err() {
                    break;
                }
            }
        });
    }
    drop(lines);

    let started = Instant::now();
    let (mut code_seen, mut last_line) = (false, String::new());
    loop {
        match output.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                if !code_seen {
                    if let Some(code) = find_code(&line) {
                        code_seen = true;
                        on_code(code);
                    }
                }
                if !line.trim().is_empty() {
                    last_line = line.trim().to_owned();
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        let give_up = if CANCELLED.load(Ordering::SeqCst) {
            Some("Sign-in cancelled")
        } else if !code_seen && started.elapsed() > code_timeout {
            Some("The GitHub CLI didn't start the sign-in. Run `gh auth login` in a terminal.")
        } else if started.elapsed() > login_timeout {
            Some("The sign-in code expired")
        } else {
            None
        };
        if let Some(reason) = give_up {
            let _ = child.kill();
            let _ = child.wait();
            return Err(reason.to_owned());
        }
    }
    finish(&mut child, &last_line)
}

fn boxed(pipe: impl std::io::Read + Send + 'static) -> Box<dyn std::io::Read + Send> {
    Box::new(pipe)
}

fn finish(child: &mut Child, last_line: &str) -> Result<(), String> {
    let status = child.wait().map_err(|e| format!("failed to wait for gh: {e}"))?;
    if status.success() {
        Ok(())
    } else if last_line.is_empty() {
        Err(format!("gh exited with {status}"))
    } else {
        Err(last_line.to_owned())
    }
}

/// `XXXX-XXXX` in a line like `! One-time code (91BE-580F) copied to clipboard`.
fn find_code(line: &str) -> Option<&str> {
    line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).find(|word| {
        word.len() == 9
            && word.as_bytes()[4] == b'-'
            && word.bytes().enumerate().all(|(i, b)| i == 4 || b.is_ascii_uppercase() || b.is_ascii_digit())
    })
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;

    use super::*;

    /// Sign-in uses process-wide flags: one test at a time.
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

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
        ];
        for (script, expected) in cases {
            assert_eq!(account(Some(&fake_gh("account", script))).unwrap(), expected, "{script}");
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
            format!(r#"{{"data":{{"repository":{{"defaultBranchRef":{{"name":"main"}},"pullRequests":{{"nodes":[{}]}}}}}}}}"#, nodes.join(","))
        };
        let ask = |script: String| pull_request(&fake_gh("pr", &script), "o", "r", "feature/x").unwrap();

        // None, then the newest of this repository's own (a fork's with the same branch name is skipped).
        let none = ask(format!("echo '{}'", reply(&[])));
        assert_eq!((none.status, none.pr, none.default_branch.as_deref()), (PrStatus::Ok, None, Some("main")));
        let open = ask(format!("echo '{}'", reply(&[node("fork", 9, "OPEN", false, "null"), node("O", 8, "OPEN", true, r#"{"state":"PENDING"}"#), node("o", 7, "MERGED", false, "null")])));
        let pr = open.pr.expect("a pull request");
        assert_eq!((pr.number, pr.is_draft, pr.checks.as_deref(), pr.state.as_str()), (8, true, Some("PENDING"), "OPEN"));

        // The variables reach gh as arguments, the branch as typed.
        let echoing = fake_gh("pr-args", r#"for a in "$@"; do case "$a" in branch=*|owner=*|name=*) echo "$a" >> "$0.args";; esac; done; echo '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}'"#);
        pull_request(&echoing, "o", "r", "feature/x y").unwrap();
        let args = std::fs::read_to_string(format!("{}.args", echoing.display())).unwrap();
        assert_eq!(args, "owner=o\nname=r\nbranch=feature/x y\n");

        // Failures.
        let not_found = ask("echo \"gh: Could not resolve to a Repository with the name 'o/r'.\" >&2; exit 1".into());
        let signed_out = ask("echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4".into());
        let offline = ask("echo 'error connecting to api.github.com' >&2; exit 1".into());
        assert_eq!((not_found.status, signed_out.status, offline.status), (PrStatus::NoAccess, PrStatus::SignedOut, PrStatus::Error));
        assert_eq!(offline.message.as_deref(), Some("error connecting to api.github.com"));
    }

    #[test]
    fn gh_never_sees_a_token_from_the_environment() {
        let c = command(Path::new("gh"), &["auth", "status"]);
        let removed: Vec<_> = c.get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        assert!(removed.contains(&"GH_TOKEN".to_owned()) && removed.contains(&"GITHUB_TOKEN".to_owned()), "{removed:?}");
    }

    #[test]
    fn sign_in_reports_the_code_then_waits_for_gh_and_says_why_it_failed() {
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let codes = Mutex::new(Vec::new());
        let on_code = |c: &str| codes.lock().unwrap().push(c.to_owned());
        let shown = "echo '! One-time code (91BE-580F) copied to clipboard' >&2; echo 'Open this URL to continue in your web browser: https://github.com/login/device'";

        // Signed in once the user finishes in the browser.
        let ok = fake_gh("login-ok", &format!("{shown}; sleep 0.3"));
        assert_eq!(sign_in_within(&ok, on_code, CODE_TIMEOUT, LOGIN_TIMEOUT), Ok(()));
        assert_eq!(*codes.lock().unwrap(), ["91BE-580F"], "once, as soon as printed");

        // Declined or expired in the browser: gh's last line is the reason.
        let declined = fake_gh("login-declined", &format!("{shown}; echo 'authorization was declined'; exit 1"));
        assert_eq!(sign_in_within(&declined, on_code, CODE_TIMEOUT, LOGIN_TIMEOUT), Err("authorization was declined".into()));

        // No code at all: not waited on for ever.
        let silent = fake_gh("login-silent", "sleep 30");
        let err = sign_in_within(&silent, on_code, Duration::from_millis(300), LOGIN_TIMEOUT).unwrap_err();
        assert!(err.contains("didn't start the sign-in"), "{err}");
    }

    #[test]
    fn a_running_sign_in_can_be_cancelled() {
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let waiting = fake_gh("login-cancel", "echo '! One-time code (AAAA-1111) copied to clipboard'; sleep 30");
        let started = Instant::now();
        let result = std::thread::scope(|scope| {
            let login = scope.spawn(|| sign_in_within(&waiting, |_| {}, CODE_TIMEOUT, LOGIN_TIMEOUT));
            std::thread::sleep(Duration::from_millis(400));
            cancel_sign_in();
            login.join().unwrap()
        });
        assert_eq!(result, Err("Sign-in cancelled".into()));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn finds_the_code_in_what_gh_prints() {
        assert_eq!(find_code("! One-time code (91BE-580F) copied to clipboard"), Some("91BE-580F"));
        assert_eq!(find_code("! First copy your one-time code: ABCD-1234"), Some("ABCD-1234"));
        assert_eq!(find_code("Open this URL to continue in your web browser: https://github.com/login/device"), None);
    }
}
