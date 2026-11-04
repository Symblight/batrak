//! Claude Code, run by `@agentclientprotocol/claude-agent-acp`. Its `--cli` passes every other
//! argument to the native `claude`, which continues a session by its ACP id.

use std::collections::BTreeMap;

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use agent_api::{is_flag_value, strings, Agent, CliSpec, Install, Launch, ModeRisk, SessionActivity, SubagentRecord, SubagentState, Update, ID, PROMPT};

/// The adapter's npm package.
pub const PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";

pub struct Claude;

impl Agent for Claude {
    fn kind(&self) -> &'static str {
        "claude"
    }

    fn subagents(&self, session_id: &str) -> Vec<SubagentRecord> {
        config_dir().map(|dir| subagents_in(&dir, session_id, SystemTime::now())).unwrap_or_default()
    }

    fn session_activity(&self, session_id: &str) -> Option<SessionActivity> {
        activity_in(&config_dir()?, session_id, is_live)
    }

    fn registry_id(&self) -> Option<&'static str> {
        Some("claude-acp")
    }

    fn install(&self) -> Option<Install> {
        Some(Install::Npx { package: PACKAGE })
    }

    fn update(&self, args: &[String], version: &str) -> Option<Update> {
        agent_kit::npx_update(args, PACKAGE, version)
    }

    fn matches(&self, launch: &Launch) -> bool {
        agent_kit::runs(launch, PACKAGE)
    }

    fn cli(&self, launch: &Launch) -> Option<CliSpec> {
        Some(CliSpec {
            program: launch.command.clone(),
            args: launch.args.iter().cloned().chain(["--cli".to_owned()]).collect(),
            resume_args: strings(&["--resume", ID]),
            new_args: Some(strings(&["--session-id", ID])),
            prompt_args: strings(&[PROMPT]),
        })
    }

    /// Claude Code's permission modes.
    fn mode_risk(&self, value: &str) -> Option<ModeRisk> {
        match value {
            "acceptEdits" => Some(ModeRisk::Agent),
            "bypassPermissions" => Some(ModeRisk::Full),
            _ => agent_api::common_mode_risk(value),
        }
    }

    /// The adapter's `model`, `mode` and `effort` options (read from claude-agent-acp 0.99.1's
    /// `session/new`) as `claude`'s `--model`, `--permission-mode` and `--effort`; `default` is no
    /// flag, and so is a value that isn't id-like (`is_flag_value`). `fast` has none.
    fn cli_args(&self, config: &BTreeMap<String, String>) -> Vec<String> {
        let flag = |option: &str, flag: &str| {
            config.get(option).filter(|v| v.as_str() != "default" && is_flag_value(v)).map(|v| [flag.to_owned(), v.clone()])
        };
        [flag("model", "--model"), flag("mode", "--permission-mode"), flag("effort", "--effort")].into_iter().flatten().flatten().collect()
    }
}

/// A running subagent's transcript grows; one untouched this long may have died with its session.
const STALE: Duration = Duration::from_secs(5 * 60);

/// Claude Code's config folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
fn config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".claude"))
}

/// The subagents Claude Code recorded for session `session_id` under `config`
/// (`projects/<project>/<session>/subagents/agent-<id>.meta.json` and `.jsonl`), oldest first.
pub fn subagents_in(config: &Path, session_id: &str, now: SystemTime) -> Vec<SubagentRecord> {
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Vec::new();
    }
    let Ok(projects) = std::fs::read_dir(config.join("projects")) else { return Vec::new() };
    let Some(dir) = projects.flatten().map(|p| p.path().join(session_id).join("subagents")).find(|d| d.is_dir()) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut found: Vec<SubagentRecord> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_prefix("agent-")?.strip_suffix(".meta.json")?.to_owned();
            let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok()?;
            let transcript = dir.join(format!("agent-{id}.jsonl"));
            let flag = |key: &str| meta.get(key).and_then(serde_json::Value::as_bool) == Some(true);
            let text = |key: &str| meta.get(key).and_then(serde_json::Value::as_str).map(str::to_owned);
            let state = if flag("finished") {
                SubagentState::Done
            } else if flag("stoppedByUser") {
                SubagentState::Stopped
            } else if quiet_since(&transcript, now).is_some_and(|quiet| quiet > STALE) {
                SubagentState::Unknown
            } else {
                SubagentState::Running
            };
            Some(SubagentRecord { id, kind: text("agentType"), title: text("description"), state, started_at: first_timestamp(&transcript) })
        })
        .collect();
    found.sort_by(|a, b| (&a.started_at, &a.id).cmp(&(&b.started_at, &b.id)));
    found
}

