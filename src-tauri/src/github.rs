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

/// Who `gh` is signed in as on github.com.
pub fn account(gh: Option<&Path>) -> Result<Account, String> {
    let Some(gh) = gh else { return Ok(Account::NoCli) };
    let mut child = command(gh, &["auth", "status", "--hostname", HOST, "--json", "hosts"])
        .spawn()
        .map_err(|e| format!("failed to run gh: {e}"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > STATUS_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("gh timed out".to_owned());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("failed to wait for gh: {e}")),
        }
    };
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        std::io::Read::read_to_string(&mut stdout, &mut out).map_err(|e| e.to_string())?;
    }
    if !status.success() {
        return Err(format!("gh exited with {status}"));
    }
    Ok(parse_account(&out))
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
