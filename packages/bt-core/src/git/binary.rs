//! Finds the `git` executable once. A GUI app on macOS starts with a minimal `PATH`, so the
//! usual install locations are tried after it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use super::exec::{self, Mode};

/// The oldest git with everything we call: `worktree list -z` came last.
const MIN_VERSION: (u32, u32) = (2, 36);

static GIT: OnceLock<Result<PathBuf, String>> = OnceLock::new();

/// The git executable, or an error the UI can show when there is none we can use.
pub fn git() -> Result<&'static Path, String> {
    GIT.get_or_init(find).as_deref().map_err(Clone::clone)
}

fn find() -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let from_path = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).map(|dir| dir.join(name)).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut too_old = None;
    for candidate in from_path.into_iter().chain(fallbacks()) {
        if !candidate.is_file() || !usable(&candidate) {
            continue;
        }
        let version = exec::run(&candidate, &std::env::temp_dir(), &exec::args(&[&"--version"]), Mode::Background).unwrap_or_default();
        let version = String::from_utf8_lossy(&version);
        if supported(&version) {
            return Ok(candidate);
        }
        too_old.get_or_insert_with(|| version.trim().to_owned());
    }
    let (major, minor) = MIN_VERSION;
    Err(too_old.map_or_else(|| "git not found".to_owned(), |found| format!("{found} is too old: Batrak needs git {major}.{minor} or later")))
}

/// Whether `git --version`'s output names a version we can use; one we can't read gets the benefit
/// of the doubt, as a call that needs more then fails with git's own message.
fn supported(version: &str) -> bool {
    let number = version.trim().strip_prefix("git version ").unwrap_or_default();
    let mut parts = number.split('.').map(|part| part.parse::<u32>().ok());
    match (parts.next().flatten(), parts.next().flatten()) {
        (Some(major), Some(minor)) => (major, minor) >= MIN_VERSION,
        _ => true,
    }
}

#[cfg(target_os = "macos")]
fn fallbacks() -> Vec<PathBuf> {
    ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"].into_iter().map(PathBuf::from).collect()
}

#[cfg(windows)]
fn fallbacks() -> Vec<PathBuf> {
    ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files (x86)\\Git\\cmd\\git.exe"]
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn fallbacks() -> Vec<PathBuf> {
    ["/usr/bin/git", "/usr/local/bin/git"].into_iter().map(PathBuf::from).collect()
}

/// `/usr/bin/git` on macOS is a stub that opens the Command Line Tools installer when they're
/// missing; only use it when `xcode-select` reports a developer directory.
fn usable(candidate: &Path) -> bool {
    if cfg!(target_os = "macos") && candidate == Path::new("/usr/bin/git") {
        return Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
    }
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn git_older_than_the_oldest_we_use_is_refused() {
        for (version, ok) in [
            ("git version 2.55.0\n", true),
            ("git version 2.36.0", true),
            ("git version 2.39.5 (Apple Git-154)", true),
            ("git version 2.45.1.windows.1", true),
            ("git version 3.0.0", true),
            ("git version 2.35.9", false),
            ("git version 1.9.5", false),
            ("not what we expected", true),
        ] {
            assert_eq!(super::supported(version), ok, "{version}");
        }
    }

    #[test]
    fn finds_git_on_this_machine() {
        assert!(super::git().is_ok());
    }
}
