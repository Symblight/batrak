//! Rules every part of the core shares: paths inside a root, atomic writes, ISO time, the user's shell.

use std::path::{Path, PathBuf};

/// Checks a root-relative path from the frontend: `/`-separated, no `..`, `.` or empty
/// segments, not absolute, and not inside `.git`. Every command taking a relative path calls it.
pub fn checked_rel(rel: &str) -> Result<&str, String> {
    let ok = !rel.is_empty()
        && !rel.contains('\\')
        && !rel.contains('\0')
        && !Path::new(rel).is_absolute()
        && rel.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        && rel.split('/').next() != Some(".git");
    if ok {
        Ok(rel)
    } else {
        Err(format!("{rel:?}: not a path inside the root"))
    }
}

/// Writes `content` to `path` atomically: a temp file in the same folder, then a rename over it.
/// Missing parent folders are created.
pub fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent folder"))?;
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.batrak-{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(content)?;
        file.sync_all()?;
        // Keep the file's mode (an executable script stays executable).
        if let Ok(meta) = std::fs::metadata(path) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Now as an ISO 8601 UTC timestamp with milliseconds, like JavaScript's `toISOString()`.
pub fn iso_now() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    iso_from_millis(now.as_millis() as i64)
}

pub fn iso_from_millis(ms: i64) -> String {
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Milliseconds since the epoch of an ISO 8601 / RFC 3339 timestamp (`2026-10-20T10:00:00Z`,
/// fractions and `±HH:MM` offsets too), as agents write `updatedAt`.
pub fn parse_iso_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hour, minute, second) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut i = 19;
    let mut millis = 0;
    if b.get(i) == Some(&b'.') {
        let digits = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            return None;
        }
        let frac = &s[i + 1..i + 1 + digits.min(3)];
        millis = frac.parse::<i64>().ok()? * 10_i64.pow(3 - frac.len() as u32);
        i += 1 + digits;
    }
    let offset = match b.get(i) {
        Some(b'Z' | b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if b.len() == i + 6 && b[i + 3] == b':' => {
            let minutes = num(i + 1, 2)? * 60 + num(i + 4, 2)?;
            if *sign == b'+' { minutes } else { -minutes }
        }
        _ => return None,
    };
    // Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset * 60;
    Some(secs * 1000 + millis)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_rel_rejects_paths_leaving_the_root() {
        for ok in ["a.txt", "src/main.rs", ".gitignore", "a/.git-keep", "dir with space/ф.txt"] {
            assert_eq!(checked_rel(ok), Ok(ok), "{ok}");
        }
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a/", ".git/config", ".git", "a\\b", "C:\\x"] {
            assert!(checked_rel(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn atomic_write_replaces_and_creates() {
        let root = std::env::temp_dir().join(format!("batrak-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "a").unwrap();
        write_atomic(&root.join("src/a.txt"), b"new").unwrap();
        assert_eq!(std::fs::read_to_string(root.join("src/a.txt")).unwrap(), "new");
        write_atomic(&root.join("x/y/z.txt"), b"z").unwrap();
        assert_eq!(std::fs::read_to_string(root.join("x/y/z.txt")).unwrap(), "z");
        let leftovers: Vec<_> = std::fs::read_dir(root.join("src")).unwrap().filter_map(Result::ok).collect();
        assert_eq!(leftovers.len(), 1, "no temp file left");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_agents_timestamps() {
        assert_eq!(parse_iso_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_millis("2026-10-15T11:54:56.789Z"), Some(1_792_065_296_789));
        assert_eq!(parse_iso_millis("2026-10-15T11:54:56.7891234Z"), Some(1_792_065_296_789));
        assert_eq!(parse_iso_millis("2026-10-15T13:54:56.789+02:00"), Some(1_792_065_296_789));
        assert_eq!(parse_iso_millis("2000-02-29T00:00:00Z"), Some(951_782_400_000));
        for bad in ["", "yesterday", "2026-13-01T00:00:00Z", "2026-10-15T11:54:56", "2026-10-15T11:54:56.Z"] {
            assert_eq!(parse_iso_millis(bad), None, "{bad}");
        }
    }

    #[test]
    fn iso_timestamps() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_792_065_296_789), "2026-10-15T11:54:56.789Z");
        assert_eq!(iso_from_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

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
}
