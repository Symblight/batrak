//! Host for the Agent Client Protocol (ACP): runs one external coding agent per session and talks
//! to it over its stdio. The only module that uses `agent_client_protocol` types; the rest of the
//! app sees [`Connection`], [`PromptBlock`], [`ClientHost`] and session updates as JSON (the ACP
//! `SessionUpdate`, serialized by the crate, forwarded to the frontend as is).

mod connection;
pub mod process;

#[cfg(test)]
pub(crate) mod fake_agent;

pub use connection::{Connection, StartOptions};

use std::path::PathBuf;

/// How long `initialize` may take: the first `npx` run downloads and installs the agent.
pub const INITIALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// One piece of a prompt, with paths already mapped to the agent's side (`file://` URIs).
#[derive(Debug, Clone, PartialEq)]
pub enum PromptBlock {
    Text(String),
    /// An `@`-mentioned file or folder: a resource link the agent reads itself.
    Mention { name: String, uri: String },
    /// Selected lines, embedded: `uri` carries the range as `#L<from>-<to>`.
    Selection { uri: String, text: String },
}

/// A `session/request_permission` waiting for the user. `request_id` is ours (the JSON-RPC id is
/// the crate's); `tool_call` and `options` are the request's own fields as JSON.
#[derive(Debug, Clone)]
pub struct PermissionRequest {
    pub request_id: String,
    pub tool_call: serde_json::Value,
    pub options: serde_json::Value,
}

/// What the app does for the agent. `read_text_file` / `write_text_file` run on a blocking thread
/// and get the agent's paths as sent: confining them is the implementor's job.
pub trait ClientHost: Send + Sync + 'static {
    /// A `session/update`'s `update`, in arrival order.
    fn on_update(&self, update: serde_json::Value);
    fn on_permission_request(&self, request: PermissionRequest);
    /// `line` is 1-based; `limit` is a number of lines.
    fn read_text_file(&self, path: PathBuf, line: Option<u32>, limit: Option<u32>) -> Result<String, FsError>;
    fn write_text_file(&self, path: PathBuf, content: String) -> Result<(), FsError>;
}

/// Why a file request failed; maps onto a JSON-RPC error for the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsError {
    /// Outside the session's directory, in `.git`, or otherwise refused.
    Denied(String),
    NotFound(String),
    Io(String),
}

impl std::fmt::Display for FsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FsError::Denied(m) | FsError::NotFound(m) | FsError::Io(m) => f.write_str(m),
        }
    }
}
