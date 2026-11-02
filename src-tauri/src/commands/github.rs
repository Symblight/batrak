//! GitHub through the GitHub CLI: who is signed in, and signing in. See `crate::github`.

use tauri::{AppHandle, Emitter};

use crate::github::{self, Account};

use super::blocking;

/// Event with the one-time code, once `gh` has printed it.
const CODE_EVENT: &str = "github://code";

/// Who `gh` is signed in as on github.com; `noCli` when `gh` isn't installed.
#[tauri::command]
pub async fn github_account() -> Result<Account, String> {
    blocking(|| github::account(github::gh().as_deref())).await?
}

/// Signs in to github.com with `gh auth login --web`: emits the one-time code as `github://code`
/// and opens the page to enter it on, then resolves when the user is done in the browser.
#[tauri::command]
pub async fn github_sign_in(app: AppHandle) -> Result<Account, String> {
    let gh = github::gh().ok_or("The GitHub CLI isn't installed")?;
    blocking(move || {
        github::sign_in(&gh, |code| {
            let _ = app.emit(CODE_EVENT, code);
        })?;
        let account = github::account(Some(&gh))?;
        tracing::info!(?account, "signed in to GitHub");
        Ok(account)
    })
    .await?
}

/// Stops a sign-in that is waiting for the browser.
#[tauri::command]
pub fn github_sign_in_cancel() {
    github::cancel_sign_in();
}
