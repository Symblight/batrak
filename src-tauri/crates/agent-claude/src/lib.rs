//! Claude Code, run by `@agentclientprotocol/claude-agent-acp`. Its `--cli` passes every other
//! argument to the native `claude`, which continues a session by its ACP id.

use std::collections::BTreeMap;

use agent_api::{is_flag_value, strings, Agent, CliSpec, Install, Update, Launch, ID, PROMPT};

/// The adapter's npm package.
pub const PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";

pub struct Claude;

impl Agent for Claude {
    fn kind(&self) -> &'static str {
        "claude"
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

#[cfg(test)]
mod tests {
    use super::*;

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
