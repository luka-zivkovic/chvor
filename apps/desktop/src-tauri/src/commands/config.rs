use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Mirrors `ChvorConfig` from `packages/cli/src/lib/config.ts`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChvorConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    pub port: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub onboarded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_name: Option<String>,
}

impl Default for ChvorConfig {
    fn default() -> Self {
        Self {
            installed_version: None,
            port: "3001".to_string(),
            token: None,
            onboarded: false,
            llm_provider: None,
            instance_name: None,
            template_name: None,
        }
    }
}

pub fn chvor_home(instance: Option<&str>) -> PathBuf {
    let home = dirs::home_dir().expect("Could not determine home directory");
    match instance {
        Some(name) => home.join(format!(".chvor-{}", name)),
        None => home.join(".chvor"),
    }
}

pub fn config_path(instance: Option<&str>) -> PathBuf {
    chvor_home(instance).join("config.json")
}

#[tauri::command]
pub fn read_config(instance: Option<String>) -> ChvorConfig {
    let path = config_path(instance.as_deref());
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<ChvorConfig>(&raw).unwrap_or_default(),
        Err(_) => ChvorConfig::default(),
    }
}

#[tauri::command]
pub fn write_config(config: ChvorConfig, instance: Option<String>) -> Result<(), String> {
    let path = config_path(instance.as_deref());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, format!("{}\n", json)).map_err(|e| e.to_string())?;

    // Restrict file permissions to owner-only (matches CLI behavior)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&path, perms);
    }

    Ok(())
}

#[tauri::command]
pub fn is_onboarded(instance: Option<String>) -> bool {
    read_config(instance).onboarded
}
