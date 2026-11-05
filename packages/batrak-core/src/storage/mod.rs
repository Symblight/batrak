//! Persistence in app data: JSON files (the session list, trust, versions…), rewritten atomically
//! on change.

#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use serde::{de::DeserializeOwned, Serialize};

/// A JSON document on disk. Writes are serialized and atomic (temp file + rename), so a crash
/// mid-write leaves the previous version.
pub struct JsonFile {
    path: PathBuf,
    write: Mutex<()>,
}

impl JsonFile {
    pub fn new(path: PathBuf) -> JsonFile {
        JsonFile { path, write: Mutex::new(()) }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The stored value; `T::default()` when there is none yet. An unreadable file is logged and
    /// moved aside (`.bad`), so the next write doesn't lose what a newer version might read.
    pub fn load<T: DeserializeOwned + Default>(&self) -> T {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return T::default(),
            Err(e) => {
                tracing::warn!(path = %self.path.display(), "can't read: {e}");
                return T::default();
            }
        };
        serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!(path = %self.path.display(), "unreadable, moved aside: {e}");
            let _ = std::fs::rename(&self.path, self.path.with_extension("json.bad"));
            T::default()
        })
    }

    pub fn save<T: Serialize + ?Sized>(&self, value: &T) -> Result<(), String> {
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)
            .and_then(|()| std::fs::rename(&tmp, &self.path))
            .map_err(|e| format!("{}: {e}", self.path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_survives_a_corrupt_file() {
        let dir = std::env::temp_dir().join(format!("batrak-storage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = JsonFile::new(dir.join("sessions.json"));
        assert_eq!(file.load::<Vec<String>>(), Vec::<String>::new());
        file.save(&vec!["a".to_owned()]).unwrap();
        assert_eq!(file.load::<Vec<String>>(), ["a"]);

        std::fs::write(file.path(), "{oops").unwrap();
        assert!(file.load::<Vec<String>>().is_empty());
        assert!(dir.join("sessions.json.bad").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
