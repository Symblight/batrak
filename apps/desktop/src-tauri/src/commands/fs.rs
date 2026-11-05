use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::ipc::Response;
use tauri::{State};

use crate::config::AgentConfigs;
use crate::session::Sessions;
use crate::roots::Roots;

use super::blocking;

/// The user-level agents.json, canonical, when it exists: readable and writable like a file in a root.
fn user_agents_file(configs: &AgentConfigs) -> Option<std::path::PathBuf> {
    configs.user_file().and_then(|f| dunce::canonicalize(f).ok())
}

/// Images larger than this aren't sent to the page: one IPC reply holds the whole file.
const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Text files larger than this don't open: the editor holds its whole text several times over.
const MAX_TEXT_BYTES: u64 = 16 * 1024 * 1024;

/// A path the page may read, canonical: inside an opened root, a worktree session's
/// folder, or the user's agents.json. Symlinks are resolved first, so none can lead out of a root.
fn readable(
    roots: &Roots,
    configs: &AgentConfigs,
    sessions: &Sessions,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    // Same form as the roots (no `\\?\` on Windows), so `contains` can compare them.
    let canonical = dunce::canonicalize(Path::new(path)).map_err(|e| format!("{path}: {e}"))?;
    let inside = roots.contains(&canonical) || sessions.contains(&canonical);
    if !inside && Some(&canonical) != user_agents_file(configs).as_ref() {
        return Err(format!("{path}: outside the opened folder"));
    }
    Ok(canonical)
}

/// Reads a readable file (see `readable`) as UTF-8 text, as its bytes (the page gets an `ArrayBuffer`
/// and decodes it, with no JSON copy). Fails for binary (non-UTF-8) files and over `MAX_TEXT_BYTES`.
#[tauri::command]
pub async fn read_file(
    roots: State<'_, Roots>,
    configs: State<'_, AgentConfigs>,
    sessions: State<'_, Sessions>,
    path: String,
) -> Result<Response, String> {
    let roots = roots.inner().clone();
    let configs = configs.inner().clone();
    let sessions = sessions.inner().clone();
    blocking(move || {
        let canonical = readable(&roots, &configs, &sessions, &path)?;
        read_text(&canonical, MAX_TEXT_BYTES).map(Response::new)
    })
    .await?
}

/// A regular file's bytes, failing when it has more than `max`. Anything else is refused before it's
/// opened: opening a FIFO nobody writes would hang.
fn read_capped(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let shown = path.display();
    if !fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?.is_file() {
        return Err(format!("{shown}: not a regular file"));
    }
    let mut bytes = Vec::new();
    let file = fs::File::open(path).map_err(|e| format!("{shown}: {e}"))?;
    file.take(max + 1).read_to_end(&mut bytes).map_err(|e| format!("{shown}: {e}"))?;
    if bytes.len() as u64 > max {
        return Err(format!("{shown}: too large to open (over {max} bytes)"));
    }
    Ok(bytes)
}

/// A text file's bytes, failing when they aren't UTF-8.
fn read_text(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let bytes = read_capped(path, max)?;
    match std::str::from_utf8(&bytes) {
        Ok(_) => Ok(bytes),
        Err(_) => Err(format!("{}: not UTF-8 text", path.display())),
    }
}

/// Reads a readable file (see `readable`) as raw bytes, for an image tab; the page gets an
/// `ArrayBuffer`, not a JSON array. At most `MAX_BYTES`.
#[tauri::command]
pub async fn read_file_bytes(
    roots: State<'_, Roots>,
    configs: State<'_, AgentConfigs>,
    sessions: State<'_, Sessions>,
    path: String,
) -> Result<Response, String> {
    let roots = roots.inner().clone();
    let configs = configs.inner().clone();
    let sessions = sessions.inner().clone();
    blocking(move || {
        let canonical = readable(&roots, &configs, &sessions, &path)?;
        read_capped(&canonical, MAX_BYTES).map(Response::new)
    })
    .await?
}

/// A path in canonical form though the file itself may be gone: its folder canonical, then its name.
fn canonical_or_missing(path: &Path) -> std::io::Result<PathBuf> {
    match dunce::canonicalize(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
                return Err(e);
            };
            Ok(dunce::canonicalize(dir)?.join(name))
        }
        resolved => resolved,
    }
}

