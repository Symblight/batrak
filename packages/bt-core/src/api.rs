//! The contract: every type a front renders, with the JSON the app's page and `--json` get. Its
//! tests spell that JSON out, so a change to it is a reviewed diff.

pub use agent_api::{SessionActivity, TerminalMode};

pub use crate::acp::auth::{ApiKey, SignInKind, SignInMethod};
pub use crate::config::registry::{AgentUpdate, KnownAgent, RegistryState};
pub use crate::config::update::Updated;
pub use crate::config::view::{AgentRow, AgentsView, Counts, RegistryRow, SignInState, Status};
pub use crate::config::{AgentList, AgentSummary, LaunchConfig, Removal, Scope, UntrustedAgent};
pub use crate::notify::{AgentsChanged, Notice, NoticeLevel, SessionsSynced, SignInEvent, SignInProgress, WorkspacesChanged};
pub use crate::release::ReleaseStatus;
pub use crate::session::{AgentSync, CliOpened, DeletePreview, Envelope, LoginTab, Session, SessionStatus, SyncOutcome, SyncReport, TitleSource};
pub use crate::workspace::{NameSource, Workspace, WorkspaceRecord};

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use serde::Serialize;
    use serde_json::{json, Value};

    use super::*;

    fn value(of: impl Serialize) -> Value {
        serde_json::to_value(of).unwrap()
    }

    fn strings(of: &[&str]) -> Vec<String> {
        of.iter().map(|s| (*s).to_owned()).collect()
    }

    fn session() -> (Session, Value) {
        let session = Session {
            id: "s".into(),
            project_id: "/p".into(),
            title: "Title".into(),
            title_source: TitleSource::User,
            agent_title: Some("Agent's".into()),
            status: SessionStatus::Idle,
            agent_id: "a".into(),
            agent_name: Some("Agent".into()),
            acp_session_id: Some("acp".into()),
            active_elsewhere_until: Some("until".into()),
            in_terminal: true,
            activity: Some(SessionActivity::WaitingForUser),
            config: BTreeMap::from([("model".to_owned(), "opus".to_owned())]),
            folder: "/p".into(),
            branch: Some("b".into()),
            workspace_id: Some("w".into()),
            created_at: "c".into(),
            last_activity_at: "l".into(),
        };
        let json = json!({
            "id": "s", "projectId": "/p", "title": "Title", "titleSource": "user", "agentTitle": "Agent's", "status": "idle",
            "agentId": "a", "agentName": "Agent", "acpSessionId": "acp", "activeElsewhereUntil": "until", "inTerminal": true,
            "activity": "waitingForUser", "config": { "model": "opus" }, "folder": "/p", "branch": "b", "workspaceId": "w",
            "createdAt": "c", "lastActivityAt": "l",
        });
        (session, json)
    }

    fn sync_report() -> (SyncReport, Value) {
        let agent = AgentSync { agent_id: "a".into(), agent_name: "Agent".into(), outcome: SyncOutcome::SignIn, count: Some(2), error: Some("e".into()) };
        let report = SyncReport { project_path: "/p".into(), started_at: "s".into(), ended_at: "e".into(), agents: vec![agent] };
        let json = json!({
            "projectPath": "/p", "startedAt": "s", "endedAt": "e",
            "agents": [{ "agentId": "a", "agentName": "Agent", "outcome": "signIn", "count": 2, "error": "e" }],
        });
        (report, json)
    }

    fn summary() -> (AgentSummary, Value) {
        let summary = AgentSummary {
            id: "a".into(),
            name: "Agent".into(),
            scope: Scope::Project,
            version: Some("1".into()),
            registry_id: Some("r".into()),
            update: Some(AgentUpdate { to: "2".into(), pin: true }),
            enabled: true,
            sign_in: true,
            command: "npx".into(),
            args: strings(&["-y"]),
            terminal: Some(TerminalMode { resume: true, new: false }),
        };
        let json = json!({
            "id": "a", "name": "Agent", "scope": "project", "version": "1", "registryId": "r", "update": { "to": "2", "pin": true },
            "enabled": true, "signIn": true, "command": "npx", "args": ["-y"], "terminal": { "resume": true, "new": false },
        });
        (summary, json)
    }

    #[test]
    fn a_session_and_a_sync_keep_their_json() {
        let (session, session_json) = session();
        let (report, report_json) = sync_report();
        let envelope = Envelope { session_id: "s".into(), seq: 7, kind: "status", payload: json!({ "status": "idle" }) };
        let cases = [
            (value(&session), session_json.clone()),
            (value(&report), report_json.clone()),
            (value(envelope), json!({ "sessionId": "s", "seq": 7, "kind": "status", "payload": { "status": "idle" } })),
            (value(CliOpened { terminal_id: "t".into() }), json!({ "terminalId": "t" })),
            (
                value(LoginTab { terminal_id: "t".into(), title: "T".into(), command_line: "c".into() }),
                json!({ "terminalId": "t", "title": "T", "commandLine": "c" }),
            ),
            (
                value(SessionsSynced { project_path: "/p".into(), sessions: std::slice::from_ref(&session), report: &report }),
                json!({ "projectPath": "/p", "sessions": [session_json], "report": report_json }),
            ),
        ];
        for (actual, expected) in cases {
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn a_workspace_keeps_its_json_with_its_record_flat() {
        let record = WorkspaceRecord {
            id: "w".into(),
            project_path: PathBuf::from("/p"),
            name: "Task".into(),
            name_source: NameSource::Agent,
            folder: PathBuf::from("/w/p"),
            worktree_path: PathBuf::from("/w"),
            branch: "b".into(),
            base_commit: "abc".into(),
            base_branch: Some("main".into()),
            created_at: "c".into(),
            checked_out: true,
        };
        let record_json = json!({
            "id": "w", "projectPath": "/p", "name": "Task", "nameSource": "agent", "folder": "/w/p", "worktreePath": "/w", "branch": "b",
            "baseCommit": "abc", "baseBranch": "main", "createdAt": "c", "checkedOut": true,
        });
        assert_eq!(value(&record), record_json);

        let mut page = record_json;
        page["creating"] = json!(true);
        page["error"] = json!("e");
        page["missing"] = json!(false);
        assert_eq!(value(Workspace { record, creating: true, error: Some("e".into()), missing: false }), page);

        let preview = DeletePreview { uncommitted: 1, commits: 2, working: strings(&["s"]) };
        assert_eq!(value(preview), json!({ "uncommitted": 1, "commits": 2, "working": ["s"] }));
    }

    #[test]
    fn the_agents_view_keeps_its_json() {
        let method = SignInMethod {
            id: "m".into(),
            name: "Method".into(),
            description: Some("d".into()),
            kind: SignInKind::Terminal,
            label: Some("l".into()),
            api_key: Some(ApiKey { provider: Some("p".into()) }),
            login: None,
        };
        let row = AgentRow {
            id: "a".into(),
            name: "Agent".into(),
            scope: Scope::User,
            enabled: true,
            is_default: true,
            command: "npx".into(),
            args: strings(&["-y"]),
            version: Some("1".into()),
            update: Some(AgentUpdate { to: "2".into(), pin: false }),
            updating: true,
            status: Status::SignIn,
            sign_in: Some(SignInState { methods: vec![method], pending: true }),
            name_matches: vec![[0, 1]],
            terminal: Some(TerminalMode { resume: true, new: true }),
            description: Some("d".into()),
        };
        let row_json = json!({
            "id": "a", "name": "Agent", "scope": "user", "enabled": true, "isDefault": true, "command": "npx", "args": ["-y"], "version": "1",
            "update": { "to": "2", "pin": false }, "updating": true, "status": "signIn",
            "signIn": {
                "methods": [{ "id": "m", "name": "Method", "description": "d", "kind": "terminal", "label": "l", "apiKey": { "provider": "p" } }],
                "pending": true,
            },
            "nameMatches": [[0, 1]], "terminal": { "resume": true, "new": true }, "description": "d",
        });
        let registry_row = RegistryRow {
            id: "r".into(),
            name: "Reg".into(),
            vendor: "v".into(),
            description: "d".into(),
            command_line: "c".into(),
            name_matches: vec![],
        };
        let registry_row_json = json!({ "id": "r", "name": "Reg", "vendor": "v", "description": "d", "commandLine": "c", "nameMatches": [] });
        let view = AgentsView {
            installed: vec![row.clone()],
            user_agents: vec![row],
            registry: vec![registry_row],
            counts: Counts { all: 1, updates: 2, off: 3 },
            default_agent: Some("a".into()),
            errors: strings(&["e"]),
            registry_state: RegistryState { checked_at: Some("c".into()), offline: true, checking: false },
        };

        assert_eq!(
            value(view),
            json!({
                "installed": [row_json], "userAgents": [row_json], "registry": [registry_row_json], "counts": { "all": 1, "updates": 2, "off": 3 },
                "defaultAgent": "a", "errors": ["e"], "registryState": { "checkedAt": "c", "offline": true, "checking": false },
            })
        );
    }

    #[test]
    fn the_agent_list_and_what_changes_it_keep_their_json() {
        let (summary, summary_json) = summary();
        let known = KnownAgent { id: "k".into(), name: "Known".into(), command: "npx".into(), args: strings(&["-y"]) };
        let list = AgentList {
            agents: vec![summary.clone()],
            default_agent: Some("a".into()),
            known: vec![known],
            user_agents: vec![summary],
            errors: strings(&["e"]),
        };
        let launch = LaunchConfig {
            agent_id: "a".into(),
            command: "npx".into(),
            args: strings(&["-y"]),
            env: BTreeMap::from([("K".to_owned(), "v".to_owned())]),
            mcp_servers: vec![json!({ "name": "m" })],
            cli: None,
        };
        let cases = [
            (
                value(list),
                json!({
                    "agents": [summary_json], "defaultAgent": "a", "known": [{ "id": "k", "name": "Known", "command": "npx", "args": ["-y"] }],
                    "userAgents": [summary_json], "errors": ["e"],
                }),
            ),
            (
                value(UntrustedAgent { name: "Agent".into(), launch }),
                json!({ "name": "Agent", "launch": { "agentId": "a", "command": "npx", "args": ["-y"], "env": { "K": "v" }, "mcpServers": [{ "name": "m" }] } }),
            ),
            (value(Removal { token: 3 }), json!({ "token": 3 })),
            (
                value(Updated { agent_id: "a".into(), version: "2".into(), downloaded: true }),
                json!({ "agentId": "a", "version": "2", "downloaded": true }),
            ),
        ];
        for (actual, expected) in cases {
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn the_notifiers_events_keep_their_json() {
        let tab = LoginTab { terminal_id: "t".into(), title: "T".into(), command_line: "c".into() };
        let event = SignInEvent {
            project_path: None,
            agent_id: "a".into(),
            state: SignInProgress::Failed,
            message: Some("m".into()),
            terminal: Some(tab),
        };
        let cases = [
            (value(AgentsChanged { project_path: None }), json!({ "projectPath": null })),
            (value(WorkspacesChanged { project_path: "/p".into() }), json!({ "projectPath": "/p" })),
            (
                value(event),
                json!({ "projectPath": null, "agentId": "a", "state": "failed", "message": "m", "terminal": { "terminalId": "t", "title": "T", "commandLine": "c" } }),
            ),
            (value(Notice { level: NoticeLevel::Error, message: "m".into() }), json!({ "level": "error", "message": "m" })),
        ];
        for (actual, expected) in cases {
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn a_release_status_keeps_its_json() {
        let known = ReleaseStatus { current: "0.9.2".into(), latest: Some("0.9.3".into()), update_available: true, self_update: true };
        let unknown = ReleaseStatus { current: "0.9.2".into(), latest: None, update_available: false, self_update: false };
        let cases = [
            (value(known), json!({ "current": "0.9.2", "latest": "0.9.3", "updateAvailable": true, "selfUpdate": true })),
            (value(unknown), json!({ "current": "0.9.2", "latest": null, "updateAvailable": false, "selfUpdate": false })),
        ];
        for (actual, expected) in cases {
            assert_eq!(actual, expected);
        }
    }

    /// Every value of every enum, as the page compares them.
    #[test]
    fn every_word_a_front_compares_stays_as_it_is() {
        let words = [
            (value(SessionStatus::Preparing), "preparing"),
            (value(SessionStatus::Starting), "starting"),
            (value(SessionStatus::Idle), "idle"),
            (value(SessionStatus::Working), "working"),
            (value(SessionStatus::Queued), "queued"),
            (value(SessionStatus::Waiting), "waiting"),
            (value(SessionStatus::Stopped), "stopped"),
            (value(SessionStatus::Error), "error"),
            (value(TitleSource::Prompt), "prompt"),
            (value(TitleSource::Agent), "agent"),
            (value(TitleSource::User), "user"),
            (value(NameSource::Agent), "agent"),
            (value(NameSource::User), "user"),
            (value(SessionActivity::Running), "running"),
            (value(SessionActivity::WaitingForUser), "waitingForUser"),
            (value(SessionActivity::Idle), "idle"),
            (value(SyncOutcome::Listed), "listed"),
            (value(SyncOutcome::Unsupported), "unsupported"),
            (value(SyncOutcome::Off), "off"),
            (value(SyncOutcome::Untrusted), "untrusted"),
            (value(SyncOutcome::SignIn), "signIn"),
            (value(SyncOutcome::Failed), "failed"),
            (value(Status::Ready), "ready"),
            (value(Status::NotStarted), "notStarted"),
            (value(Status::Off), "off"),
            (value(Status::SignIn), "signIn"),
            (value(Scope::User), "user"),
            (value(Scope::Project), "project"),
            (value(SignInKind::Agent), "agent"),
            (value(SignInKind::Terminal), "terminal"),
            (value(SignInKind::Command), "command"),
            (value(SignInProgress::Waiting), "waiting"),
            (value(SignInProgress::Done), "done"),
            (value(SignInProgress::Failed), "failed"),
            (value(SignInProgress::Cancelled), "cancelled"),
            (value(NoticeLevel::Warn), "warn"),
            (value(NoticeLevel::Error), "error"),
        ];
        for (actual, word) in words {
            assert_eq!(actual, word);
        }
    }
}
