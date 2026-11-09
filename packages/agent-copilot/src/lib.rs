//! GitHub Copilot: the `copilot` CLI, which `--acp` turns into the agent; without it, the same
//! program is the CLI a session continues in.

use std::collections::BTreeMap;
use std::path::Path;

use agent_api::{is_flag_value, is_session_id, strings, Agent, CliSpec, Install, Launch, ModeRisk, SessionActivity, Update, ID, PROMPT};

pub const PACKAGE: &str = "@github/copilot";

pub struct Copilot;

impl Agent for Copilot {
    fn kind(&self) -> &'static str {
        "copilot"
    }

    fn session_activity(&self, session_id: &str) -> Option<SessionActivity> {
        activity_in(&agent_kit::agent_home("COPILOT_HOME", ".copilot")?, session_id)
    }

    fn registry_id(&self) -> Option<&'static str> {
        Some("github-copilot-cli")
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
            args: launch.args.iter().filter(|a| *a != "--acp").cloned().collect(),
            resume_args: strings(&["--resume", ID]),
            new_args: Some(strings(&["--session-id", ID])),
            prompt_args: vec![format!("--interactive={PROMPT}")],
        })
    }

    /// A shell call by its model's `description`, with its command. Its reads name their file; its
    /// edits (`apply_patch`) name theirs only in their diffs.
    fn shown_tool_call(&self, tool_call: &serde_json::Value, _plan: &[agent_api::PlanEntry]) -> agent_api::ShownToolCall {
        match tool_call["kind"] == "execute" {
            true => agent_kit::shell_call(tool_call),
            false => agent_api::ShownToolCall::AS_SENT,
        }
    }

    /// Its modes are URLs ending in `#agent`, `#plan` or `#autopilot` (which goes on unasked).
    fn mode_risk(&self, value: &str) -> Option<ModeRisk> {
        match value.rsplit_once('#')?.1 {
            "autopilot" => Some(ModeRisk::Agent),
            other => agent_api::common_mode_risk(other),
        }
    }

    /// Its `model`, `mode` and `allow_all` options (read from copilot 1.0.103's `session/new`) as
    /// `--model`, `--mode` and `--allow-all`. A mode is a URL ending in `#agent`, `#plan` or
    /// `#autopilot`; `#agent` is the CLI's `interactive`.
    fn cli_args(&self, config: &BTreeMap<String, String>) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(model) = config.get("model").filter(|m| is_flag_value(m)) {
            args.extend(["--model".to_owned(), model.clone()]);
        }
        let mode = config.get("mode").and_then(|m| m.rsplit_once('#')).map(|(_, mode)| mode);
        if let Some(mode) = mode.and_then(|m| match m {
            "agent" => Some("interactive"),
            "plan" | "autopilot" => Some(m),
            _ => None,
        }) {
            args.extend(["--mode".to_owned(), mode.to_owned()]);
        }
        if config.get("allow_all").is_some_and(|v| v == "on") {
            args.push("--allow-all".to_owned());
        }
        args
    }
}

