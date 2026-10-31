//! The hub: which agent crate drives an agent (spec: `docs/specs/agent-plugins.md`). The app asks it
//! for anything agent-specific and never names an agent; this is the one place that lists the crates.

use std::sync::{Arc, OnceLock};

use agent_api::{Agent, Launch};

use crate::config::AgentConfig;

pub struct AgentHub {
    /// Asked in order; the generic agent, last, takes any launch.
    agents: Vec<Box<dyn Agent>>,
}

impl AgentHub {
    /// Every crate the app ships.
    pub fn standard() -> AgentHub {
        AgentHub::of(vec![Box::new(agent_claude::Claude)])
    }

    /// `agents`, then the generic agent.
    pub fn of(mut agents: Vec<Box<dyn Agent>>) -> AgentHub {
        agents.push(Box::new(agent_generic::Generic));
        AgentHub { agents }
    }

    /// The crate for a launch: the first that matches.
    pub fn for_launch(&self, launch: &Launch) -> &dyn Agent {
        self.agents.iter().find(|a| a.matches(launch)).expect("the generic agent matches any launch").as_ref()
    }
}

/// An agents.json entry's launch.
pub fn launch_of(agent: &AgentConfig) -> Launch {
    Launch { command: agent.command.clone(), args: agent.args.clone() }
}

/// The standard hub, for code with no `Sessions` at hand (the agent list).
pub fn standard() -> &'static Arc<AgentHub> {
    static HUB: OnceLock<Arc<AgentHub>> = OnceLock::new();
    HUB.get_or_init(|| Arc::new(AgentHub::standard()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(command: &str, args: &[&str]) -> Launch {
        Launch { command: command.into(), args: agent_api::strings(args) }
    }

    #[test]
    fn picks_the_crate_by_what_an_agent_runs_and_the_generic_one_for_the_rest() {
        let hub = AgentHub::standard();
        assert_eq!(hub.for_launch(&launch("npx", &["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"])).kind(), "claude");
        assert_eq!(hub.for_launch(&launch("my-agent", &["--acp"])).kind(), "generic");
    }
}
