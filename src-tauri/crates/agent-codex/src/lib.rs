//! Codex, run by `@agentclientprotocol/codex-acp`: a library over Codex's own threads. Its CLI is a
//! package of its own (`@openai/codex`), which resumes a thread but can't start one under our id.

use agent_api::{strings, Agent, CliSpec, Install, Update, Launch, ID};

pub const PACKAGE: &str = "@agentclientprotocol/codex-acp";
/// The CLI a session continues in.
const CLI_PACKAGE: &str = "@openai/codex";

pub struct Codex;

impl Agent for Codex {
    fn kind(&self) -> &'static str {
        "codex"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumes_a_thread_in_its_own_cli_and_starts_none() {
        let launch = Launch { command: "/usr/local/bin/npx".into(), args: strings(&["-y", "@agentclientprotocol/codex-acp@2.5.0"]) };
        assert!(Codex.matches(&launch));
        let cli = Codex.cli(&launch).unwrap();
        assert_eq!(cli.resume("t-1"), ("/usr/local/bin/npx".to_owned(), strings(&["-y", "@openai/codex", "resume", "t-1"])));
        assert_eq!(cli.start_new("t-1", None), None);
    }
}
