//! Thin IPC layer: Tauri commands exposed to the frontend.

pub mod about;
pub mod agents;
pub mod attachments;
pub mod dropped;
pub mod fonts;
pub mod fs;
pub mod git;
pub mod github;
pub mod log;
pub mod sessions;
pub mod terminal;
pub mod roots;
pub mod workspaces;

/// Runs blocking work (disk IO, scans) off the async runtime's threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}
