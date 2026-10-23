//! The app's side of an agent's ACP connection: updates, permission requests and file access.

use super::*;

/// The app's side of a probe: no session, so nothing to show and no files to give.
pub(super) struct ProbeHost;

impl ClientHost for ProbeHost {
    fn on_update(&self, _update: Value) {}

    fn on_permission_request(&self, _request: PermissionRequest) {}

    fn read_text_file(&self, path: PathBuf, _line: Option<u32>, _limit: Option<u32>) -> Result<String, FsError> {
        Err(FsError::Denied(format!("{}: no files while probing", path.display())))
    }

    fn write_text_file(&self, path: PathBuf, _content: String) -> Result<(), FsError> {
        Err(FsError::Denied(format!("{}: no files while probing", path.display())))
    }
}

/// The app's side of one session's ACP connection.
pub(super) struct SessionHost {
    pub(super) state: Weak<SessionState>,
}

impl SessionHost {
    /// `session_info_update`'s title: `None` clears it. It becomes the session's title unless the
    /// user named the session; saved with the next status change or turn end, like config options.
    fn on_agent_title(&self, state: &SessionState, title: Option<&str>) {
        let title = title.map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);
        let session = {
            let mut record = lock(&state.record);
            if record.agent_title == title {
                return;
            }
            record.agent_title.clone_from(&title);
            if let (Some(title), false) = (title, record.title_source == TitleSource::User) {
                record.title = title;
                record.title_source = TitleSource::Agent;
            }
            Session::from(&*record)
        };
        state.emit("session", serde_json::to_value(session).unwrap_or_default());
    }

    /// The files a tool call changes, as the turn's: its diffs, and its locations unless its kind
    /// (sent once, usually with `tool_call`) only looks at them.
    fn note_touched(&self, state: &SessionState, update: &Value) {
        let Some(env) = lock(&state.env).clone() else { return };
        let looks = {
            let mut kinds = lock(&state.tool_kinds);
            let id = update["toolCallId"].as_str().unwrap_or_default();
            if let Some(kind) = update["kind"].as_str() {
                kinds.insert(id.to_owned(), kind.to_owned());
            }
            kinds.get(id).is_some_and(|kind| LOOKING_TOOL_KINDS.contains(&kind.as_str()))
        };
        let locations =
            update["locations"].as_array().into_iter().flatten().filter(|_| !looks).map(|l| &l["path"]);
        let diffs = update["content"].as_array().into_iter().flatten().filter(|c| c["type"] == "diff").map(|c| &c["path"]);
        let named = locations.chain(diffs).filter_map(Value::as_str).filter_map(|path| {
            let path = normalize(&env.agent_cwd().join(path));
            env.to_host_path(&path).ok()
        });
        lock(&state.touched).extend(named);
    }

    pub(super) fn env(&self) -> Result<Arc<dyn SessionEnv>, FsError> {
        let state = self.state.upgrade().ok_or_else(|| FsError::Io("the session is gone".to_owned()))?;
        let env = lock(&state.env).clone();
        env.ok_or_else(|| FsError::Io("the session is not running".to_owned()))
    }

    /// An agent path as a checked host path.
    fn host_path(&self, path: &Path, access: Access) -> Result<PathBuf, FsError> {
        let env = self.env()?;
        let host = env.to_host_path(path).map_err(FsError::Denied)?;
        env::confine(env.host_dir(), &host, access).map_err(|e| {
            if access == Access::Read && !host.exists() && !e.contains("outside") && !e.contains(".git") {
                FsError::NotFound(e)
            } else {
                tracing::info!(path = %path.display(), "agent file access refused: {e}");
                FsError::Denied(e)
            }
        })
    }
}

/// `path` without `.` and `..` (lexically: a symlink is left as named), so that two names of one
/// file match the watcher's.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    out
}

/// ACP tool kinds whose locations are files read, not changed.
const LOOKING_TOOL_KINDS: [&str; 4] = ["read", "search", "fetch", "think"];

impl ClientHost for SessionHost {
    fn on_update(&self, update: Value) {
        let Some(state) = self.state.upgrade() else { return };
        let options = state.conn().and_then(|conn| conn.note_update(&update));
        if update["sessionUpdate"] == "session_info_update" {
            if let Some(title) = update.get("title") {
                self.on_agent_title(&state, title.as_str());
            }
        }
        if update["sessionUpdate"] == "tool_call" || update["sessionUpdate"] == "tool_call_update" {
            self.note_touched(&state, &update);
        }
        state.emit("update", update);
        if let Some(options) = options {
            // Saved with the next status change.
            remember_config(&state, &options);
            state.emit("config-options", json!({ "configOptions": options }));
        }
    }

    fn on_permission_request(&self, request: PermissionRequest) {
        let Some(state) = self.state.upgrade() else { return };
        state.emit(
            "permission-request",
            json!({ "requestId": request.request_id, "toolCall": request.tool_call, "options": request.options }),
        );
        lock(&state.record).status = SessionStatus::Waiting;
        state.emit("status", json!({ "status": SessionStatus::Waiting }));
    }

    // TODO: serve unsaved editor buffers instead of the disk version of the same file.
    fn read_text_file(&self, path: PathBuf, line: Option<u32>, limit: Option<u32>) -> Result<String, FsError> {
        let host = self.host_path(&path, Access::Read)?;
        read_lines(&host, line, limit, MAX_READ).map_err(|e| FsError::Io(format!("{}: {e}", path.display())))
    }

    fn write_text_file(&self, path: PathBuf, content: String) -> Result<(), FsError> {
        let host = self.host_path(&path, Access::Write)?;
        // What it runs is the user's to decide (a changed launch needs trust again, but an agent
        // shouldn't get to try).
        if crate::config::project_of_agents_file(&host).is_some() {
            tracing::info!(path = %path.display(), "agent file access refused: agents.json");
            return Err(FsError::Denied(format!("{}: agents.json is the user's to edit", path.display())));
        }
        env::write_atomic(&host, content.as_bytes()).map_err(|e| FsError::Io(format!("{}: {e}", path.display())))
    }
}
