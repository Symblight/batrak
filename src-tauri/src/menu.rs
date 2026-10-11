//! The macOS menu bar: Tauri's default menu, whose app menu opens our own About dialog and
//! Settings instead of the native About panel. Other platforms have no menu bar.

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Tauri event to the focused window; payload is the item's id (`about`, `settings`).
pub const MENU_EVENT: &str = "menu://action";
const ACTIONS: &[&str] = &["about", "settings"];

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    // The app menu comes first: About, separator, Services, …
    if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
        app_menu.remove_at(0)?;
        let name = &app.package_info().name;
        app_menu.insert_items(
            &[
                &MenuItem::with_id(app, "about", format!("About {name}"), true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
            ],
            0,
        )?;
    }
    Ok(menu)
}

/// Sends our items' clicks to the focused window, which shows what was picked.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if !ACTIONS.contains(&id) {
        return;
    }
    let focused = app.webview_windows().into_values().find(|window| window.is_focused().unwrap_or(false));
    if let Some(window) = focused {
        if let Err(e) = app.emit_to(window.label(), MENU_EVENT, id) {
            tracing::warn!(id, "menu event not sent: {e}");
        }
    }
}