/// Where a save of `path` writes (canonical; a deleted file is created again) and the project
/// whose `.brama/agents.json` it is, `None` for the user's agents.json. Nothing else is writable.
fn writable(
    path: &str,
    user_file: Option<&Path>,
    contains_project: impl Fn(&Path) -> bool,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    let canonical = canonical_or_missing(Path::new(path)).map_err(|e| format!("{path}: {e}"))?;
    if user_file.and_then(|f| canonical_or_missing(f).ok()).as_ref() == Some(&canonical) {
        return Ok((canonical, None));
    }
    let project = crate::config::project_of_agents_file(&canonical)
        .filter(|_| contains_project(&canonical))
        .map(Path::to_path_buf);
    match project {
        Some(project) => Ok((canonical, Some(project))),
        None => Err(format!("{path}: only agents.json can be edited")),
    }
}

/// Saves an agents.json from the editor: a project's `.brama/agents.json` inside an opened project, or
/// the user's, created again if it was deleted. Nothing else is writable from the page yet. The agent
/// list is re-read right away (`agents://changed`; `projectPath: null` for the user's file, which
/// affects every project).
#[tauri::command]
pub async fn write_file(
    roots: State<'_, Roots>,
    configs: State<'_, AgentConfigs>,
    path: String,
    content: String,
) -> Result<(), String> {
    let roots = roots.inner().clone();
    let configs = configs.inner().clone();
    blocking(move || {
        let (canonical, project) =
            writable(&path, configs.user_file(), |p| roots.contains_project(p))?;
        crate::util::write_atomic(&canonical, content.as_bytes()).map_err(|e| format!("{path}: {e}"))?;
        let changed = match &project {
            Some(project) => configs.reload(project),
            None => configs.reload_user(),
        };
        if changed {
            configs.announce(project.as_deref());
        }
        Ok(())
    })
    .await?
}

/// Shows a file or folder in the OS file manager: selected in Finder / Explorer. Elsewhere a folder
/// opens, a file's own: `xdg-open` on a file would launch it with its default handler.
#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), String> {
    blocking(move || {
        // Absolute and free of `..`, so it can't read as an option to the tools below.
        let target = dunce::canonicalize(Path::new(&path)).map_err(|e| format!("{path}: {e}"))?;
        #[cfg(target_os = "macos")]
        let status = Command::new("open").arg("-R").arg(&target).status();
        // Explorer parses its own command line: quote the path so a comma in it doesn't end `/select`.
        // Windows paths can't contain `"`, so it can't close the quotes early.
        #[cfg(target_os = "windows")]
        let status = {
            use std::os::windows::process::CommandExt;
            Command::new("explorer").raw_arg(format!("/select,\"{}\"", target.display())).status()
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let status = {
            let folder = if target.is_dir() { target.as_path() } else { target.parent().unwrap_or(&target) };
            Command::new("xdg-open").arg(folder).status()
        };
        // Explorer exits with 1 even on success, so only a failure to launch counts.
        status.map(|_| ()).map_err(|e| format!("{path}: {e}"))
    })
    .await?
}

/// A link the OS may open: `http`, `https` or `mailto`, with no quote, whitespace or control
/// character (a URL from the page's `href` property has them percent-encoded), so no launcher can
/// read it as more than one argument.
fn checked_url(url: &str) -> Result<&str, String> {
    let lower = url.to_ascii_lowercase();
    let scheme = ["http://", "https://", "mailto:"].iter().any(|scheme| lower.starts_with(scheme));
    let plain = !url.chars().any(|c| c == '"' || c.is_whitespace() || c.is_control());
    if scheme && plain {
        Ok(url)
    } else {
        Err(format!("{url:?}: only web and mail links open"))
    }
}

