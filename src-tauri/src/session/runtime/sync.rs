//! The agents own the sessions: a sync asks each agent of a project for its sessions there
//! (`session/list`, in a scratch process) and makes them the project's list, kept with what Brama
//! adds (its id, run target, picks, a user title). Brama stores the list, never messages.
//! Removing a session deletes it in its agent (`session/delete`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{watch, Semaphore};

use super::{lock, new_state, Inner, LaunchKey, Launched, SessionState, Sessions, SignInNeed};
use crate::acp::process::AgentProcess;
use crate::acp::{Catalog, CatalogOptions, ConnectError, ListedSession};
use crate::config::AgentConfig;
use crate::session::env::Mode;
use crate::session::{iso_from_millis, iso_now, parse_iso_millis, Session, SessionRecord, SessionStatus, TitleSource};
use crate::storage::JsonFile;

/// How long one agent may take to start and list its sessions.
pub(super) const SYNC_TIMEOUT: Duration = Duration::from_secs(15);
/// Agents asked at once.
const SYNC_CONCURRENCY: usize = 2;
/// The most sessions taken from one agent.
const MAX_LISTED: usize = 500;
/// Activity an agent reports within this long marks a session not running here as active elsewhere.
const ELSEWHERE_MS: i64 = 2 * 60_000;
/// Activity the agent reports up to this long after Brama's own is Brama's own.
const OWN_ACTIVITY_SLACK_MS: i64 = 5_000;

/// How one sync went, agent by agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub project_path: String,
    pub started_at: String,
    pub ended_at: String,
    pub agents: Vec<AgentSync>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSync {
    pub agent_id: String,
    pub agent_name: String,
    pub outcome: SyncOutcome,
    /// `listed`: how many sessions it listed.
    pub count: Option<usize>,
    /// `failed`: why.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncOutcome {
    Listed,
    /// It can't list sessions: only its running ones show.
    Unsupported,
    Off,
    Untrusted,
    SignIn,
    Failed,
}

/// The syncs running, by project; a second call joins the first.
#[derive(Default)]
pub(super) struct SyncState {
    running: Mutex<HashMap<PathBuf, watch::Receiver<Option<SyncReport>>>>,
}

/// Forgets a project's running sync when it ends, however it ends.
struct Running<'a> {
    state: &'a SyncState,
    project: PathBuf,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        lock(&self.state.running).remove(&self.project);
    }
}

impl Sessions {
    /// Lists the sessions of a project's agents (`agent_ids`, else all of them) and makes them
    /// the project's sessions: each agent that's on, trusted and not waiting for a sign-in is
    /// asked in a scratch process, two at a time. A session an agent no longer lists, and that
    /// isn't running here, goes. The project's sessions are then in [`Sessions::list`].
    pub async fn sync(&self, project: &Path, agent_ids: Option<&[String]>) -> SyncReport {
        let joined = lock(&self.inner.sync.running).get(project).cloned();
        if let Some(mut receiver) = joined {
            let report = receiver.wait_for(Option::is_some).await.ok().and_then(|report| report.clone());
            return report.unwrap_or_else(|| empty_report(project));
        }
        let (sender, receiver) = watch::channel(None);
        let joined = {
            let mut running = lock(&self.inner.sync.running);
            let joined = running.get(project).cloned();
            if joined.is_none() {
                running.insert(project.to_path_buf(), receiver);
            }
            joined
        };
        if let Some(mut receiver) = joined {
            // Another one started meanwhile.
            let report = receiver.wait_for(Option::is_some).await.ok().and_then(|report| report.clone());
            return report.unwrap_or_else(|| empty_report(project));
        }
        let _running = Running { state: &self.inner.sync, project: project.to_path_buf() };
        let report = self.inner.run_sync(project, agent_ids).await;
        sender.send_replace(Some(report.clone()));
        report
    }
}

fn empty_report(project: &Path) -> SyncReport {
    let now = iso_now();
    SyncReport { project_path: project.to_string_lossy().into_owned(), started_at: now.clone(), ended_at: now, agents: Vec::new() }
}

/// What listing one agent gave.
struct Listing {
    can_list: bool,
    sessions: Vec<ListedSession>,
    /// Every page of every folder was read.
    complete: bool,
}

