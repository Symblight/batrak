//! Well-known ACP agents Settings offers to add, with the launch the ACP agent registry gives them
//! (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, its `npx` distributions, unpinned so
//! `npx` runs the latest).

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownAgent {
    /// Its id in agents.json, when that's free.
    pub id: &'static str,
    pub name: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
}

pub const KNOWN_AGENTS: &[KnownAgent] = &[
    KnownAgent {
        id: "claude-code",
        name: "Claude Code",
        command: "npx",
        args: &["-y", "@agentclientprotocol/claude-agent-acp"],
    },
    KnownAgent { id: "codex", name: "Codex", command: "npx", args: &["-y", "@agentclientprotocol/codex-acp"] },
    KnownAgent { id: "gemini", name: "Gemini CLI", command: "npx", args: &["-y", "@google/gemini-cli", "--acp"] },
    KnownAgent { id: "copilot", name: "GitHub Copilot", command: "npx", args: &["-y", "@github/copilot", "--acp"] },
    KnownAgent { id: "qwen-code", name: "Qwen Code", command: "npx", args: &["-y", "@qwen-code/qwen-code", "--acp"] },
];

/// The known agent with this id.
pub fn known_agent(id: &str) -> Option<&'static KnownAgent> {
    KNOWN_AGENTS.iter().find(|agent| agent.id == id)
}
