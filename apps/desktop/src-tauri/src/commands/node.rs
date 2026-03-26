use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub meets_minimum: bool,
}

const MIN_MAJOR: u32 = 22;

fn parse_major(version: &str) -> Option<u32> {
    let v = version.trim().strip_prefix('v').unwrap_or(version.trim());
    v.split('.').next()?.parse().ok()
}

#[tauri::command]
pub fn detect_node() -> NodeInfo {
    let output = Command::new("node").arg("-v").output();

    match output {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let major = parse_major(&version).unwrap_or(0);
            NodeInfo {
                installed: true,
                version: Some(version),
                meets_minimum: major >= MIN_MAJOR,
            }
        }
        _ => NodeInfo {
            installed: false,
            version: None,
            meets_minimum: false,
        },
    }
}

#[tauri::command]
pub async fn install_node() -> Result<String, String> {
    // Security: We do not pipe remote scripts to shell interpreters.
    // Instead, try the system package manager (winget) which verifies packages,
    // and fall back to directing users to nodejs.org.

    #[cfg(target_os = "windows")]
    {
        // winget verifies package identity — safe to invoke directly
        let winget = Command::new("winget")
            .args([
                "install",
                "OpenJS.NodeJS.LTS",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ])
            .output();

        match winget {
            Ok(out) if out.status.success() => {
                return Ok("Node.js installed via winget. You may need to restart the app for PATH changes to take effect.".to_string());
            }
            _ => {
                return Err(
                    "Automatic installation failed. Please install Node.js 22+ from https://nodejs.org and restart this app."
                        .to_string(),
                );
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Check if Homebrew is available (user-installed — we don't install it)
        let brew_check = Command::new("brew").arg("--version").output();
        if let Ok(out) = brew_check {
            if out.status.success() {
                let install = Command::new("brew")
                    .args(["install", "node@22"])
                    .output()
                    .map_err(|e| format!("Failed to install Node.js: {}", e))?;

                if install.status.success() {
                    return Ok("Node.js 22 installed via Homebrew".to_string());
                }

                let stderr = String::from_utf8_lossy(&install.stderr);
                return Err(format!(
                    "brew install node@22 failed: {}. Please install manually from https://nodejs.org",
                    stderr
                ));
            }
        }

        Err(
            "Homebrew not found. Please install Node.js 22+ from https://nodejs.org and restart this app."
                .to_string(),
        )
    }

    #[cfg(target_os = "linux")]
    {
        Err(
            "Automatic Node.js installation is not supported on Linux. Please install Node.js 22+ from https://nodejs.org or via your package manager, then restart this app."
                .to_string(),
        )
    }
}