impl Inner {
    async fn run_sync(self: &Arc<Self>, project: &Path, only: Option<&[String]>) -> SyncReport {
        let started_at = iso_now();
        let merged = self.opts.configs.merged(Some(project));
        let folders = self.sync_folders(project);
        let semaphore = Arc::new(Semaphore::new(SYNC_CONCURRENCY));
        let mut pending = Vec::new();
        for agent in merged.agents.iter().filter(|a| only.is_none_or(|ids| ids.contains(&a.id))) {
            let skipped = if merged.enabled(&agent.id).is_none() {
                Some(SyncOutcome::Off)
            } else if self.check_trust(project, &merged, &agent.id).is_err() {
                Some(SyncOutcome::Untrusted)
            } else if self.waits_for_sign_in(&LaunchKey::of(agent)) {
                Some(SyncOutcome::SignIn)
            } else {
                None
            };
            let task = skipped.is_none().then(|| {
                let (inner, agent, folders, semaphore) = (Arc::clone(self), agent.clone(), folders.clone(), Arc::clone(&semaphore));
                tokio::spawn(async move {
                    let _permit = semaphore.acquire().await;
                    tokio::time::timeout(inner.opts.sync_timeout, inner.list_agent(&agent, &folders)).await
                })
            });
            pending.push((agent.clone(), skipped, task));
        }
        let mut agents = Vec::new();
        for (agent, skipped, task) in pending {
            let mut sync = AgentSync { agent_id: agent.id.clone(), agent_name: agent.name.clone(), outcome: SyncOutcome::Failed, count: None, error: None };
            let answer = match (skipped, task) {
                (Some(outcome), _) => {
                    sync.outcome = outcome;
                    agents.push(sync);
                    continue;
                }
                (None, Some(task)) => task.await.map_err(|e| e.to_string()),
                (None, None) => unreachable!("an agent not skipped is asked"),
            };
            match answer {
                Ok(Ok(Ok(listing))) if !listing.can_list => sync.outcome = SyncOutcome::Unsupported,
                Ok(Ok(Ok(listing))) => {
                    sync.outcome = SyncOutcome::Listed;
                    sync.count = Some(self.apply_listing(project, &agent, &folders, listing));
                }
                Ok(Ok(Err(ConnectError::SignIn { methods, .. }))) => {
                    let need = SignInNeed { key: LaunchKey::of(&agent), agent_id: agent.id.clone(), agent_name: agent.name.clone(), methods };
                    lock(&self.sign_ins_needed).insert(need.key.clone(), need);
                    sync.outcome = SyncOutcome::SignIn;
                }
                Ok(Ok(Err(ConnectError::Failed(e)))) | Err(e) => sync.error = Some(e),
                Ok(Err(_)) => sync.error = Some(format!("{} didn't answer within {}s", agent.name, self.opts.sync_timeout.as_secs_f32())),
            }
            if let Some(e) = &sync.error {
                tracing::info!(agent = %agent.id, "listing sessions failed: {e}");
            }
            agents.push(sync);
        }
        self.persist();
        let report = SyncReport { project_path: project.to_string_lossy().into_owned(), started_at, ended_at: iso_now(), agents };
        tracing::info!(project = %project.display(), agents = ?report.agents.iter().map(|a| (&a.agent_id, a.outcome, a.count)).collect::<Vec<_>>(), "sessions synced");
        report
    }

    fn waits_for_sign_in(&self, key: &LaunchKey) -> bool {
        lock(&self.sign_ins_needed).contains_key(key) || lock(&self.signing_in).contains_key(key)
    }

    /// The folders a project's sessions run in: the project, and its worktree sessions' folders.
    fn sync_folders(&self, project: &Path) -> Vec<PathBuf> {
        let mut folders = vec![project.to_path_buf()];
        for record in self.known().into_iter().filter(|r| r.project_path == project && r.mode == Mode::Worktree) {
            if !folders.contains(&record.agent_cwd) {
                folders.push(record.agent_cwd);
            }
        }
        folders
    }

