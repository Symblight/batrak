use crate::session::Session;

#[tauri::command]
pub fn list_sessions() -> Vec<Session> {
    Vec::new()
}

#[tauri::command]
pub fn get_active_session() -> Option<String> {
    None
}

#[tauri::command]
pub fn set_active_session(_id: String) {}
