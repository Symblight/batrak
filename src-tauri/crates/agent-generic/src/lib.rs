//! Any ACP agent no other crate drives: plain ACP through the trait's defaults, no CLI. The hub
//! asks it last, so it takes what the others don't.

use agent_api::{Agent, Launch};

pub struct Generic;

impl Agent for Generic {
    fn kind(&self) -> &'static str {
        "generic"
    }

    fn matches(&self, _launch: &Launch) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_any_launch_and_has_no_cli() {
        let launch = Launch { command: "my-agent".into(), args: vec!["--acp".into()] };
        assert!(Generic.matches(&launch));
        assert_eq!(Generic.cli(&launch), None);
        assert!(Generic.cli_args(&Default::default()).is_empty());
    }
}