    /// Starts `agent` in the probe folder for its session store only.
    async fn open_catalog(&self, agent: &AgentConfig) -> Result<(Catalog, Option<AgentProcess>), ConnectError> {
        let Launched { process, writer, reader } = self.scratch_launch(agent).await?;
        let opts = CatalogOptions { agent_name: agent.name.clone(), initialize_timeout: self.opts.initialize_timeout };
        match Catalog::open(writer, reader, opts).await {
            Ok(catalog) => Ok((catalog, process)),
            Err(e) => {
                stop(process).await;
                Err(e)
            }
        }
    }

    /// The agent's sessions in `folders`; its process is stopped after.
    async fn list_agent(&self, agent: &AgentConfig, folders: &[PathBuf]) -> Result<Listing, ConnectError> {
        let (catalog, process) = self.open_catalog(agent).await?;
        if let Some(version) = catalog.agent_version() {
            self.opts.configs.note_version(&agent.id, version);
        }
        let listing = async {
            if !catalog.capabilities().list {
                return Ok(Listing { can_list: false, sessions: Vec::new(), complete: true });
            }
            let mut listing = Listing { can_list: true, sessions: Vec::new(), complete: true };
            for folder in folders {
                if listing.sessions.len() >= MAX_LISTED {
                    listing.complete = false;
                    break;
                }
                let listed = catalog.list_sessions(folder, MAX_LISTED - listing.sessions.len()).await?;
                listing.complete &= listed.complete;
                listing.sessions.extend(listed.sessions);
            }
            Ok(listing)
        }
        .await;
        drop(catalog);
        stop(process).await;
        listing
    }

    /// An agent's list becomes its sessions of the project: each one known here is brought up to
    /// date, each new one listed (unless hidden); when the list is complete, a
    /// session it no longer has goes unless it runs here. Returns how many it listed.
    fn apply_listing(&self, project: &Path, agent: &AgentConfig, folders: &[PathBuf], listing: Listing) -> usize {
        let in_folders = |cwd: &Path| folders.iter().any(|f| f == cwd) || dunce::canonicalize(cwd).is_ok_and(|c| folders.contains(&c));
        let mut sessions = lock(&self.sessions);
        let hidden = lock(&self.hidden);
        let mut seen = HashSet::new();
        for item in listing.sessions.iter().filter(|s| in_folders(&s.cwd)) {
            if !seen.insert(item.session_id.clone()) {
                continue;
            }
            let known = sessions.values().find(|s| lock(&s.record).acp_session_id.as_deref() == Some(&item.session_id)).cloned();
            if let Some(state) = known {
                update_from_list(&state, item);
                continue;
            }
            if hidden.contains_key(&item.session_id) {
                continue;
            }
            let record = listed_record(project, agent, item);
            if sessions.contains_key(&record.session_id) {
                continue;
            }
            let state = Arc::new(new_state(record));
            update_from_list(&state, item);
            sessions.insert(state.id.clone(), state);
        }
        if listing.complete {
            sessions.retain(|_, state| {
                let record = lock(&state.record);
                let gone = record.project_path == project
                    && record.agent_id == agent.id
                    && record.acp_session_id.as_ref().is_some_and(|id| !seen.contains(id))
                    && !record.status.is_active()
                    && !state.turn_running.load(std::sync::atomic::Ordering::SeqCst);
                !gone
            });
        }
        seen.len()
    }

    /// Deletes a removed session in its agent (`session/delete`); `false` when it couldn't (the
    /// agent can't delete, can't run, or failed): it's then hidden in Brama instead.
    pub(super) async fn delete_in_agent(&self, record: &SessionRecord, acp_id: &str) -> bool {
        let agent = match self.startable(Some(&record.project_path), &record.agent_id) {
            Ok(agent) => agent,
            Err(e) => {
                tracing::info!(session = %record.session_id, "not deleted in its agent, hidden: {e}");
                return false;
            }
        };
        let deleted = tokio::time::timeout(self.opts.sync_timeout, async {
            let (catalog, process) = self.open_catalog(&agent).await?;
            let deleted = match catalog.capabilities().delete {
                true => catalog.delete_session(acp_id).await.map(|()| true),
                false => Ok(false),
            };
            drop(catalog);
            stop(process).await;
            deleted
        })
        .await;
        match deleted {
            Ok(Ok(true)) => {
                tracing::info!(session = %record.session_id, agent = %agent.id, "session deleted in its agent");
                true
            }
            Ok(Ok(false)) => {
                tracing::info!(session = %record.session_id, agent = %agent.id, "the agent can't delete sessions: hidden");
                false
            }
            Ok(Err(e)) => {
                tracing::warn!("{} didn't delete the session ({e}); it's hidden in Brama", agent.name);
                false
            }
            Err(_) => {
                tracing::warn!("{} didn't delete the session in time; it's hidden in Brama", agent.name);
                false
            }
        }
    }
}

