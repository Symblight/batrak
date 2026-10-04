use std::fs;
use std::path::Path;
use std::process::Command;

use tauri::State;

use crate::workspace::Workspaces;

use super::blocking;

/// Reads a file inside an opened workspace root as UTF-8 text. Fails for binary (non-UTF-8) files
/// and for paths outside every root; symlinks are resolved first, so none can lead out of a root.
#[tauri::command]
pub async fn read_file(workspaces: State<'_, Workspaces>, path: String) -> Result<String, String> {
    let workspaces = workspaces.inner().clone();
    blocking(move || {
        // Same form as the roots (no `\\?\` on Windows), so `contains` can compare them.
        let canonical = dunce::canonicalize(Path::new(&path)).map_err(|e| format!("{path}: {e}"))?;
        if !workspaces.contains(&canonical) {
            return Err(format!("{path}: outside the opened folder"));
        }
        fs::read_to_string(&canonical).map_err(|e| format!("{path}: {e}"))
    })
    .await?
}

/// Shows a path in the OS file manager: selected in Finder / Explorer, opened elsewhere.
#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), String> {
    blocking(move || {
        #[cfg(target_os = "macos")]
        let status = Command::new("open").arg("-R").arg(&path).status();
        #[cfg(target_os = "windows")]
        let status = Command::new("explorer").arg(format!("/select,{path}")).status();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let status = Command::new("xdg-open").arg(&path).status();
        // Explorer exits with 1 even on success, so only a failure to launch counts.
        status.map(|_| ()).map_err(|e| format!("{path}: {e}"))
    })
    .await?
}
