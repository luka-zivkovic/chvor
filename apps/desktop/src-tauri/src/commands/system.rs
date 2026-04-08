use serde::Serialize;

use super::config::{app_dir, chvor_home, validate_port};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
    pub asset_name_template: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChvorDirs {
    pub home: String,
    pub app: String,
    pub data: String,
    pub logs: String,
    pub downloads: String,
    pub skills: String,
    pub tools: String,
    pub config: String,
}

fn get_os() -> &'static str {
    #[cfg(target_os = "windows")]
    { "win" }
    #[cfg(target_os = "macos")]
    { "darwin" }
    #[cfg(target_os = "linux")]
    { "linux" }
}

fn get_arch() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    { "x64" }
    #[cfg(target_arch = "aarch64")]
    { "arm64" }
}

pub fn get_asset_name(version: &str) -> String {
    let os = get_os();
    let arch = get_arch();
    let ext = if os == "win" { "zip" } else { "tar.gz" };
    format!("chvor-v{}-{}-{}.{}", version, os, arch, ext)
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    PlatformInfo {
        os: get_os().to_string(),
        arch: get_arch().to_string(),
        asset_name_template: format!("chvor-v{{version}}-{}-{}", get_os(), get_arch()),
    }
}

#[tauri::command]
pub fn open_browser(url: String) -> Result<(), String> {
    // Parse URL properly to prevent bypasses like http://localhost:@evil.com
    let parsed = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Only http/https URLs are allowed".to_string());
    }

    match parsed.host_str() {
        Some("localhost") | Some("127.0.0.1") | Some("[::1]") => {}
        _ => return Err("Only localhost URLs are allowed".to_string()),
    }

    open::that(&url).map_err(|e| format!("Failed to open browser: {}", e))
}

/// Save LLM credentials via the server API — keeps API keys in the Rust process only.
#[tauri::command]
pub async fn save_credentials(
    port: String,
    token: String,
    provider: String,
    provider_name: String,
    api_key: String,
) -> Result<(), String> {
    validate_port(&port)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    let url = format!("http://localhost:{}/api/credentials", port);

    let body = serde_json::json!({
        "name": provider_name,
        "type": provider,
        "data": { "apiKey": api_key },
    });

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to save credentials: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    Ok(())
}

/// Configure persona via the server API.
#[tauri::command]
pub async fn configure_persona(
    port: String,
    token: String,
    timezone: String,
) -> Result<(), String> {
    validate_port(&port)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    let url = format!("http://localhost:{}/api/persona", port);

    let body = serde_json::json!({
        "timezone": timezone,
    });

    let resp = client
        .patch(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to configure persona: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub fn get_chvor_dirs(instance: Option<String>) -> ChvorDirs {
    let home = chvor_home(instance.as_deref());
    let shared_home = chvor_home(None);
    ChvorDirs {
        home: home.to_string_lossy().to_string(),
        app: app_dir().to_string_lossy().to_string(),
        data: home.join("data").to_string_lossy().to_string(),
        logs: home.join("logs").to_string_lossy().to_string(),
        downloads: shared_home.join("downloads").to_string_lossy().to_string(),
        skills: home.join("skills").to_string_lossy().to_string(),
        tools: home.join("tools").to_string_lossy().to_string(),
        config: home.join("config.json").to_string_lossy().to_string(),
    }
}
