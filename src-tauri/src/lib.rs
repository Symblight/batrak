mod acp;
mod commands;
mod git;
mod session;
mod storage;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(workspace::Workspaces::default())
        .invoke_handler(tauri::generate_handler![
            commands::sessions::list_sessions,
            commands::sessions::get_active_session,
            commands::sessions::set_active_session,
            commands::fs::read_file,
            commands::fs::reveal_path,
            commands::workspace::open_workspace,
            commands::workspace::close_workspace,
            commands::workspace::list_dir,
            commands::workspace::quick_open,
            commands::workspace::note_file_opened,
            commands::workspace::find_in_files,
            commands::workspace::cancel_search,
            commands::git::git_status,
            commands::git::git_file_at_head,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Brama");
}
