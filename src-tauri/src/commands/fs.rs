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
