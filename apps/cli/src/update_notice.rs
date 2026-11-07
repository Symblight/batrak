//! The notice that a newer batrak exists (docs/specs/app-update.md §2.2, §3.4). A command prints it
//! from the cache and never waits; a detached child of its own refreshes the cache. Nothing here can
//! change a command's output or exit code: every failure is silent.

use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bt_core::dirs::Dirs;
use bt_core::release::{self, Source};
use bt_core::util::write_atomic;
use semver::Version;
use serde::{Deserialize, Serialize};

use crate::self_update::Install;

const CACHE_FILE: &str = "cli-update-check.json";
const DAY: u64 = 24 * 60 * 60;
/// `Http`'s own timeouts add up to minutes, and nobody waits for this process to end.
const REFRESH_DEADLINE: Duration = Duration::from_secs(15);

/// What silences the notice and the check.
struct Env {
    stdout_tty: bool,
    stderr_tty: bool,
    ci: bool,
    json: bool,
    disabled: bool,
}

impl Env {
    fn current() -> Self {
        Self {
            stdout_tty: io::stdout().is_terminal(),
            stderr_tty: io::stderr().is_terminal(),
            ci: std::env::var_os("CI").is_some(),
            json: std::env::args_os().any(|arg| arg == "--json"),
            disabled: release::checks_disabled(),
        }
    }
}

/// `cli-update-check.json`, with times in unix seconds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Cache {
    checked_at: Option<u64>,
    latest: Option<Version>,
    notified_at: Option<u64>,
}

/// What a command does on its way out. `cache` is what to save, if it does anything.
#[derive(Debug, PartialEq, Eq)]
struct Plan {
    spawn: bool,
    notice: Option<String>,
    cache: Cache,
}

/// A missing or malformed file is an empty cache.
fn read_cache(path: &Path) -> Cache {
    fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn write_cache(path: &Path, cache: &Cache) -> Option<()> {
    let bytes = serde_json::to_vec(cache).ok()?;
    write_atomic(path, &bytes).ok()
}

/// A time in the future is a clock that moved, so it counts as long ago rather than silencing for years.
fn day_passed(since: Option<u64>, now: u64) -> bool {
    since.is_none_or(|at| at > now || now - at >= DAY)
}

fn decide(env: &Env, cache: &Cache, now: u64, current: &Version, advice: &str) -> Plan {
    let mut next = cache.clone();
    if !env.stdout_tty || !env.stderr_tty || env.ci || env.json || env.disabled {
        return Plan { spawn: false, notice: None, cache: next };
    }
    let spawn = day_passed(cache.checked_at, now);
    if spawn {
        next.checked_at = Some(now);
    }
    let news = cache.latest.as_ref().filter(|latest| release::compare(current, latest) && day_passed(cache.notified_at, now));
    let notice = news.map(|latest| format!("batrak {latest} is available (you have {current}). {advice}"));
    if notice.is_some() {
        next.notified_at = Some(now);
    }
    Plan { spawn, notice, cache: next }
}

/// Saves before the spawn, so the child's write comes after this one and a racing command sees the check
/// as taken. With nothing saved it does nothing, or it would repeat on every command.
fn finish(path: &Path, env: &Env, now: u64, current: &Version, advice: &str, err: &mut dyn Write, spawn: impl FnOnce()) {
    let plan = decide(env, &read_cache(path), now, current, advice);
    if !plan.spawn && plan.notice.is_none() {
        return;
    }
    if write_cache(path, &plan.cache).is_none() {
        return;
    }
    if let Some(notice) = plan.notice {
        let _ = writeln!(err, "{notice}");
    }
    if plan.spawn {
        spawn();
    }
}

/// For the end of a command that has the notice.
pub fn after_command() {
    let (Ok(dirs), Ok(install), Ok(now)) = (Dirs::resolve(), Install::running(), SystemTime::now().duration_since(UNIX_EPOCH)) else { return };
    let path = dirs.data.join(CACHE_FILE);
    finish(&path, &Env::current(), now.as_secs(), &install.current, &install.update_advice(), &mut io::stderr(), || spawn_refresh(&dirs.data));
}

/// Outlives this process without being waited on or sharing its terminal, so a command costs nothing and
/// Ctrl-C at the prompt doesn't reach the child. It runs in `dir`, since on Windows it would otherwise
/// keep the user's working directory from being deleted.
fn spawn_refresh(dir: &Path) {
    let Ok(exe) = std::env::current_exe() else { return };
    let mut command = Command::new(exe);
    command.args(["self", "refresh-check"]).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    let _ = command.spawn();
}

/// Reads the cache after the answer, so that what a command saved meanwhile stays.
fn refresh(path: &Path, source: &dyn Source) {
    if let Ok(manifest) = source.manifest() {
        let latest = Some(manifest.version);
        write_cache(path, &Cache { latest, ..read_cache(path) });
    }
}

/// `batrak self refresh-check`, the detached child. It never prints.
pub fn refresh_check() -> ExitCode {
    thread::spawn(|| {
        thread::sleep(REFRESH_DEADLINE);
        std::process::exit(1);
    });
    if let Ok(dirs) = Dirs::resolve() {
        refresh(&dirs.data.join(CACHE_FILE), &release::Http);
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests;
