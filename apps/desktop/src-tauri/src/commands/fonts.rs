//! Installed font families, for the editor font setting.

use std::collections::BTreeMap;

use serde::Serialize;

use super::blocking;

#[derive(Serialize)]
pub struct FontFamily {
    pub family: String,
    /// Any face of the family is fixed-pitch.
    pub monospace: bool,
}

/// Every installed family, sorted by name. Parses each font file's header, so it runs off the IPC
/// thread. macOS's hidden system families (`.SF NS Mono` & co) aren't addressable by name and are left out.
#[tauri::command]
pub async fn list_fonts() -> Result<Vec<FontFamily>, String> {
    blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut families: BTreeMap<String, bool> = BTreeMap::new();
        for face in db.faces() {
            // The first name is the English one when the font has it.
            let Some((family, _)) = face.families.first() else { continue };
            if family.is_empty() || family.starts_with('.') {
                continue;
            }
            *families.entry(family.clone()).or_default() |= face.monospaced;
        }
        families
            .into_iter()
            .map(|(family, monospace)| FontFamily { family, monospace })
            .collect()
    })
    .await
}
