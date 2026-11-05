use std::sync::Arc;

use tauri::State;

use crate::config::registry::RegistryState;
use crate::config::update::{Updated, Updater};
use crate::config::view::{AgentsView, Filter, RowState};
use crate::notify::{SignInEvent, SignInProgress};
use crate::session::program::ProgramRunner;
use crate::terminal::WindowRunner;
use crate::config::{AgentConfigs, AgentList, LaunchConfig, NewAgent, Removal, UntrustedAgent};

use super::blocking;

/// The agents of a project (its `.brama/agents.json`; the user's file without one), without their
/// environment. `errors` lists files that don't parse.
#[tauri::command]
pub async fn agents_list(sessions: State<'_, crate::session::Sessions>, project_path: Option<String>) -> Result<AgentList, String> {
    let sessions = sessions.inner().clone();
    blocking(move || {
        let project = match project_path {
            Some(path) => Some(dunce::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?),
            None => None,
        };
        Ok(sessions.agent_list(project.as_deref()))
    })
    .await?
}

/// The agents.json "Add ACP agent…" opens: the project's `.brama/agents.json`, or the user's
/// without a project; created with the defaults when missing. Absolute path.
#[tauri::command]
pub async fn agents_config_file(configs: State<'_, AgentConfigs>, project_path: Option<String>) -> Result<String, String> {
    let configs = configs.inner().clone();
    blocking(move || {
        let project = match project_path {
            Some(path) => Some(dunce::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?),
            None => None,
        };
        let file = configs.editable_file(project.as_deref())?;
        // Same form as the roots, so `read_file` / `write_file` recognize it.
        Ok(dunce::canonicalize(&file).unwrap_or(file).to_string_lossy().into_owned())
    })
    .await?
}

/// An agent's config options (models, thought levels, modes) before it has a session: it's started
/// in a scratch folder, asked, and stopped. ACP `SessionConfigOption`s.
#[tauri::command]
pub async fn agents_probe_options(
    sessions: State<'_, crate::session::Sessions>,
    project_path: Option<String>,
    agent_id: String,
) -> Result<crate::session::Probed, String> {
    let project = match project_path {
        Some(path) => Some(dunce::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?),
        None => None,
    };
    sessions.probe_options(project.as_deref(), &agent_id).await
}

/// Signs an agent in with one of the methods it offered: an `agent` method in the backend (the
/// agent opens the browser), a `terminal` / `command` one as a login in a terminal this window
/// owns, whose tab the page opens (the returned `LoginTab`; `None` to a window joining a login
/// another one started); exit 0 there signs it in, closing it cancels. Returns once it started;
/// how it went comes as `agents://sign-in` to every window (`state`: `waiting`, then `done` /
/// `failed` / `cancelled`; `terminal`: the login's tab, which only its own window can reach),
/// and a success also as `agents://changed`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agents_sign_in(
    window: tauri::Window,
    configs: State<'_, AgentConfigs>,
    sessions: State<'_, crate::session::Sessions>,
    terminals: State<'_, crate::terminal::Terminals>,
    project_path: Option<String>,
    agent_id: String,
    method_id: Option<String>,
) -> Result<Option<crate::session::LoginTab>, String> {
    let project = project_of(project_path)?;
    let sessions = sessions.inner().clone();
    let runner: Arc<dyn ProgramRunner> = Arc::new(WindowRunner::new(terminals.inner().clone(), window.label()));
    let sign_in = sessions.sign_in(project.as_deref(), &agent_id, method_id.as_deref(), Arc::clone(&runner)).await?;
    // A sign-in joined from another window keeps its login in the window that started it.
    let tab = sign_in.tab.clone().filter(|tab| runner.owns(&tab.terminal_id));
    let path = project.as_ref().map(|p| p.to_string_lossy().into_owned());
    let terminal = sign_in.tab.clone();
    let event = move |state: SignInProgress, message: Option<String>| SignInEvent {
        project_path: path.clone(),
        agent_id: agent_id.clone(),
        state,
        message,
        terminal: terminal.clone(),
    };
    let configs = configs.inner().clone();
    configs.notifier().sign_in(&event(SignInProgress::Waiting, None));
    tauri::async_runtime::spawn(async move {
        let name = sign_in.agent_name.clone();
        let ended = match sign_in.end().await {
            crate::session::SignInEnd::Done => {
                configs.announce(project.as_deref());
                event(SignInProgress::Done, Some(format!("Signed in to {name}")))
            }
            crate::session::SignInEnd::Failed(e) => event(SignInProgress::Failed, Some(e)),
            crate::session::SignInEnd::Cancelled => event(SignInProgress::Cancelled, None),
        };
        configs.notifier().sign_in(&ended);
    });
    Ok(tab)
}

