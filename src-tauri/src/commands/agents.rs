use tauri::{AppHandle, Emitter, State};

use crate::config::registry::{Registry, RegistryState};
use crate::config::{AgentConfigs, AgentList, LaunchConfig, NewAgent, Removal, UntrustedAgent};

use super::blocking;

/// The agents of a project (its `.brama/agents.json`; the user's file without one), without their
/// environment. `errors` lists files that don't parse.
#[tauri::command]
pub async fn agents_list(configs: State<'_, AgentConfigs>, project_path: Option<String>) -> Result<AgentList, String> {
    let configs = configs.inner().clone();
    blocking(move || {
        let project = match project_path {
            Some(path) => Some(dunce::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?),
            None => None,
        };
        Ok(configs.list(project.as_deref()))
    })
    .await?
}

/// The project's `.brama/workspace.json` settings (how its sessions start). A `worktree` default
/// counts only where a worktree can start (a repository with a commit): every project opened before
/// the setting was read got it written, git or not.
#[tauri::command]
pub async fn workspace_settings(project_path: String) -> Result<crate::config::WorkspaceSettings, String> {
    blocking(move || {
        let project = dunce::canonicalize(&project_path).map_err(|e| format!("{project_path}: {e}"))?;
        let mut settings = crate::config::workspace_settings(&project);
        if settings.default_mode == "worktree" && !crate::session::env::can_place(&project) {
            settings.default_mode = "local".to_owned();
        }
        Ok(settings)
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
) -> Result<Vec<serde_json::Value>, String> {
    let project = match project_path {
        Some(path) => Some(dunce::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?),
        None => None,
    };
    sessions.probe_options(project.as_deref(), &agent_id).await
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

/// An agents.json changed (`None`: the user's, the agents of no project): every window hears of
/// it, and the project's sessions follow (`Sessions::sync_agents`). Every reload that changed the
/// agents comes through here.
pub(crate) fn emit_changed(app: &AppHandle, project: Option<&std::path::Path>) {
    use tauri::Manager;
    let project_path = project.map(|p| p.to_string_lossy().into_owned());
    let _ = app.emit(crate::config::AGENTS_CHANGED_EVENT, serde_json::json!({ "projectPath": project_path }));
    if let (Some(project), Some(sessions)) = (project, app.try_state::<crate::session::Sessions>()) {
        let sessions = sessions.inner().clone();
        let project = project.to_path_buf();
        tauri::async_runtime::spawn(async move { sessions.sync_agents(&project).await });
    }
}

/// Adds an ACP agent from Settings to the project's agents.json (trusted), or the user's without a
/// project; returns its id.
#[tauri::command]
pub async fn agents_add(
    app: AppHandle,
    configs: State<'_, AgentConfigs>,
    project_path: Option<String>,
    agent: NewAgent,
) -> Result<String, String> {
    let configs = configs.inner().clone();
    let (id, project) = blocking(move || {
        let project = match project_path {
            Some(path) => Some(dunce::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?),
            None => None,
        };
        configs.add_agent(project.as_deref(), &agent).map(|id| (id, project))
    })
    .await??;
    emit_changed(&app, project.as_deref());
    Ok(id)
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
    app: AppHandle,
    configs: State<'_, AgentConfigs>,
    project_path: Option<String>,
    agent_id: String,
    agent: NewAgent,
) -> Result<(), String> {
    let configs = configs.inner().clone();
    let changed = blocking(move || configs.update_agent(project_of(project_path)?.as_deref(), &agent_id, &agent)).await??;
    emit_changed(&app, changed.as_deref());
    Ok(())
}

/// Makes an agent the default for new sessions (the project's agents.json, else the user's).
#[tauri::command]
pub async fn agents_set_default(
    app: AppHandle,
    configs: State<'_, AgentConfigs>,
    project_path: Option<String>,
    agent_id: String,
) -> Result<(), String> {
    let configs = configs.inner().clone();
    let changed = blocking(move || configs.set_default(project_of(project_path)?.as_deref(), &agent_id)).await??;
    emit_changed(&app, changed.as_deref());
    Ok(())
}

/// Removes an agent's entry from the project's agents.json (the user's without one); `agents_restore` with
/// the returned token undoes it.
#[tauri::command]
pub async fn agents_remove(
    app: AppHandle,
    configs: State<'_, AgentConfigs>,
    project_path: Option<String>,
    agent_id: String,
) -> Result<Removal, String> {
    let configs = configs.inner().clone();
    let removal = blocking(move || configs.remove_agent(project_of(project_path)?.as_deref(), &agent_id)).await??;
    emit_changed(&app, removal.project.as_deref());
    Ok(removal)
}

/// Puts back what an `agents_remove` took out.
#[tauri::command]
pub async fn agents_restore(app: AppHandle, configs: State<'_, AgentConfigs>, token: u64) -> Result<(), String> {
    let configs = configs.inner().clone();
    let changed = blocking(move || configs.restore_agent(token)).await??;
    emit_changed(&app, changed.as_deref());
    Ok(())
}

/// Turns an agent of the project's agents.json (the user's without one) on or off for this user;
/// the file isn't touched. Returns how many of the project's sessions turning it off stops (each
/// after its running turn).
#[tauri::command]
pub async fn agents_set_enabled(
    app: AppHandle,
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
    let changed = blocking(move || configs.set_enabled(project.as_deref(), &agent_id, enabled)).await??;
    emit_changed(&app, changed.as_deref());
    Ok(stopped)
}

/// Asks the ACP registry now (Check now); every window hears when its agents changed. Returns how
/// the check went.
#[tauri::command]
pub async fn agents_registry_check(app: AppHandle, configs: State<'_, AgentConfigs>) -> Result<RegistryState, String> {
    let registry = configs.registry().clone();
    check_registry(&app, &registry).await;
    Ok(registry.state())
}

async fn check_registry(app: &AppHandle, registry: &Registry) {
    // The registry is the same for every project: one `null` change has every window re-read its list.
    if registry.check().await {
        emit_changed(app, None);
    }
}

/// Checks the registry in the background whenever the last answer is a day old: at launch, then
/// as the app keeps running (asleep or not, a check is never more than an hour late).
pub(crate) fn check_registry_daily(app: AppHandle, registry: Registry) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
        loop {
            tick.tick().await;
            if registry.due() {
                check_registry(&app, &registry).await;
            }
        }
    });
}

/// Copies the user's own agents the project lacks into its agents.json (trusted: the user wrote
/// them); returns their ids.
#[tauri::command]
pub async fn agents_import_user(app: AppHandle, configs: State<'_, AgentConfigs>, project_path: String) -> Result<Vec<String>, String> {
    let configs = configs.inner().clone();
    let (ids, project) = blocking(move || {
        let project = dunce::canonicalize(&project_path).map_err(|e| format!("{project_path}: {e}"))?;
        configs.import_user_agents(&project).map(|ids| (ids, project))
    })
    .await??;
    emit_changed(&app, Some(&project));
    Ok(ids)
}
