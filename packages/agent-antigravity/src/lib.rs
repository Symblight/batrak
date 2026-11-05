//! Antigravity: the registry ships it as an archive whose program (`agy_acp_server.par`) the user
//! installs and updates on PATH. Brama never downloads it; it has no CLI to continue a session in.

use std::path::Path;

use agent_api::{Agent, Install, Launch};

/// The archive's program, by its file name.
pub const PROGRAM: &str = "agy_acp_server.par";

pub struct Antigravity;

impl Agent for Antigravity {
    fn kind(&self) -> &'static str {
        "antigravity"
    }

    fn registry_id(&self) -> Option<&'static str> {
        Some("antigravity-acp")
    }

    fn install(&self) -> Option<Install> {
        Some(Install::Program)
    }

    fn matches(&self, launch: &Launch) -> bool {
        Path::new(&launch.command).file_name().is_some_and(|name| name == PROGRAM)
    }

    /// Signed out, its `session/new` / `session/load` opens Google's sign-in in the browser (when
    /// its settings name a login method) before answering AuthRequired.
    fn starts_in_background(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_agent_contract() {
        agent_api::conformance::check(&Antigravity);
    }

    #[test]
    fn is_its_program_wherever_it_is_and_has_no_cli_or_update() {
        let launch = Launch { command: "/opt/agy/agy_acp_server.par".into(), args: Vec::new() };
        assert!(Antigravity.matches(&launch));
        assert!(!Antigravity.matches(&Launch { command: "npx".into(), args: Vec::new() }));
        assert_eq!(Antigravity.cli(&launch), None);
        assert_eq!(Antigravity.update(&[], "1.0"), None, "the user updates it");
        assert!(!Antigravity.starts_in_background(), "started signed out, it opens the browser");
    }
}
