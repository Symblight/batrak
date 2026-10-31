//! Files dropped on a window from the OS (Tauri's native file drop): the page may ask what they are
//! and read one for the chat, and nothing else outside the opened folders.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{State, Window};

use super::blocking;

/// A dropped file larger than this isn't read: one IPC reply holds the whole file.
const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// A window's drops kept readable: the page may still be reading one when the next lands.
const KEEP_DROPS: usize = 4;

/// What a dropped path is now.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DroppedKind {
    File,
    Folder,
    /// Gone, or neither a regular file nor a folder.
    Other,
}

/// Each window's last `KEEP_DROPS` drops, newest last, by window label, as the OS named the paths.
#[derive(Clone, Default)]
pub struct DroppedFiles(Arc<Mutex<HashMap<String, VecDeque<Vec<PathBuf>>>>>);

impl DroppedFiles {
    /// Records a drop on `window`, forgetting the oldest beyond `KEEP_DROPS`.
    pub fn record(&self, window: &str, paths: &[PathBuf]) {
        let mut drops = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let kept = drops.entry(window.to_owned()).or_default();
        kept.push_back(paths.to_vec());
        while kept.len() > KEEP_DROPS {
            kept.pop_front();
        }
    }

    /// Forgets a closed window's drop.
    pub fn forget(&self, window: &str) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).remove(window);
    }

    /// `path` if one of the window's kept drops named it.
    fn dropped(&self, window: &str, path: &str) -> Result<PathBuf, String> {
        let drops = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        drops
            .get(window)
            .and_then(|kept| kept.iter().flatten().find(|p| p.as_path() == Path::new(path)))
            .cloned()
            .ok_or_else(|| format!("{path}: not dropped on this window"))
    }

    /// What each of the window's dropped `paths` is; fails if any wasn't dropped there.
    pub fn kinds(&self, window: &str, paths: &[String]) -> Result<Vec<DroppedKind>, String> {
        paths
            .iter()
            .map(|path| {
                let path = self.dropped(window, path)?;
                Ok(match fs::metadata(&path) {
                    Ok(meta) if meta.is_file() => DroppedKind::File,
                    Ok(meta) if meta.is_dir() => DroppedKind::Folder,
                    _ => DroppedKind::Other,
                })
            })
            .collect()
    }

    /// The bytes of a regular file one of the window's kept drops named, at most `max`.
    pub fn read(&self, window: &str, path: &str, max: u64) -> Result<Vec<u8>, String> {
        let path = self.dropped(window, path)?;
        let shown = path.display();
        let file = fs::File::open(&path).map_err(|e| format!("{shown}: {e}"))?;
        let meta = file.metadata().map_err(|e| format!("{shown}: {e}"))?;
        if !meta.is_file() {
            return Err(format!("{shown}: not a file"));
        }
        let too_large = || format!("{shown}: too large to attach (over {} MB)", max / (1024 * 1024));
        if meta.len() > max {
            return Err(too_large());
        }
        // Read through a cap: the file may have grown since.
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        file.take(max + 1).read_to_end(&mut bytes).map_err(|e| format!("{shown}: {e}"))?;
        if bytes.len() as u64 > max {
            return Err(too_large());
        }
        Ok(bytes)
    }
}

/// What the paths of the window's recent file drops are: `file`, `folder` or `other`.
#[tauri::command]
pub async fn dropped_kinds(
    window: Window,
    dropped: State<'_, DroppedFiles>,
    paths: Vec<String>,
) -> Result<Vec<DroppedKind>, String> {
    let dropped = dropped.inner().clone();
    let label = window.label().to_owned();
    blocking(move || dropped.kinds(&label, &paths)).await?
}

/// A file of the window's recent file drops as raw bytes (an `ArrayBuffer` in the page), for a chat
/// attachment. Regular files only, at most `MAX_BYTES`.
#[tauri::command]
pub async fn read_dropped_file(
    window: Window,
    dropped: State<'_, DroppedFiles>,
    path: String,
) -> Result<Response, String> {
    let dropped = dropped.inner().clone();
    let label = window.label().to_owned();
    blocking(move || dropped.read(&label, &path, MAX_BYTES).map(Response::new)).await?
}

