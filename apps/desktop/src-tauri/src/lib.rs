use bt_core::{config, dirs, notify, session, util, workspace};

mod commands;
mod git;
mod github;
mod logging;
mod menu;
mod terminal;
mod roots;

use tauri::Manager;

pub fn run() {
    logging::install_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(roots::Roots::default())
        .manage(commands::dropped::DroppedFiles::default())
        .on_menu_event(menu::on_event)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_menu(menu::build(app.handle())?)?;
            let dirs = dirs::Dirs::resolve()?;
            let notifier: std::sync::Arc<dyn notify::Notifier> =
                std::sync::Arc::new(commands::notifier::AppNotifier(app.handle().clone()));
            // The app still works without its log; the dev terminal shows why there is none.
            match logging::init(&dirs.logs, Some(notifier.clone())) {
                Ok(()) => tracing::info!(
                    version = %app.package_info().version,
                    os = std::env::consts::OS,
                    arch = std::env::consts::ARCH,
                    dir = %dirs.logs.display(),
                    "Batrak started"
                ),
                Err(e) => eprintln!("logging disabled: {e}"),
            }
            let user_agents = Some(dirs.config.join(config::AGENTS_FILE));
            let data_dir = dirs.data.clone();
            let registry = config::registry::Registry::new(
                Some(data_dir.join("acp-registry.json")),
                std::sync::Arc::new(config::registry::Http),
            );
            let configs =
                config::AgentConfigs::new(user_agents, Some(data_dir.join("trusted-agents.json"))).with_registry(registry).with_notifier(notifier);
            let sessions = session::Sessions::new(session::SessionsOptions::for_app(data_dir.clone(), configs.clone(), tauri::async_runtime::handle().inner().clone()));
            let tidy = sessions.clone();
            tauri::async_runtime::spawn_blocking(move || tidy.tidy_worktrees());
            let user_watch = config::watch::watch_user_file(configs.clone()).unwrap_or_else(|e| {
                tracing::warn!("not watching the user's agents.json: {e}");
                None
            });
            app.manage(UserAgentsWatch(std::sync::Mutex::new(user_watch)));
            commands::agents::check_registry_daily(configs.clone());
            app.manage(config::update::Updater::new(
                configs.clone(),
                std::sync::Arc::new(config::update::NpmPrefetch { dir: data_dir.join("npm") }),
            ));
            app.manage(sessions);
            app.manage(configs);
            app.manage(dirs);
            app.manage(terminal::Terminals::new(terminal::TerminalsOptions {
                shell: None,
                version: app.package_info().version.to_string(),
            }));
            Ok(())
        })
        // A webview window reports its file drops as window events, a child webview as its own.
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                webview.state::<commands::dropped::DroppedFiles>().record(webview.window().label(), paths);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<commands::dropped::DroppedFiles>().record(window.label(), paths);
            }
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<commands::dropped::DroppedFiles>().forget(window.label());
                window.state::<roots::Roots>().close_group(window.label());
                window.state::<session::Sessions>().detach_all(window.label());
                window.state::<terminal::Terminals>().close_group(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::sessions::list_sessions,
            commands::sessions::sessions_sync,
            commands::sessions::session_create,
            commands::sessions::session_open,
            commands::sessions::session_send_prompt,
            commands::sessions::session_cancel,
            commands::sessions::session_cancel_subagent,
            commands::sessions::session_respond_permission,
            commands::sessions::session_stop,
            commands::sessions::session_restart,
            commands::sessions::session_resume,
            commands::sessions::session_open_cli,
            commands::sessions::session_close_cli,
            commands::sessions::session_cli_busy,
            commands::sessions::session_remove,
            commands::sessions::session_rename,
            commands::sessions::session_reset_title,
            commands::sessions::session_open_log,
            commands::sessions::session_set_config_option,
            commands::agents::agents_list,
            commands::agents::agents_add,
            commands::agents::agents_update,
            commands::agents::agents_set_default,
            commands::agents::agents_remove,
            commands::agents::agents_restore,
            commands::agents::agents_import_user,
            commands::agents::agents_set_enabled,
            commands::agents::agents_registry_check,
            commands::agents::agents_update_version,
            commands::agents::agents_update_all,
            commands::agents::agents_view,
            commands::agents::agents_config_file,
            commands::agents::agents_probe_options,
            commands::agents::agents_sign_in,
            commands::agents::agents_sign_in_cancel,
            commands::agents::agents_trust,
            commands::agents::agents_untrusted,
            commands::about::about,
            commands::about::windows_build,
            commands::fonts::list_fonts,
            commands::fs::read_file,
            commands::fs::read_file_bytes,
            commands::dropped::dropped_kinds,
            commands::attachments::save_attachment,
            commands::fs::write_file,
            commands::fs::reveal_path,
            commands::fs::open_url,
            commands::log::write_log,
            commands::workspaces::workspaces_list,
            commands::workspaces::workspace_create,
            commands::workspaces::workspace_rename,
            commands::workspaces::workspace_delete_preview,
            commands::workspaces::workspace_delete,
            commands::workspaces::workspace_recreate,
            commands::workspaces::workspace_apply_locally,
            commands::workspaces::workspace_check_out_branch,
            commands::workspaces::workspace_changes,
            commands::workspaces::workspace_file_at_base,
            commands::roots::open_root,
            commands::roots::open_workspace_root,
            commands::roots::close_root,
            commands::roots::close_window_roots,
            commands::roots::list_dir,
            commands::roots::rescan_root,
            commands::roots::quick_open,
            commands::roots::note_file_opened,
            commands::roots::find_in_files,
            commands::roots::cancel_search,
            commands::git::git_head,
            commands::git::git_status,
            commands::git::git_file_at_head,
            commands::git::git_last_commit_message,
            commands::git::git_branches,
            commands::git::git_fetch,
            commands::git::git_commit,
            commands::git::git_revert_file,
            commands::github::github_account,
            commands::github::github_pull_request,
            commands::terminal::terminal_open,
            commands::terminal::terminal_attach,
            commands::terminal::terminal_write,
            commands::terminal::terminal_ack,
            commands::terminal::terminal_clear,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_busy,
            commands::terminal::terminal_close,
            commands::terminal::close_window_terminals,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Batrak")
        .run(|app, event| {
            // No agent process or shell outlives the app: every session's and terminal's process
            // group is stopped.
            if let tauri::RunEvent::Exit = event {
                app.state::<session::Sessions>().shutdown();
                app.state::<terminal::Terminals>().stop_all(std::time::Duration::from_millis(200));
            }
        });
}

/// Keeps the user's agents.json watched for the app's lifetime.
struct UserAgentsWatch(
    #[allow(dead_code)]
    std::sync::Mutex<
        Option<notify_debouncer_full::Debouncer<notify_debouncer_full::notify::RecommendedWatcher, notify_debouncer_full::NoCache>>,
    >,
);

#[cfg(test)]
mod tests {
    mod dirs {
        use tauri::Manager;

        use bt_core::dirs::Dirs;

        #[test]
        fn the_standard_folders_are_the_ones_tauri_resolves() {
            let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().identifier = conf["identifier"].as_str().unwrap().to_owned();
            let app = tauri::test::mock_builder().build(context).unwrap();
            let path = app.path();

            let dirs = Dirs::standard().unwrap();

            assert_eq!(dirs.data, path.app_data_dir().unwrap());
            assert_eq!(dirs.config, path.config_dir().unwrap().join("batrak"));
            assert_eq!(dirs.logs, path.app_log_dir().unwrap());
        }
    }
}
