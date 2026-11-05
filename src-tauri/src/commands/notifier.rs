//! The app's [`Notifier`]: every change reaches all windows as an event.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::notify::{AgentsChanged, Notice, NoticeLevel, Notifier, SessionsSynced, SignInEvent, WorkspacesChanged};
use crate::session::{Session, SyncReport};

const AGENTS_CHANGED: &str = "agents://changed";
const AGENTS_SIGN_IN: &str = "agents://sign-in";
const SESSIONS_SYNCED: &str = "sessions://synced";
const WORKSPACES_CHANGED: &str = "workspaces://changed";
const NOTICE: &str = "app://notice";

pub struct AppNotifier<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> AppNotifier<R> {
    fn emit(&self, event: &str, payload: impl Serialize + Clone) {
        let _ = self.0.emit(event, payload);
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl<R: Runtime> Notifier for AppNotifier<R> {
    fn agents_changed(&self, project: Option<&Path>) {
        self.emit(AGENTS_CHANGED, AgentsChanged { project_path: project.map(path_string) });
    }

    fn sessions_synced(&self, project: &Path, sessions: &[Session], report: &SyncReport) {
        self.emit(SESSIONS_SYNCED, SessionsSynced { project_path: path_string(project), sessions, report });
    }

    fn workspaces_changed(&self, project: &Path) {
        self.emit(WORKSPACES_CHANGED, WorkspacesChanged { project_path: path_string(project) });
    }

    fn sign_in(&self, event: &SignInEvent) {
        self.emit(AGENTS_SIGN_IN, event.clone());
    }

    fn notice(&self, level: NoticeLevel, message: &str) {
        self.emit(NOTICE, Notice { level, message: message.to_owned() });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};
    use tauri::Listener;

    use super::*;
    use crate::notify::SignInProgress;
    use crate::session::LoginTab;

    /// The page's contract: each event's name and JSON.
    #[test]
    fn every_change_reaches_the_windows_under_its_name_with_its_json() {
        let app = tauri::test::mock_app();
        let notifier = AppNotifier(app.handle().clone());
        let project = Path::new("/p");
        let report = SyncReport { project_path: "/p".into(), started_at: "a".into(), ended_at: "b".into(), agents: Vec::new() };
        let tab = LoginTab { terminal_id: "sign-in-1".into(), title: "Sign in".into(), command_line: "login".into() };

        type Case<'a> = (&'a str, Box<dyn Fn() + 'a>, Value);
        let cases: Vec<Case> = vec![
            (AGENTS_CHANGED, Box::new(|| notifier.agents_changed(Some(project))), json!({ "projectPath": "/p" })),
            (AGENTS_CHANGED, Box::new(|| notifier.agents_changed(None)), json!({ "projectPath": null })),
            (
                SESSIONS_SYNCED,
                Box::new(|| notifier.sessions_synced(project, &[], &report)),
                json!({ "projectPath": "/p", "sessions": [], "report": { "projectPath": "/p", "startedAt": "a", "endedAt": "b", "agents": [] } }),
            ),
            (WORKSPACES_CHANGED, Box::new(|| notifier.workspaces_changed(project)), json!({ "projectPath": "/p" })),
            (
                AGENTS_SIGN_IN,
                Box::new(|| {
                    notifier.sign_in(&SignInEvent {
                        project_path: Some("/p".into()),
                        agent_id: "a".into(),
                        state: SignInProgress::Waiting,
                        message: None,
                        terminal: Some(tab.clone()),
                    })
                }),
                json!({ "projectPath": "/p", "agentId": "a", "state": "waiting", "message": null,
                        "terminal": { "terminalId": "sign-in-1", "title": "Sign in", "commandLine": "login" } }),
            ),
            (NOTICE, Box::new(|| notifier.notice(NoticeLevel::Warn, "careful")), json!({ "level": "warn", "message": "careful" })),
        ];

        for (name, emit, expected) in cases {
            let heard = Arc::new(Mutex::new(Vec::<Value>::new()));
            let sink = Arc::clone(&heard);
            let id = app.listen_any(name, move |event| sink.lock().unwrap().push(serde_json::from_str(event.payload()).unwrap()));
            emit();
            app.unlisten(id);
            assert_eq!(*heard.lock().unwrap(), [expected], "{name}");
        }
    }

    #[test]
    fn every_sign_in_state_reads_as_the_page_expects() {
        for (state, word) in [
            (SignInProgress::Waiting, "waiting"),
            (SignInProgress::Done, "done"),
            (SignInProgress::Failed, "failed"),
            (SignInProgress::Cancelled, "cancelled"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), word);
        }
        assert_eq!(serde_json::to_value(NoticeLevel::Error).unwrap(), "error");
    }
}
