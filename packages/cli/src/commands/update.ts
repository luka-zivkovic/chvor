import { rmSync } from "node:fs";
import { readConfig, writeConfig } from "../lib/config.js";
import { getAppDir } from "../lib/paths.js";
import { downloadRelease } from "../lib/download.js";
import { isServerRunning, stopServer } from "../lib/process.js";

export async function update(): Promise<void> {
  const res = await fetch(
    "https://api.github.com/repos/luka-zivkovic/chvor/releases/latest"
  );
  const release = (await res.json()) as { tag_name: string };
  const version = release.tag_name.replace(/^v/, "");

  const config = readConfig();

  if (config.installedVersion === version) {
    console.log("Already up to date.");
    return;
  }

  if (isServerRunning().running) {
    await stopServer();
  }

  rmSync(getAppDir(), { recursive: true, force: true });

  await downloadRelease(version);

  writeConfig({ ...config, installedVersion: version });

  console.log(`Updated to v${version}.`);
  console.log("Run `chvor start` to start the server.");
}
