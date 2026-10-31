//! What several agent crates share: the mechanics of an npx agent (which package a launch runs, its
//! pinned launch, pinning a launch to a version, downloading a version ahead of a start). Later: an
//! agent's archive, downloaded and unpacked. A plugin may use it; the trait (`agent-api`) never
//! requires it.

use std::path::Path;

use agent_api::{Command, Launch, Update};

/// The package an `npx` launch runs: its argument's index, its name and the version it pins.
pub fn npx_package(launch: &Launch) -> Option<(usize, &str, Option<&str>)> {
    if Path::new(&launch.command).file_stem().is_none_or(|stem| stem != "npx") {
        return None;
    }
    let (at, spec) = package_arg(&launch.args)?;
    let (name, version) = split_spec(spec);
    Some((at, name, version))
}

/// Whether `launch` is npx running `package` (any version).
pub fn runs(launch: &Launch, package: &str) -> bool {
    npx_package(launch).is_some_and(|(_, name, _)| name == package)
}

/// An npx agent's update: its launch's `package` pinned to `version`, downloaded with npm.
pub fn npx_update(args: &[String], package: &str, version: &str) -> Option<Update> {
    Some(Update { pin: pin_arg(args, package, version)?, download: npm_prefetch(package, version) })
}

/// `npx -y <package>@<version> <args>`.
pub fn npx_launch(package: &str, version: &str, args: &[String]) -> Launch {
    let pinned = ["-y".to_owned(), format!("{package}@{version}")];
    Launch { command: "npx".to_owned(), args: pinned.into_iter().chain(args.iter().cloned()).collect() }
}

/// The argument of an npx launch's `args` that pins `package` to `version`, and where it goes;
/// `None` when npx runs another package.
pub fn pin_arg(args: &[String], package: &str, version: &str) -> Option<(usize, String)> {
    let (at, current) = package_arg(args)?;
    if split_spec(current).0 != package {
        return None;
    }
    let spec = format!("{package}@{version}");
    let arg = if args[at].starts_with("--package=") { format!("--package={spec}") } else { spec };
    Some((at, arg))
}

/// `npm cache add <package>@<version>`: downloads it, so npx's next run of it isn't a cold one.
pub fn npm_prefetch(package: &str, version: &str) -> Command {
    let program = if cfg!(windows) { "npm.cmd" } else { "npm" };
    Command { program: program.to_owned(), args: vec!["cache".to_owned(), "add".to_owned(), format!("{package}@{version}")] }
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
    use agent_api::strings;

    fn launch(command: &str, args: &[&str]) -> Launch {
        Launch { command: command.into(), args: strings(args) }
    }

    #[test]
    fn names_the_package_an_npx_launch_runs() {
        assert_eq!(
            npx_package(&launch("npx", &["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"])),
            Some((1, "@agentclientprotocol/claude-agent-acp", Some("0.99.1")))
        );
        assert_eq!(npx_package(&launch("/usr/local/bin/npx", &["--package=@github/copilot", "copilot"])), Some((0, "@github/copilot", None)));
        assert_eq!(npx_package(&launch("claude", &["--acp"])), None, "not npx");
    }

    #[test]
    fn builds_and_pins_npx_launches() {
        assert_eq!(npx_launch("@github/copilot", "1.0.103", &strings(&["--acp"])), launch("npx", &["-y", "@github/copilot@1.0.103", "--acp"]));
        assert_eq!(pin_arg(&strings(&["-y", "@github/copilot@1.0.1", "--acp"]), "@github/copilot", "1.0.2"), Some((1, "@github/copilot@1.0.2".into())));
        assert_eq!(pin_arg(&strings(&["--package=@github/copilot", "copilot"]), "@github/copilot", "1.0.2"), Some((0, "--package=@github/copilot@1.0.2".into())));
        assert_eq!(pin_arg(&strings(&["-y", "other"]), "@github/copilot", "1.0.2"), None, "another package");
    }

    #[test]
    fn updates_an_npx_launch_it_can_pin_only() {
        let update = npx_update(&strings(&["-y", "@github/copilot@1.0.1"]), "@github/copilot", "1.0.2").unwrap();
        assert_eq!(update.pin, (1, "@github/copilot@1.0.2".to_owned()));
        assert_eq!(update.download.args.last().map(String::as_str), Some("@github/copilot@1.0.2"));
        assert_eq!(npx_update(&strings(&["-y", "other"]), "@github/copilot", "1.0.2"), None);
        assert!(runs(&launch("npx", &["-y", "@github/copilot@1"]), "@github/copilot"));
        assert!(!runs(&launch("npx", &["-y", "other"]), "@github/copilot"));
    }

    #[test]
    fn downloads_a_version_with_npm() {
        let command = npm_prefetch("@github/copilot", "1.0.103");
        assert_eq!(command.args, ["cache", "add", "@github/copilot@1.0.103"]);
        assert_eq!(command.program, if cfg!(windows) { "npm.cmd" } else { "npm" });
    }
}
