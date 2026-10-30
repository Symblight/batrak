//! An agent's own CLI (`claude`, `codex`, `copilot`), which a session can continue in, in a
//! terminal, instead of the chat: the agent owns the session, so its CLI resumes it by its ACP id.
//! Known for the registry's agents by what they run (the package, not agents.json's id), or set
//! by an agents.json entry's `cli`, which wins.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::AgentConfig;

/// Stands for the ACP session id in `resumeArgs` / `newArgs`.
const ID: &str = "{id}";
/// Stands for a new session's first prompt in `promptArgs`.
const PROMPT: &str = "{prompt}";

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

/// How an agent's CLI runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliSpec {
    pub program: String,
    pub args: Vec<String>,
    pub resume_args: Vec<String>,
    pub new_args: Option<Vec<String>>,
    /// See `CliOverride::prompt_args`.
    pub prompt_args: Vec<String>,
}

/// What the agent list says about an agent's CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMode {
    /// It continues a session by id.
    pub resume: bool,
    /// It starts a new one under an id Brama chooses.
    pub new: bool,
}

impl CliSpec {
    /// The command line that continues ACP session `id`.
    pub fn resume(&self, id: &str) -> (String, Vec<String>) {
        (self.program.clone(), self.with(&self.resume_args, id))
    }

    /// The command line that starts a new session under `id`, with `prompt` as its first message;
    /// `None` when the CLI can't.
    pub fn start_new(&self, id: &str, prompt: Option<&str>) -> Option<(String, Vec<String>)> {
        let extra = self.new_args.as_ref()?;
        let mut args = self.with(extra, id);
        if let Some(prompt) = prompt.filter(|p| !p.trim().is_empty()) {
            // One word could name one of the CLI's commands (`claude update` runs the updater); a
            // trailing space keeps it a prompt.
            let prompt = if prompt.contains(char::is_whitespace) { prompt.to_owned() } else { format!("{prompt} ") };
            // One pass over the template: what the prompt holds is never expanded.
            args.extend(self.prompt_args.iter().map(|a| a.replacen(PROMPT, &prompt, 1)));
        }
        Some((self.program.clone(), args))
    }

    pub fn mode(&self) -> TerminalMode {
        TerminalMode { resume: true, new: self.new_args.is_some() }
    }

    fn with(&self, extra: &[String], id: &str) -> Vec<String> {
        self.args.iter().cloned().chain(extra.iter().map(|a| a.replace(ID, id))).collect()
    }
}

/// The CLI of `agent`: its `cli` entry, else the one of the registry agent it runs (by package).
pub fn cli_for(agent: &AgentConfig) -> Option<CliSpec> {
    if let Some(cli) = &agent.cli {
        let (program, args) = match &cli.command {
            Some(command) => (command.clone(), cli.args.clone().unwrap_or_default()),
            None => (agent.command.clone(), cli.args.clone().unwrap_or_else(|| agent.args.clone())),
        };
        let prompt_args = cli.prompt_args.clone().unwrap_or_else(|| vec![PROMPT.to_owned()]);
        return Some(CliSpec { program, args, resume_args: cli.resume_args.clone(), new_args: cli.new_args.clone(), prompt_args });
    }
    if Path::new(&agent.command).file_stem().is_none_or(|stem| stem != "npx") {
        return None;
    }
    let (at, spec) = super::registry::package_arg(&agent.args)?;
    let strings = |args: &[&str]| args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
    let (args, resume_args, new_args, prompt_args) = match super::registry::split_spec(spec).0 {
        // The adapter bundles Claude Code, which `--cli` runs (as its terminal sign-in does).
        "@agentclientprotocol/claude-agent-acp" => {
            let args = agent.args.iter().cloned().chain(["--cli".to_owned()]).collect();
            (args, strings(&["--resume", ID]), Some(strings(&["--session-id", ID])), strings(&[PROMPT]))
        }
        // The adapter is a library over Codex's own threads; its CLI is a package of its own.
        "@agentclientprotocol/codex-acp" => {
            let before = agent.args[..at].iter().filter(|a| a.starts_with('-'));
            (before.cloned().chain(["@openai/codex".to_owned()]).collect(), strings(&["resume", ID]), None, Vec::new())
        }
        // The CLI itself, which `--acp` turns into the agent.
        "@github/copilot" => {
            let args = agent.args.iter().filter(|a| *a != "--acp").cloned().collect();
            (args, strings(&["--resume", ID]), Some(strings(&["--session-id", ID])), vec![format!("--interactive={PROMPT}")])
        }
        _ => return None,
    };
    Some(CliSpec { program: agent.command.clone(), args, resume_args, new_args, prompt_args })
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
        let cli = cli_for(&agent("npx", &["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"])).unwrap();
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
        let cli = cli_for(&agent("/usr/local/bin/npx", &["-y", "@agentclientprotocol/codex-acp@2.5.0"])).unwrap();
        assert_eq!(line(&cli.resume("t-1")), "/usr/local/bin/npx -y @openai/codex resume t-1");
        assert_eq!(cli.start_new("t-1", None), None);
        assert_eq!(cli.mode(), TerminalMode { resume: true, new: false });
    }

    #[test]
    fn copilot_runs_its_launch_without_acp() {
        let cli = cli_for(&agent("npx", &["-y", "@github/copilot@1.0.105", "--acp"])).unwrap();
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
        assert!(cli_for(&claude).is_some());
        assert_eq!(cli_for(&agent("npx", &["-y", "@agentclientprotocol/claude-agent-acp-extra"])), None, "another package");
        assert_eq!(cli_for(&agent("agy_acp_server.par", &[])), None, "Antigravity has none");
        assert_eq!(cli_for(&agent("my-agent", &["--acp"])), None, "custom");
    }

    #[test]
    fn a_cli_entry_wins_and_reuses_the_launch_without_a_command() {
        let mut custom = agent("my-agent", &["--acp"]);
        custom.cli = Some(CliOverride { resume_args: vec!["--resume".into(), "{id}".into()], ..CliOverride::default() });
        let cli = cli_for(&custom).unwrap();
        assert_eq!(line(&cli.resume("x")), "my-agent --acp --resume x");
        assert_eq!(cli.mode(), TerminalMode { resume: true, new: false });

        let mut claude = agent("npx", &["-y", "@agentclientprotocol/claude-agent-acp"]);
        claude.cli = Some(CliOverride {
            command: Some("claude".into()),
            resume_args: vec!["-r".into(), "{id}".into()],
            new_args: Some(vec!["--session-id={id}".into()]),
            ..CliOverride::default()
        });
        let cli = cli_for(&claude).unwrap();
        assert_eq!(line(&cli.resume("x")), "claude -r x", "a command runs without the launch's args");
        assert_eq!(line(&cli.start_new("x", None).unwrap()), "claude --session-id=x");
        assert_eq!(cli.start_new("x", Some("go on")).unwrap().1.last().map(String::as_str), Some("go on"), "no promptArgs: the prompt goes last");

        let mut args_only = agent("my-agent", &["--acp"]);
        args_only.cli = Some(CliOverride { args: Some(vec!["chat".into()]), resume_args: vec!["{id}".into()], ..CliOverride::default() });
        assert_eq!(line(&cli_for(&args_only).unwrap().resume("x")), "my-agent chat x");
    }
}
