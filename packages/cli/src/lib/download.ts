import { createWriteStream, createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { getAppDir, getDownloadsDir, ensureDir } from "./paths.js";
import { readConfig, writeConfig } from "./config.js";
import { getAssetName, getPlatform } from "./platform.js";

const GITHUB_API = "https://api.github.com";
const REPO = "luka-zivkovic/chvor";

interface ResolvedRelease {
  url: string;
  checksum?: string;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  assets: GitHubAsset[];
}

export async function resolveRelease(
  version: string
): Promise<ResolvedRelease> {
  const tag = `v${version}`;
  const url = `${GITHUB_API}/repos/${REPO}/releases/tags/${tag}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "chvor-cli",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch release ${tag}: ${res.status} ${res.statusText}`
    );
  }

  const release = (await res.json()) as GitHubRelease;
  const assetName = getAssetName(version);

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(
      `Asset "${assetName}" not found in release ${tag}. ` +
        `Available assets: ${release.assets.map((a) => a.name).join(", ")}`
    );
  }

  let checksum: string | undefined;
  const checksumAsset = release.assets.find(
    (a) => a.name === "SHA256SUMS.txt"
  );
  if (checksumAsset) {
    const checksumRes = await fetch(checksumAsset.browser_download_url, {
      headers: { "User-Agent": "chvor-cli" },
    });
    if (checksumRes.ok) {
      const text = await checksumRes.text();
      const line = text
        .split("\n")
        .find((l) => l.includes(assetName));
      if (line) {
        checksum = line.trim().split(/\s+/)[0];
      }
    }
  }

  return { url: asset.browser_download_url, checksum };
}

export function isInstalled(version: string): boolean {
  const appDir = getAppDir();
  if (!existsSync(appDir)) return false;
  const config = readConfig();
  return config.installedVersion === version;
}

export async function downloadRelease(version: string): Promise<void> {
  if (isInstalled(version)) {
    console.log(`Chvor v${version} is already installed.`);
    return;
  }

  console.log(`Resolving Chvor v${version} release...`);
  const { url, checksum } = await resolveRelease(version);

  const downloadsDir = getDownloadsDir();
  ensureDir(downloadsDir);

  const assetName = getAssetName(version);
  const tarballPath = join(downloadsDir, assetName);

  // Download the tarball
  console.log(`Downloading ${assetName}...`);
  const res = await fetch(url, {
    headers: { "User-Agent": "chvor-cli" },
  });

  if (!res.ok) {
    throw new Error(
      `Download failed: ${res.status} ${res.statusText}`
    );
  }

  if (!res.body) {
    throw new Error("Download response has no body");
  }

  const fileStream = createWriteStream(tarballPath);
  await pipeline(Readable.fromWeb(res.body as never), fileStream);

  console.log("Download complete.");

  // Verify checksum if available
  if (checksum) {
    console.log("Verifying checksum...");
    const actual = await computeSha256(tarballPath);
    if (actual !== checksum) {
      throw new Error(
        `Checksum mismatch!\n  Expected: ${checksum}\n  Actual:   ${actual}`
      );
    }
    console.log("Checksum verified.");
  }

  // Extract
  const appDir = getAppDir();
  ensureDir(appDir);

  console.log(`Extracting to ${appDir}...`);
  if (getPlatform() === "win") {
    execFileSync("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -Path '${tarballPath}' -DestinationPath '${appDir}' -Force`,
    ], { stdio: "inherit" });
    // Move contents up from the nested directory (strip-components equivalent)
    const nested = join(appDir, assetName.replace(/\.zip$/, ""));
    if (existsSync(nested)) {
      execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Get-ChildItem -Path '${nested}' | Move-Item -Destination '${appDir}' -Force`,
      ], { stdio: "inherit" });
      execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Remove-Item -Path '${nested}' -Recurse -Force`,
      ], { stdio: "inherit" });
    }
  } else {
    execFileSync("tar", ["-xzf", tarballPath, "-C", appDir, "--strip-components=1"], {
      stdio: "inherit",
    });
  }
  console.log("Extraction complete.");

  // Install Playwright's Chromium browser (required by browser agent / Stagehand)
  console.log("Installing browser engine (Chromium)...");
  try {
    execFileSync("node", [
      join(appDir, "node_modules", "@playwright", "test", "cli.js"),
      "install", "chromium",
    ], { stdio: "inherit", cwd: appDir });
    console.log("Browser engine installed.");
  } catch (err) {
    console.warn(
      "Warning: failed to install browser engine. " +
      "The web agent won't work until you run: npx playwright install chromium"
    );
  }

  // Update config
  const config = readConfig();
  config.installedVersion = version;
  writeConfig(config);

  console.log(`Chvor v${version} installed successfully.`);
}

async function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
