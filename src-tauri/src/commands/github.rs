//! GitHub through the GitHub CLI: who is signed in, and the branch's pull request. See `crate::github`.

use tauri::{AppHandle, Emitter};

use crate::github::{self, Account, PrReply, PrStatus};
use crate::workspace::Workspaces;
use tauri::State;
use crate::git::binary;

use super::blocking;

/// Event to every window that `gh`'s account changed (its token was rejected): read it again.
const ACCOUNT_EVENT: &str = "github://account";

/// Who `gh` is signed in as on github.com; `noCli` when `gh` isn't installed.
#[tauri::command]
pub async fn github_account() -> Result<Account, String> {
    blocking(|| github::account(github::gh().as_deref())).await?
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
