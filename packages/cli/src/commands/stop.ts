import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stopServer } from "../lib/process.js";

function isServiceInstalled(): boolean {
  switch (process.platform) {
    case "darwin":
      return existsSync(join(homedir(), "Library", "LaunchAgents", "ai.chvor.server.plist"));
    case "linux":
      return existsSync(join(homedir(), ".config", "systemd", "user", "chvor.service"));
    case "win32": {
      const appData = process.env.APPDATA;
      if (!appData) return false;
      return existsSync(join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "chvor-autostart.vbs"));
    }
    default:
      return false;
  }
}

export async function stop(): Promise<void> {
  await stopServer();

  if (isServiceInstalled()) {
    console.log("Note: Auto-start is configured. Server will restart on next login.");
    console.log("  Use `chvor service uninstall` to disable auto-start.");
  }
}
