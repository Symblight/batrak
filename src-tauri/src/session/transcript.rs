//! A session's conversation on disk (`sessions/<id>/transcript.jsonl` in app data), so it shows
//! again after a reload or restart: one JSON object per line, appended as the session goes.
//!
//! - `{ "kind": "prompt", "prompt": [PromptInput…], "at" }` — what the user sent
//! - `{ "kind": "update", "update": SessionUpdate }` — the agent's updates during a turn (not
//!   `usage_update`, and not history an agent replays on `session/load`)
//! - `{ "kind": "turn-end", "stopReason", "message"? }` — `stopReason` `error` with its message
//!   when the turn failed

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde_json::Value;

/// A transcript larger than this is read from its last part only.
const MAX_READ: u64 = 32 * 1024 * 1024;

pub struct Transcript {
    path: PathBuf,
    /// Opened on the first append.
    file: Mutex<Option<File>>,
    /// The session was removed: nothing is written any more (a late append would recreate the
    /// deleted folder).
    closed: std::sync::atomic::AtomicBool,
}

impl Transcript {
    pub fn new(path: PathBuf) -> Transcript {
        Transcript { path, file: Mutex::new(None), closed: std::sync::atomic::AtomicBool::new(false) }
    }

    /// Stops writing for good.
    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        self.file.lock().unwrap_or_else(PoisonError::into_inner).take();
    }

    /// Appends one entry. A failure is logged once per open attempt and the session goes on: the
    /// transcript is a convenience, not the conversation itself.
    pub fn append(&self, entry: &Value) {
        let mut file = self.file.lock().unwrap_or_else(PoisonError::into_inner);
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        if file.is_none() {
            let opened = self
                .path
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| OpenOptions::new().create(true).append(true).open(&self.path));
            match opened {
                Ok(f) => *file = Some(f),
                Err(e) => {
                    tracing::warn!(path = %self.path.display(), "can't write the session's transcript: {e}");
                    return;
                }
            }
        }
        let Some(f) = file.as_mut() else { return };
        let mut line = entry.to_string();
        line.push('\n');
        if let Err(e) = f.write_all(line.as_bytes()) {
            tracing::warn!(path = %self.path.display(), "writing the transcript failed: {e}");
            *file = None;
        }
    }
}

/// The entries of a transcript, oldest first; none when there is no file. Unreadable lines (a
/// write cut short by a crash) are skipped.
pub fn read(path: &Path) -> Result<Vec<Value>, String> {
    use std::io::{Seek, SeekFrom};
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let skip_partial = size > MAX_READ;
    if skip_partial {
        file.seek(SeekFrom::Start(size - MAX_READ)).map_err(|e| e.to_string())?;
    }
    let mut lines = BufReader::new(file).lines();
    if skip_partial {
        lines.next(); // starts mid-line
    }
    Ok(lines.map_while(Result::ok).filter_map(|line| serde_json::from_str(&line).ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn appends_and_reads_back_skipping_broken_lines() {
        let dir = std::env::temp_dir().join(format!("brama-transcript-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("s/transcript.jsonl");
        assert!(read(&path).unwrap().is_empty());
        let transcript = Transcript::new(path.clone());
        transcript.append(&json!({ "kind": "prompt" }));
        transcript.append(&json!({ "kind": "update" }));
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"kind\":\"tur").unwrap();
        let entries = read(&path).unwrap();
        assert_eq!(entries, [json!({ "kind": "prompt" }), json!({ "kind": "update" })]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
