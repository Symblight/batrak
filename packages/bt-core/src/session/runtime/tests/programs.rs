//! A CLI of the fake agent, and the programs sessions ran.

use super::*;

/// The fake agent with a CLI of its own.
pub(super) const CLI_AGENTS: &str = r#"{"version":1,"agents":{
    "fake":{"name":"Fake","command":"fake-agent","env":{"TOKEN":"${keychain:token}"},
        "cli":{"command":"fake-cli","resumeArgs":["--resume","{id}"],"newArgs":["--session-id","{id}"]}},
    "quitter":{"name":"Quitter","command":"fake-agent","cli":{"command":"fake-cli","resumeArgs":["{id}"]}},
    "plain":{"name":"Plain","command":"fake-agent"}}}"#;

/// The programs sessions ran, a client's own, as a recording `ProgramRunner` sees them.
#[derive(Default, Clone)]
pub(super) struct Programs(Arc<Mutex<HashMap<String, Ran>>>);

pub(super) struct Ran {
    client: String,
    cwd: PathBuf,
    program: Program,
    on_exit: Option<OnExit>,
}

pub(super) struct ClientPrograms {
    programs: Programs,
    client: String,
}

impl ProgramRunner for ClientPrograms {
    fn run(&self, id: &str, cwd: &Path, program: Program, _size: Option<(u16, u16)>, on_exit: OnExit) -> Result<(), String> {
        let ran = Ran { client: self.client.clone(), cwd: cwd.to_path_buf(), program, on_exit: Some(on_exit) };
        lock(&self.programs.0).insert(id.to_owned(), ran);
        Ok(())
    }

    fn close(&self, id: &str) {
        self.programs.close(id);
    }

    fn busy(&self, _id: &str) -> bool {
        false
    }

    fn owns(&self, id: &str) -> bool {
        self.programs.owns(&self.client, id)
    }
}

impl Programs {
    pub(super) fn client(&self, client: &str) -> Arc<dyn ProgramRunner> {
        Arc::new(ClientPrograms { programs: self.clone(), client: client.to_owned() })
    }

    pub(super) fn owns(&self, client: &str, id: &str) -> bool {
        lock(&self.0).get(id).is_some_and(|ran| ran.client == client)
    }

    pub(super) fn program(&self, id: &str) -> Program {
        lock(&self.0)[id].program.clone()
    }

    /// What it got: its arguments, folder and the agent's secret.
    pub(super) fn shown(&self, id: &str) -> String {
        let programs = lock(&self.0);
        let ran = &programs[id];
        let token = ran.program.env.iter().find(|(k, _)| k == "TOKEN").map_or("", |(_, v)| v.as_str());
        format!("ARGS:{} PWD:{} TOKEN:{token}", ran.program.args.join(" "), ran.cwd.display())
    }

    /// It ended on its own.
    pub(super) fn exit(&self, id: &str, code: Option<i32>, signal: Option<&str>) {
        let on_exit = lock(&self.0).get_mut(id).and_then(|ran| ran.on_exit.take());
        on_exit.expect("it runs")(Some(&ProgramExit { code, signal: signal.map(str::to_owned) }));
    }

    /// Its terminal closed first.
    pub(super) fn close(&self, id: &str) {
        let ran = lock(&self.0).remove(id);
        if let Some(on_exit) = ran.and_then(|ran| ran.on_exit) {
            on_exit(None);
        }
    }
}

pub(super) fn listed(f: &Fixture, id: &str) -> Session {
    f.sessions.list().into_iter().find(|s| s.id == id).unwrap()
}

impl Fixture {
    /// The project's agents with CLIs, trusted.
    pub(super) fn give_cli_agents(&self) {
        self.set_agents(&self.project, CLI_AGENTS);
        let configs = &self.sessions.inner.opts.configs;
        let launches: Vec<_> = configs.untrusted(&self.project).into_iter().map(|u| u.launch).collect();
        configs.trust(&self.project, &launches).unwrap();
    }

    /// A session of `agent` that started once (so its agent has it) and is stopped.
    pub(super) async fn started_then_stopped(&self, id: &str, agent: &str) -> (String, Arc<Recorder>) {
        let (_, events) = self.create(id, agent).unwrap();
        events.wait_status("idle").await;
        self.sessions.stop(id).await.unwrap();
        (listed(self, id).acp_session_id.unwrap(), events)
    }

    pub(super) fn draft(&self, agent: &str, workspace_id: Option<String>) -> CliDraft {
        CliDraft {
            project_path: self.project.to_string_lossy().into_owned(),
            agent_id: agent.to_owned(),
            title: "New session".to_owned(),
            config: BTreeMap::new(),
            workspace_id,
            prompt: None,
        }
    }
}
