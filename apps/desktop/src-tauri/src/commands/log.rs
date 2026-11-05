use serde::Deserialize;

/// A message over this is cut, so a runaway error loop can't fill the disk line by line.
const MAX_MESSAGE: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
}

/// Writes a frontend message (uncaught errors, rejections) to the app log, target `frontend`.
#[tauri::command]
pub async fn write_log(level: Level, message: String) -> Result<(), String> {
    let message = match message.char_indices().nth(MAX_MESSAGE) {
        Some((end, _)) => format!("{}… (cut)", &message[..end]),
        None => message,
    };
    match level {
        Level::Error => tracing::error!(target: "frontend", "{message}"),
        Level::Warn => tracing::warn!(target: "frontend", "{message}"),
        Level::Info => tracing::info!(target: "frontend", "{message}"),
        Level::Debug => tracing::debug!(target: "frontend", "{message}"),
    }
    Ok(())
}
