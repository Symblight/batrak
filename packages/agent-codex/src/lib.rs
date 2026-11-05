//! Codex, run by `@agentclientprotocol/codex-acp`: a library over Codex's own threads. Its CLI is a
//! package of its own (`@openai/codex`), which resumes a thread but can't start one under our id.

use std::path::{Path, PathBuf};

use agent_api::{is_session_id, strings, Agent, CliSpec, Install, Launch, ModeRisk, SessionActivity, Update, ID};

pub const PACKAGE: &str = "@agentclientprotocol/codex-acp";
/// The CLI a session continues in.
const CLI_PACKAGE: &str = "@openai/codex";

pub struct Codex;

impl Agent for Codex {
    fn kind(&self) -> &'static str {
        "codex"
    }

    fn session_activity(&self, session_id: &str) -> Option<SessionActivity> {
        activity_in(&agent_kit::agent_home("CODEX_HOME", ".codex")?, session_id)
    }

    fn registry_id(&self) -> Option<&'static str> {
        Some("codex-acp")
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

    /// codex-acp's modes: `read-only`, `auto`, `full-access`.
    fn mode_risk(&self, value: &str) -> Option<ModeRisk> {
        match value {
            "read-only" => Some(ModeRisk::Plan),
            "full-access" => Some(ModeRisk::Full),
            _ => agent_api::common_mode_risk(value),
        }
    }

    /// npx's own flags (before the package), then its CLI's package.
    fn cli(&self, launch: &Launch) -> Option<CliSpec> {
        let (at, _, _) = agent_kit::npx_package(launch)?;
        let before = launch.args[..at].iter().filter(|a| a.starts_with('-')).cloned();
        Some(CliSpec {
            program: launch.command.clone(),
            args: before.chain([CLI_PACKAGE.to_owned()]).collect(),
            resume_args: strings(&["resume", ID]),
            new_args: None,
            prompt_args: Vec::new(),
        })
    }
}

/// What thread `thread_id` is doing, from the last turn event of its rollout under `home`
/// (`sessions/<y>/<m>/<d>/rollout-<time>-<thread id>.jsonl`). An approval wait isn't recorded, so it
/// reads as running.
pub fn activity_in(home: &Path, thread_id: &str) -> Option<SessionActivity> {
    if !is_session_id(thread_id) {
        return None;
    }
    let rollout = find_rollout(&home.join("sessions"), &format!("-{thread_id}.jsonl"))?;
    agent_kit::last_told(&rollout, |line| {
        // Most lines are long and tell nothing: parsed only if they may.
        if !["task_started", "task_complete", "turn_aborted"].iter().any(|kind| line.contains(kind)) {
            return None;
        }
        let record: serde_json::Value = serde_json::from_str(line).ok()?;
        if record.get("type")?.as_str()? != "event_msg" {
            return None;
        }
        match record.get("payload")?.get("type")?.as_str()? {
            "task_started" => Some(SessionActivity::Running),
            "task_complete" | "turn_aborted" => Some(SessionActivity::Idle),
            _ => None,
        }
    })
}

/// The file under `dir` whose name ends with `suffix`, the newest day's first.
fn find_rollout(dir: &Path, suffix: &str) -> Option<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.flatten().map(|entry| entry.path()).collect();
    entries.sort_unstable_by(|a, b| b.cmp(a));
    entries.into_iter().find_map(|path| match path.is_dir() {
        true => find_rollout(&path, suffix),
        false => path.file_name()?.to_str()?.ends_with(suffix).then_some(path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_agent_contract() {
        agent_api::conformance::check(&Codex);
    }

    /// A Codex home with one thread's rollout of these lines, in a day's folder.
    fn rollout(name: &str, day: &str, thread: &str, lines: &[String]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("batrak-codex-activity-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("sessions").join(day);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("rollout-2026-10-25T20-39-15-{thread}.jsonl")), lines.join("\n")).unwrap();
        root
    }

    fn event(kind: &str) -> String {
        serde_json::json!({ "timestamp": "2026-10-25T18:39:15.466Z", "type": "event_msg", "payload": { "type": kind } }).to_string()
    }

    const THREAD: &str = "01a1745c-19ee-7990-82a6-fb09b922c5fe";

    #[test]
    fn a_threads_last_turn_event_tells_what_it_is_doing() {
        // Arrange
        let item = serde_json::json!({ "type": "response_item", "payload": { "type": "task_complete" } }).to_string();
        let cases = [
            (vec![event("task_started")], Some(SessionActivity::Running), "a turn began"),
            (vec![event("task_started"), event("token_count"), item], Some(SessionActivity::Running), "its work follows; only events count"),
            (vec![event("task_started"), event("task_complete"), event("item_completed")], Some(SessionActivity::Idle), "ended"),
            (vec![event("task_started"), event("turn_aborted")], Some(SessionActivity::Idle), "Esc"),
            (vec![event("task_complete"), event("task_started")], Some(SessionActivity::Running), "the next turn"),
            (vec![event("thread_settings_applied")], None, "no turn yet"),
        ];
        for (lines, expected, why) in cases {
            let root = rollout("events", "2026/10/25", THREAD, &lines);
            // Act + Assert
            assert_eq!(activity_in(&root, THREAD), expected, "{why}");
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn a_thread_is_found_by_its_id_in_any_days_folder() {
        // Arrange
        let root = rollout("find", "2026/09/01", THREAD, &[event("task_started")]);
        std::fs::create_dir_all(root.join("sessions/2026/10/25")).unwrap();
        // Act + Assert
        assert_eq!(activity_in(&root, THREAD), Some(SessionActivity::Running));
        assert_eq!(activity_in(&root, "01a1745c-0000-0000-0000-000000000000"), None, "another thread");
        let _ = std::fs::remove_dir_all(root);
    }

    /// What this machine's records say of thread `$BATRAK_CODEX_THREAD`: `cargo test -p agent-codex real_session_activity -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_session_activity() {
        let thread = std::env::var("BATRAK_CODEX_THREAD").expect("BATRAK_CODEX_THREAD");
        let answer = Codex.session_activity(&thread);
        eprintln!("{thread}: {answer:?}");
        assert!(answer.is_some(), "no record of {thread} told");
    }

    #[test]
    fn resumes_a_thread_in_its_own_cli_and_starts_none() {
        let launch = Launch { command: "/usr/local/bin/npx".into(), args: strings(&["-y", "@agentclientprotocol/codex-acp@2.5.0"]) };
        assert!(Codex.matches(&launch));
        let cli = Codex.cli(&launch).unwrap();
        assert_eq!(cli.resume("t-1"), ("/usr/local/bin/npx".to_owned(), strings(&["-y", "@openai/codex", "resume", "t-1"])));
        assert_eq!(cli.start_new("t-1", None), None);
    }

    #[test]
    fn tags_its_modes_by_risk() {
        assert_eq!(["read-only", "auto", "full-access"].map(|m| Codex.mode_risk(m)), [Some(ModeRisk::Plan), Some(ModeRisk::Agent), Some(ModeRisk::Full)]);
    }
}