/// What session `session_id` is doing, from the last turn event of its log under `home`
/// (`session-state/<session id>/events.jsonl`). A CLI killed mid-turn writes no end, so its next
/// `session.resume` ends that turn.
pub fn activity_in(home: &Path, session_id: &str) -> Option<SessionActivity> {
    if !is_session_id(session_id) {
        return None;
    }
    let log = home.join("session-state").join(session_id).join("events.jsonl");
    agent_kit::last_told(&log, |line| {
        let record: serde_json::Value = serde_json::from_str(line).ok()?;
        match record.get("type")?.as_str()? {
            "assistant.turn_start" | "permission.completed" => Some(SessionActivity::Running),
            "permission.requested" => Some(SessionActivity::WaitingForUser),
            "assistant.turn_end" | "abort" | "session.error" | "session.shutdown" | "session.resume" => Some(SessionActivity::Idle),
            _ => None,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `tool_call`s of the recorded session (`agent-acp`'s `real_tool_calls`), by title, as shown.
    fn recorded_calls() -> Vec<(String, agent_api::ShownToolCall)> {
        let updates: Vec<serde_json::Value> = serde_json::from_str(include_str!("../tests/fixtures/tool-calls.json")).unwrap();
        updates
            .iter()
            .filter(|u| u["sessionUpdate"] == "tool_call")
            .map(|u| (u["title"].as_str().unwrap_or_default().to_owned(), Copilot.shown_tool_call(u, &[])))
            .collect()
    }

    #[test]
    fn words_its_recorded_tool_calls() {
        let keep = |label: Option<&str>, command: Option<&str>| agent_api::ShownToolCall::Keep { label: label.map(str::to_owned), command: command.map(str::to_owned) };
        let expected = vec![
            ("Viewing /project/README.md".to_owned(), keep(None, None)),
            ("Viewing /project".to_owned(), keep(None, None)),
            ("Run echo hello".to_owned(), keep(Some("Run echo hello"), Some("echo hello"))),
            ("Read missing.txt".to_owned(), keep(Some("Read missing.txt"), Some("cat missing.txt"))),
            ("apply_patch".to_owned(), keep(None, None)),
            ("apply_patch".to_owned(), keep(None, None)),
        ];
        assert_eq!(recorded_calls(), expected);
    }

    #[test]
    fn keeps_the_agent_contract() {
        agent_api::conformance::check(&Copilot);
    }

    /// A Copilot home with `session`'s event log of these event types.
    fn event_log(name: &str, session: &str, types: &[&str]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("batrak-copilot-activity-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("session-state").join(session);
        std::fs::create_dir_all(&dir).unwrap();
        let lines: Vec<String> = types.iter().map(|t| serde_json::json!({ "type": t, "data": {}, "timestamp": "2026-10-21T13:37:16.143Z" }).to_string()).collect();
        std::fs::write(dir.join("events.jsonl"), lines.join("\n")).unwrap();
        root
    }

    #[test]
    fn a_sessions_last_turn_event_tells_what_it_is_doing() {
        // Arrange
        use SessionActivity::{Idle, Running, WaitingForUser};
        let cases = [
            (&["user.message", "assistant.turn_start"][..], Some(Running), "a turn began"),
            (&["assistant.turn_start", "tool.execution_start", "hook.start"], Some(Running), "its work follows"),
            (&["assistant.turn_start", "permission.requested"], Some(WaitingForUser), "it asks"),
            (&["assistant.turn_start", "permission.requested", "permission.completed"], Some(Running), "answered"),
            (&["assistant.turn_start", "assistant.turn_end", "session.usage_checkpoint"], Some(Idle), "ended"),
            (&["assistant.turn_start", "abort"], Some(Idle), "Esc"),
            (&["assistant.turn_start", "session.error"], Some(Idle), "failed"),
            (&["assistant.turn_start", "session.shutdown"], Some(Idle), "closed"),
            (&["assistant.turn_start", "session.resume"], Some(Idle), "killed mid-turn, resumed at its prompt"),
            (&["session.start", "session.model_change"], None, "no turn yet"),
        ];
        for (types, expected, why) in cases {
            let root = event_log("events", "s-1", types);
            // Act + Assert
            assert_eq!(activity_in(&root, "s-1"), expected, "{why}");
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn only_a_sessions_own_log_is_read() {
        // Arrange
        let root = event_log("own", "s-1", &["assistant.turn_start"]);
        std::fs::write(root.join("events.jsonl"), "{\"type\":\"assistant.turn_start\"}").unwrap();
        // Act + Assert
        assert_eq!(activity_in(&root, "s-2"), None, "another session");
        assert_eq!(activity_in(&root, ".."), None, "not an id: the log above session-state/");
        let _ = std::fs::remove_dir_all(root);
    }

    /// What this machine's records say of session `$BATRAK_COPILOT_SESSION`: `cargo test -p agent-copilot real_session_activity -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_session_activity() {
        let session = std::env::var("BATRAK_COPILOT_SESSION").expect("BATRAK_COPILOT_SESSION");
        let answer = Copilot.session_activity(&session);
        eprintln!("{session}: {answer:?}");
        assert!(answer.is_some(), "no record of {session} told");
    }

    fn config(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn runs_its_cli_without_acp_and_starts_it_with_a_prompt() {
        let launch = Launch { command: "npx".into(), args: strings(&["-y", "@github/copilot@1.0.105", "--acp"]) };
        assert!(Copilot.matches(&launch));
        let cli = Copilot.cli(&launch).unwrap();
        assert_eq!(cli.resume("s").1, ["-y", "@github/copilot@1.0.105", "--resume", "s"]);
        assert_eq!(cli.start_new("s", Some("hi there")).unwrap().1, ["-y", "@github/copilot@1.0.105", "--session-id", "s", "--interactive=hi there"]);
    }

    #[test]
    fn passes_the_picked_model_mode_and_permissions_as_flags() {
        let mode = |m: &str| format!("https://agentclientprotocol.com/protocol/session-modes#{m}");
        assert_eq!(
            Copilot.cli_args(&config(&[("model", "auto"), ("mode", &mode("agent")), ("allow_all", "off")])),
            ["--model", "auto", "--mode", "interactive"]
        );
        assert_eq!(Copilot.cli_args(&config(&[("mode", &mode("plan")), ("allow_all", "on")])), ["--mode", "plan", "--allow-all"]);
        assert_eq!(Copilot.cli_args(&config(&[("mode", &mode("autopilot"))])), ["--mode", "autopilot"]);
        assert!(Copilot.cli_args(&config(&[("mode", &mode("unknown")), ("model", "a b")])).is_empty(), "nothing guessed");
    }

    #[test]
    fn tags_its_mode_urls_by_risk() {
        let mode = |m: &str| format!("https://agentclientprotocol.com/protocol/session-modes#{m}");
        assert_eq!(Copilot.mode_risk(&mode("plan")), Some(ModeRisk::Plan));
        assert_eq!(Copilot.mode_risk(&mode("autopilot")), Some(ModeRisk::Agent));
        assert_eq!(Copilot.mode_risk("plan"), None, "not one of its URLs");
    }

    #[test]
    fn is_updated_through_npm() {
        let update = Copilot.update(&strings(&["-y", "@github/copilot", "--acp"]), "1.0.103").unwrap();
        assert_eq!(update.pin, (1, "@github/copilot@1.0.103".to_owned()));
        assert_eq!(update.download.args, ["cache", "add", "@github/copilot@1.0.103"]);
    }
}
