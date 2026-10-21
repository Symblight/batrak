//! Which shell a terminal (and the login-shell environment agents get) runs, and its environment.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The user's default shell: `$SHELL`, else the account's login shell, else the platform's.
pub fn default_shell() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(comspec) = std::env::var_os("COMSPEC").filter(|s| !s.is_empty()) {
            return PathBuf::from(comspec);
        }
    }
    choose(std::env::var("SHELL").ok().as_deref(), account_shell(), &is_executable)
}

/// `env` when executable, else `account` when executable, else `/bin/zsh` (macOS) / `/bin/sh`.
fn choose(env: Option<&str>, account: Option<PathBuf>, executable: &dyn Fn(&Path) -> bool) -> PathBuf {
    env.filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| executable(p))
        .or_else(|| account.filter(|p| executable(p)))
        .unwrap_or_else(|| PathBuf::from(if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" }))
}

#[cfg(unix)]
fn account_shell() -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    // SAFETY: getpwuid returns a pointer into static storage or null; it's read at once.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_shell.is_null() {
            return None;
        }
        let shell = std::ffi::CStr::from_ptr((*entry).pw_shell).to_bytes();
        (!shell.is_empty()).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(shell)))
    }
}

#[cfg(not(unix))]
fn account_shell() -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// A terminal's environment: `base` (the app's) without git's redirects, plus what a terminal
/// emulator sets. `LANG` only when no locale is set (a GUI app starts with none).
pub fn terminal_env(base: impl IntoIterator<Item = (OsString, OsString)>, version: &str) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = base
        .into_iter()
        .filter(|(k, _)| !k.to_str().is_some_and(|k| crate::git::exec::SCRUBBED_ENV.contains(&k)))
        .collect();
    let has_locale = env.iter().any(|(k, v)| ["LANG", "LC_ALL", "LC_CTYPE"].map(OsString::from).contains(k) && !v.is_empty());
    let mut set = |key: &str, value: &str| {
        env.retain(|(k, _)| k != key);
        env.push((key.into(), value.into()));
    };
    set("TERM", "xterm-256color");
    set("COLORTERM", "truecolor");
    set("TERM_PROGRAM", "Brama");
    set("TERM_PROGRAM_VERSION", version);
    if !has_locale {
        set("LANG", "en_US.UTF-8");
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fallback() -> PathBuf {
        PathBuf::from(if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" })
    }

    #[test]
    fn the_shell_variable_wins_then_the_accounts_shell_then_the_platforms() {
        let all = |_: &Path| true;
        let account = Some(PathBuf::from("/usr/bin/fish"));
        assert_eq!(choose(Some("/bin/bash"), account.clone(), &all), PathBuf::from("/bin/bash"));
        assert_eq!(choose(Some(""), account.clone(), &all), PathBuf::from("/usr/bin/fish"));
        assert_eq!(choose(None, account.clone(), &all), PathBuf::from("/usr/bin/fish"));
        let only_fish = |p: &Path| p == Path::new("/usr/bin/fish");
        assert_eq!(choose(Some("/gone/bash"), account, &only_fish), PathBuf::from("/usr/bin/fish"), "not executable");
        assert_eq!(choose(None, None, &all), fallback());
        assert_eq!(choose(Some("/gone"), Some(PathBuf::from("/gone2")), &|_| false), fallback());
    }

    #[cfg(unix)]
    #[test]
    fn the_default_shell_is_executable() {
        assert!(is_executable(&default_shell()));
    }

    fn env_of(base: &[(&str, &str)]) -> std::collections::HashMap<OsString, OsString> {
        terminal_env(base.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))), "1.2.3").into_iter().collect()
    }

    #[test]
    fn a_terminal_says_what_it_is_and_drops_gits_redirects() {
        let env = env_of(&[("PATH", "/usr/bin"), ("GIT_DIR", "/x/.git"), ("GIT_INDEX_FILE", "i"), ("TERM", "dumb")]);
        let env: std::collections::HashMap<String, String> =
            env.into_iter().map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap())).collect();
        assert_eq!(env["TERM"], "xterm-256color");
        assert_eq!(env["COLORTERM"], "truecolor");
        assert_eq!(env["TERM_PROGRAM"], "Brama");
        assert_eq!(env["TERM_PROGRAM_VERSION"], "1.2.3");
        assert_eq!(env["PATH"], "/usr/bin");
        assert!(!env.contains_key("GIT_DIR") && !env.contains_key("GIT_INDEX_FILE"));
    }

    #[test]
    fn lang_is_set_only_without_a_locale() {
        let lang = OsString::from("LANG");
        assert_eq!(env_of(&[]).get(&lang), Some(&OsString::from("en_US.UTF-8")));
        assert_eq!(env_of(&[("LANG", "de_DE.UTF-8")])[&lang], "de_DE.UTF-8");
        assert!(!env_of(&[("LC_ALL", "C.UTF-8")]).contains_key(&lang));
        assert!(!env_of(&[("LC_CTYPE", "UTF-8")]).contains_key(&lang));
    }

    #[cfg(unix)]
    #[test]
    fn a_variable_that_isnt_utf8_is_passed_on() {
        use std::os::unix::ffi::OsStringExt;
        let odd = OsString::from_vec(vec![b'a', 0xff]);
        let env: std::collections::HashMap<_, _> =
            terminal_env([(OsString::from("ODD"), odd.clone())], "1.2.3").into_iter().collect();
        assert_eq!(env[&OsString::from("ODD")], odd);
    }
}
