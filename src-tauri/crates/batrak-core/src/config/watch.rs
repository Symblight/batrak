//! Watches the user's agents.json, which no project root covers: an edit in another editor, or its
//! removal, reaches the agent list like an edit in the app.

use std::time::Duration;

use notify_debouncer_full::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};

use super::AgentConfigs;

const DEBOUNCE: Duration = Duration::from_millis(150);

/// Re-reads the user's agents.json whenever it changes on disk and announces it when the
/// agents it gives differ. Watches its folder (created if missing), so the file may come and go;
/// stops when the returned debouncer is dropped. `None` without a user file.
pub fn watch_user_file(
    configs: AgentConfigs,
) -> Result<Option<Debouncer<RecommendedWatcher, NoCache>>, String> {
    let Some(file) = configs.user_file().map(std::path::Path::to_path_buf) else { return Ok(None) };
    let Some(dir) = file.parent().map(std::path::Path::to_path_buf) else { return Ok(None) };
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let name = file.file_name().map(std::ffi::OsStr::to_owned);
    let mut debouncer = new_debouncer_opt(
        DEBOUNCE,
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            // Editors save through a temp file renamed onto it: any event naming the file counts.
            let touched = events.iter().flat_map(|e| &e.paths).any(|p| p.file_name() == name.as_deref());
            if touched && configs.reload_user() {
                configs.announce(None);
            }
        },
        NoCache,
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    debouncer.watch(&dir, RecursiveMode::NonRecursive).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(Some(debouncer))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::mpsc;

    use super::*;
    use crate::notify::testing::OnAgents;

    #[test]
    fn edits_on_disk_reach_the_agent_list() {
        let dir = std::env::temp_dir().join(format!("brama-user-agents-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let file = dir.join("brama").join("agents.json");
        let (tx, rx) = mpsc::channel();
        let told = OnAgents(move |project: Option<&std::path::Path>| tx.send(project.map(std::path::Path::to_path_buf)).unwrap());
        let configs = AgentConfigs::new(Some(file.clone()), None).with_notifier(std::sync::Arc::new(told));
        let _watch = watch_user_file(configs.clone()).unwrap().unwrap();
        let ids = || configs.list(None).agents.into_iter().map(|a| a.id).collect::<Vec<_>>();
        let changed = || assert_eq!(rx.recv_timeout(Duration::from_secs(5)).expect("no change heard within 5s"), None, "the user's file");

        fs::write(&file, r#"{"version":1,"agents":{"a":{"command":"a"},"b":{"command":"b"}}}"#).unwrap();
        changed();
        assert_eq!(ids(), ["a", "b"]);

        fs::write(&file, r#"{"version":1,"agents":{"b":{"command":"b"}}}"#).unwrap();
        changed();
        assert_eq!(ids(), ["b"], "an agent removed in the file leaves the list");

        fs::write(dir.join("brama").join("other.json"), "{}").unwrap();
        fs::remove_file(&file).unwrap();
        changed();
        assert!(ids().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
