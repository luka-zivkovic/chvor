mod commands;
pub mod platform;
mod tray;


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(commands::server::ServerState::default())
        .setup(|app| {
            tray::setup_tray(app)?;
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
