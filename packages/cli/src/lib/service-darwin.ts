import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

function getPlistPath(instance?: string): string {
  const name = instance ? `ai.chvor.server.${instance}` : "ai.chvor.server";
  return join(homedir(), "Library", "LaunchAgents", `${name}.plist`);
}

function getLabel(instance?: string): string {
  return instance ? `ai.chvor.server.${instance}` : "ai.chvor.server";
}

export async function install(nodePath: string, cliPath: string, instance?: string): Promise<void> {
  const plistPath = getPlistPath(instance);
  const label = getLabel(instance);

  const args = ["start", "--foreground"];
  if (instance) args.push("-i", instance);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
${args.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${join(homedir(), ".chvor", "logs", "launchd-stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), ".chvor", "logs", "launchd-stderr.log")}</string>
</dict>
</plist>`;

  writeFileSync(plistPath, plist, "utf-8");

  const uid = execSync("id -u", { encoding: "utf-8" }).trim();
  try {
    execSync(`launchctl bootout gui/${uid}/${label}`, { stdio: "pipe" });
  } catch {
    // Not loaded yet — fine
  }
  execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`, { stdio: "inherit" });

  console.log(`Auto-start installed. Chvor will start on login.`);
  console.log(`  Plist: ${plistPath}`);
}

export async function uninstall(instance?: string): Promise<void> {
  const plistPath = getPlistPath(instance);
  const label = getLabel(instance);

  if (!existsSync(plistPath)) {
    console.log("Auto-start is not installed.");
    return;
  }

  const uid = execSync("id -u", { encoding: "utf-8" }).trim();
  try {
    execSync(`launchctl bootout gui/${uid}/${label}`, { stdio: "pipe" });
  } catch {
    // Already unloaded
  }

  unlinkSync(plistPath);
  console.log("Auto-start removed.");
}

export async function status(instance?: string): Promise<void> {
  const plistPath = getPlistPath(instance);
  if (!existsSync(plistPath)) {
    console.log("Auto-start: not installed");
    return;
  }

  const label = getLabel(instance);
  try {
    const output = execSync(`launchctl print gui/$(id -u)/${label}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const running = output.includes("state = running");
    console.log(`Auto-start: installed (${running ? "running" : "stopped"})`);
    console.log(`  Plist: ${plistPath}`);
  } catch {
    console.log("Auto-start: installed (not loaded)");
    console.log(`  Plist: ${plistPath}`);
  }
}
