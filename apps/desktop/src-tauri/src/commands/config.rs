use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[cfg(target_os = "windows")]
use crate::platform::silent_command;

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
            port: "9147".to_string(),
            token: None,
            onboarded: false,
            llm_provider: None,
            instance_name: None,
            template_name: None,
        }
    }
}

/// Shared app directory — binaries are shared across instances.
pub fn app_dir() -> PathBuf {
    home_dir().join(".chvor").join("app")
}

fn home_dir() -> PathBuf {
    dirs::home_dir().expect("Could not determine home directory")
}

pub fn chvor_home(instance: Option<&str>) -> PathBuf {
    let home = home_dir();
    match instance {
        Some(name) => {
            // Validated by validate_instance before reaching here in commands,
            // but belt-and-suspenders: reject anything that isn't alphanumeric/dash/underscore
            if !name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
            {
                eprintln!(
                    "[config] Rejecting unsafe instance name '{}', using default",
                    name
                );
                return home.join(".chvor");
            }
            home.join(format!(".chvor-{}", name))
        }
        None => home.join(".chvor"),
    }
}

/// Validate an instance name is safe for use in filesystem paths.
pub fn validate_instance(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Instance name cannot be empty".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "Instance name '{}' contains invalid characters. Only alphanumeric, dash, and underscore are allowed.",
            name
        ));
    }
    Ok(())
}

/// Validate a port string and return a u16.
pub fn validate_port(port: &str) -> Result<u16, String> {
    let port_num: u16 = port
        .parse()
        .map_err(|_| format!("Invalid port '{}': must be a number between 1024 and 65535", port))?;
    if port_num < 1024 {
        return Err(format!(
            "Port {} is in the privileged range (< 1024)",
            port_num
        ));
    }
    Ok(port_num)
}

pub fn config_path(instance: Option<&str>) -> PathBuf {
    chvor_home(instance).join("config.json")
}

#[tauri::command]
pub fn read_config(instance: Option<String>) -> ChvorConfig {
    if let Some(ref name) = instance {
        if let Err(e) = validate_instance(name) {
            eprintln!("[config] {}", e);
            return ChvorConfig::default();
        }
    }
    let path = config_path(instance.as_deref());
    match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<ChvorConfig>(&raw) {
            Ok(config) => config,
            Err(e) => {
                eprintln!("[config] Failed to parse {}: {}", path.display(), e);
                ChvorConfig::default()
            }
        },
        Err(_) => ChvorConfig::default(),
    }
}

#[tauri::command]
pub fn write_config(config: ChvorConfig, instance: Option<String>) -> Result<(), String> {
    if let Some(ref name) = instance {
        validate_instance(name)?;
    }
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
        std::fs::set_permissions(&path, perms)
            .map_err(|e| format!("Failed to set config permissions: {}", e))?;
    }

    // On Windows, restrict to current user via icacls
    #[cfg(target_os = "windows")]
    {
        let path_str = path.to_string_lossy();
        // Disable inheritance and remove all inherited ACEs
        let _ = silent_command("icacls")
            .args([path_str.as_ref(), "/inheritance:r"])
            .output();
        // Grant full control only to the current user
        if let Ok(user) = std::env::var("USERNAME") {
            let _ = silent_command("icacls")
                .args([path_str.as_ref(), "/grant:r", &format!("{}:F", user)])
                .output();
        }
    }

    Ok(())
}

#[tauri::command]
pub fn is_onboarded(instance: Option<String>) -> bool {
    if let Some(ref name) = instance {
        if validate_instance(name).is_err() {
            return false;
        }
    }
    read_config(instance).onboarded
}
