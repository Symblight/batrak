mod acp;
mod commands;
mod git;
mod logging;
mod session;
mod storage;
mod workspace;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::install_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(workspace::Workspaces::default())
        .setup(|app| {
            let dir = app.path().app_log_dir()?;
            // The app still works without its log; the dev terminal shows why there is none.
            match logging::init(&dir) {
                Ok(()) => tracing::info!(
                    version = %app.package_info().version,
                    os = std::env::consts::OS,
                    arch = std::env::consts::ARCH,
                    dir = %dir.display(),
                    "Brama started"
                ),
                Err(e) => eprintln!("logging disabled: {e}"),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<workspace::Workspaces>().close_group(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::sessions::list_sessions,
            commands::sessions::get_active_session,
            commands::sessions::set_active_session,
            commands::fonts::list_fonts,
            commands::fs::read_file,
            commands::fs::reveal_path,
            commands::log::write_log,
            commands::workspace::open_workspace,
            commands::workspace::close_workspace,
            commands::workspace::close_window_workspaces,
            commands::workspace::list_dir,
            commands::workspace::quick_open,
            commands::workspace::note_file_opened,
            commands::workspace::find_in_files,
            commands::workspace::cancel_search,
            commands::git::git_head,
            commands::git::git_status,
            commands::git::git_file_at_head,
            commands::git::git_last_commit_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Brama");
}
