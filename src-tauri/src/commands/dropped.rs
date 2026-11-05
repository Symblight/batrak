//! Files dropped on a window from the OS (Tauri's native file drop): the page may ask what they are,
//! and nothing else outside the opened folders.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use tauri::{State, Window};

use super::blocking;

/// A window's drops kept: the page may still be asking about one when the next lands.
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
    fn answers_only_for_files_dropped_on_the_window() {
        let tmp = Tmp::new("scope");
        let dropped = DroppedFiles::default();
        let kind = |window: &str, path: &str| dropped.kinds(window, &[path.to_owned()]);
        assert!(kind("main", &tmp.str("a.png")).unwrap_err().contains("not dropped"));

        dropped.record("main", &[tmp.path("a.png"), tmp.path("docs")]);
        assert_eq!(kind("main", &tmp.str("a.png")).unwrap(), [DroppedKind::File]);
        assert!(kind("other", &tmp.str("a.png")).unwrap_err().contains("not dropped"), "another window's");
        assert!(kind("main", &tmp.str("big.png")).unwrap_err().contains("not dropped"), "beside a dropped one");
        let outside = format!("{}/../{}", tmp.str("docs"), "big.png");
        assert!(kind("main", &outside).unwrap_err().contains("not dropped"), "{outside}");

        dropped.record("main", &[tmp.path("big.png")]);
        assert!(kind("main", &tmp.str("a.png")).is_ok(), "a drop before, still asked about");
        for _ in 1..super::KEEP_DROPS {
            dropped.record("main", &[tmp.path("docs")]);
        }
        assert!(kind("main", &tmp.str("a.png")).unwrap_err().contains("not dropped"), "older than the kept drops");
        assert!(kind("main", &tmp.str("big.png")).is_ok(), "the oldest kept");
        dropped.forget("main");
        assert!(kind("main", &tmp.str("big.png")).is_err(), "forgotten with its window");
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
