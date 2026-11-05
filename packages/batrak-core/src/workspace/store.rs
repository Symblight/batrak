//! `workspaces.json` in app data: every project's workspaces, shared by all windows.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::storage::JsonFile;

use super::WorkspaceRecord;

/// The records in memory, written through to disk on each change. One writer: this.
pub struct Store {
    file: JsonFile,
    records: Mutex<Vec<WorkspaceRecord>>,
}

impl Store {
    /// Reads `path`; a missing or unreadable file is no workspaces.
    pub fn open(path: PathBuf) -> Store {
        let file = JsonFile::new(path);
        let records = file.load::<Vec<WorkspaceRecord>>();
        Store { file, records: Mutex::new(records) }
    }

    fn records(&self) -> MutexGuard<'_, Vec<WorkspaceRecord>> {
        self.records.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The workspaces of `project` (every project's for `None`), oldest first.
    pub fn list(&self, project: Option<&Path>) -> Vec<WorkspaceRecord> {
        self.records().iter().filter(|r| project.is_none_or(|p| r.project_path == p)).cloned().collect()
    }

    pub fn get(&self, id: &str) -> Result<WorkspaceRecord, String> {
        self.records().iter().find(|r| r.id == id).cloned().ok_or_else(|| format!("unknown workspace {id}"))
    }

    pub fn insert(&self, record: WorkspaceRecord) -> Result<(), String> {
        let mut records = self.records();
        if records.iter().any(|r| r.id == record.id) {
            return Err(format!("workspace {} exists already", record.id));
        }
        records.push(record);
        self.file.save(&*records)
    }

    /// Changes one record and saves; returns it as changed.
    pub fn update(&self, id: &str, change: impl FnOnce(&mut WorkspaceRecord)) -> Result<WorkspaceRecord, String> {
        let mut records = self.records();
        let record = records.iter_mut().find(|r| r.id == id).ok_or_else(|| format!("unknown workspace {id}"))?;
        change(record);
        let changed = record.clone();
        self.file.save(&*records)?;
        Ok(changed)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut records = self.records();
        records.retain(|r| r.id != id);
        self.file.save(&*records)
    }
}