/// Stops an agent's sign-in (closing its login's terminal); `false` when none ran.
#[tauri::command]
pub async fn agents_sign_in_cancel(
    sessions: State<'_, crate::session::Sessions>,
    terminals: State<'_, crate::terminal::Terminals>,
    project_path: Option<String>,
    agent_id: String,
) -> Result<bool, String> {
    let Some(cancelled) = sessions.cancel_sign_in(project_of(project_path)?.as_deref(), &agent_id) else { return Ok(false) };
    if let Some(id) = cancelled.terminal_id {
        terminals.close(&[id]);
    }
    Ok(true)
}

/// The project's agents that run what its agents.json chose and wait for the user's trust, as the
/// trust dialog shows them.
#[tauri::command]
pub async fn agents_untrusted(
    configs: State<'_, AgentConfigs>,
    project_path: String,
) -> Result<Vec<UntrustedAgent>, String> {
    let configs = configs.inner().clone();
    blocking(move || {
        let project = dunce::canonicalize(&project_path).map_err(|e| format!("{project_path}: {e}"))?;
        Ok(configs.untrusted(&project))
    })
    .await?
}

/// Trusts what the project's agents.json runs for some agents (each `launch` as `agents_untrusted`
/// showed it); refused, all of them, when the file has changed since.
#[tauri::command]
pub async fn agents_trust(
    configs: State<'_, AgentConfigs>,
    project_path: String,
    launches: Vec<LaunchConfig>,
) -> Result<(), String> {
    let configs = configs.inner().clone();
    blocking(move || {
        let project = dunce::canonicalize(&project_path).map_err(|e| format!("{project_path}: {e}"))?;
        configs.trust(&project, &launches)
    })
    .await?
}

/// Adds a supported registry agent (Claude, Codex, Copilot or Antigravity) with the registry's launch to
/// the project's agents.json (trusted), or the user's without a project; returns its id.
#[tauri::command]
pub async fn agents_add(
    configs: State<'_, AgentConfigs>,
    project_path: Option<String>,
    agent: NewAgent,
) -> Result<String, String> {
    let configs = configs.inner().clone();
    blocking(move || configs.add_agent(project_of(project_path)?.as_deref(), &agent)).await?
}

/// Canonical form of a project path the page sent.
fn project_of(project_path: Option<String>) -> Result<Option<std::path::PathBuf>, String> {
    project_path
        .map(|path| dunce::canonicalize(&path).map_err(|e| format!("{path}: {e}")))
        .transpose()
}

/// Rewrites an agent's name and launch from Settings' edit form.
#[tauri::command]
pub async fn agents_update(
    configs: State<'_, AgentConfigs>,
    project_path: Option<String>,
    agent_id: String,
    agent: NewAgent,
) -> Result<(), String> {
    let configs = configs.inner().clone();
    blocking(move || configs.update_agent(project_of(project_path)?.as_deref(), &agent_id, &agent)).await??;
    Ok(())
}

/// Makes an agent the default for new sessions (the project's agents.json, else the user's).
#[tauri::command]
pub async fn agents_set_default(
    configs: State<'_, AgentConfigs>,
    project_path: Option<String>,
    agent_id: String,
) -> Result<(), String> {
    let configs = configs.inner().clone();
    blocking(move || configs.set_default(project_of(project_path)?.as_deref(), &agent_id)).await??;
    Ok(())
}

/// Removes an agent's entry from the project's agents.json (the user's without one); `agents_restore` with
/// the returned token undoes it.
#[tauri::command]
pub async fn agents_remove(
    configs: State<'_, AgentConfigs>,
    project_path: Option<String>,
    agent_id: String,
) -> Result<Removal, String> {
    let configs = configs.inner().clone();
    let removal = blocking(move || configs.remove_agent(project_of(project_path)?.as_deref(), &agent_id)).await??;
    Ok(removal)
}