/// Opens a link from an agent's reply in the default browser (a click in the page would navigate
/// the app's own window away). Only `http`, `https` and `mailto`.
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    checked_url(&url)?;
    blocking(move || {
        #[cfg(target_os = "macos")]
        let status = Command::new("open").arg(&url).status();
        // Not through `cmd /C start`: cmd would read `&`, `|` and `%` in the URL as its own syntax.
        #[cfg(target_os = "windows")]
        let status = Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).status();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let status = Command::new("xdg-open").arg(&url).status();
        status.map(|_| ()).map_err(|e| format!("{url}: {e}"))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::{checked_url, read_capped, read_text, writable};
    use std::path::{Path, PathBuf};

    /// A temp folder (canonical) with a project at `p/` holding `.brama/`; removed on drop.
    struct Tmp(PathBuf);

    impl Tmp {
        fn new(name: &str) -> Tmp {
            let dir = std::env::temp_dir().join(format!("batrak-writable-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("p/.brama")).unwrap();
            Tmp(dunce::canonicalize(dir).unwrap())
        }

        fn project(&self) -> PathBuf {
            self.0.join("p")
        }

        fn in_project(&self) -> impl Fn(&Path) -> bool + '_ {
            move |path: &Path| path.starts_with(self.project())
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_project_agents_file_is_writable_existing_or_deleted() {
        let tmp = Tmp::new("project");
        let file = tmp.project().join(".brama/agents.json");
        let expected = Ok((file.clone(), Some(tmp.project())));
        assert_eq!(writable(file.to_str().unwrap(), None, tmp.in_project()), expected, "deleted");
        std::fs::write(&file, "{}").unwrap();
        assert_eq!(writable(file.to_str().unwrap(), None, tmp.in_project()), expected, "existing");
    }

    #[test]
    fn the_user_agents_file_is_writable_existing_or_deleted() {
        let tmp = Tmp::new("user");
        let file = tmp.0.join("agents.json");
        let expected = Ok((file.clone(), None));
        assert_eq!(writable(file.to_str().unwrap(), Some(&file), |_| false), expected, "deleted");
        std::fs::write(&file, "{}").unwrap();
        assert_eq!(writable(file.to_str().unwrap(), Some(&file), |_| false), expected, "existing");
    }

    #[test]
    fn nothing_else_is_writable() {
        let tmp = Tmp::new("other");
        let project = tmp.project();
        std::fs::write(project.join("a.txt"), "").unwrap();
        std::fs::create_dir(tmp.0.join(".brama")).unwrap();
        for (path, why) in [
            (project.join("a.txt"), "another file"),
            (project.join(".brama/other.json"), "another missing file"),
            (project.join("gone/.brama/agents.json"), "a missing folder"),
            (tmp.0.join(".brama/agents.json"), "outside the project"),
        ] {
            assert!(writable(path.to_str().unwrap(), None, tmp.in_project()).is_err(), "{why}");
        }
    }

    #[test]
    fn reads_bytes_up_to_the_cap() {
        let dir = std::env::temp_dir().join(format!("batrak-read-bytes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.png");
        std::fs::write(&file, [0x89, b'P', b'N', b'G', 0xff]).unwrap();
        assert_eq!(read_capped(&file, 5), Ok(vec![0x89, b'P', b'N', b'G', 0xff]));
        let too_big = read_capped(&file, 4).unwrap_err();
        assert!(too_big.contains("too large"), "{too_big}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_a_regular_file_is_read() {
        let dir = std::env::temp_dir().join(format!("batrak-read-regular-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let folder = read_capped(&dir, 1024).unwrap_err();
        assert!(folder.contains("not a regular file"), "{folder}");
        #[cfg(unix)]
        {
            let fifo = dir.join("fifo");
            assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
            // On a thread: reading a FIFO nobody writes would hang the test instead of failing it.
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || tx.send(read_capped(&fifo, 1024)));
            let refused = rx.recv_timeout(std::time::Duration::from_secs(2)).expect("a FIFO doesn't hang the read");
            assert!(refused.unwrap_err().contains("not a regular file"));
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn text_is_utf8_kept_as_it_is_on_disk() {
        let dir = std::env::temp_dir().join(format!("batrak-read-text-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        let bom_and_crlf = b"\xef\xbb\xbfa\r\nb".to_vec();
        std::fs::write(&file, &bom_and_crlf).unwrap();
        assert_eq!(read_text(&file, 1024), Ok(bom_and_crlf));
        std::fs::write(&file, [0xff, 0xfe, 0x00]).unwrap();
        let binary = read_text(&file, 1024).unwrap_err();
        assert!(binary.contains("not UTF-8"), "{binary}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_plain_web_and_mail_links_open() {
        for ok in ["https://example.com/a?b=1&c=%20", "http://x.org", "MAILTO:me@x.org", "https://x.org/a^b"] {
            assert_eq!(checked_url(ok), Ok(ok), "{ok}");
        }
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://x\"&calc&\"",
            "https://x y",
            "https://x\ty",
            "https://x\0",
            "https://x\n",
        ] {
            assert!(checked_url(bad).is_err(), "{bad:?}");
        }
    }
}
