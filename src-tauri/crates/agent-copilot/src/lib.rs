//! GitHub Copilot: the `copilot` CLI, which `--acp` turns into the agent; without it, the same
//! program is the CLI a session continues in.

use std::collections::BTreeMap;

use agent_api::{is_flag_value, strings, Agent, CliSpec, Install, Update, Launch, ID, PROMPT};

pub const PACKAGE: &str = "@github/copilot";

pub struct Copilot;

impl Agent for Copilot {
    fn kind(&self) -> &'static str {
        "copilot"
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn is_updated_through_npm() {
        let update = Copilot.update(&strings(&["-y", "@github/copilot", "--acp"]), "1.0.103").unwrap();
        assert_eq!(update.pin, (1, "@github/copilot@1.0.103".to_owned()));
        assert_eq!(update.download.args, ["cache", "add", "@github/copilot@1.0.103"]);
    }
}
