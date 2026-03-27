use serde::Serialize;
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::sync::Mutex;
use tauri::State;

use crate::platform::silent_command;

use super::config::{chvor_home, read_config};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: Option<String>,
}

pub struct ServerState {
    pub pid: Mutex<Option<u32>>,
    pub port: Mutex<Option<String>>,
}

impl Default for ServerState {
    fn default() -> Self {
        Self {
            pid: Mutex::new(None),
            port: Mutex::new(None),
        }
    }
}

fn app_dir() -> PathBuf {
    dirs::home_dir().expect("home dir").join(".chvor").join("app")
}

fn is_process_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        let output = StdCommand::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid)])
            .output();
        match output {
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stdout);
                text.contains(&pid.to_string())
            }
            Err(_) => false,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}

#[tauri::command]
pub fn server_status(state: State<'_, ServerState>) -> ServerStatus {
    // Clone values out of the mutex quickly, then drop the guards before doing IO
    let (known_pid, known_port) = {
        let pid = state.pid.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let port = state.port.lock().unwrap_or_else(|e| e.into_inner()).clone();
        (pid, port)
    };

    if let Some(pid) = known_pid {
        if is_process_alive(pid) {
            return ServerStatus {
                running: true,
                pid: Some(pid),
                port: known_port,
            };
        }
    }

    // Fallback: check PID file in case server was started by CLI
    let pid_path = chvor_home(None).join("chvor.pid");
    if let Ok(raw) = std::fs::read_to_string(&pid_path) {
        if let Ok(pid) = raw.trim().parse::<u32>() {
            if is_process_alive(pid) {
                let config = read_config(None);
                return ServerStatus {
                    running: true,
                    pid: Some(pid),
                    port: Some(config.port),
                };
            }
        }
        // Stale PID file
        let _ = std::fs::remove_file(&pid_path);
    }

    ServerStatus {
        running: false,
        pid: None,
        port: None,
    }
}

#[tauri::command]
pub async fn start_server(
    port: Option<String>,
    state: State<'_, ServerState>,
) -> Result<ServerStatus, String> {
    // Check if already running — clone out quickly
    {
        let pid = state.pid.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(pid) = pid {
            if is_process_alive(pid) {
                let port = state
                    .port
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                return Ok(ServerStatus {
                    running: true,
                    pid: Some(pid),
                    port,
                });
            }
        }
    }

    let config = read_config(None);
    let port = port.unwrap_or(config.port.clone());

    // Validate port
    let port_num: u16 = port
        .parse()
        .map_err(|_| format!("Invalid port: {}", port))?;
    if port_num < 1024 {
        return Err(format!("Port {} is in the privileged range (< 1024)", port));
    }

    let token = config.token.clone();

    let server_entry = app_dir()
        .join("apps")
        .join("server")
        .join("src")
        .join("index.ts");
    if !server_entry.exists() {
        return Err(format!(
            "Server not found at {}. Please install first.",
            server_entry.display()
        ));
    }

    let home = chvor_home(None);
    let data_dir = home.join("data");
    let skills_dir = home.join("skills");
    let tools_dir = home.join("tools");
    let logs_dir = home.join("logs");

    // Ensure directories exist
    for dir in [&data_dir, &skills_dir, &tools_dir, &logs_dir] {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let log_path = logs_dir.join("server.log");

    // Build the command — use tsx loader so Node can execute .ts source files
    let mut cmd = silent_command("node");
    cmd.arg("--import").arg("tsx");
    cmd.arg(server_entry.to_string_lossy().as_ref());
    cmd.current_dir(app_dir());
    // Ensure `--import tsx` can resolve tsx from the app's node_modules,
    // regardless of how Node resolves modules on Windows.
    cmd.env("NODE_PATH", app_dir().join("node_modules").to_string_lossy().as_ref());
    cmd.env("PORT", &port);
    cmd.env("CHVOR_DATA_DIR", data_dir.to_string_lossy().as_ref());
    cmd.env("CHVOR_SKILLS_DIR", skills_dir.to_string_lossy().as_ref());
    cmd.env("CHVOR_TOOLS_DIR", tools_dir.to_string_lossy().as_ref());
    cmd.env("NODE_ENV", "production");

    if let Some(ref t) = token {
        cmd.env("CHVOR_TOKEN", t);
    }

    // Pass through LLM API keys from environment
    for key in &[
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GOOGLE_AI_API_KEY",
        "MISTRAL_API_KEY",
        "GROQ_API_KEY",
        "TOGETHER_API_KEY",
        "OPENROUTER_API_KEY",
        "AZURE_OPENAI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
    ] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }

    // Redirect stdout/stderr to log file
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;
    let log_file_err = log_file.try_clone().map_err(|e| e.to_string())?;

    cmd.stdout(std::process::Stdio::from(log_file));
    cmd.stderr(std::process::Stdio::from(log_file_err));
    cmd.stdin(std::process::Stdio::null());

    // On Unix, detach into its own process group so it survives desktop app exit
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start server: {}", e))?;
    let pid = child.id();

    // Write PID file for CLI compatibility
    let pid_path = home.join("chvor.pid");
    let _ = std::fs::write(&pid_path, pid.to_string());

    // Store in managed state
    *state.pid.lock().unwrap_or_else(|e| e.into_inner()) = Some(pid);
    *state.port.lock().unwrap_or_else(|e| e.into_inner()) = Some(port.clone());

    Ok(ServerStatus {
        running: true,
        pid: Some(pid),
        port: Some(port),
    })
}

/// Stop the server process. Attempts graceful shutdown first on all platforms.
#[tauri::command]
pub async fn stop_server(state: State<'_, ServerState>) -> Result<(), String> {
    let pid = {
        let mut pid_guard = state.pid.lock().unwrap_or_else(|e| e.into_inner());
        let pid = *pid_guard;
        *pid_guard = None;
        pid
    };
    *state.port.lock().unwrap_or_else(|e| e.into_inner()) = None;

    // Also check PID file
    let pid_path = chvor_home(None).join("chvor.pid");
    let effective_pid = pid.or_else(|| {
        std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
    });

    if let Some(pid) = effective_pid {
        kill_server_process(pid);
    }

    let _ = std::fs::remove_file(&pid_path);
    Ok(())
}

/// Kill a server process, attempting graceful shutdown first.
pub fn kill_server_process(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        // First try graceful shutdown (without /F)
        let _ = StdCommand::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .output();

        // Wait up to 5 seconds for graceful exit
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !is_process_alive(pid) {
                return;
            }
        }

        // Force kill if still alive
        let _ = StdCommand::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
}

#[tauri::command]
pub async fn poll_health(port: String, token: Option<String>) -> Result<bool, String> {
    let url = format!("http://localhost:{}/api/health", port);
    let client = reqwest::Client::new();
    let timeout = std::time::Duration::from_secs(15);
    let interval = std::time::Duration::from_millis(500);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        let mut req = client.get(&url);
        if let Some(ref t) = token {
            req = req.header("Authorization", format!("Bearer {}", t));
        }

        if let Ok(resp) = req.send().await {
            if resp.status().is_success() {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    if body.get("ok") == Some(&serde_json::Value::Bool(true)) {
                        return Ok(true);
                    }
                }
            }
        }

        tokio::time::sleep(interval).await;
    }

    Ok(false)
}
