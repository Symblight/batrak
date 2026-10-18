mod acp;
mod commands;
mod config;
mod git;
mod logging;
mod menu;
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
        .on_menu_event(menu::on_event)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_menu(menu::build(app.handle())?)?;
            let dir = app.path().app_log_dir()?;
            // The app still works without its log; the dev terminal shows why there is none.
            match logging::init(&dir, Some(app.handle().clone())) {
                Ok(()) => tracing::info!(
                    version = %app.package_info().version,
                    os = std::env::consts::OS,
                    arch = std::env::consts::ARCH,
                    dir = %dir.display(),
                    "Brama started"
                ),
                Err(e) => eprintln!("logging disabled: {e}"),
            }
            let user_agents = app.path().config_dir().ok().map(|dir| dir.join("brama").join(config::AGENTS_FILE));
            let data_dir = app.path().app_data_dir()?;
            let configs = config::AgentConfigs::new(user_agents, Some(data_dir.join("trusted-agents.json")));
            let sessions = session::Sessions::new(session::SessionsOptions::for_app(data_dir, configs.clone()));
            let tidy = sessions.clone();
            tauri::async_runtime::spawn_blocking(move || tidy.tidy_worktrees());
            app.manage(sessions);
            app.manage(configs);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<workspace::Workspaces>().close_group(window.label());
                window.state::<session::Sessions>().detach_all(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::sessions::list_sessions,
            commands::sessions::get_active_session,
            commands::sessions::set_active_session,
            commands::sessions::session_create,
            commands::sessions::session_open,
            commands::sessions::session_send_prompt,
            commands::sessions::session_cancel,
            commands::sessions::session_respond_permission,
            commands::sessions::session_stop,
            commands::sessions::session_changes,
            commands::sessions::session_file_at_base,
            commands::sessions::session_apply_locally,
            commands::sessions::session_check_out_branch,
            commands::sessions::session_restart,
            commands::sessions::session_resume,
            commands::sessions::session_remove,
            commands::sessions::session_rename,
            commands::sessions::session_open_log,
            commands::sessions::session_history,
            commands::sessions::session_set_config_option,
            commands::agents::agents_list,
            commands::agents::workspace_settings,
            commands::agents::agents_config_file,
            commands::agents::agents_probe_options,
            commands::agents::agents_trust,
            commands::about::about,
            commands::fonts::list_fonts,
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::reveal_path,
            commands::fs::open_url,
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
            commands::git::git_branches,
            commands::git::git_commit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Brama")
        .run(|app, event| {
            // No agent process outlives the app: every session's process group is stopped.
            if let tauri::RunEvent::Exit = event {
                app.state::<session::Sessions>().shutdown();
            }
        });
}
