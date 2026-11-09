//! Records the tool calls real agents send, as sent, into each agent crate's fixture
//! (`packages/agent-<kind>/tests/fixtures/tool-calls.json`; spec:
//! `docs/specs/tool-wording-other-agents.md` §3.5). Each needs network, Node and the agent signed
//! in, so they're ignored. Run one with
//! `cargo test -p agent-acp --test real_tool_calls codex -- --ignored --nocapture`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_acp::process::{self, AgentCommand};
use agent_acp::{ClientHost, Connection, FsError, PermissionRequest, PromptBlock, StartOptions};
use serde_json::Value;
use tokio::sync::mpsc;

/// One call of each shape a row words differently, each its own tool call.
const PROMPT: &str = "This is a test of your tools; do each step as its own tool call, in order, \
and don't ask me anything. 1. Read README.md. 2. List the files in this folder. 3. Run the shell \
command `echo hello`. 4. Run the shell command `cat missing.txt` (it fails; go on). 5. Append the \
line `Edited.` to README.md. 6. Create notes.txt containing `A note.`. Then say done.";

/// What the agent sent for its tool calls, in order; permissions go out to be answered.
struct Recorder {
    root: PathBuf,
    updates: Mutex<Vec<Value>>,
    permissions: mpsc::UnboundedSender<PermissionRequest>,
}

impl ClientHost for Recorder {
    fn on_update(&self, update: Value, subagent: Option<String>) {
        let kind = update["sessionUpdate"].as_str().unwrap_or_default();
        if kind != "tool_call" && kind != "tool_call_update" {
            return;
        }
        let mut update = update;
        if let Some(subagent) = subagent {
            update["recordedSubagent"] = subagent.into();
        }
        self.updates.lock().unwrap().push(update);
    }

    fn on_permission_request(&self, request: PermissionRequest) {
        let _ = self.permissions.send(request);
    }

    fn read_text_file(&self, path: PathBuf, line: Option<u32>, limit: Option<u32>) -> Result<String, FsError> {
        let text = std::fs::read_to_string(self.inside(&path)?).map_err(|e| FsError::NotFound(e.to_string()))?;
        let skip = line.map_or(0, |l| l.saturating_sub(1) as usize);
        let take = limit.map_or(usize::MAX, |l| l as usize);
        Ok(text.lines().skip(skip).take(take).collect::<Vec<_>>().join("\n"))
    }

    fn write_text_file(&self, path: PathBuf, content: String) -> Result<(), FsError> {
        std::fs::write(self.inside(&path)?, content).map_err(|e| FsError::Io(e.to_string()))
    }
}

impl Recorder {
    fn inside(&self, path: &Path) -> Result<PathBuf, FsError> {
        match path.starts_with(&self.root) {
            true => Ok(path.to_owned()),
            false => Err(FsError::Denied(format!("{}: outside the project", path.display()))),
        }
    }
}

/// Runs `PROMPT` with the agent `program args` in a fresh project and writes its tool calls to
/// `agent-<kind>`'s fixture, the project's path as `/project`.
async fn record(kind: &str, program: &str, args: &[&str]) {
    let dir = std::env::temp_dir().join(format!("batrak-record-{kind}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = dir.join("project");
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    std::fs::write(root.join("README.md"), "# Sample\n\nA project to test tools in.\n").unwrap();

    let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    let env: Vec<(String, String)> = std::env::vars().collect();
    let stderr = std::fs::File::create(dir.join("agent.log")).unwrap();
    let command = AgentCommand { program, args: &args, cwd: &root, env: &env };
    let (mut agent, pipes) = process::spawn(&command, stderr).unwrap();

    let (tx, mut permissions) = mpsc::unbounded_channel();
    let recorder = Arc::new(Recorder { root: root.clone(), updates: Mutex::default(), permissions: tx });
    let opts = StartOptions {
        cwd: root.clone(),
        mcp_servers: vec![],
        resume: None,
        agent_name: kind.to_owned(),
        initialize_timeout: Duration::from_secs(180),
        authenticate: None,
    };
    let (connection, _) = Connection::start(pipes.stdin, pipes.stdout, recorder.clone(), opts).await.unwrap();
    let connection = Arc::new(connection);

    // Allows every call once, so each one runs.
    let answering = connection.clone();
    let answers = tokio::spawn(async move {
        while let Some(request) = permissions.recv().await {
            let allow = request.options.as_array().into_iter().flatten().find(|o| o["kind"].as_str().is_some_and(|k| k.starts_with("allow")));
            let option = allow.and_then(|o| o["optionId"].as_str()).map(str::to_owned);
            let _ = answering.respond_permission(&request.request_id, option);
        }
    });
    let stop = tokio::time::timeout(Duration::from_secs(600), connection.prompt(vec![PromptBlock::Text(PROMPT.to_owned())])).await;
    answers.abort();
    agent.stop().await;
    eprintln!("{kind}: stopped with {stop:?}");

    let updates = recorder.updates.lock().unwrap().clone();
    let json = serde_json::to_string_pretty(&updates).unwrap().replace(&root.to_string_lossy().into_owned(), "/project");
    let json = scrub(&json, &format!("{}/project", dir.file_name().unwrap().to_string_lossy()));
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../agent-{kind}/tests/fixtures/tool-calls.json"));
    std::fs::create_dir_all(fixture.parent().unwrap()).unwrap();
    std::fs::write(&fixture, json + "\n").unwrap();
    eprintln!("{kind}: {} updates written to {}", updates.len(), fixture.display());
    assert!(!updates.is_empty(), "{kind} called no tools; its log: {}", dir.join("agent.log").display());
}

/// `json` with each run of a path that ends in `marker` (a title may shorten it: `...T/<marker>`)
/// as `/project`, back to the space or quote before it.
fn scrub(json: &str, marker: &str) -> String {
    let mut out = String::new();
    let mut rest = json;
    while let Some(at) = rest.find(marker) {
        let start = rest[..at].rfind([' ', '"']).map_or(0, |i| i + 1);
        out.push_str(&rest[..start]);
        out.push_str("/project");
        rest = &rest[at + marker.len()..];
    }
    out + rest
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_claude_tool_calls() {
    record("claude", "npx", &["-y", "@agentclientprotocol/claude-agent-acp"]).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_codex_tool_calls() {
    record("codex", "npx", &["-y", "@agentclientprotocol/codex-acp"]).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_copilot_tool_calls() {
    record("copilot", "npx", &["-y", "@github/copilot", "--acp"]).await;
}
