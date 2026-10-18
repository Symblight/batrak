use std::fs;
use std::path::Path;
use std::process::Command;

use tauri::{AppHandle, Emitter, State};

use crate::config::AgentConfigs;
use crate::session::Sessions;
use crate::workspace::Workspaces;

use super::blocking;

/// The user-level agents.json, canonical, when it exists: readable and writable like a file in a root.
fn user_agents_file(configs: &AgentConfigs) -> Option<std::path::PathBuf> {
    configs.user_file().and_then(|f| dunce::canonicalize(f).ok())
}

/// Reads a file inside an opened workspace root, a worktree session's folder (or the user's
/// agents.json) as UTF-8 text. Fails for binary (non-UTF-8) files and for paths outside every root;
/// symlinks are resolved first, so none can lead out of a root.
#[tauri::command]
pub async fn read_file(
    workspaces: State<'_, Workspaces>,
    configs: State<'_, AgentConfigs>,
    sessions: State<'_, Sessions>,
    path: String,
) -> Result<String, String> {
    let workspaces = workspaces.inner().clone();
    let configs = configs.inner().clone();
    let sessions = sessions.inner().clone();
    blocking(move || {
        // Same form as the roots (no `\\?\` on Windows), so `contains` can compare them.
        let canonical = dunce::canonicalize(Path::new(&path)).map_err(|e| format!("{path}: {e}"))?;
        let readable = workspaces.contains(&canonical) || sessions.contains(&canonical);
        if !readable && Some(&canonical) != user_agents_file(&configs).as_ref() {
            return Err(format!("{path}: outside the opened folder"));
        }
        fs::read_to_string(&canonical).map_err(|e| format!("{path}: {e}"))
    })
    .await?
}

/// Saves an agents.json from the editor: a project's `.brama/agents.json` inside an opened root, or
/// the user's. Nothing else is writable from the page yet. The agent list is re-read right away
/// (`agents://changed`; `projectPath: null` for the user's file, which affects every project).
#[tauri::command]
pub async fn write_file(
    app: AppHandle,
    workspaces: State<'_, Workspaces>,
    configs: State<'_, AgentConfigs>,
    path: String,
    content: String,
) -> Result<(), String> {
    let workspaces = workspaces.inner().clone();
    let configs = configs.inner().clone();
    blocking(move || {
        let canonical = dunce::canonicalize(Path::new(&path)).map_err(|e| format!("{path}: {e}"))?;
        let is_user = Some(&canonical) == user_agents_file(&configs).as_ref();
        let project = crate::config::project_of_agents_file(&canonical)
            .filter(|_| workspaces.contains(&canonical))
            .map(Path::to_path_buf);
        if !is_user && project.is_none() {
            return Err(format!("{path}: only agents.json can be edited"));
        }
        crate::session::env::write_atomic(&canonical, content.as_bytes()).map_err(|e| format!("{path}: {e}"))?;
        let changed = match &project {
            Some(project) => configs.reload(project),
            None => configs.reload_user(),
        };
        if changed {
            let project_path = project.map(|p| p.to_string_lossy().into_owned());
            let _ = app.emit(crate::config::AGENTS_CHANGED_EVENT, serde_json::json!({ "projectPath": project_path }));
        }
        Ok(())
    })
    .await?
}

/// Shows a folder in the OS file manager: selected in Finder / Explorer, opened elsewhere.
/// Folders only: `xdg-open` on a file would launch it with its default handler.
#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), String> {
    blocking(move || {
        // Absolute and free of `..`, so it can't read as an option to the tools below.
        let dir = dunce::canonicalize(Path::new(&path)).map_err(|e| format!("{path}: {e}"))?;
        if !dir.is_dir() {
            return Err(format!("{path}: not a folder"));
        }
        #[cfg(target_os = "macos")]
        let status = Command::new("open").arg("-R").arg(&dir).status();
        // Explorer parses its own command line: quote the path so a comma in it doesn't end `/select`.
        // Windows paths can't contain `"`, so it can't close the quotes early.
        #[cfg(target_os = "windows")]
        let status = {
            use std::os::windows::process::CommandExt;
            Command::new("explorer").raw_arg(format!("/select,\"{}\"", dir.display())).status()
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let status = Command::new("xdg-open").arg(&dir).status();
        // Explorer exits with 1 even on success, so only a failure to launch counts.
        status.map(|_| ()).map_err(|e| format!("{path}: {e}"))
    })
    .await?
}

/// A link the OS may open: `http`, `https` or `mailto`, with no quote, whitespace or control
/// character (a URL from the page's `href` property has them percent-encoded), so no launcher can
/// read it as more than one argument.
fn checked_url(url: &str) -> Result<&str, String> {
    let lower = url.to_ascii_lowercase();
    let scheme = ["http://", "https://", "mailto:"].iter().any(|scheme| lower.starts_with(scheme));
    let plain = !url.chars().any(|c| c == '"' || c.is_whitespace() || c.is_control());
    if scheme && plain {
        Ok(url)
    } else {
        Err(format!("{url:?}: only web and mail links open"))
    }
}

/// Opens a link from an agent's reply in the default browser (a click in the page would navigate
/// the app's own window away). Only `http`, `https` and `mailto`.
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    checked_url(&url)?;
    blocking(move || {
        #[cfg(target_os = "macos")]
        let status = Command::new("open").arg(&url).status();
        // Not through `cmd /C start`: cmd would read `&`, `|` and `%` in the URL as its own syntax.
        #[cfg(target_os = "windows")]
        let status = Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).status();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let status = Command::new("xdg-open").arg(&url).status();
        status.map(|_| ()).map_err(|e| format!("{url}: {e}"))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::checked_url;

    #[test]
    fn only_plain_web_and_mail_links_open() {
        for ok in ["https://example.com/a?b=1&c=%20", "http://x.org", "MAILTO:me@x.org", "https://x.org/a^b"] {
            assert_eq!(checked_url(ok), Ok(ok), "{ok}");
        }
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://x\"&calc&\"",
            "https://x y",
            "https://x\ty",
            "https://x\0",
            "https://x\n",
        ] {
            assert!(checked_url(bad).is_err(), "{bad:?}");
        }
    }
}
