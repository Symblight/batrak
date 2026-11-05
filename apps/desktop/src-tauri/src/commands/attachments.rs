//! Files attached in the composer (picked, pasted): saved into the session's folder, so the agent
//! (its CLI, or the chat's mentions) reads them by path like any other file there.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use tauri::ipc::{InvokeBody, Request};
use tauri::State;

use crate::session::Sessions;
use crate::roots::Roots;

use super::blocking;

/// Where attachments go, inside the session's folder.
pub const ATTACHMENTS_DIR: &str = ".brama/attachments";
/// An attachment larger than this isn't saved: one IPC request holds the whole file (the page checks
/// first, so it never sends one).
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
const FOLDER_HEADER: &str = "folder";
const NAME_HEADER: &str = "name";

/// Saves `bytes` as `name` in `folder`'s attachments, which ignore themselves in git (`*` in their
/// own `.gitignore`), under a name no other attachment there has. Returns the file's path.
pub fn save(folder: &Path, name: &str, bytes: &[u8], max: usize) -> Result<PathBuf, String> {
    if bytes.len() > max {
        return Err(format!("{name}: too large to attach (over {} MB)", max / (1024 * 1024)));
    }
    let dir = folder.join(ATTACHMENTS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // A symlinked `.brama` or `attachments` mustn't lead the file out of the folder.
    let dir = dunce::canonicalize(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let root = dunce::canonicalize(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    if !dir.starts_with(&root) {
        return Err(format!("{}: leads out of {}", ATTACHMENTS_DIR, root.display()));
    }
    // Created only where nothing is, a symlink included: never written through one.
    let ignore = dir.join(".gitignore");
    match OpenOptions::new().write(true).create_new(true).open(&ignore) {
        Ok(mut file) => file.write_all(b"*\n").map_err(|e| format!("{}: {e}", ignore.display()))?,
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("{}: {e}", ignore.display())),
    }
    let (path, mut file) = claim(&dir, &file_name(name))?;
    if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        let _ = fs::remove_file(&path);
        return Err(format!("{}: {e}", path.display()));
    }
    Ok(path)
}

/// `name`'s last component, never empty, hidden or a path, and one word: a CLI's `@path` ends at a
/// space, and Windows refuses `:<>"|?*` (`:` would name a stream).
fn file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default().trim().trim_start_matches('.');
    let word: String = last.chars().map(|c| if c.is_whitespace() || ":<>\"|?*".contains(c) || c.is_control() { '-' } else { c }).collect();
    if word.is_empty() { "attachment".to_owned() } else { word }
}

/// Creates `name` in `dir`, or `stem-2.ext`, `stem-3.ext`… when taken: claimed by creating it, so two
/// saves at once never get one name.
fn claim(dir: &Path, name: &str) -> Result<(PathBuf, fs::File), String> {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    for n in 1..10_000 {
        let path = if n == 1 { dir.join(name) } else { dir.join(format!("{stem}-{n}{ext}")) };
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    Err(format!("{}: too many attachments named {name}", dir.display()))
}

/// `%XX`-encoded header text (the page sends `encodeURIComponent`, headers are ASCII).
fn decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3).ok_or("bad header")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad header")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "bad header".to_owned())
}

