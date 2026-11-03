//! GitHub through the user's GitHub CLI (`gh`): who is signed in, and signing in. The app keeps no
//! token and has no OAuth app: `gh` logs in through the browser and holds the credentials.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::git::exec::stop_group;

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
    reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}}";

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
        }),
    }
}

/// The sign-in flows: the newest one runs, an older one still running stops.
struct Flows {
    /// The newest flow's number; a flow whose number isn't this one has been replaced.
    newest: u64,
    /// Whether the newest flow is still running.
    running: bool,
    /// Asked to stop the newest flow, or the one about to start; cleared when it ends.
    cancel: bool,
}

static FLOWS: Mutex<Flows> = Mutex::new(Flows { newest: 0, running: false, cancel: false });

fn flows() -> std::sync::MutexGuard<'static, Flows> {
    FLOWS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Stops the sign-in that is running, or the one about to start.
pub fn cancel_sign_in() {
    flows().cancel = true;
}

/// Stops a running sign-in and its `gh` (the app quits); returns once it has stopped, or after 2 s.
pub fn stop_sign_in() {
    {
        let mut flows = flows();
        if !flows.running {
            return;
        }
        flows.cancel = true;
    }
    let started = Instant::now();
    while flows().running && started.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Runs `gh auth login --web` and calls `on_code` with the one-time code it prints, then waits for
/// the user to finish in the browser. A new one replaces one still running (a reloaded page's).
pub fn sign_in(gh: &Path, on_code: impl Fn(&str)) -> Result<(), String> {
    sign_in_within(gh, on_code, CODE_TIMEOUT, LOGIN_TIMEOUT)
}

fn sign_in_within(gh: &Path, on_code: impl Fn(&str), code_timeout: Duration, login_timeout: Duration) -> Result<(), String> {
    let flow = {
        let mut flows = flows();
        flows.newest += 1;
        flows.running = true;
        flows.newest
    };
    let stopped = || {
        let flows = flows();
        flows.newest != flow || flows.cancel
    };
    let result = run_login(gh, on_code, &stopped, code_timeout, login_timeout);
    let mut flows = flows();
    // A replaced flow leaves the new one's state alone.
    if flows.newest == flow {
        flows.running = false;
        flows.cancel = false;
    }
    result
}

/// How long gh's output is still read after it exited, for its last lines.
const OUTPUT_GRACE: Duration = Duration::from_millis(500);

fn run_login(gh: &Path, on_code: impl Fn(&str), stopped: &dyn Fn() -> bool, code_timeout: Duration, login_timeout: Duration) -> Result<(), String> {
    if stopped() {
        return Err("Sign-in cancelled".to_owned());
    }
    let mut command = command(gh, &["auth", "login", "--hostname", HOST, "--web", "--git-protocol", "https", "--skip-ssh-key"]);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A process group of its own, so that stopping it stops what it started (the browser launcher).
        // SAFETY: `setsid` is async-signal-safe and touches nothing of the parent.
        unsafe {
            command.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
        }
    }
    let mut child = command.spawn().map_err(|e| format!("failed to run gh: {e}"))?;
    // gh prints its code and URL on either stream, depending on its version; its errors on stderr.
    let (lines, output) = mpsc::channel::<(bool, String)>();
    for (is_stderr, pipe) in [(false, child.stdout.take().map(boxed)), (true, child.stderr.take().map(boxed))] {
        let Some(pipe) = pipe else { continue };
        let lines = lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if lines.send((is_stderr, line)).is_err() {
                    break;
                }
            }
        });
    }
    drop(lines);

    let started = Instant::now();
    let mut code_seen = false;
    // The last non-empty line of stdout and of stderr.
    let mut last = [String::new(), String::new()];
    let mut exited = None;
    loop {
        match output.recv_timeout(Duration::from_millis(100)) {
            Ok((is_stderr, line)) => {
                if !code_seen {
                    if let Some(code) = find_code(&line) {
                        code_seen = true;
                        on_code(code);
                    }
                }
                if !line.trim().is_empty() {
                    last[usize::from(is_stderr)] = line.trim().to_owned();
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        // Something gh started may hold its output open after it exited: its exit status ends it.
        match exited {
            Some(at) if Instant::now().duration_since(at) > OUTPUT_GRACE => break,
            Some(_) => continue,
            None => {}
        }
        if matches!(child.try_wait(), Ok(Some(_))) {
            exited = Some(Instant::now());
            continue;
        }
        let give_up = if stopped() {
            Some("Sign-in cancelled")
        } else if !code_seen && started.elapsed() > code_timeout {
            Some("The GitHub CLI didn't start the sign-in. Run `gh auth login` in a terminal.")
        } else if started.elapsed() > login_timeout {
            Some("The sign-in code expired")
        } else {
            None
        };
        if let Some(reason) = give_up {
            stop_group(&mut child);
            let _ = child.wait();
            return Err(reason.to_owned());
        }
    }
    let [stdout_last, stderr_last] = last;
    finish(&mut child, if stderr_last.is_empty() { &stdout_last } else { &stderr_last })
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
        // gh writes its error to stderr; what stdout printed later isn't the reason.
        let declined = fake_gh("login-declined", &format!("{shown}; echo 'authorization was declined' >&2; sleep 0.2; echo 'Press Enter to open github.com in your browser...'; exit 1"));
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
    fn a_cancel_sent_before_the_sign_in_starts_still_stops_it_and_only_it() {
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let waiting = fake_gh("login-precancel", "echo '! One-time code (AAAA-1111) copied to clipboard'; sleep 30");
        cancel_sign_in();
        assert_eq!(sign_in_within(&waiting, |_| {}, CODE_TIMEOUT, Duration::from_secs(2)), Err("Sign-in cancelled".into()));
        // That cancel is used up: the next sign-in runs.
        let ok = fake_gh("login-after-cancel", "echo '! One-time code (AAAA-1111) copied to clipboard'; sleep 0.2");
        assert_eq!(sign_in_within(&ok, |_| {}, CODE_TIMEOUT, LOGIN_TIMEOUT), Ok(()));
    }

    #[test]
    fn a_new_sign_in_replaces_one_still_running() {
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let left_over = fake_gh("login-left-over", "echo '! One-time code (AAAA-1111) copied to clipboard'; sleep 30");
        let fresh = fake_gh("login-fresh", "echo '! One-time code (BBBB-2222) copied to clipboard'; sleep 0.5");
        let (shown, code) = mpsc::channel();
        let (old, new) = std::thread::scope(|scope| {
            let old = scope.spawn(|| sign_in_within(&left_over, |_| shown.send(()).unwrap(), CODE_TIMEOUT, Duration::from_secs(5)));
            code.recv_timeout(Duration::from_secs(5)).unwrap();
            let new = sign_in_within(&fresh, |_| {}, CODE_TIMEOUT, LOGIN_TIMEOUT);
            (old.join().unwrap(), new)
        });
        assert_eq!((old, new), (Err("Sign-in cancelled".into()), Ok(())));
    }

    /// Whether process `pid` is gone, given a moment to be reaped.
    fn gone(pid: i32) -> bool {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            // SAFETY: signal 0 only checks the process exists.
            if unsafe { libc::kill(pid, 0) } == -1 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn stopping_a_sign_in_stops_what_gh_started_too() {
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        // gh starts a helper (a browser launcher) that outlives it unless its group is stopped.
        let gh = fake_gh("login-group", "sleep 30 >/dev/null 2>&1 & echo $! > \"$0.child\"; echo '! One-time code (AAAA-1111) copied to clipboard'; wait");
        let (shown, code) = mpsc::channel();
        let result = std::thread::scope(|scope| {
            let login = scope.spawn(|| sign_in_within(&gh, |_| shown.send(()).unwrap(), CODE_TIMEOUT, Duration::from_secs(5)));
            code.recv_timeout(Duration::from_secs(5)).unwrap();
            // What quitting the app does: returns once the sign-in has stopped.
            stop_sign_in();
            assert!(login.is_finished(), "stopped before returning");
            login.join().unwrap()
        });
        assert_eq!(result, Err("Sign-in cancelled".into()));
        let child: i32 = std::fs::read_to_string(format!("{}.child", gh.display())).unwrap().trim().parse().unwrap();
        assert!(gone(child), "gh's helper was stopped with it");
    }

    #[test]
    fn a_sign_in_ends_when_gh_exits_even_if_its_helper_keeps_the_output_open() {
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let gh = fake_gh("login-helper", "sleep 30 & echo $! > \"$0.child\"; echo '! One-time code (AAAA-1111) copied to clipboard'; sleep 0.2; exit 0");
        let started = Instant::now();
        let result = sign_in_within(&gh, |_| {}, CODE_TIMEOUT, Duration::from_secs(3));
        let child: i32 = std::fs::read_to_string(format!("{}.child", gh.display())).unwrap().trim().parse().unwrap();
        // SAFETY: the test's own sleep.
        unsafe { libc::kill(child, libc::SIGKILL) };
        assert_eq!(result, Ok(()));
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    }

    #[test]
    fn finds_the_code_in_what_gh_prints() {
        assert_eq!(find_code("! One-time code (91BE-580F) copied to clipboard"), Some("91BE-580F"));
        assert_eq!(find_code("! First copy your one-time code: ABCD-1234"), Some("ABCD-1234"));
        assert_eq!(find_code("Open this URL to continue in your web browser: https://github.com/login/device"), None);
    }
}
