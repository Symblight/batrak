use tauri::State;

use crate::config::{AgentConfigs, AgentList, LaunchConfig};

use super::blocking;

/// The agents configured for a project (built-in, user-level and `.brama/agents.json` merged),
/// without their commands or environment. `errors` lists files that don't parse.
#[tauri::command]
pub async fn agents_list(configs: State<'_, AgentConfigs>, project_path: Option<String>) -> Result<AgentList, String> {
    let configs = configs.inner().clone();
    blocking(move || {
        let project = match project_path {
            Some(path) => Some(dunce::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?),
            None => None,
        };
        Ok(configs.merged(project.as_deref()).list())
    })
    .await?
}

/// The project's `.brama/workspace.json` settings (how its sessions start).
#[tauri::command]
pub async fn workspace_settings(project_path: String) -> Result<crate::config::WorkspaceSettings, String> {
    blocking(move || {
        let project = dunce::canonicalize(&project_path).map_err(|e| format!("{project_path}: {e}"))?;
        Ok(crate::config::workspace_settings(&project))
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

/// Trusts what the project's agents.json runs for one agent (its `launch` as the `untrusted` event
/// showed it); refused when the file has changed since.
#[tauri::command]
pub async fn agents_trust(
    configs: State<'_, AgentConfigs>,
    project_path: String,
    launch: LaunchConfig,
) -> Result<(), String> {
    let configs = configs.inner().clone();
    blocking(move || {
        let project = dunce::canonicalize(&project_path).map_err(|e| format!("{project_path}: {e}"))?;
        configs.trust(&project, &launch)
    })
    .await?
}
