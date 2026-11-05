//! What knows agents, with no front: a desktop app or a command line runs over it, passing what it
//! must decide itself through traits (`notify::Notifier`, `session::program::ProgramRunner`).

/// The generic ACP driver, its own crate; `crate::acp::…` paths read as before.
use agent_acp as acp;

pub mod agents;
pub mod config;
pub mod dirs;
pub mod git;
pub mod notify;
pub mod session;
pub mod storage;
pub mod util;
pub mod workspace;
