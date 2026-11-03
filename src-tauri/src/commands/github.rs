//! GitHub through the GitHub CLI: who is signed in, and signing in. See `crate::github`.

use tauri::{AppHandle, Emitter};

use crate::github::{self, Account, PrReply, PrStatus};
use crate::workspace::Workspaces;
use tauri::State;
use crate::git::binary;

use super::blocking;

/// Event with the one-time code, once `gh` has printed it.
const CODE_EVENT: &str = "github://code";
/// Event to every window that `gh`'s account changed (signed in, or its token was rejected): read it again.
const ACCOUNT_EVENT: &str = "github://account";

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
        let _ = app.emit(ACCOUNT_EVENT, ());
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

/// The pull request of the root's branch on GitHub, with the repository's default branch. `signedOut`
/// when `gh` has no login; empty when the branch's remote isn't on github.com.
#[tauri::command]
pub async fn github_pull_request(app: AppHandle, workspaces: State<'_, Workspaces>, root_id: String) -> Result<PrReply, String> {
    let root = workspaces.get(&root_id)?;
    blocking(move || {
        let Some(gh) = github::gh() else { return Ok(PrReply { status: PrStatus::SignedOut, pr: None, default_branch: None, message: Some("The GitHub CLI isn't installed".into()) }) };
        let state = root.git.head(binary::git()?, &root.path, root.epoch())?;
        let Some((repo, branch)) = state.as_ref().and_then(|s| Some((s.remote.as_ref()?.github.as_ref()?, s.branch.as_deref()?))) else {
            return Ok(PrReply { status: PrStatus::Ok, pr: None, default_branch: None, message: None });
        };
        let reply = github::pull_request(&gh, &repo.owner, &repo.repo, branch)?;
        // The token was rejected (revoked): every window's account is stale.
        if reply.status == PrStatus::SignedOut {
            let _ = app.emit(ACCOUNT_EVENT, ());
        }
        Ok(reply)
    })
    .await?
}