/// What session `session_id` is doing, from the records its live CLIs keep under `config`
/// (`sessions/<pid>.json`). A CLI in a turn decides over an idle one of the same session; an SDK-driven
/// CLI keeps `busy` after its turn, so it tells nothing. `is_live` checks a record's pid and recorded
/// start.
pub fn activity_in(config: &Path, session_id: &str, mut is_live: impl FnMut(u32, Option<&str>) -> bool) -> Option<SessionActivity> {
    let entries = std::fs::read_dir(config.join("sessions")).ok()?;
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let pid: u32 = name.strip_suffix(".json")?.parse().ok()?;
            let record: serde_json::Value = serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok()?;
            let text = |key: &str| record.get(key).and_then(serde_json::Value::as_str);
            if text("sessionId") != Some(session_id)
                || record.get("pid").and_then(serde_json::Value::as_u64) != Some(u64::from(pid))
                || text("kind") != Some("interactive")
                || text("entrypoint").is_none_or(|e| e.starts_with("sdk-"))
            {
                return None;
            }
            let activity = match text("status")? {
                "busy" | "shell" => SessionActivity::Running,
                "waiting" => SessionActivity::WaitingForUser,
                "idle" => SessionActivity::Idle,
                _ => return None,
            };
            is_live(pid, text("procStart")).then_some(activity)
        })
        .max_by_key(|activity| match activity {
            SessionActivity::Idle => 0,
            SessionActivity::Running => 1,
            SessionActivity::WaitingForUser => 2,
        })
}

/// Whether `pid` runs, and is the process started at `recorded_start` (a pid can be reused), which
/// Claude Code writes as `LC_ALL=C TZ=UTC ps -o lstart=` prints it.
#[cfg(unix)]
fn is_live(pid: u32, recorded_start: Option<&str>) -> bool {
    let words = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let output = std::process::Command::new("ps").args(["-o", "lstart=", "-p", &pid.to_string()]).env("LC_ALL", "C").env("TZ", "UTC").output();
    let Ok(output) = output else { return false };
    let started = words(&String::from_utf8_lossy(&output.stdout));
    !started.is_empty() && recorded_start.is_none_or(|recorded| words(recorded) == started)
}

/// Whether `pid` runs. Windows has no `ps`, and Claude Code's start time isn't compared there.
#[cfg(windows)]
fn is_live(pid: u32, _recorded_start: Option<&str>) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let filter = format!("PID eq {pid}");
    let output = std::process::Command::new("tasklist").args(["/FI", &filter, "/NH", "/FO", "CSV"]).creation_flags(CREATE_NO_WINDOW).output();
    output.is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")))
}

/// How long the file hasn't changed.
fn quiet_since(path: &Path, now: SystemTime) -> Option<Duration> {
    now.duration_since(std::fs::metadata(path).ok()?.modified().ok()?).ok()
}

