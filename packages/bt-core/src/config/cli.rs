//! An agent's own CLI (`claude`, `codex`, `copilot`), which a session can continue in, in a
//! terminal, instead of the chat: the agent owns the session, so its CLI resumes it by its ACP id.
//! Known for the registry's agents by what they run (the package, not agents.json's id), or set
//! by an agents.json entry's `cli`, which wins.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub use agent_api::{prompt_fits_argv, CliSpec, TerminalMode};
use agent_api::PROMPT;

use super::AgentConfig;

/// agents.json's `cli`: what the agent's CLI runs. No `command`: the agent's own (with `args`,
/// else its args); a `command` without `args` runs with none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Added to resume a session, `{id}` its ACP id.
    pub resume_args: Vec<String>,
    /// Added to start a new session under `{id}`; without them a new session can't start there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_args: Option<Vec<String>>,
    /// Added after `newArgs` to give a new session its first prompt, `{prompt}` the prompt (also
    /// inside an argument, `--interactive={prompt}`); without them the prompt is the last argument.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_args: Option<Vec<String>>,
}

/// The CLI of `agent`: its `cli` entry, else its crate's (`hub`). `config` (a session's picks) becomes flags through the
/// crate of the agent's launch, also under a `cli` entry: what an option means is the agent's.
pub fn cli_for(hub: &crate::agents::AgentHub, agent: &AgentConfig, config: &BTreeMap<String, String>) -> Option<CliSpec> {
    let launch = crate::agents::launch_of(agent);
    let kind = hub.for_launch(&launch);
    let spec = cli_of(kind, &launch, agent)?;
    Some(spec.with_flags(kind.cli_args(config)))
}

