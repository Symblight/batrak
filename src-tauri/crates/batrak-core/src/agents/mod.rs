//! The hub: which agent crate drives an agent (spec: `docs/specs/agent-plugins.md`). The app asks it
//! for anything agent-specific and never names an agent; this is the one place that lists the crates.

use std::sync::{Arc, OnceLock};

use serde_json::Value;

use agent_api::{Agent, Launch};

use crate::config::AgentConfig;

pub struct AgentHub {
    /// Asked in order; the generic agent, last, takes any launch.
    agents: Vec<Arc<dyn Agent>>,
}

impl AgentHub {
    /// Every crate the app ships.
    pub fn standard() -> AgentHub {
        AgentHub::of(vec![
            Arc::new(agent_claude::Claude),
            Arc::new(agent_copilot::Copilot),
            Arc::new(agent_codex::Codex),
            Arc::new(agent_antigravity::Antigravity),
        ])
    }

    /// `agents`, then the generic agent.
    pub fn of(mut agents: Vec<Arc<dyn Agent>>) -> AgentHub {
        agents.push(Arc::new(agent_generic::Generic));
        AgentHub { agents }
    }

    /// The crate of the registry agent with this id: Brama offers only the registry's agents a crate
    /// names (`Agent::registry_id`).
    pub fn for_registry_id(&self, id: &str) -> Option<&dyn Agent> {
        self.agents.iter().find(|a| a.registry_id() == Some(id)).map(AsRef::as_ref)
    }

    /// The crate for a launch: the first that matches.
    pub fn for_launch(&self, launch: &Launch) -> &dyn Agent {
        self.shared_for_launch(launch).as_ref()
    }

    /// The crate for a launch, to keep (a session keeps its agent's).
    pub fn shared_for_launch(&self, launch: &Launch) -> &Arc<dyn Agent> {
        self.agents.iter().find(|a| a.matches(launch)).expect("the generic agent matches any launch")
    }
}

/// An agents.json entry's launch.
pub fn launch_of(agent: &AgentConfig) -> Launch {
    launch_of_parts(&agent.command, &agent.args)
}

/// A launch of `command` with `args`.
pub fn launch_of_parts(command: &str, args: &[String]) -> Launch {
    Launch { command: command.to_owned(), args: args.to_vec() }
}

/// An agent's config options (ACP `SessionConfigOption`s) with each value of a `mode` option tagged
/// with its risk (`risk`, `Agent::mode_risk`), which the mode picker shows: the page never names an
/// agent's modes.
pub fn tag_modes(agent: &dyn Agent, mut options: Vec<Value>) -> Vec<Value> {
    for option in &mut options {
        let mode = option.get("category").and_then(Value::as_str) == Some("mode");
        let Some(values) = option.get_mut("options").and_then(Value::as_array_mut) else { continue };
        // A value, or a group of values (ACP groups are one level deep).
        let flat = values.iter_mut().flat_map(|v| match v.get("options").is_some() {
            true => v["options"].as_array_mut().map(|g| g.iter_mut().collect()).unwrap_or_default(),
            false => vec![v],
        });
        for value in flat {
            // Only the crate says: a `risk` the agent sent goes.
            let Some(fields) = value.as_object_mut() else { continue };
            fields.remove("risk");
            let risk = fields.get("value").and_then(Value::as_str).filter(|_| mode).and_then(|v| agent.mode_risk(v));
            if let Some(risk) = risk {
                fields.insert("risk".to_owned(), risk.as_str().into());
            }
        }
    }
    options
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
    fn tags_each_mode_value_with_its_risk_and_leaves_the_rest() {
        let options = vec![
            serde_json::json!({ "id": "mode", "category": "mode", "type": "select", "currentValue": "plan",
                "options": [{ "value": "plan", "name": "Plan" }, { "value": "bypassPermissions", "name": "Bypass" }, { "value": "x", "name": "X" }] }),
            serde_json::json!({ "id": "model", "category": "model", "type": "select", "currentValue": "plan",
                "options": [{ "value": "plan", "name": "Not a mode" }] }),
            serde_json::json!({ "id": "mode", "category": "mode", "type": "select", "currentValue": "plan",
                "options": [{ "group": "g", "name": "G", "options": [{ "value": "plan", "name": "Plan" }] }] }),
        ];
        let tagged = tag_modes(&agent_claude::Claude, options);
        assert_eq!(tagged[0]["options"][0]["risk"], "plan");
        assert_eq!(tagged[0]["options"][1]["risk"], "full");
        assert!(tagged[0]["options"][2].get("risk").is_none(), "unknown: untagged");
        assert!(tagged[1]["options"][0].get("risk").is_none(), "only modes");
        assert_eq!(tagged[2]["options"][0]["options"][0]["risk"], "plan", "grouped values too");
        let sent = vec![serde_json::json!({ "id": "mode", "category": "mode", "type": "select", "currentValue": "x",
            "options": [{ "value": "x", "name": "X", "risk": "plan" }] })];
        assert!(tag_modes(&agent_claude::Claude, sent)[0]["options"][0].get("risk").is_none(), "never the agent's own risk");
    }

    #[test]
    fn picks_the_crate_by_what_an_agent_runs_and_the_generic_one_for_the_rest() {
        let hub = AgentHub::standard();
        assert_eq!(hub.for_launch(&launch("npx", &["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"])).kind(), "claude");
        assert_eq!(hub.for_launch(&launch("npx", &["-y", "@github/copilot", "--acp"])).kind(), "copilot");
        assert_eq!(hub.for_launch(&launch("npx", &["-y", "@agentclientprotocol/codex-acp"])).kind(), "codex");
        assert_eq!(hub.for_launch(&launch("/opt/agy_acp_server.par", &[])).kind(), "antigravity");
        assert_eq!(hub.for_launch(&launch("my-agent", &["--acp"])).kind(), "generic");
        assert_eq!(hub.for_registry_id("github-copilot-cli").map(|a| a.kind()), Some("copilot"));
        assert!(hub.for_registry_id("cline").is_none(), "no crate: not offered");
    }
}