/// The `timestamp` of a transcript's first line: when the subagent started.
fn first_timestamp(path: &Path) -> Option<String> {
    use std::io::BufRead;
    let mut line = String::new();
    std::io::BufReader::new(std::fs::File::open(path).ok()?).read_line(&mut line).ok()?;
    let first: serde_json::Value = serde_json::from_str(&line).ok()?;
    first.get("timestamp").and_then(serde_json::Value::as_str).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_agent_contract() {
        agent_api::conformance::check(&Claude);
    }

    /// A Claude config dir whose live registry holds these files (name, content).
    fn registry(name: &str, files: &[(&str, String)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("brama-claude-activity-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        for (file, content) in files {
            std::fs::write(root.join("sessions").join(file), content).unwrap();
        }
        root
    }

    /// A CLI's record, as Claude Code 2.1.316 writes it.
    fn cli_record(pid: u32, session: &str, status: &str) -> String {
        serde_json::json!({ "pid": pid, "sessionId": session, "kind": "interactive", "entrypoint": "cli", "procStart": "Wed Nov  4 07:35:05 2026", "status": status, "statusUpdatedAt": 1 }).to_string()
    }

    #[test]
    fn a_live_clis_status_tells_what_its_session_is_doing() {
        // Arrange
        let cases = [("busy", Some(SessionActivity::Running)), ("shell", Some(SessionActivity::Running)), ("waiting", Some(SessionActivity::WaitingForUser)), ("idle", Some(SessionActivity::Idle)), ("new-status", None)];
        for (status, expected) in cases {
            let root = registry("status", &[("7.json", cli_record(7, "s", status))]);
            // Act + Assert
            assert_eq!(activity_in(&root, "s", |_, _| true), expected, "{status}");
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn of_several_live_clis_of_a_session_the_one_in_a_turn_decides() {
        // Arrange
        let cases = [
            (("idle", "busy"), SessionActivity::Running),
            (("busy", "idle"), SessionActivity::Running),
            (("busy", "waiting"), SessionActivity::WaitingForUser),
            (("idle", "idle"), SessionActivity::Idle),
        ];
        for ((first, second), expected) in cases {
            let root = registry("several", &[("7.json", cli_record(7, "s", first)), ("8.json", cli_record(8, "s", second))]);
            // Act + Assert
            assert_eq!(activity_in(&root, "s", |_, _| true), Some(expected), "{first}, {second}");
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn a_record_that_doesnt_tell_of_a_live_cli_is_left_out() {
        // Arrange
        let with = |key: &str, value: &str| {
            let mut record: serde_json::Value = serde_json::from_str(&cli_record(7, "s", "busy")).unwrap();
            record[key] = value.into();
            record.to_string()
        };
        let cases = [
            ("another session", "7.json", cli_record(7, "other", "busy")),
            ("an SDK-driven CLI stays busy", "7.json", with("entrypoint", "sdk-cli")),
            ("not interactive", "7.json", with("kind", "print")),
            ("another pid's file", "8.json", cli_record(7, "s", "busy")),
            ("not a record's name", "7.abc.key", cli_record(7, "s", "busy")),
            ("not JSON", "7.json", "{ cut off".to_owned()),
        ];
        for (why, file, content) in cases {
            let root = registry("left-out", &[(file, content)]);
            // Act + Assert
            assert_eq!(activity_in(&root, "s", |_, _| true), None, "{why}");
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn a_cli_that_died_or_whose_pid_was_reused_tells_nothing() {
        // Arrange
        let root = registry("dead", &[("7.json", cli_record(7, "s", "busy"))]);
        // Act
        let mut asked = None;
        let answer = activity_in(&root, "s", |pid, start| {
            asked = Some((pid, start.map(str::to_owned)));
            false
        });
        // Assert
        assert_eq!(answer, None);
        assert_eq!(asked, Some((7, Some("Wed Nov  4 07:35:05 2026".to_owned()))), "its pid and recorded start are checked");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn a_process_is_live_only_while_it_runs_and_only_as_the_one_recorded() {
        // Arrange
        let own = std::process::id();
        let mut ended = std::process::Command::new("true").spawn().unwrap();
        let gone = ended.id();
        ended.wait().unwrap();
        // Act + Assert
        assert!(is_live(own, None), "no recorded start to compare");
        assert!(!is_live(own, Some("Thu Jan  1 00:00:00 1970")), "a reused pid");
        assert!(!is_live(gone, None), "it ended");
    }

    /// What this machine's records say of session `$BRAMA_CLAUDE_SESSION`: `cargo test -p agent-claude real_session_activity -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_session_activity() {
        let session = std::env::var("BRAMA_CLAUDE_SESSION").expect("BRAMA_CLAUDE_SESSION");
        let answer = Claude.session_activity(&session);
        eprintln!("{session}: {answer:?}");
        assert!(answer.is_some(), "no live CLI of {session} told");
    }

    /// A Claude config dir with one session's subagents: (id, meta JSON, first transcript line's timestamp, transcript age).
    fn claude_dir(name: &str, session: &str, agents: &[(&str, &str, &str, std::time::Duration)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("brama-claude-subagents-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("projects").join("-work-project").join(session).join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        for (id, meta, started, age) in agents {
            std::fs::write(dir.join(format!("agent-{id}.meta.json")), meta).unwrap();
            let transcript = dir.join(format!("agent-{id}.jsonl"));
            std::fs::write(&transcript, format!("{{\"type\":\"user\",\"timestamp\":\"{started}\"}}\n")).unwrap();
            let file = std::fs::File::options().write(true).open(&transcript).unwrap();
            file.set_modified(std::time::SystemTime::now() - *age).unwrap();
        }
        root
    }

    /// The subagents Claude Code recorded on this machine for session `$BRAMA_CLAUDE_SESSION`: `cargo test -p agent-claude real_subagent_records -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_subagent_records() {
        let session = std::env::var("BRAMA_CLAUDE_SESSION").expect("BRAMA_CLAUDE_SESSION");
        let found = Claude.subagents(&session);
        for s in &found {
            eprintln!("{s:?}");
        }
        assert!(!found.is_empty(), "no subagents recorded for {session}");
    }

    #[test]
    fn a_sessions_subagents_come_from_its_transcript_folder_in_start_order() {
        // Arrange
        let minute = std::time::Duration::from_secs(60);
        let root = claude_dir("list", "s-1", &[
            ("b", r#"{"agentType":"Explore","description":"Find usages","finished":true}"#, "2026-11-03T10:02:00Z", minute),
            ("a", r#"{"agentType":"Plan","description":"Plan it","stoppedByUser":true}"#, "2026-11-03T10:01:00Z", minute),
            ("c", r#"{"agentType":"Explore","description":"Still going"}"#, "2026-11-03T10:03:00Z", std::time::Duration::ZERO),
            ("d", r#"{"description":"Crashed long ago"}"#, "2026-11-03T10:04:00Z", 10 * minute),
        ]);
        // Act
        let found = subagents_in(&root, "s-1", std::time::SystemTime::now());
        // Assert
        let seen: Vec<_> = found.iter().map(|s| (s.id.as_str(), s.kind.as_deref(), s.title.as_deref(), s.state, s.started_at.as_deref())).collect();
        assert_eq!(seen, [
            ("a", Some("Plan"), Some("Plan it"), SubagentState::Stopped, Some("2026-11-03T10:01:00Z")),
            ("b", Some("Explore"), Some("Find usages"), SubagentState::Done, Some("2026-11-03T10:02:00Z")),
            ("c", Some("Explore"), Some("Still going"), SubagentState::Running, Some("2026-11-03T10:03:00Z")),
            ("d", None, Some("Crashed long ago"), SubagentState::Unknown, Some("2026-11-03T10:04:00Z")),
        ]);
        assert!(subagents_in(&root, "s-2", std::time::SystemTime::now()).is_empty(), "another session has none");
        assert!(subagents_in(&root, "../projects", std::time::SystemTime::now()).is_empty(), "not an id");
        let _ = std::fs::remove_dir_all(root);
    }

    fn launch(command: &str, args: &[&str]) -> Launch {
        Launch { command: command.into(), args: strings(args) }
    }

    fn config(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn drives_the_adapter_by_its_package_and_runs_its_bundled_cli() {
        let pinned = launch("npx", &["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"]);
        assert!(Claude.matches(&pinned));
        assert!(!Claude.matches(&launch("npx", &["-y", "@github/copilot"])));
        assert!(!Claude.matches(&launch("claude", &[])), "not the adapter");
        let cli = Claude.cli(&pinned).unwrap();
        assert_eq!(cli.resume("abc").1, ["-y", "@agentclientprotocol/claude-agent-acp@0.99.1", "--cli", "--resume", "abc"]);
        assert_eq!(cli.start_new("abc", Some("fix it")).unwrap().1.last().map(String::as_str), Some("fix it"));
    }

    #[test]
    fn passes_the_picked_model_and_permission_mode_as_flags() {
        assert_eq!(Claude.cli_args(&config(&[("model", "opus"), ("mode", "plan")])), ["--model", "opus", "--permission-mode", "plan"]);
        assert_eq!(Claude.cli_args(&config(&[("model", "claude-sonnet-5"), ("mode", "bypassPermissions")])), ["--model", "claude-sonnet-5", "--permission-mode", "bypassPermissions"]);
        assert_eq!(Claude.cli_args(&config(&[("effort", "high")])), ["--effort", "high"]);
    }

    #[test]
    fn tags_its_permission_modes_by_risk() {
        let risks: Vec<_> = ["default", "plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"].map(|m| Claude.mode_risk(m)).into();
        assert_eq!(risks, [Some(ModeRisk::Neutral), Some(ModeRisk::Plan), Some(ModeRisk::Agent), Some(ModeRisk::Agent), Some(ModeRisk::Full), None]);
    }

    #[test]
    fn never_passes_a_value_that_isnt_id_like() {
        assert!(Claude.cli_args(&config(&[("model", "opus & calc"), ("mode", "--dangerously-skip-permissions")])).is_empty());
    }

    #[test]
    fn passes_nothing_for_defaults_and_options_its_cli_has_no_flag_for() {
        assert!(Claude.cli_args(&config(&[("model", "default"), ("mode", "default"), ("effort", "default")])).is_empty());
        assert!(Claude.cli_args(&config(&[("fast", "on")])).is_empty());
        assert!(Claude.cli_args(&config(&[])).is_empty());
    }
}
