use serde::Serialize;

use super::config::read_config;
use super::download::{download_release, resolve_latest_version};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub update_available: bool,
    pub current_version: Option<String>,
    pub latest_version: String,
}

#[tauri::command]
pub async fn check_server_update() -> Result<UpdateInfo, String> {
    let config = read_config(None);
    let latest = resolve_latest_version().await?;

    let update_available = match &config.installed_version {
        Some(current) => current != &latest,
        None => true,
    };

    Ok(UpdateInfo {
        update_available,
        current_version: config.installed_version,
        latest_version: latest,
    })
}

#[tauri::command]
pub async fn update_server(app: tauri::AppHandle) -> Result<String, String> {
    let latest = resolve_latest_version().await?;
    download_release(latest.clone(), app).await?;
    Ok(format!("Updated to v{}", latest))
}
