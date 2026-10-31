//! What every agent crate implements, and the types the app and the crates share: an agent's
//! launch, its CLI and how a first prompt goes on the CLI's command line. No I/O.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

/// Stands for the ACP session id in `resumeArgs` / `newArgs`.
pub const ID: &str = "{id}";
/// Stands for a new session's first prompt in `promptArgs`.
pub const PROMPT: &str = "{prompt}";
/// A first prompt longer than this, in bytes, is pasted once the CLI reads instead of going on its
/// command line: well under Windows' 32 K and `ARG_MAX`, with room for the launch.
pub const MAX_ARG_PROMPT: usize = 8000;

/// Whether a first prompt can go on the CLI's command line. Never on Windows: the CLI runs as
/// `npx.cmd`, so through `cmd.exe`, which caps the whole line at 8191 and rewrites `%`, `^`, `&`, `|`
/// and `"` inside arguments.
pub fn prompt_fits_argv(prompt: &str, windows: bool) -> bool {
    !windows && prompt.len() <= MAX_ARG_PROMPT
}

/// How an agent's CLI runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliSpec {
    pub program: String,
    pub args: Vec<String>,
    pub resume_args: Vec<String>,
    pub new_args: Option<Vec<String>>,
    /// After `new_args`, a new session's first prompt: `{prompt}` replaced once, also inside an
    /// argument (`--interactive={prompt}`).
    pub prompt_args: Vec<String>,
}

/// What the agent list says about an agent's CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMode {
    /// It continues a session by id.
    pub resume: bool,
    /// It starts a new one under an id Brama chooses.
    pub new: bool,
}

impl CliSpec {
    /// The command line that continues ACP session `id`.
    pub fn resume(&self, id: &str) -> (String, Vec<String>) {
        (self.program.clone(), self.with(&self.resume_args, id))
    }

    /// The command line that starts a new session under `id`, with `prompt` as its first message;
    /// `None` when the CLI can't.
    pub fn start_new(&self, id: &str, prompt: Option<&str>) -> Option<(String, Vec<String>)> {
        let extra = self.new_args.as_ref()?;
        let mut args = self.with(extra, id);
        if let Some(prompt) = prompt.filter(|p| !p.trim().is_empty()) {
            // One word could name one of the CLI's commands (`claude update` runs the updater); a
            // trailing space keeps it a prompt.
            let prompt = if prompt.contains(char::is_whitespace) { prompt.to_owned() } else { format!("{prompt} ") };
            // One pass over the template: what the prompt holds is never expanded. An argument of its
            // own that starts like an option gets a leading space, so it stays a prompt; `--`
            // might not survive `npx` and the adapter's wrapper.
            args.extend(self.prompt_args.iter().map(|a| match a == PROMPT && prompt.starts_with('-') {
                true => format!(" {prompt}"),
                false => a.replacen(PROMPT, &prompt, 1),
            }));
        }
        Some((self.program.clone(), args))
    }

    /// With `flags` (the composer's picks, `Agent::cli_args`) after the resume and new-session args,
    /// so before a first prompt.
    pub fn with_flags(mut self, flags: Vec<String>) -> CliSpec {
        if let Some(new_args) = &mut self.new_args {
            new_args.extend(flags.iter().cloned());
        }
        self.resume_args.extend(flags);
        self
    }

    pub fn mode(&self) -> TerminalMode {
        TerminalMode { resume: true, new: self.new_args.is_some() }
    }

    fn with(&self, extra: &[String], id: &str) -> Vec<String> {
        self.args.iter().cloned().chain(extra.iter().map(|a| a.replace(ID, id))).collect()
    }
}

/// How an agent is started: its command and arguments (an `npx` launch names its package).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub command: String,
    pub args: Vec<String>,
}

impl Launch {
    /// The package an `npx` launch runs: its argument's index, its name and the version it pins.
    pub fn npx_package(&self) -> Option<(usize, &str, Option<&str>)> {
        if Path::new(&self.command).file_stem().is_none_or(|stem| stem != "npx") {
            return None;
        }
        let (at, spec) = package_arg(&self.args)?;
        let (name, version) = split_spec(spec);
        Some((at, name, version))
    }
}

/// One kind of agent. Default methods are plain ACP with no CLI; a crate overrides what its agent
/// does differently. The app's hub picks the crate for a launch and calls only this.
pub trait Agent: Send + Sync + 'static {
    /// Stable id of the kind (`claude`, `copilot`, `codex`, `generic`).
    fn kind(&self) -> &'static str;
    /// Whether this crate drives an agent with this launch.
    fn matches(&self, launch: &Launch) -> bool;
    /// Its CLI, if it has one: how to resume a session and start one under our id.
    fn cli(&self, _launch: &Launch) -> Option<CliSpec> {
        None
    }
    /// The composer's picks (option id → value) as the CLI's flags; those it doesn't know left out.
    fn cli_args(&self, _config: &BTreeMap<String, String>) -> Vec<String> {
        Vec::new()
    }
}