/// `agent`'s CLI, no flags.
fn cli_of(kind: &dyn agent_api::Agent, launch: &agent_api::Launch, agent: &AgentConfig) -> Option<CliSpec> {
    if let Some(cli) = &agent.cli {
        let (program, args) = match &cli.command {
            Some(command) => (command.clone(), cli.args.clone().unwrap_or_default()),
            None => (agent.command.clone(), cli.args.clone().unwrap_or_else(|| agent.args.clone())),
        };
        let prompt_args = cli.prompt_args.clone().unwrap_or_else(|| vec![PROMPT.to_owned()]);
        return Some(CliSpec { program, args, resume_args: cli.resume_args.clone(), new_args: cli.new_args.clone(), prompt_args });
    }
    kind.cli(launch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(command: &str, args: &[&str]) -> AgentConfig {
        AgentConfig {
            id: "whatever".into(),
            name: "Agent".into(),
            command: command.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            ..AgentConfig::default()
        }
    }

    fn line(spec: &(String, Vec<String>)) -> String {
        std::iter::once(spec.0.as_str()).chain(spec.1.iter().map(String::as_str)).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn claude_runs_the_adapters_bundled_cli() {
        let cli = cli_for(crate::agents::standard(), &agent("npx", &["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"]), &BTreeMap::new()).unwrap();
        assert_eq!(line(&cli.resume("abc")), "npx -y @agentclientprotocol/claude-agent-acp@0.99.1 --cli --resume abc");
        assert_eq!(line(&cli.start_new("abc", None).unwrap()), "npx -y @agentclientprotocol/claude-agent-acp@0.99.1 --cli --session-id abc");
        assert_eq!(
            cli.start_new("abc", Some("fix the build")).unwrap().1.last().map(String::as_str),
            Some("fix the build"),
            "the first prompt, as its own argument"
        );
        assert_eq!(
            cli.start_new("abc", Some("update")).unwrap().1.last().map(String::as_str),
            Some("update "),
            "a one-word prompt never names one of its commands (`claude update` would run the updater)"
        );
        assert_eq!(cli.mode(), TerminalMode { resume: true, new: true });
    }

    #[test]
    fn codex_runs_the_codex_cli_and_cant_start_a_session_by_id() {
        let cli = cli_for(crate::agents::standard(), &agent("/usr/local/bin/npx", &["-y", "@agentclientprotocol/codex-acp@2.5.0"]), &BTreeMap::new()).unwrap();
        assert_eq!(line(&cli.resume("t-1")), "/usr/local/bin/npx -y @openai/codex resume t-1");
        assert_eq!(cli.start_new("t-1", None), None);
        assert_eq!(cli.mode(), TerminalMode { resume: true, new: false });
    }

    #[test]
    fn copilot_runs_its_launch_without_acp() {
        let cli = cli_for(crate::agents::standard(), &agent("npx", &["-y", "@github/copilot@1.0.105", "--acp"]), &BTreeMap::new()).unwrap();
        assert_eq!(line(&cli.resume("s")), "npx -y @github/copilot@1.0.105 --resume s");
        assert_eq!(line(&cli.start_new("s", None).unwrap()), "npx -y @github/copilot@1.0.105 --session-id s");
        assert_eq!(line(&cli.start_new("s", Some("hi there")).unwrap()), "npx -y @github/copilot@1.0.105 --session-id s --interactive=hi there");
        assert_eq!(
            cli.start_new("s", Some("-x {prompt} {id}")).unwrap().1.last().map(String::as_str),
            Some("--interactive=-x {prompt} {id}"),
            "a prompt starting with a dash stays the option's value, and isn't expanded"
        );
    }

    #[test]
    fn matched_by_what_it_runs_not_its_id() {
        let mut claude = agent("npx", &["-y", "@agentclientprotocol/claude-agent-acp"]);
        claude.id = "my-claude".into();
        assert!(cli_for(crate::agents::standard(), &claude, &BTreeMap::new()).is_some());
        assert_eq!(cli_for(crate::agents::standard(), &agent("npx", &["-y", "@agentclientprotocol/claude-agent-acp-extra"]), &BTreeMap::new()), None, "another package");
        assert_eq!(cli_for(crate::agents::standard(), &agent("agy_acp_server.par", &[]), &BTreeMap::new()), None, "Antigravity has none");
        assert_eq!(cli_for(crate::agents::standard(), &agent("my-agent", &["--acp"]), &BTreeMap::new()), None, "custom");
    }

    #[test]
    fn a_prompt_like_an_option_stays_a_prompt() {
        let claude = cli_for(crate::agents::standard(), &agent("npx", &["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"]), &BTreeMap::new()).unwrap();
        let last = |prompt: &str| claude.start_new("abc", Some(prompt)).unwrap().1.last().cloned();
        assert_eq!(last("-v what changed?").as_deref(), Some(" -v what changed?"), "a leading space: never parsed as a flag");
        assert_eq!(last("--help me").as_deref(), Some(" --help me"));
        let copilot = cli_for(crate::agents::standard(), &agent("npx", &["-y", "@github/copilot", "--acp"]), &BTreeMap::new()).unwrap();
        assert_eq!(
            copilot.start_new("abc", Some("-v now")).unwrap().1.last().map(String::as_str),
            Some("--interactive=-v now"),
            "inside an argument it's already a value"
        );
    }

    #[test]
    fn a_cli_entry_wins_and_reuses_the_launch_without_a_command() {
        let mut custom = agent("my-agent", &["--acp"]);
        custom.cli = Some(CliOverride { resume_args: vec!["--resume".into(), "{id}".into()], ..CliOverride::default() });
        let cli = cli_for(crate::agents::standard(), &custom, &BTreeMap::new()).unwrap();
        assert_eq!(line(&cli.resume("x")), "my-agent --acp --resume x");
        assert_eq!(cli.mode(), TerminalMode { resume: true, new: false });

        let mut claude = agent("npx", &["-y", "@agentclientprotocol/claude-agent-acp"]);
        claude.cli = Some(CliOverride {
            command: Some("claude".into()),
            resume_args: vec!["-r".into(), "{id}".into()],
            new_args: Some(vec!["--session-id={id}".into()]),
            ..CliOverride::default()
        });
        let cli = cli_for(crate::agents::standard(), &claude, &BTreeMap::new()).unwrap();
        assert_eq!(line(&cli.resume("x")), "claude -r x", "a command runs without the launch's args");
        assert_eq!(line(&cli.start_new("x", None).unwrap()), "claude --session-id=x");
        assert_eq!(cli.start_new("x", Some("go on")).unwrap().1.last().map(String::as_str), Some("go on"), "no promptArgs: the prompt goes last");

        let mut args_only = agent("my-agent", &["--acp"]);
        args_only.cli = Some(CliOverride { args: Some(vec!["chat".into()]), resume_args: vec!["{id}".into()], ..CliOverride::default() });
        assert_eq!(line(&cli_for(crate::agents::standard(), &args_only, &BTreeMap::new()).unwrap().resume("x")), "my-agent chat x");
    }
}
