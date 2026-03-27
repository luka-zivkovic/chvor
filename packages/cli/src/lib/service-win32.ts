import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

function getVbsPath(instance?: string): string {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA environment variable not set");
  const name = instance ? `chvor-${instance}-autostart` : "chvor-autostart";
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${name}.vbs`);
}

function escapeVbs(s: string): string {
  return s.replace(/"/g, '""');
}

export async function install(nodePath: string, cliPath: string, instance?: string): Promise<void> {
  const vbsPath = getVbsPath(instance);

  const escapedNode = escapeVbs(nodePath);
  const escapedCli = escapeVbs(cliPath);
  const args = instance ? `start -i ${instance}` : "start";

  // VBScript that runs chvor start in a hidden window (no console flash)
  const vbs = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${escapedNode}"" ""${escapedCli}"" ${args}", 0, False
`;

  writeFileSync(vbsPath, vbs, "utf-8");
  console.log(`Auto-start installed. Chvor will start on login.`);
  console.log(`  Script: ${vbsPath}`);
}

export async function uninstall(instance?: string): Promise<void> {
  const vbsPath = getVbsPath(instance);

  if (!existsSync(vbsPath)) {
    console.log("Auto-start is not installed.");
    return;
  }

  unlinkSync(vbsPath);
  console.log("Auto-start removed.");
}

export async function status(instance?: string): Promise<void> {
  const vbsPath = getVbsPath(instance);

  if (!existsSync(vbsPath)) {
    console.log("Auto-start: not installed");
    return;
  }

  console.log("Auto-start: installed");
  console.log(`  Script: ${vbsPath}`);
}
