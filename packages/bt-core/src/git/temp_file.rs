//! Temporary paths for git to read or write.

use std::path::PathBuf;

/// A path in the temp directory for a file or folder git reads or writes (a temporary index, a
/// commit message, scratch objects); removed on drop.
pub struct TempFile {
    pub path: PathBuf,
}

impl TempFile {
    pub fn new(kind: &str) -> TempFile {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        TempFile { path: std::env::temp_dir().join(format!("batrak-{kind}-{}-{n}", std::process::id())) }
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if self.path.is_dir() {
            let _ = std::fs::remove_dir_all(&self.path);
        } else {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
