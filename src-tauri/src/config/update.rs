//! Updating agents to the ACP registry's version: pin it in agents.json (`AgentConfigs::pin_versions`),
//! tell everyone the agents changed (running sessions hear their launch is outdated), then download
//! the new version into npm's cache, so the next start isn't a cold download. Nothing restarts.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures::future::{FutureExt, Shared};
use serde::Serialize;

use super::{AgentConfigs, Pinned};

/// How long `npm cache add` may take.
const PREFETCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Downloads `<package>@<version>` ahead of the agent's next start. Tests replace it.
pub trait Prefetch: Send + Sync {
    fn prefetch(&self, spec: String) -> BoxFuture<Result<(), String>>;
}

/// An agent `update` pinned, and whether its download went through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Updated {
    pub agent_id: String,
    pub version: String,
    pub downloaded: bool,
}

/// Called after agents.json was written: `emit_changed` in the app.
pub type OnChanged = Arc<dyn Fn(Option<&Path>) + Send + Sync>;

type Key = (Option<PathBuf>, String);
type Running = Shared<BoxFuture<Result<Vec<Updated>, String>>>;

/// Updates agents, one update of an agent at a time. Cheap to clone.
#[derive(Clone)]
pub struct Updater {
    configs: AgentConfigs,
    prefetch: Arc<dyn Prefetch>,
    changed: OnChanged,
    /// A single agent's update, which a second Update of it joins.
    running: Arc<Mutex<HashMap<Key, Running>>>,
}

impl Updater {
    pub fn new(configs: AgentConfigs, prefetch: Arc<dyn Prefetch>, changed: OnChanged) -> Updater {
        Updater { configs, prefetch, changed, running: Arc::default() }
    }

    /// Updates one agent; returns once its download ended. A second call while one runs gets the
    /// first's answer. Empty: it was up to date.
    pub async fn update(&self, project: Option<PathBuf>, agent_id: String) -> Result<Vec<Updated>, String> {
        let key = (project.clone(), agent_id.clone());
        let running = {
            let mut running = lock(&self.running);
            running
                .entry(key.clone())
                .or_insert_with(|| {
                    let this = self.clone();
                    let work: BoxFuture<_> = Box::pin(async move { this.run(project, Some(agent_id)).await });
                    work.shared()
                })
                .clone()
        };
        let result = running.await;
        lock(&self.running).remove(&key);
        result
    }

    /// Updates every agent of the scope with an update: one write, then the downloads one at a time.
    pub async fn update_all(&self, project: Option<PathBuf>) -> Result<Vec<Updated>, String> {
        self.run(project, None).await
    }