/// Saves the request's raw body as an attachment (`save`) in the `folder` header's folder (a
/// folder of an open project or a session's), named by the `name` header. Returns its path.
#[tauri::command]
pub async fn save_attachment(roots: State<'_, Roots>, sessions: State<'_, Sessions>, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("an attachment must be raw bytes".to_owned());
    };
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).ok_or(format!("no {key}")).and_then(decode);
    let (folder, name) = (header(FOLDER_HEADER)?, header(NAME_HEADER)?);
    let (bytes, roots, sessions) = (bytes.clone(), roots.inner().clone(), sessions.inner().clone());
    blocking(move || {
        let canonical = dunce::canonicalize(&folder).map_err(|e| format!("{folder}: {e}"))?;
        if !roots.contains(&canonical) && !sessions.contains_folder(&canonical) {
            return Err(format!("{folder}: outside the opened folders"));
        }
        let path = save(&canonical, &name, &bytes, MAX_BYTES)?;
        tracing::info!(path = %path.display(), "attachment saved");
        Ok(path.to_string_lossy().into_owned())
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("batrak-attach-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saves_into_the_folders_attachments_which_git_ignores() {
        let folder = tmp("save");
        let folder = dunce::canonicalize(&folder).unwrap();
        let path = save(&folder, "shot.png", b"\x89PNG", 64).unwrap();
        assert_eq!(path, folder.join(".brama/attachments/shot.png"));
        assert_eq!(fs::read(&path).unwrap(), b"\x89PNG");
        assert_eq!(fs::read_to_string(folder.join(".brama/attachments/.gitignore")).unwrap(), "*\n");
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn never_overwrites_an_earlier_attachment() {
        let folder = tmp("unique");
        save(&folder, "notes.md", b"a", 64).unwrap();
        assert_eq!(save(&folder, "notes.md", b"b", 64).unwrap().file_name().unwrap(), "notes-2.md");
        assert_eq!(save(&folder, "notes.md", b"c", 64).unwrap().file_name().unwrap(), "notes-3.md");
        assert_eq!(fs::read(folder.join(".brama/attachments/notes.md")).unwrap(), b"a");
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn keeps_a_name_inside_the_attachments() {
        let folder = dunce::canonicalize(tmp("names")).unwrap();
        assert_eq!(save(&folder, "../../evil.sh", b"x", 64).unwrap(), folder.join(".brama/attachments/evil.sh"));
        assert_eq!(save(&folder, "..\\win.txt", b"x", 64).unwrap(), folder.join(".brama/attachments/win.txt"));
        assert_eq!(save(&folder, ".hidden", b"x", 64).unwrap(), folder.join(".brama/attachments/hidden"));
        assert_eq!(save(&folder, "", b"x", 64).unwrap(), folder.join(".brama/attachments/attachment"));
        assert_eq!(
            save(&folder, "Screenshot 2026-10-31 at 10:00.png", b"x", 64).unwrap(),
            folder.join(".brama/attachments/Screenshot-2026-10-31-at-10-00.png"),
            "one word, no Windows-forbidden characters"
        );
        let _ = fs::remove_dir_all(&folder);
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_symlink_out_of_the_folder() {
        let (folder, outside) = (tmp("link"), tmp("link-out"));
        fs::create_dir_all(folder.join(".brama")).unwrap();
        std::os::unix::fs::symlink(&outside, folder.join(".brama/attachments")).unwrap();
        assert!(save(&folder, "a.txt", b"x", 64).unwrap_err().contains("leads out"));
        assert!(!outside.join("a.txt").exists());
        let _ = (fs::remove_dir_all(&folder), fs::remove_dir_all(&outside));
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_its_gitignore_through_a_symlink() {
        let (folder, outside) = (tmp("ignore-link"), tmp("ignore-out"));
        fs::create_dir_all(folder.join(".brama/attachments")).unwrap();
        std::os::unix::fs::symlink(outside.join("target"), folder.join(".brama/attachments/.gitignore")).unwrap();
        save(&folder, "a.txt", b"x", 64).unwrap();
        assert!(!outside.join("target").exists());
        let _ = (fs::remove_dir_all(&folder), fs::remove_dir_all(&outside));
    }

    #[test]
    fn refuses_what_is_too_large() {
        let folder = tmp("large");
        assert!(save(&folder, "big.bin", &[0; 65], 64).unwrap_err().contains("too large"));
        assert!(!folder.join(".brama/attachments/big.bin").exists());
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn decodes_header_text() {
        assert_eq!(decode("Screen%20Shot%20%C3%A9.png").unwrap(), "Screen Shot é.png");
        assert!(decode("bad%2").is_err());
    }
}