#[cfg(test)]
mod tests {
    use super::{DroppedFiles, DroppedKind};
    use std::path::PathBuf;

    /// A temp folder holding `a.png` (4 bytes), `big.png` (11 bytes) and `docs/`; removed on drop.
    struct Tmp(PathBuf);

    impl Tmp {
        fn new(name: &str) -> Tmp {
            let dir = std::env::temp_dir().join(format!("brama-dropped-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("docs")).unwrap();
            std::fs::write(dir.join("a.png"), b"\x89PNG").unwrap();
            std::fs::write(dir.join("big.png"), b"0123456789A").unwrap();
            Tmp(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn str(&self, name: &str) -> String {
            self.path(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_only_files_dropped_on_the_window() {
        let tmp = Tmp::new("read");
        let dropped = DroppedFiles::default();
        let err = dropped.read("main", &tmp.str("a.png"), 64).unwrap_err();
        assert!(err.contains("not dropped"), "{err}");

        dropped.record("main", &[tmp.path("a.png"), tmp.path("docs")]);
        assert_eq!(dropped.read("main", &tmp.str("a.png"), 64).unwrap(), b"\x89PNG");
        assert!(dropped.read("other", &tmp.str("a.png"), 64).unwrap_err().contains("not dropped"), "another window's");
        assert!(dropped.read("main", &tmp.str("big.png"), 64).unwrap_err().contains("not dropped"), "beside a dropped one");
        let outside = format!("{}/../{}", tmp.str("docs"), "big.png");
        assert!(dropped.read("main", &outside, 64).unwrap_err().contains("not dropped"), "{outside}");

        dropped.record("main", &[tmp.path("big.png")]);
        assert_eq!(dropped.read("main", &tmp.str("a.png"), 64).unwrap(), b"\x89PNG", "a drop before, still being read");
        for _ in 1..super::KEEP_DROPS {
            dropped.record("main", &[tmp.path("docs")]);
        }
        assert!(dropped.read("main", &tmp.str("a.png"), 64).unwrap_err().contains("not dropped"), "older than the kept drops");
        assert_eq!(dropped.read("main", &tmp.str("big.png"), 64).unwrap(), b"0123456789A", "the oldest kept");
        dropped.forget("main");
        assert!(dropped.read("main", &tmp.str("big.png"), 64).is_err(), "forgotten with its window");
    }

    #[test]
    fn reads_regular_files_up_to_the_cap() {
        let tmp = Tmp::new("cap");
        let dropped = DroppedFiles::default();
        dropped.record("main", &[tmp.path("a.png"), tmp.path("big.png"), tmp.path("docs"), tmp.path("gone.png")]);
        assert_eq!(dropped.read("main", &tmp.str("big.png"), 11).unwrap(), b"0123456789A");
        assert!(dropped.read("main", &tmp.str("big.png"), 10).unwrap_err().contains("too large"));
        assert!(dropped.read("main", &tmp.str("docs"), 64).is_err(), "a folder");
        assert!(dropped.read("main", &tmp.str("gone.png"), 64).is_err(), "gone");
    }

    #[test]
    fn tells_dropped_files_from_folders() {
        let tmp = Tmp::new("kinds");
        let dropped = DroppedFiles::default();
        dropped.record("main", &[tmp.path("a.png"), tmp.path("docs"), tmp.path("gone.png")]);
        let kinds = dropped.kinds("main", &[tmp.str("docs"), tmp.str("a.png"), tmp.str("gone.png")]).unwrap();
        assert_eq!(kinds, [DroppedKind::Folder, DroppedKind::File, DroppedKind::Other]);
        assert!(dropped.kinds("main", &[tmp.str("a.png"), tmp.str("big.png")]).unwrap_err().contains("not dropped"));
        assert_eq!(serde_json::to_string(&kinds).unwrap(), r#"["folder","file","other"]"#);
    }
}