async fn stop(process: Option<AgentProcess>) {
    if let Some(mut process) = process {
        process.stop().await;
    }
}

/// The id of a session first seen in a list: its agent's and the agent's session id.
fn listed_id(agent_id: &str, acp_id: &str) -> String {
    let safe = |s: &str| s.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' }).collect::<String>();
    format!("{}~{}", safe(agent_id), safe(acp_id))
}

/// A session first seen in its agent's list: local, in the listed folder.
fn listed_record(project: &Path, agent: &AgentConfig, item: &ListedSession) -> SessionRecord {
    let at = item.updated_at.as_deref().and_then(parse_iso_millis).map_or_else(iso_now, iso_from_millis);
    SessionRecord {
        session_id: listed_id(&agent.id, &item.session_id),
        acp_session_id: Some(item.session_id.clone()),
        agent_id: agent.id.clone(),
        mode: Mode::Local,
        agent_cwd: project.to_path_buf(),
        project_path: project.to_path_buf(),
        title: String::new(),
        title_source: TitleSource::Agent,
        agent_title: None,
        status: SessionStatus::Stopped,
        created_at: at,
        last_activity_at: None,
        config: Default::default(),
        worktree_path: None,
        branch: None,
        base_commit: None,
        launch: None,
        agent_name: Some(agent.name.clone()),
        hidden: false,
    }
}

/// The agent's title (unless the user named it) and its last activity.
fn update_from_list(state: &SessionState, item: &ListedSession) {
    let title = item.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);
    let updated = item.updated_at.as_deref().and_then(parse_iso_millis);
    let mut record = lock(&state.record);
    if title.is_some() {
        record.agent_title.clone_from(&title);
    }
    match title {
        Some(title) if record.title_source != TitleSource::User => {
            record.title = title;
            record.title_source = TitleSource::Agent;
        }
        _ if record.title.is_empty() => "Untitled session".clone_into(&mut record.title),
        _ => {}
    }
    if let Some(updated) = updated {
        let ours = record.last_activity_at.as_deref().and_then(parse_iso_millis);
        if ours.is_none_or(|ours| updated > ours) {
            record.last_activity_at = Some(iso_from_millis(updated));
        }
        *lock(&state.listed_activity) = Some(updated);
    }
}

/// A session as the list shows it at `now` (ms).
pub(super) fn listed(state: &SessionState, now: i64) -> Session {
    let mut session = Session::from(&*lock(&state.record));
    let ours = *lock(&state.active_here);
    session.active_elsewhere = !session.status.is_active()
        && lock(&state.listed_activity).is_some_and(|at| {
            now - at < ELSEWHERE_MS && ours.is_none_or(|ours| at > ours + OWN_ACTIVITY_SLACK_MS)
        });
    session
}

/// A session as stored: no status (none runs after a relaunch).
pub(super) fn stored(record: SessionRecord) -> SessionRecord {
    SessionRecord { status: SessionStatus::Stopped, ..record }
}

/// The stored sessions (listed again at launch, `stopped`) and the hidden ones, by ACP session
/// id. Transcripts of older versions are deleted: messages are the agent's.
pub(super) fn load(store: &JsonFile, data_dir: &Path) -> (Vec<SessionRecord>, HashMap<String, SessionRecord>) {
    let dirs = std::fs::read_dir(data_dir.join("sessions")).into_iter().flatten().filter_map(Result::ok);
    for dir in dirs {
        let _ = std::fs::remove_file(dir.path().join("transcript.jsonl"));
    }
    let (hidden, listed): (Vec<SessionRecord>, Vec<SessionRecord>) = store.load::<Vec<SessionRecord>>().into_iter().partition(|r| r.hidden);
    let hidden = hidden.into_iter().filter_map(|r| Some((r.acp_session_id.clone()?, r))).collect();
    (listed.into_iter().map(stored).collect(), hidden)
}
