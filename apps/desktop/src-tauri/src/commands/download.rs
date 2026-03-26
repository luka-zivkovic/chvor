use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read as _, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

use super::config::{read_config, write_config};
use super::system::get_asset_name;

const GITHUB_API: &str = "https://api.github.com";
const REPO: &str = "luka-zivkovic/chvor";

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub stage: String,
    pub percent: f64,
    pub message: String,
}

fn app_dir() -> PathBuf {
    dirs::home_dir().expect("home dir").join(".chvor").join("app")
}

fn downloads_dir() -> PathBuf {
    dirs::home_dir()
        .expect("home dir")
        .join(".chvor")
        .join("downloads")
}

#[tauri::command]
pub async fn resolve_latest_version() -> Result<String, String> {
    let url = format!("{}/repos/{}/releases/latest", GITHUB_API, REPO);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "chvor-desktop")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }

    let release: GitHubRelease = resp.json().await.map_err(|e| e.to_string())?;
    let version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name);
    Ok(version.to_string())
}

#[tauri::command]
pub fn is_installed(version: String) -> bool {
    let dir = app_dir();
    if !dir.exists() {
        return false;
    }
    let config = read_config(None);
    config.installed_version.as_deref() == Some(&version)
}

/// Extract a zip archive into `dest`, stripping one leading directory component
/// (equivalent to tar --strip-components=1). Uses the `zip` crate instead of
/// shelling out to PowerShell to avoid command-injection risks.
#[cfg(target_os = "windows")]
fn extract_zip(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Failed to open archive: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;

        let raw_path = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue, // skip entries with unsafe paths (e.g. ../)
        };

        // Strip the first path component (equivalent to --strip-components=1)
        let stripped: PathBuf = raw_path.components().skip(1).collect();
        if stripped.as_os_str().is_empty() {
            continue; // top-level directory entry itself
        }

        let out_path = dest.join(&stripped);

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            fs::write(&out_path, &buf).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn download_release(version: String, app: AppHandle) -> Result<(), String> {
    if is_installed(version.clone()) {
        return Ok(());
    }

    let emit = |stage: &str, percent: f64, message: &str| {
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                stage: stage.to_string(),
                percent,
                message: message.to_string(),
            },
        );
    };

    // Step 1: Resolve the release asset URL
    emit("resolve", 0.0, "Resolving release...");
    let tag = format!("v{}", version);
    let url = format!("{}/repos/{}/releases/tags/{}", GITHUB_API, REPO, tag);
    let client = reqwest::Client::new();

    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "chvor-desktop")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Release {} not found (HTTP {})",
            tag,
            resp.status()
        ));
    }

    let release: GitHubRelease = resp.json().await.map_err(|e| e.to_string())?;
    let asset_name = get_asset_name(&version);

    let asset = release
        .assets
        .iter()
        .find(|a| a.name == asset_name)
        .ok_or_else(|| format!("Asset '{}' not found in release", asset_name))?;

    // Find SHA256 checksum — mandatory for integrity verification
    let checksum_asset = release
        .assets
        .iter()
        .find(|a| a.name == "SHA256SUMS.txt")
        .ok_or_else(|| {
            "SHA256SUMS.txt not found in release. Cannot verify download integrity.".to_string()
        })?;

    let checksum_resp = client
        .get(&checksum_asset.browser_download_url)
        .header("User-Agent", "chvor-desktop")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch checksums: {}", e))?;

    let checksum_text = checksum_resp
        .text()
        .await
        .map_err(|e| format!("Failed to read checksums: {}", e))?;

    let expected_checksum = checksum_text
        .lines()
        .find(|line| line.contains(&asset_name))
        .and_then(|line| line.split_whitespace().next())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "Checksum for '{}' not found in SHA256SUMS.txt",
                asset_name
            )
        })?;

    // Step 2: Stream download to disk with progress
    emit("download", 5.0, &format!("Downloading {}...", asset_name));
    let dl_dir = downloads_dir();
    fs::create_dir_all(&dl_dir).map_err(|e| e.to_string())?;
    let tarball_path = dl_dir.join(&asset_name);

    let resp = client
        .get(&asset.browser_download_url)
        .header("User-Agent", "chvor-desktop")
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut file = fs::File::create(&tarball_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let pct = 5.0 + (downloaded as f64 / total_size as f64) * 50.0;
            emit("download", pct, &format!("Downloading {}...", asset_name));
        }
    }
    drop(file);
    emit("download", 55.0, "Download complete");

    // Step 3: Verify checksum (mandatory)
    emit("verify", 60.0, "Verifying checksum...");
    let data = fs::read(&tarball_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_checksum {
        // Remove the corrupted download
        let _ = fs::remove_file(&tarball_path);
        return Err(format!(
            "Checksum mismatch!\n  Expected: {}\n  Actual:   {}",
            expected_checksum, actual
        ));
    }

    // Step 4: Extract
    emit("extract", 65.0, "Extracting...");
    let app_path = app_dir();
    fs::create_dir_all(&app_path).map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    {
        extract_zip(&tarball_path, &app_path)?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let status = Command::new("tar")
            .args([
                "-xzf",
                &tarball_path.to_string_lossy(),
                "-C",
                &app_path.to_string_lossy(),
                "--strip-components=1",
            ])
            .status()
            .map_err(|e| e.to_string())?;

        if !status.success() {
            return Err("Extraction failed".to_string());
        }
    }

    emit("extract", 80.0, "Extraction complete");

    // Step 5: Install Playwright Chromium
    emit("browser", 82.0, "Installing browser engine (Chromium)...");
    let playwright_cli = app_path
        .join("node_modules")
        .join("@playwright")
        .join("test")
        .join("cli.js");

    if playwright_cli.exists() {
        let _ = Command::new("node")
            .args([
                playwright_cli.to_string_lossy().as_ref(),
                "install",
                "chromium",
            ])
            .current_dir(&app_path)
            .status();
    }

    emit("browser", 95.0, "Browser engine installed");

    // Step 6: Update config
    let mut config = read_config(None);
    config.installed_version = Some(version.clone());
    write_config(config, None).map_err(|e| e.to_string())?;

    emit("done", 100.0, &format!("Chvor v{} installed", version));
    Ok(())
}
