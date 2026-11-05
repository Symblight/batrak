//! An agent's sign-in methods (`initialize`'s `authMethods`) as the app handles them: sent to
//! `authenticate`, or run in a terminal (the standard `terminal` type, or Zed's legacy
//! `_meta["terminal-auth"]` command).

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

/// How a method is carried out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SignInKind {
    /// `authenticate { methodId }`: the agent signs in itself.
    Agent,
    /// The agent's own launch plus the method's args and env, in a terminal.
    Terminal,
    /// The command its `terminal-auth` meta names, in a terminal.
    Command,
}

/// What a terminal sign-in runs; never sent to the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Login {
    /// Appended to the agent's launch; `env` overrides the launch's.
    Terminal { args: Vec<String>, env: BTreeMap<String, String> },
    /// An absolute command from the agent, run with the launch's env.
    Command { command: String, args: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    pub provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInMethod {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub kind: SignInKind,
    /// The `terminal-auth` label, for the terminal tab's title.
    pub label: Option<String>,
    /// A method that reads a key from the agent's environment (`_meta["api-key"]`).
    pub api_key: Option<ApiKey>,
    #[serde(skip)]
    pub login: Option<Login>,
}

/// One method of `authMethods`, as JSON; `None` for one without an id or name. A `terminal` type
/// wins over `terminal-auth` meta, which wins over `authenticate`.
pub fn parse_method(method: &Value) -> Option<SignInMethod> {
    let id = method["id"].as_str()?.to_owned();
    let name = method["name"].as_str()?.to_owned();
    let meta = &method["_meta"];
    let legacy = &meta["terminal-auth"];
    let strings = |v: &Value| -> Vec<String> {
        v.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
    };
    let (kind, login) = if method["type"] == "terminal" {
        let env = method["env"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
            .collect();
        (SignInKind::Terminal, Some(Login::Terminal { args: strings(&method["args"]), env }))
    } else if let Some(command) = legacy["command"].as_str().filter(|c| !c.is_empty()) {
        (SignInKind::Command, Some(Login::Command { command: command.to_owned(), args: strings(&legacy["args"]) }))
    } else {
        (SignInKind::Agent, None)
    };
    let api_key = meta.get("api-key").filter(|v| v.is_object()).map(|v| ApiKey { provider: v["provider"].as_str().map(str::to_owned) });
    Some(SignInMethod {
        id,
        name,
        description: method["description"].as_str().map(str::to_owned),
        kind,
        label: legacy["label"].as_str().map(str::to_owned),
        api_key,
        login,
    })
}

pub fn parse_methods(methods: &[Value]) -> Vec<SignInMethod> {
    methods.iter().filter_map(parse_method).collect()
}

/// A login to run in a terminal: its program, arguments and whole environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// What a terminal sign-in runs, given the agent's launch (`env`: its resolved environment). A
/// `terminal` method runs the launch plus its args, its env over the launch's; a `command` one
/// runs the agent's command with the launch's env.
pub fn login_command(command: &str, args: &[String], env: &[(String, String)], login: &Login) -> LoginCommand {
    match login {
        Login::Terminal { args: extra, env: overrides } => {
            let mut env: Vec<(String, String)> = env.iter().filter(|(k, _)| !overrides.contains_key(k)).cloned().collect();
            env.extend(overrides.iter().map(|(k, v)| (k.clone(), v.clone())));
            LoginCommand { program: command.to_owned(), args: args.iter().chain(extra).cloned().collect(), env }
        }
        Login::Command { command, args } => LoginCommand { program: command.clone(), args: args.clone(), env: env.to_vec() },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn kinds(methods: &[SignInMethod]) -> Vec<(&str, SignInKind)> {
        methods.iter().map(|m| (m.id.as_str(), m.kind)).collect()
    }

    #[test]
    fn copilot_runs_its_terminal_auth_command() {
        let methods = parse_methods(&[json!({
            "id": "copilot-login",
            "name": "Log in with Copilot CLI",
            "description": "Run `copilot login` in the terminal",
            "_meta": { "terminal-auth": {
                "command": "/opt/node_modules/@github/copilot-darwin-arm64/copilot",
                "args": ["login"],
                "label": "Copilot Login",
            } },
        })]);
        assert_eq!(kinds(&methods), [("copilot-login", SignInKind::Command)]);
        let copilot = &methods[0];
        assert_eq!(copilot.label.as_deref(), Some("Copilot Login"));
        assert_eq!(copilot.description.as_deref(), Some("Run `copilot login` in the terminal"));
        assert_eq!(
            copilot.login,
            Some(Login::Command {
                command: "/opt/node_modules/@github/copilot-darwin-arm64/copilot".into(),
                args: vec!["login".into()]
            })
        );
    }

    #[test]
    fn codex_and_gemini_authenticate_and_mark_api_keys() {
        let codex = parse_methods(&[
            json!({ "id": "api-key", "name": "API Key", "description": "Use an OpenAI API key", "_meta": { "api-key": { "provider": "openai" } } }),
            json!({ "id": "chat-gpt", "name": "ChatGPT", "description": "Sign in with ChatGPT" }),
        ]);
        assert_eq!(kinds(&codex), [("api-key", SignInKind::Agent), ("chat-gpt", SignInKind::Agent)]);
        assert_eq!(codex[0].api_key, Some(ApiKey { provider: Some("openai".into()) }));
        assert_eq!(codex[1].api_key, None);
        assert_eq!(codex[1].login, None);

        let gemini = parse_methods(&[
            json!({ "id": "oauth-personal", "name": "Log in with Google", "description": null }),
            json!({ "id": "gemini-api-key", "name": "Use Gemini API key", "_meta": { "api-key": { "provider": "google" } } }),
            json!({ "id": "vertex-ai", "name": "Vertex AI" }),
            json!({ "id": "gateway", "name": "AI API Gateway" }),
        ]);
        assert_eq!(
            kinds(&gemini),
            [
                ("oauth-personal", SignInKind::Agent),
                ("gemini-api-key", SignInKind::Agent),
                ("vertex-ai", SignInKind::Agent),
                ("gateway", SignInKind::Agent)
            ]
        );
        assert_eq!(gemini[0].description, None);
        assert_eq!(gemini[1].api_key, Some(ApiKey { provider: Some("google".into()) }));
    }

    #[test]
    fn claudes_terminal_type_wins_over_its_legacy_meta() {
        let methods = parse_methods(&[
            json!({
                "type": "terminal",
                "id": "claude-ai-login",
                "name": "Claude subscription",
                "description": "Log in with your Claude account",
                "args": ["--cli", "auth", "login", "--claudeai"],
                "env": { "CLAUDE_LOGIN": "1" },
                "_meta": { "terminal-auth": { "command": "node", "args": ["cli.js", "auth", "login"], "label": "Claude Login" } },
            }),
            json!({
                "type": "terminal",
                "id": "console-login",
                "name": "Anthropic Console",
                "args": ["--cli", "auth", "login", "--console"],
            }),
        ]);
        assert_eq!(kinds(&methods), [("claude-ai-login", SignInKind::Terminal), ("console-login", SignInKind::Terminal)]);
        assert_eq!(methods[0].label.as_deref(), Some("Claude Login"));
        assert_eq!(
            methods[0].login,
            Some(Login::Terminal {
                args: vec!["--cli".into(), "auth".into(), "login".into(), "--claudeai".into()],
                env: BTreeMap::from([("CLAUDE_LOGIN".into(), "1".into())]),
            })
        );
        assert_eq!(methods[1].label, None);
    }

    #[test]
    fn a_terminal_login_reruns_the_launch_with_its_args_and_env() {
        let launch = ["-y".to_owned(), "@agentclientprotocol/claude-agent-acp@0.94.0".to_owned()];
        let env = [("PATH".to_owned(), "/usr/bin".to_owned()), ("MODE".to_owned(), "acp".to_owned())];
        let login = Login::Terminal {
            args: vec!["--cli".into(), "auth".into(), "login".into(), "--claudeai".into()],
            env: BTreeMap::from([("MODE".into(), "login".into())]),
        };
        let command = login_command("npx", &launch, &env, &login);
        assert_eq!(command.program, "npx");
        assert_eq!(command.args, ["-y", "@agentclientprotocol/claude-agent-acp@0.94.0", "--cli", "auth", "login", "--claudeai"]);
        assert_eq!(command.env, [("PATH".to_owned(), "/usr/bin".to_owned()), ("MODE".to_owned(), "login".to_owned())]);
    }

    #[test]
    fn a_command_login_runs_the_agents_command_with_the_launch_env() {
        let env = [("PATH".to_owned(), "/usr/bin".to_owned())];
        let login = Login::Command { command: "/opt/copilot".into(), args: vec!["login".into()] };
        let command = login_command("npx", &["-y".to_owned(), "@github/copilot".to_owned()], &env, &login);
        assert_eq!(command, LoginCommand { program: "/opt/copilot".into(), args: vec!["login".into()], env: env.to_vec() });
    }

    #[test]
    fn methods_without_an_id_or_name_are_skipped_and_details_stay_out_of_json() {
        let methods = parse_methods(&[
            json!({ "name": "No id" }),
            json!({ "id": "x" }),
            json!({ "id": "cli", "name": "CLI", "_meta": { "terminal-auth": { "command": "/bin/cli", "args": ["login"] } } }),
        ]);
        assert_eq!(kinds(&methods), [("cli", SignInKind::Command)]);
        assert_eq!(
            serde_json::to_value(&methods[0]).unwrap(),
            json!({ "id": "cli", "name": "CLI", "description": null, "kind": "command", "label": null, "apiKey": null })
        );
    }
}