    async fn run(&self, project: Option<PathBuf>, agent_id: Option<String>) -> Result<Vec<Updated>, String> {
        let configs = self.configs.clone();
        let scope = project.clone();
        let pinned: Vec<Pinned> = tokio::task::spawn_blocking(move || configs.pin_versions(scope.as_deref(), agent_id.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
        if pinned.is_empty() {
            return Ok(Vec::new());
        }
        (self.changed)(project.as_deref());
        let mut updated = Vec::new();
        for pin in pinned {
            let downloaded = match self.prefetch.prefetch(pin.spec.clone()).await {
                Ok(()) => true,
                Err(e) => {
                    // The pin stays: the next start downloads it anyway.
                    tracing::warn!(agent = %pin.agent_id, "Downloading {} {} failed: {e}", pin.name, pin.version);
                    false
                }
            };
            updated.push(Updated { agent_id: pin.agent_id, version: pin.version, downloaded });
        }
        Ok(updated)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `npm cache add <spec>` in the user's login-shell environment, in its own process group (stopped
/// with the agents on app exit), at most `PREFETCH_TIMEOUT`.
pub struct NpmPrefetch {
    /// Where npm runs and writes its output (`npm-prefetch.log`).
    pub dir: PathBuf,
}

impl Prefetch for NpmPrefetch {
    fn prefetch(&self, spec: String) -> BoxFuture<Result<(), String>> {
        let dir = self.dir.clone();
        Box::pin(async move {
            let log_path = dir.join("npm-prefetch.log");
            let (env, log) = tokio::task::spawn_blocking({
                let log_path = log_path.clone();
                move || -> Result<_, String> {
                    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
                    let env: Vec<(String, String)> =
                        super::env::login_shell_env().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                    let log = std::fs::File::create(&log_path).map_err(|e| format!("{}: {e}", log_path.display()))?;
                    Ok((env, log))
                }
            })
            .await
            .map_err(|e| e.to_string())??;
            let program = if cfg!(windows) { "npm.cmd" } else { "npm" };
            let args = ["cache".to_owned(), "add".to_owned(), spec.clone()];
            let cwd = log_path.parent().unwrap_or(Path::new("."));
            let command = crate::acp::process::AgentCommand { program, args: &args, cwd, env: &env };
            let (mut process, _pipes) = crate::acp::process::spawn(&command, log)?;
            tracing::info!(%spec, "downloading an agent update");
            let status = match tokio::time::timeout(PREFETCH_TIMEOUT, process.wait()).await {
                Ok(status) => status.map_err(|e| e.to_string())?,
                Err(_) => {
                    process.stop().await;
                    return Err("timed out".to_owned());
                }
            };
            if status.success() {
                return Ok(());
            }
            let output = std::fs::read_to_string(&log_path).unwrap_or_default();
            // npm's last lines say why (`npm error 404 …`).
            let mut tail: Vec<&str> = output.lines().rev().map(str::trim).filter(|l| !l.is_empty()).take(3).collect();
            tail.reverse();
            Err(if tail.is_empty() { format!("npm exited with {status}") } else { tail.join(" ") })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::registry::{self, Registry};
    use std::fs;

    /// Records each download; fails those of `fail`, after `delay`.
    #[derive(Default)]
    struct FakePrefetch {
        specs: Mutex<Vec<String>>,
        fail: bool,
        delay: Duration,
    }

    impl Prefetch for FakePrefetch {
        fn prefetch(&self, spec: String) -> BoxFuture<Result<(), String>> {
            lock(&self.specs).push(spec);
            let (fail, delay) = (self.fail, self.delay);
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                if fail { Err("E404 not found".to_owned()) } else { Ok(()) }
            })
        }
    }

    struct Fixture {
        dir: PathBuf,
        file: PathBuf,
        updater: Updater,
        configs: AgentConfigs,
        prefetch: Arc<FakePrefetch>,
        changed: Arc<Mutex<Vec<Option<PathBuf>>>>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture(name: &str, prefetch: FakePrefetch) -> Fixture {
        let dir = std::env::temp_dir().join(format!("brama-update-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("agents.json");
        fs::write(
            &file,
            r#"{"version":1,"agents":{
                "claude":{"name":"Claude","command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp@0.90.0"]},
                "gem":{"name":"Gemini","command":"npx","args":["-y","@google/gemini-cli@0.60.0","--acp"]}
            }}"#,
        )
        .unwrap();
        let configs = AgentConfigs::new(Some(file.clone()), None).with_registry(Registry::of(registry::tests::FIXTURE));
        let prefetch = Arc::new(prefetch);
        let changed = Arc::new(Mutex::new(Vec::new()));
        let heard = Arc::clone(&changed);
        let updater = Updater::new(
            configs.clone(),
            Arc::clone(&prefetch) as Arc<dyn Prefetch>,
            Arc::new(move |project: Option<&Path>| lock(&heard).push(project.map(Path::to_path_buf))),
        );
        Fixture { dir, file, updater, configs, prefetch, changed }
    }

    #[tokio::test]
    async fn an_update_pins_tells_and_downloads() {
        let f = fixture("one", FakePrefetch::default());
        let updated = f.updater.update(None, "claude".into()).await.unwrap();
        assert_eq!(updated, [Updated { agent_id: "claude".into(), version: "0.94.0".into(), downloaded: true }]);
        assert!(fs::read_to_string(&f.file).unwrap().contains("claude-agent-acp@0.94.0"));
        assert_eq!(*lock(&f.prefetch.specs), ["@agentclientprotocol/claude-agent-acp@0.94.0"]);
        assert_eq!(*lock(&f.changed), [None], "the list and sessions follow");
        assert!(f.updater.update(None, "claude".into()).await.unwrap().is_empty(), "up to date");
    }

    #[tokio::test]
    async fn a_failed_download_keeps_the_pin() {
        let f = fixture("fail", FakePrefetch { fail: true, ..FakePrefetch::default() });
        let updated = f.updater.update(None, "gem".into()).await.unwrap();
        assert_eq!(updated, [Updated { agent_id: "gem".into(), version: "0.65.0".into(), downloaded: false }]);
        assert_eq!(f.configs.merged(None).agent("gem").unwrap().args, ["-y", "@google/gemini-cli@0.65.0", "--acp"]);
    }

    #[tokio::test]
    async fn a_second_update_of_an_agent_joins_the_first() {
        let f = fixture("join", FakePrefetch { delay: Duration::from_millis(100), ..FakePrefetch::default() });
        let first = f.updater.update(None, "claude".into());
        let second = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            f.updater.update(None, "claude".into()).await
        };
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap(), second.unwrap(), "the same answer");
        assert_eq!(lock(&f.prefetch.specs).len(), 1, "one download");
    }

    /// Network and npm: `cargo test --lib real_npm -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn real_npm_prefetch_downloads_and_says_why_it_failed() {
        let dir = std::env::temp_dir().join(format!("brama-npm-{}", std::process::id()));
        let npm = NpmPrefetch { dir: dir.clone() };
        npm.prefetch("is-number@7.0.0".to_owned()).await.unwrap();
        let failed = npm.prefetch("@brama-test/no-such-package@0.0.1".to_owned()).await.unwrap_err();
        assert!(failed.contains("404"), "{failed}");
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn update_all_writes_once_and_downloads_one_at_a_time() {
        let f = fixture("all", FakePrefetch::default());
        let updated = f.updater.update_all(None).await.unwrap();
        assert_eq!(updated.iter().map(|u| u.agent_id.as_str()).collect::<Vec<_>>(), ["claude", "gem"]);
        assert_eq!(lock(&f.changed).len(), 1, "one write");
        assert_eq!(lock(&f.prefetch.specs).len(), 2);
        assert!(f.configs.list(None).agents.iter().all(|a| a.update.is_none()));
    }
}
