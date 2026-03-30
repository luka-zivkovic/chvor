mod commands;
pub mod platform;
mod tray;

use tauri::Manager;

use commands::config::chvor_home;
use commands::server::kill_server_process;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // When a second instance launches, focus the existing window instead
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(commands::server::ServerState::default())
        .setup(|app| {
            tray::setup_tray(app)?;

            // Hide window on close instead of quitting — app stays in tray
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                    if let tauri::WindowEvent::Destroyed = event {
                        // Clean up server on unexpected window destruction
                        cleanup_server();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Node
            commands::node::detect_node,
            commands::node::install_node,
            // Config
            commands::config::read_config,
            commands::config::write_config,
            commands::config::is_onboarded,
            // Download
            commands::download::resolve_latest_version,
            commands::download::download_release,
            commands::download::is_installed,
            // Server
            commands::server::start_server,
            commands::server::stop_server,
            commands::server::server_status,
            commands::server::poll_health,
            // System
            commands::system::get_platform_info,
            commands::system::open_browser,
            commands::system::get_chvor_dirs,
            commands::system::save_credentials,
            commands::system::configure_persona,
            // Update
            commands::update::check_server_update,
            commands::update::update_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn cleanup_server() {
    let pid_path = chvor_home(None).join("chvor.pid");
    if let Ok(raw) = std::fs::read_to_string(&pid_path) {
        if let Ok(pid) = raw.trim().parse::<u32>() {
            kill_server_process(pid);
        }
        let _ = std::fs::remove_file(&pid_path);
    }
}