/// Whether an option's value may go on a CLI's command line as a flag's value: it looks like an id
/// (a model's, a mode's), never like a flag, and holds nothing a shell such as Windows' `cmd.exe`
/// (which runs `npx.cmd`) would read. A value can come from the agent, which reads the project's
/// settings, so it isn't trusted as is.
pub fn is_flag_value(value: &str) -> bool {
    value.len() <= 200
        && value.starts_with(|c: char| c.is_ascii_alphanumeric())
        && value.chars().all(|c| c.is_ascii_alphanumeric() || "._:/[]-".contains(c))
}

/// Owned strings, for building argument lists.
pub fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}

/// `<package>@<version>` (a scope's leading `@` is not the separator).
pub fn split_spec(spec: &str) -> (&str, Option<&str>) {
    match spec.rfind('@') {
        Some(at) if at > 0 => (&spec[..at], Some(&spec[at + 1..])),
        _ => (spec, None),
    }
}

/// Where npx's args name the package it runs: the first `-p` / `--package` value, else the first
/// argument that isn't a flag. Returns its index and the spec (`--package=` taken off).
pub fn package_arg(args: &[String]) -> Option<(usize, &str)> {
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        match arg.as_str() {
            "-p" | "--package" => return args.get(i + 1).map(|spec| (i + 1, spec.as_str())),
            "--" => return args.get(i + 1).map(|spec| (i + 1, spec.as_str())),
            _ => {}
        }
        if let Some(spec) = arg.strip_prefix("--package=") {
            return Some((i, spec));
        }
        if !arg.starts_with('-') {
            return Some((i, arg));
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(command: &str, args: &[&str]) -> Launch {
        Launch { command: command.into(), args: strings(args) }
    }

    #[test]
    fn names_the_package_an_npx_launch_runs() {
        assert_eq!(
            launch("npx", &["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"]).npx_package(),
            Some((1, "@agentclientprotocol/claude-agent-acp", Some("0.99.1")))
        );
        assert_eq!(launch("/usr/local/bin/npx", &["--package=@github/copilot", "copilot"]).npx_package(), Some((0, "@github/copilot", None)));
        assert_eq!(launch("claude", &["--acp"]).npx_package(), None, "not npx");
    }

    #[test]
    fn a_first_prompt_goes_on_the_command_line_only_where_it_is_safe() {
        assert!(prompt_fits_argv("fix the build", false));
        assert!(!prompt_fits_argv("fix the build", true), "Windows: npx.cmd runs through cmd.exe");
        assert!(prompt_fits_argv(&"x".repeat(MAX_ARG_PROMPT), false));
        assert!(!prompt_fits_argv(&"x".repeat(MAX_ARG_PROMPT + 1), false), "too long for a command line");
        assert!(!prompt_fits_argv(&"é".repeat(MAX_ARG_PROMPT / 2 + 1), false), "counted in bytes");
    }

    #[test]
    fn a_new_sessions_prompt_stays_a_prompt() {
        let spec = CliSpec { program: "cli".into(), args: vec![], resume_args: strings(&["--resume", ID]), new_args: Some(strings(&["--session-id", ID])), prompt_args: strings(&[PROMPT]) };
        let last = |prompt: &str| spec.start_new("abc", Some(prompt)).unwrap().1.last().cloned();
        assert_eq!(last("fix the build").as_deref(), Some("fix the build"));
        assert_eq!(last("update").as_deref(), Some("update "), "one word never names a command");
        assert_eq!(last("-v what changed?").as_deref(), Some(" -v what changed?"), "never parsed as a flag");
        assert_eq!(spec.resume("abc").1, ["--resume", "abc"]);
        assert_eq!(spec.mode(), TerminalMode { resume: true, new: true });
    }

    #[test]
    fn takes_only_id_like_values_for_flags() {
        for ok in ["opus", "claude-sonnet-5", "claude-opus-4-8[1m]", "bypassPermissions", "anthropic/claude:v1.2"] {
            assert!(is_flag_value(ok), "{ok}");
        }
        for bad in ["", "-v", "--dangerously-skip-permissions", "opus & calc", "a%PATH%", "a\"b", "a b", "^x", "a|b"] {
            assert!(!is_flag_value(bad), "{bad}");
        }
    }

    #[test]
    fn flags_go_after_the_resume_and_new_args_before_the_prompt() {
        let spec = CliSpec { program: "cli".into(), args: strings(&["--cli"]), resume_args: strings(&["--resume", ID]), new_args: Some(strings(&["--session-id", ID])), prompt_args: strings(&[PROMPT]) }
            .with_flags(strings(&["--model", "opus"]));
        assert_eq!(spec.resume("s").1, ["--cli", "--resume", "s", "--model", "opus"]);
        assert_eq!(spec.start_new("s", Some("fix it")).unwrap().1, ["--cli", "--session-id", "s", "--model", "opus", "fix it"]);
    }
}
