use tauri::{
    menu::{Menu, MenuItem},
    App, Emitter, Manager,
};

use crate::commands::config::chvor_home;
use crate::commands::server::kill_server_process;

pub fn setup_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let open_item = MenuItem::with_id(app, "open", "Open Chvor", true, None::<&str>)?;
    let start_item = MenuItem::with_id(app, "start", "Start Server", true, None::<&str>)?;
    let stop_item = MenuItem::with_id(app, "stop", "Stop Server", true, None::<&str>)?;
    let update_item =
        MenuItem::with_id(app, "update", "Check for Updates", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&open_item, &start_item, &stop_item, &update_item, &quit_item],
    )?;

    let tray = app.tray_by_id("main").unwrap_or_else(|| {
        tauri::tray::TrayIconBuilder::with_id("main")
            .menu(&menu)
            .show_menu_on_left_click(true)
            .build(app)
            .expect("failed to build tray icon")
    });

    tray.on_menu_event(move |app, event| {
        match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "start" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = app.emit("tray-action", "start");
                });
            }
            "stop" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = app.emit("tray-action", "stop");
                });
            }
            "update" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = app.emit("tray-action", "update");
                });
            }
            "quit" => {
                // Stop the server before exiting to avoid orphaned processes
                let pid_path = chvor_home(None).join("chvor.pid");
                if let Ok(raw) = std::fs::read_to_string(&pid_path) {
                    if let Ok(pid) = raw.trim().parse::<u32>() {
                        kill_server_process(pid);
                    }
                    let _ = std::fs::remove_file(&pid_path);
                }
                app.exit(0);
            }
            _ => {}
        }
    });

    Ok(())
}
