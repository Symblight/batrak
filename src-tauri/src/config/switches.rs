//! Which agents the user turned off (`agent-switches.json` in app data), by scope: a project's
//! canonical path, or `""` for the user's agents.json. Not in agents.json, which is the
//! repository's: turning an agent off for yourself must not change a committed file.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Switches {
    version: u32,
    /// Scope → ids of the agents that are off there.
    #[serde(default)]
    off: BTreeMap<String, BTreeSet<String>>,
}

impl Default for Switches {
    fn default() -> Switches {
        Switches { version: 1, off: BTreeMap::new() }
    }
}

/// The key of a scope: the project's path, `""` for no project.
fn key(project: Option<&Path>) -> String {
    project.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

impl Switches {
    /// What a stored file says; one of another version is read as all on.
    pub fn loaded(self) -> Switches {
        if self.version == 1 { self } else { Switches::default() }
    }

    pub fn is_off(&self, project: Option<&Path>, agent_id: &str) -> bool {
        self.off.get(&key(project)).is_some_and(|ids| ids.contains(agent_id))
    }

    /// The agents that are off in a scope.
    pub fn off(&self, project: Option<&Path>) -> BTreeSet<String> {
        self.off.get(&key(project)).cloned().unwrap_or_default()
    }

    /// Turns an agent on or off. Returns whether that changed anything.
    pub fn set(&mut self, project: Option<&Path>, agent_id: &str, enabled: bool) -> bool {
        let key = key(project);
        let changed = if enabled {
            self.off.get_mut(&key).is_some_and(|ids| ids.remove(agent_id))
        } else {
            self.off.entry(key.clone()).or_default().insert(agent_id.to_owned())
        };
        if self.off.get(&key).is_some_and(BTreeSet::is_empty) {
            self.off.remove(&key);
        }
        changed
    }

    /// Drops the entries of agents the scope's file no longer has. Returns whether any went.
    pub fn prune(&mut self, project: Option<&Path>, keep: impl Fn(&str) -> bool) -> bool {
        let key = key(project);
        let Some(ids) = self.off.get_mut(&key) else { return false };
        let before = ids.len();
        ids.retain(|id| keep(id));
        let changed = ids.len() != before;
        if ids.is_empty() {
            self.off.remove(&key);
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_per_scope() {
        let mut switches = Switches::default();
        let project = Path::new("/p");
        assert!(switches.set(Some(project), "codex", false));
        assert!(!switches.set(Some(project), "codex", false), "already off");
        assert!(switches.is_off(Some(project), "codex"));
        assert!(!switches.is_off(None, "codex"), "the user's file is another scope");
        assert!(!switches.is_off(Some(Path::new("/q")), "codex"));
        assert!(switches.set(None, "gemini", false));
        assert_eq!(serde_json::to_value(&switches).unwrap(), serde_json::json!({ "version": 1, "off": { "/p": ["codex"], "": ["gemini"] } }));

        assert!(switches.set(Some(project), "codex", true));
        assert!(!switches.set(Some(project), "codex", true), "already on");
        assert_eq!(serde_json::to_value(&switches).unwrap(), serde_json::json!({ "version": 1, "off": { "": ["gemini"] } }), "no empty scope left");
    }

    #[test]
    fn pruned_to_the_agents_the_file_has() {
        let mut switches = Switches::default();
        switches.set(None, "a", false);
        switches.set(None, "b", false);
        assert!(!switches.prune(Some(Path::new("/p")), |_| false), "another scope");
        assert!(switches.prune(None, |id| id == "a"));
        assert_eq!(switches.off(None).into_iter().collect::<Vec<_>>(), ["a"]);
        assert!(!switches.prune(None, |id| id == "a"));
        assert!(switches.prune(None, |_| false));
        assert_eq!(switches, Switches::default());
    }

    #[test]
    fn another_version_reads_as_all_on() {
        let stored: Switches = serde_json::from_str(r#"{"version":2,"off":{"":["a"]}}"#).unwrap();
        assert!(!stored.loaded().is_off(None, "a"));
    }
}
