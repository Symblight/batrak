//! Finds the `git` executable once. A GUI app on macOS starts with a minimal `PATH`, so the
//! usual install locations are tried after it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

static GIT: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The git executable, or an error the UI can show when there is none.
pub fn git() -> Result<&'static Path, String> {
    GIT.get_or_init(find).as_deref().ok_or_else(|| "git not found".to_owned())
}

fn find() -> Option<PathBuf> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let from_path = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).map(|dir| dir.join(name)).collect::<Vec<_>>())
        .unwrap_or_default();
    from_path
        .into_iter()
        .chain(fallbacks())
        .find(|candidate| candidate.is_file() && usable(candidate))
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
    fn finds_git_on_this_machine() {
        assert!(super::git().is_ok());
    }
}