/// Puts back what an `agents_remove` took out.
#[tauri::command]
pub async fn agents_restore(configs: State<'_, AgentConfigs>, token: u64) -> Result<(), String> {
    let configs = configs.inner().clone();
    blocking(move || configs.restore_agent(token)).await??;
    Ok(())
}

/// Turns an agent of the project's agents.json (the user's without one) on or off for this user;
/// the file isn't touched. Returns how many of the project's sessions turning it off stops (each
/// after its running turn).
#[tauri::command]
pub async fn agents_set_enabled(
    configs: State<'_, AgentConfigs>,
    sessions: State<'_, crate::session::Sessions>,
    project_path: Option<String>,
    agent_id: String,
    enabled: bool,
) -> Result<usize, String> {
    let configs = configs.inner().clone();
    let project = project_of(project_path)?;
    let stopped = match (&project, enabled) {
        (Some(project), false) => sessions.active_of(project, &agent_id),
        _ => 0,
    };
    blocking(move || configs.set_enabled(project.as_deref(), &agent_id, enabled)).await??;
    Ok(stopped)
}

/// Pins an agent of the project's agents.json (the user's without one) to the registry's newer
/// version and downloads it; returns once the download ended (empty: it was up to date). Running
/// sessions keep their process and hear their launch changed.
#[tauri::command]
pub async fn agents_update_version(
    updater: State<'_, Updater>,
    project_path: Option<String>,
    agent_id: String,
) -> Result<Vec<Updated>, String> {
    updater.inner().clone().update(project_of(project_path)?, agent_id).await
}

/// `agents_update_version` for every agent of the scope that has an update: one write, then the
/// downloads one at a time.
#[tauri::command]
pub async fn agents_update_all(updater: State<'_, Updater>, project_path: Option<String>) -> Result<Vec<Updated>, String> {
    updater.inner().clone().update_all(project_of(project_path)?).await
}

/// The Agents tab's data: the project's agents (the user's without one) and the registry's,
/// searched (`query`) and filtered, with counts, highlights and update states.
#[tauri::command]
pub async fn agents_view(
    configs: State<'_, AgentConfigs>,
    updater: State<'_, Updater>,
    sessions: State<'_, crate::session::Sessions>,
    project_path: Option<String>,
    query: String,
    filter: Filter,
) -> Result<AgentsView, String> {
    let (configs, updater, sessions) = (configs.inner().clone(), updater.inner().clone(), sessions.inner().clone());
    blocking(move || {
        let project = project_of(project_path)?;
        let state = RowState {
            updating: &|id| updater.is_updating(project.as_deref(), id),
            sign_in: &|id| sessions.sign_in_state(project.as_deref(), id),
        };
        Ok(configs.view(project.as_deref(), &query, filter, state))
    })
    .await?
}

/// Asks the ACP registry now (Check now); every window hears when its agents changed. Returns how
/// the check went.
#[tauri::command]
pub async fn agents_registry_check(configs: State<'_, AgentConfigs>) -> Result<RegistryState, String> {
    let configs = configs.inner().clone();
    configs.check_registry().await;
    Ok(configs.registry().state())
}

/// Checks the registry in the background whenever it is due (`Registry::due`): at launch, then
/// as the app keeps running (asleep or not, a check is never more than a minute late).
pub(crate) fn check_registry_daily(configs: AgentConfigs) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(crate::config::registry::RETRY_EVERY);
        loop {
            tick.tick().await;
            if configs.registry().due() {
                configs.check_registry().await;
            }
        }
    });
}

/// Copies the user's own agents the project lacks into its agents.json (trusted: the user wrote
/// them), `agent_ids` only when given; returns their ids.
#[tauri::command]
pub async fn agents_import_user(
    configs: State<'_, AgentConfigs>,
    project_path: String,
    agent_ids: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let configs = configs.inner().clone();
    blocking(move || {
        let project = dunce::canonicalize(&project_path).map_err(|e| format!("{project_path}: {e}"))?;
        configs.import_user_agents(&project, agent_ids.as_deref())
    })
    .await?
}
